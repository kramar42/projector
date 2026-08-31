import { advance } from '../intake/run.ts';
import { classify, type Ask, type Classified } from '../intake/classify.ts';
import { materialise } from '../intake/materialise.ts';
import { settingsFor } from '../settings.ts';
import { suppress } from '../intake/db.ts';
import { sweep } from '../intake/run.ts';
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
 * So a tick that cannot reach the classifier **holds**: it writes nothing and
 * advances nothing, and the next tick tries again. Falling back to materialising
 * everything would reach the bad outcome by accident, and there is no reading of
 * "the judge is down" that makes writing down everything the right answer.
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
  /** Notes worth interrupting for. A higher bar than deserving a note. */
  notify: { id: string; title: string }[];
  /** Set when the classifier could not be reached, so the tick held. */
  held?: string;
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
    /** Absent when the channel answered; the reason when it did not. */
    unreachable?: string;
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
    notify: [],
    channels: [],
  };
  const { reports } = await sweep(root);
  const wantsJudgement = settingsFor(root).classify.enabled;
  const createdBy = new Map<string, number>();

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
        unreachable: reason,
      });
      continue;
    }

    /**
     * With no judgement wanted, every candidate is kept with an empty verdict —
     * so the write path is one path. The card is then as thin as the channel
     * made it, which is what `classify.enabled: false` is asking for.
     */
    let declinedHere = 0;
    let kept: Classified['keep'] = report.candidates.map((candidate) => ({
      candidate,
      verdict: { fingerprint: candidate.fingerprint, decision: 'keep', reason: '' },
    }));

    if (wantsJudgement && report.candidates.length) {
      const judged = await classify(root, report.candidates, ask);
      if (!judged) {
        // Held, not failed. Nothing written and nothing advanced, so the next
        // tick sees exactly what this one saw.
        out.held = 'the classifier could not be reached';
        return out;
      }
      kept = judged.keep;
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
    createdBy.set(report.channel, res.created.length);
    out.created.push(...res.created);
    out.skipped += res.skipped;
    out.extending += res.extending;
    out.notify.push(...res.notify);
    out.channels.push({
      channel: report.channel,
      seen: report.candidates.length,
      created: res.created.length,
      skipped: res.skipped,
      declined: declinedHere,
      extending: res.extending,
    });
  }

  /**
   * Advance only the channels this tick actually resolved.
   *
   * A channel that could not be reached recorded a pending cursor of null, so it
   * has nothing to promote and `advance` skips it — but naming them explicitly
   * says the intent rather than relying on that. `captured` is the count of notes
   * this run wrote *from that channel*, which for once is knowable: unlike
   * `pj add` from a conversation, this run wrote them and can attribute them.
   */
  for (const report of reports) {
    if (!report.fetched) continue;
    const moved = advance(root, { channel: report.channel, captured: createdBy.get(report.channel) ?? 0 });
    out.advanced.push(...moved.moved.map((m) => m.channel));
  }
  return out;
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
        const tail = tally({
          new: c.created,
          extending: c.extending,
          declined: c.declined,
          known: c.skipped,
        });
        info('intake', `${name}/${c.channel} saw ${c.seen}${tail ? `  ${tail}` : ''}`);
      }

      // The tick's own line, after the channels, so the summary reads as a total
      // of what is above it rather than as a fifth channel.
      info(
        'intake',
        `${name} tick in ${Date.now() - started}ms  ` +
          `${count(res.created.length, 'note')} written, ` +
          `${res.declined} declined, ` +
          `${count(res.advanced.length, 'cursor')} advanced`,
      );
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

  info('intake', `${name} polling every ${poll.everySeconds}s`);
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
