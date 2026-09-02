import { advance } from '../intake/run.ts';
import { classify, type Ask, type Classified } from '../intake/classify.ts';
import { materialise } from '../intake/materialise.ts';
import { addCost, renderCost } from '../intake/relay.ts';
import { settingsFor } from '../settings.ts';
import { markSeen, suppress } from '../intake/db.ts';
import { sweep } from '../intake/run.ts';
import type { Cost } from '../intake/types.ts';
import { basename } from 'node:path';
import { count, info, tally, warn } from './log.ts';

/**
 * The sweep, unattended.
 *
 * `pj intake` and this loop run the same channels through the same code, and
 * differ in exactly one thing: who is there to answer. A person running a sweep
 * is standing right there, so it proposes and stops. A timer has nobody to ask,
 * so it writes each candidate into the vault as a note carrying `intake:
 * unjudged` and leaves the answer for whenever you next look.
 *
 * **Which is why the cursor may move here and not there.** The rule has always
 * been that a cursor may only pass a boundary with nothing unexamined behind it,
 * and `pj intake` cannot satisfy that — it wrote nothing down, so advancing would
 * step over candidates that exist only in a terminal buffer. A materialising run
 * can: every candidate it passed is a file, or was already answered for. The queue
 * now guarantees what the cursor used to be asked to, so the cursor is demoted to
 * what it always should have been — where to resume fetching.
 *
 * A truncated run still holds, for the original reason: `sweep` has already
 * nulled `nextCursor` in that case, and there is more behind the boundary that
 * this run never looked at.
 *
 * **A tick judges before it writes.** `classify` decides which candidates deserve
 * a note; the rest are recorded as declined, with the model's reason, so they stop
 * being offered and stay readable through `pj intake declined`. Without that step
 * every commit and every session on the machine would become a note, which is the
 * failure the queue exists to prevent rather than a milder version of it.
 *
 * So a tick that cannot reach the classifier **holds** that channel and every one
 * after it: nothing more is written or advanced, and the next tick tries again.
 * Channels judged before the hold keep what they earned — their notes are files,
 * their declines are rows, so their cursors move — because the rule is per
 * channel: a cursor may pass a boundary once everything behind it is a file or
 * answered for, and that is true of a judged channel whatever happened to the
 * next one. Two relay fetches are the expensive part of a tick, and a hold on the
 * last channel must not make the next tick pay for them again. Falling back to
 * materialising everything would reach the bad outcome by accident, and there is
 * no reading of "the judge is down" that makes writing down everything the right
 * answer.
 *
 * **A tick is also the sync.** A channel offers what moved on the things the vault
 * already tracks as candidates that can only extend the tracking note, and once a
 * tick has judged them it records the state each was seen in (`seen`, in
 * `intake/db.ts`), so the next tick asks about a change rather than about an
 * item. That record is written here and only here, after judgement: a held tick
 * must see the same change again, or the change is lost to a table nobody reads.
 *
 * **And it says what it cost.** Two of the channels run an agent and the
 * classifier runs a model; a tick that takes two minutes and forty thousand tokens
 * looks, from the board, exactly like one that took two seconds. So every channel
 * line carries what fetching and judging cost, and the tick line carries the sum.
 */

export interface PollResult {
  vault: string;
  created: string[];
  /** Already in the vault, or already answered for. */
  skipped: number;
  /** Channels that could not be reached this tick, with the reason. */
  unreachable: { channel: string; reason: string }[];
  advanced: string[];
  /** Candidates the classifier declined, now recorded as suppressed. */
  declined: number;
  /** Of those created, how many are waiting to be merged into an existing note. */
  extending: number;
  /** Of `extending`, how many are news about a note the vault already tracked. */
  updates: number;
  /** Notes worth interrupting for. A higher bar than deserving a note. */
  notify: { id: string; title: string }[];
  /** Set when the classifier could not be reached, so the tick held. */
  held?: string;
  /** Everything the tick spent, fetching and judging, where the transports said. */
  cost?: Cost;
  /**
   * The same tick, per channel.
   *
   * The totals above answer "did anything happen"; these answer "which source is
   * working", which is the question you actually have when a board has been
   * empty for two days. A channel that fetched and found nothing is a *row of
   * zeroes* here rather than an absence — that distinction is the whole point,
   * and it is the one the totals cannot carry.
   */
  channels: {
    channel: string;
    /** What the channel offered, before the classifier saw any of it. */
    seen: number;
    created: number;
    skipped: number;
    declined: number;
    /** Of `created`, those waiting to be merged into a note that exists. */
    extending: number;
    /** Of `extending`, those that are updates to a tracked note. */
    updates: number;
    /** What fetching cost, when the transport said. */
    fetch?: Cost;
    /** What judging cost, when the classifier said. */
    judge?: Cost;
    /** Absent when the channel answered; the reason when it did not. */
    unreachable?: string;
    /** What a channel that answered still wanted to say: records dropped, pages left, a held cursor. */
    note?: string;
  }[];
}

/**
 * One tick for one vault. Exported so a test can run it without a timer, which is
 * the only way to assert what a loop does without waiting for it.
 */
export async function pollOnce(root: string, ask?: Ask): Promise<PollResult> {
  const out: PollResult = {
    vault: root,
    created: [],
    skipped: 0,
    unreachable: [],
    advanced: [],
    declined: 0,
    extending: 0,
    updates: 0,
    notify: [],
    channels: [],
  };
  const { reports } = await sweep(root);
  const wantsJudgement = settingsFor(root).classify.enabled;

  for (const report of reports) {
    if (!report.fetched) {
      // Slack without MCP lands here by design. A failing Gmail CLI or any other
      // channel lands here too, since `collectSafely` gives a thrown collect the
      // same shape.
      const reason = report.reason ?? 'not fetched here';
      out.unreachable.push({ channel: report.channel, reason });
      out.channels.push({
        channel: report.channel,
        seen: 0,
        created: 0,
        skipped: 0,
        declined: 0,
        extending: 0,
        updates: 0,
        ...(report.cost ? { fetch: report.cost } : {}),
        unreachable: reason,
      });
      out.cost = addCost(out.cost, report.cost);
      continue;
    }

    /**
     * With no judgement wanted, every candidate is kept with an empty verdict —
     * so the write path is one path. The card is then as thin as the channel
     * made it, which is what `classify.enabled: false` is asking for.
     */
    let declinedHere = 0;
    let judge: Cost | undefined;
    let kept: Classified['keep'] = report.candidates.map((candidate) => ({
      candidate,
      verdict: { fingerprint: candidate.fingerprint, decision: 'keep', reason: '' },
    }));

    if (wantsJudgement && report.candidates.length) {
      const judged = await classify(root, report.candidates, ask);
      if (!judged) {
        // Held, not failed. Nothing written and nothing advanced for this
        // channel or those after it, so the next tick sees exactly what this
        // one saw there. What earlier channels wrote and advanced stands.
        out.held = `the classifier could not be reached for ${report.channel}`;
        return out;
      }
      kept = judged.keep;
      judge = judged.cost;
      declinedHere = judged.drop.length;
      for (const d of judged.drop) {
        suppress(root, {
          fingerprint: d.candidate.fingerprint,
          reason: d.reason,
          channel: report.channel,
          title: d.candidate.title,
          // The model's decline, not a person's. Calibration needs to know which,
          // and so does anyone deciding how much to trust an empty board.
          by: 'model',
        });
        out.declined++;
      }
    }

    const res = materialise(root, report.channel, kept);
    // Judged, and written or declined: now the state each was seen in is a fact
    // the next tick may compare against. Every candidate, not only the tracked
    // ones — a discovery that becomes a note is tracked from then on, and its
    // first update should be a change, not the state it was filed in.
    for (const c of report.candidates) if (c.state) markSeen(root, c.state.key, c.state.value);

    // Advance now rather than after every channel: this one is resolved —
    // everything behind its boundary is a file or answered for — and a hold on
    // a later channel must not cost it that.
    const moved = advance(root, { channel: report.channel, captured: res.created.length });
    out.advanced.push(...moved.moved.map((m) => m.channel));

    out.created.push(...res.created);
    out.skipped += res.skipped;
    out.extending += res.extending;
    out.updates += res.updates;
    out.notify.push(...res.notify);
    out.cost = addCost(out.cost, addCost(report.cost, judge));
    out.channels.push({
      channel: report.channel,
      seen: report.candidates.length,
      created: res.created.length,
      skipped: res.skipped,
      declined: declinedHere,
      extending: res.extending,
      updates: res.updates,
      ...(report.cost ? { fetch: report.cost } : {}),
      ...(judge ? { judge } : {}),
      ...(report.reason ? { note: report.reason } : {}),
    });
  }

  return out;
}

/**
 * One channel of a tick as a line, shared by the poller's log and `pj intake
 * apply`, so the two surfaces cannot describe the same tick differently.
 */
export function channelLine(c: PollResult['channels'][number]): string {
  const tail = tally({
    new: c.created - c.extending,
    extending: c.extending - c.updates,
    updates: c.updates,
    declined: c.declined,
    known: c.skipped,
  });
  const spent = [c.fetch ? `fetch ${renderCost(c.fetch)}` : '', c.judge ? `judge ${renderCost(c.judge)}` : '']
    .filter(Boolean)
    .join(', ');
  return `saw ${c.seen}${tail ? `  ${tail}` : ''}${spent ? `  [${spent}]` : ''}${c.note ? `  — ${c.note}` : ''}`;
}

/** The tick as one line: what was written, declined and advanced, and what it all cost. */
export function tickLine(res: PollResult, elapsedMs: number): string {
  return (
    `tick in ${(elapsedMs / 1000).toFixed(1)}s  ` +
    `${count(res.created.length, 'note')} written` +
    (res.updates ? ` (${count(res.updates, 'update')})` : '') +
    `, ${res.declined} declined, ${count(res.advanced.length, 'cursor')} advanced` +
    (res.cost ? `  [${renderCost(res.cost)}]` : '')
  );
}

/**
 * Whether a local hour falls inside a polling window, `[from, until)`.
 *
 * A window that wraps midnight — `[22, 6]` — is the hours from ten in the
 * evening and the hours before six, which is the natural reading and the one a
 * range check gets wrong. `until: 24` means through midnight.
 */
export function withinHours(hour: number, hours: { from: number; until: number } | null): boolean {
  if (!hours) return true;
  const { from, until } = hours;
  return from < until ? hour >= from && hour < until : hour >= from || hour < until;
}

type Timer = ReturnType<typeof setInterval>;
const timers = new Map<string, Timer>();

/**
 * Start polling a vault, if it asked to be polled.
 *
 * Idempotent per vault: the server calls this whenever a vault is first used, and
 * a second call must not double the rate. Returns whether a loop is now running,
 * so the caller can say so once rather than guessing.
 */
export function startPolling(
  root: string,
  /** Called with what a tick judged worth interrupting for. Local delivery only. */
  onAttention: (notes: { id: string; title: string }[]) => void = () => {},
): boolean {
  if (timers.has(root)) return true;
  const { poll } = settingsFor(root);
  if (!poll.enabled) return false;

  const name = basename(root);

  const tick = async () => {
    const started = Date.now();
    // The timer keeps its cadence through the night; the tick is what stays home.
    // Local time, like every stamp in this log: the window is about a working
    // day, and a working day is where the machine is.
    if (!withinHours(new Date().getHours(), poll.hours)) {
      info('intake', `${name} outside polling hours ${poll.hours!.from}–${poll.hours!.until}, tick skipped`);
      return;
    }
    try {
      const res = await pollOnce(root);
      if (res.held) {
        // Loud, because a held tick looks exactly like a quiet channel from the
        // outside and the two mean opposite things: nothing to write, versus
        // plenty to write and no way to judge it.
        warn('intake', `${name} held — ${res.held}`);
        return;
      }

      // One line per channel, always — a channel that answered and found nothing
      // is a row of zeroes rather than a silence, because "quiet" and "broken"
      // are the two readings this log exists to separate.
      for (const c of res.channels) {
        if (c.unreachable) {
          // A missing Slack MCP is expected; a failing Gmail CLI is actionable.
          // Either is channel-local rather than fatal. A channel that has been
          // unreachable for a week is still worth
          // seeing, which is why it is a line and not a shrug.
          warn('intake', `${name}/${c.channel} not fetched — ${c.unreachable}`);
          continue;
        }
        info('intake', `${name}/${c.channel} ${channelLine(c)}`);
      }

      // The tick's own line, after the channels, so the summary reads as a total
      // of what is above it rather than as a fifth channel.
      info('intake', `${name} ${tickLine(res, Date.now() - started)}`);
      // After the log, so a tick that writes and interrupts says both.
      onAttention(res.notify);
      if (res.notify.length) {
        info('intake', `${name} ${count(res.notify.length, 'note')} worth interrupting for`);
      }
    } catch (e) {
      // A tick that throws must not stop the timer: the next one may well work,
      // and a poller that dies on one bad sweep is worse than one that is noisy.
      warn('intake', `${name} tick failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  info(
    'intake',
    `${name} polling every ${poll.everySeconds}s` +
      (poll.hours ? `, ${poll.hours.from}–${poll.hours.until} local time` : ''),
  );
  const timer = setInterval(tick, poll.everySeconds * 1000);
  // Never hold the process open on our account. A timer is not a reason for a
  // server to refuse to exit.
  timer.unref?.();
  timers.set(root, timer);
  void tick();
  return true;
}

/** Stop polling one vault, or all of them. Used by tests and by shutdown. */
export function stopPolling(root?: string): void {
  for (const [key, timer] of timers) {
    if (root && key !== root) continue;
    clearInterval(timer);
    timers.delete(key);
  }
}
