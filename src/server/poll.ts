import { classify, type Ask, type Classified } from '../intake/classify.ts';
import { materialise } from '../intake/materialise.ts';
import { addCost, renderCost } from '../intake/cost.ts';
import { settingsFor } from '../settings.ts';
import { markOffered, suppress } from '../intake/db.ts';
import { pending, type ChannelReport } from '../intake/run.ts';
import { ATTEMPT_DONE, endAttempt, sinkToKernel, startAttempt, type AttemptStatus, type Examined, type Runner, type Sent, type TickCounts } from '../intake/kernel.ts';
import type { Candidate, Cost } from '../intake/types.ts';
import { basename } from 'node:path';
import { count, info, tally, warn } from './log.ts';

/**
 * The triage pass, unattended — and `pj intake`, which is the same pass run by
 * hand.
 *
 * **It never fetches.** Gathering is the kernel connectors' job, run by the
 * owner (`bin/kernel sync`). A pass reads the connector events already in the
 * kernel that intake has not judged (`pending`, in `src/intake/run.ts`), judges
 * them, writes each candidate it keeps into `inbox/` as a card, and records every
 * event it looked at back in the kernel as an `intake/<channel>` event — which is
 * what moves the cursor, because the cursor is the newest of those
 * (`src/intake/connectors.ts`). `inbox/` is not your notes, so filing there needs
 * nobody standing by: the timer does it, and so does a bare `pj intake`. Only
 * `pj intake --dry-run` reads and stops.
 *
 * **A pass judges before it writes.** `classify` decides which candidates
 * deserve a note; the rest are recorded as declined, with the model's reason, so
 * they stop being offered and stay readable through `pj intake declined`.
 * Without that step every commit and every session on the machine would become
 * a note, which is the failure the queue exists to prevent.
 *
 * So a pass that cannot reach the classifier **holds** that channel and every
 * one after it: nothing more is written or recorded, and the next pass reads the
 * same events again. Channels judged before the hold keep what they earned —
 * their cards are files, their declines rows, their intake events in the kernel —
 * because the cursor is per channel. Falling back to writing everything would
 * reach the bad outcome by accident.
 *
 * **Each pass that judges is an attempt.** Intake's judgment is projector's spec
 * `judge-intake`, so before the first channel with candidates is judged the pass
 * starts an attempt of it, every intake event goes into that attempt, and the
 * pass ends it with its counts — `failed` when it held or threw — so the kernel
 * judges the judging (`src/intake/kernel.ts`). An attempt the kernel would not
 * start is a line, and the events go without one.
 *
 * **And it says what it cost.** The classifier runs a model; a pass that takes
 * two minutes and forty thousand tokens looks, from the board, exactly like one
 * that took two seconds. So every channel line carries what judging cost, and
 * the tick line carries the sum.
 */

export interface PollResult {
  vault: string;
  created: string[];
  /** Already in the vault, or skipped before the judge with a reason. */
  skipped: number;
  /** Candidates the classifier declined, now recorded as suppressed. */
  declined: number;
  /** Of those created, how many are waiting to be merged into an existing note. */
  extending: number;
  /** Of `extending`, how many are news about a note the vault already tracked. */
  updates: number;
  /** The owner's own progress attached to the notes it belongs to, with no card. */
  linked: number;
  /** Candidates the judge gave no verdict for after two asks, recorded as declined with that reason. */
  unanswered: number;
  /** Intake events the kernel was sent: every connector event the pass looked at. */
  recorded: number;
  /** Notes worth interrupting for. A higher bar than deserving a note. */
  notify: { id: string; title: string }[];
  /** Why the pass read nothing at all: the kernel block is off, or the kernel could not answer. */
  idle?: string;
  /** Set when the classifier could not be reached, so the pass held. */
  held?: string;
  /** Everything the pass spent judging, where the transport said. */
  cost?: Cost;
  /**
   * The pass as an attempt of `judge-intake` in the owner's kernel, when a
   * channel had something to judge: its id and how it ended, or why the kernel
   * would not start or end it.
   */
  attempt?: { ok: true; id: string; status: AttemptStatus } | { ok: false; reason: string };
  /**
   * The same pass, per channel.
   *
   * The totals above answer "did anything happen"; these answer "which source is
   * moving", which is the question you actually have when a board has been empty
   * for two days. A channel with nothing new is a *row of zeroes* here rather
   * than an absence — the reading that says the connector has not been synced.
   */
  channels: {
    channel: string;
    /** The connector that gathers it. */
    connector: string;
    /** Connector events read. */
    read: number;
    /** Candidates sent to the judge. */
    seen: number;
    created: number;
    skipped: number;
    declined: number;
    /** Of `created`, those waiting to be merged into a note that exists. */
    extending: number;
    /** Of `extending`, those that are updates to a tracked note. */
    updates: number;
    /** Progress attached to a note without a card. */
    linked: number;
    /** Declined for want of any verdict. */
    unanswered: number;
    /** What judging cost, when the classifier said. */
    judge?: Cost;
    /** What the channel still wanted to say: a cursor older than its window, keys it could not recover. */
    note?: string;
    /** More events wait behind this slice: the next tick comes sooner (`poll.catchUpSeconds`). */
    behind?: boolean;
    /** What the kernel took of this channel's intake events, or why it could not. */
    kernel?: Sent;
  }[];
}

/**
 * One pass for one vault. Exported so a test can run it without a timer, and so
 * `pj intake` can run it by hand.
 *
 * `only` names the channels to judge, as `pj intake jira` does; empty means the
 * ones the vault turned on. Per channel is safe because the cursor is per
 * channel: a channel left out is neither read nor recorded.
 */
export async function pollOnce(
  root: string,
  ask?: Ask,
  /** `kernel` stands in for spawning the kernel, and `now` for the clock the windows are read against, for a test. */
  opts: { only?: string[]; kernel?: Runner; limit?: number; now?: number } = {},
): Promise<PollResult> {
  const out: PollResult = {
    vault: root,
    created: [],
    skipped: 0,
    declined: 0,
    extending: 0,
    updates: 0,
    linked: 0,
    unanswered: 0,
    recorded: 0,
    notify: [],
    channels: [],
  };
  const settings = settingsFor(root);
  /** The pass's attempt: undefined until a channel has something to judge, null when the kernel would not start it. */
  let attempt: string | null | undefined;
  let failure: string | undefined;
  try {
    await passBody(root, ask, opts, out, settings, async () => {
      if (attempt !== undefined) return attempt ?? undefined;
      const started = await startAttempt(settings.kernel, opts.kernel);
      attempt = started.ok ? started.id : null;
      if (!started.ok) out.attempt = started;
      return attempt ?? undefined;
    });
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    if (attempt) {
      const status: AttemptStatus = out.held || failure ? 'failed' : ATTEMPT_DONE;
      const ended = await endAttempt(settings.kernel, attempt, status, countsOf(out, failure), opts.kernel);
      out.attempt = ended.ok ? { ok: true, id: attempt, status } : ended;
    }
  }
  return out;
}

/** What a pass counted, as its attempt's result. */
function countsOf(out: PollResult, error?: string): TickCounts {
  return {
    seen: out.channels.reduce((n, c) => n + c.seen, 0),
    created: out.created.length,
    extending: out.extending,
    updates: out.updates,
    linked: out.linked,
    declined: out.declined,
    unanswered: out.unanswered,
    skipped: out.skipped,
    recorded: out.recorded,
    ...(out.held ? { held: out.held } : {}),
    ...(error ? { error } : {}),
  };
}

/** A skipped connector event as the sink records it: no verdict, the reason it never reached the judge. */
const skippedAs = (channel: string, s: ChannelReport['skipped'][number]): Examined => ({
  candidate: { channel, fingerprint: s.fingerprint, title: s.title, links: [], ...(s.event ? { event: s.event } : {}) } as Candidate,
  decision: 'skip',
  reason: s.why,
});

/**
 * The pass's channels, written into `out`. `attempt` starts the pass's attempt
 * the first time a channel has candidates to judge, and answers its id (or
 * nothing, with the kernel refusing) every time after.
 */
async function passBody(
  root: string,
  ask: Ask | undefined,
  opts: { only?: string[]; kernel?: Runner; limit?: number; now?: number },
  out: PollResult,
  settings: ReturnType<typeof settingsFor>,
  attempt: () => Promise<string | undefined>,
): Promise<void> {
  const read = await pending(root, {
    ...(opts.only?.length ? { only: opts.only } : {}),
    ...(opts.kernel ? { run: opts.kernel } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  if (!read.ok) {
    // Nothing to read is not a hold: there was nothing to judge. It never falls
    // back to fetching — gathering is the connectors' job.
    out.idle = read.reason;
    return;
  }
  const wantsJudgement = settings.classify.enabled;

  for (const report of read.reports) {
    /**
     * With no judgement wanted, every candidate is kept with an empty verdict —
     * so the write path is one path. The card is then as thin as the connector
     * event made it, which is what `classify.enabled: false` is asking for.
     */
    let declinedHere = 0;
    let unansweredHere = 0;
    let judge: Cost | undefined;
    /** Everything this channel looked at, whatever became of it: what the kernel sink is sent. */
    const examined: Examined[] = report.skipped.map((s) => skippedAs(report.channel, s));
    let kept: Classified['keep'] = report.candidates.map((candidate) => ({
      candidate,
      verdict: { fingerprint: candidate.fingerprint, decision: 'keep', reason: '' },
    }));

    // Something to judge: this pass is an attempt from here on.
    const attemptId = report.candidates.length ? await attempt() : undefined;

    if (wantsJudgement && report.candidates.length) {
      const judged = await classify(root, report.candidates, ask);
      if (!judged) {
        // Held, not failed. Nothing written or recorded for this channel or
        // those after it, so the next pass reads exactly what this one read
        // there. What earlier channels wrote and recorded stands.
        out.held = `the classifier could not be reached for ${report.channel}`;
        return;
      }
      kept = judged.keep;
      judge = judged.cost;
      declinedHere = judged.drop.length;
      for (const d of judged.drop) {
        examined.push({ candidate: d.candidate, decision: 'drop', reason: d.reason });
        suppress(root, {
          fingerprint: d.candidate.fingerprint,
          reason: d.reason,
          channel: report.channel,
          title: d.candidate.title,
          // The model's decline, not a person's. Calibration needs to know which,
          // and so does anyone deciding how much to trust an empty board.
          by: 'model',
          ...(d.candidate.event ? { event: d.candidate.event.id } : {}),
        });
        out.declined++;
      }
      // No verdict after two asks is not a keep. It is recorded as a decline with
      // exactly that reason, so the pile shows it and one click brings it back.
      for (const c of judged.unjudged) {
        examined.push({ candidate: c, decision: 'unjudged', reason: 'no verdict from the judge after two asks' });
        suppress(root, {
          fingerprint: c.fingerprint,
          reason: 'no verdict from the judge after two asks',
          channel: report.channel,
          title: c.title,
          by: 'model',
          ...(c.event ? { event: c.event.id } : {}),
        });
        unansweredHere++;
        out.unanswered++;
      }
    }

    const res = materialise(root, report.channel, kept);
    // A decline taken back is offered once; whatever the judge said, it is spent.
    for (const fp of report.rescued ?? []) markOffered(root, fp);

    // The kernel hears about everything this channel looked at, after the vault
    // has it: the cards first, so a kernel that refuses the batch costs a second
    // read next pass and never a card (see `src/intake/kernel.ts`).
    examined.unshift(...kept.map(({ candidate, verdict }) => ({ candidate, verdict, decision: verdict.decision, reason: verdict.reason })));
    const sent = await sinkToKernel(root, report.channel, examined, opts.kernel, attemptId);
    if (sent?.ok) out.recorded += examined.length;

    const skipped = res.skipped + report.skipped.length;
    out.created.push(...res.created);
    out.skipped += skipped;
    out.extending += res.extending;
    out.updates += res.updates;
    out.linked += res.linked.length;
    out.notify.push(...res.notify);
    out.cost = addCost(out.cost, judge);
    out.channels.push({
      channel: report.channel,
      connector: report.connector,
      read: report.read,
      seen: report.candidates.length,
      created: res.created.length,
      skipped,
      declined: declinedHere,
      extending: res.extending,
      updates: res.updates,
      linked: res.linked.length,
      unanswered: unansweredHere,
      ...(judge ? { judge } : {}),
      ...(report.note ? { note: report.note } : {}),
      ...(report.truncated ? { behind: true } : {}),
      ...(sent ? { kernel: sent } : {}),
    });
  }
}

/**
 * Whether a pass left any channel with more to read than it read. A held pass
 * is not behind — the judge was down, and asking it sooner is not catching up —
 * and nor is one whose batch the kernel refused, which would read the same slice.
 */
export function isBehind(res: PollResult): boolean {
  return !res.held && res.channels.some((c) => c.behind && c.kernel?.ok !== false);
}

/**
 * One channel of a pass as a line, shared by the poller's log and `pj intake`, so
 * the two surfaces cannot describe the same pass differently.
 */
export function channelLine(c: PollResult['channels'][number]): string {
  const tail = tally({
    new: c.created - c.extending,
    extending: c.extending - c.updates,
    updates: c.updates,
    linked: c.linked,
    declined: c.declined,
    unanswered: c.unanswered,
    skipped: c.skipped,
  });
  const spent = c.judge ? `judge ${renderCost(c.judge)}` : '';
  const kernel = !c.kernel
    ? ''
    : c.kernel.ok
      ? ''
      : `kernel not written: ${c.kernel.reason} — the next pass judges these again`;
  const said = [c.behind ? 'more behind this slice' : '', c.note ?? '', kernel].filter(Boolean).join('; ');
  return `read ${c.read}, judged ${c.seen}${tail ? `  ${tail}` : ''}${spent ? `  [${spent}]` : ''}${said ? `  — ${said}` : ''}`;
}

/** The pass as one line: what was written, declined and recorded, and what judging cost. */
export function tickLine(res: PollResult, elapsedMs: number): string {
  return (
    `tick in ${(elapsedMs / 1000).toFixed(1)}s  ` +
    `${count(res.created.length, 'note')} written` +
    (res.updates ? ` (${count(res.updates, 'update')})` : '') +
    (res.linked ? `, ${count(res.linked, 'link')} attached` : '') +
    `, ${res.declined + res.unanswered} declined, ${res.recorded} recorded in the kernel` +
    (res.cost ? `  [${renderCost(res.cost)}]` : '') +
    // The pass as the kernel's attempt, when it was one: what the kernel judges next.
    (!res.attempt
      ? ''
      : res.attempt.ok
        ? `  — kernel attempt ${res.attempt.id.slice(0, 8)} ${res.attempt.status}`
        : `  — kernel attempt not recorded: ${res.attempt.reason}`)
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

/** `next tick now`, `… in 40s`, `… in 12m`, `… in 3h`: for the line a loop starts with. */
function nextTick(ms: number): string {
  if (ms <= 0) return 'next tick now';
  const secs = Math.ceil(ms / 1000);
  if (secs < 90) return `next tick in ${secs}s`;
  const mins = Math.round(secs / 60);
  return `next tick in ${mins < 90 ? `${mins}m` : `${Math.round(mins / 60)}h`}`;
}

/** The pending next tick, as one thing to cancel. */
const loops = new Map<string, () => void>();

/**
 * Start polling a vault, if it asked to be polled and has a kernel to read.
 *
 * Idempotent per vault: the server calls this at startup and whenever a vault is
 * used, and a second call must not double the rate. Returns whether a loop is
 * now running, so the caller can say so once rather than guessing. A vault whose
 * kernel block is off has nothing for a pass to read, so it starts no loop
 * (`pollAtStartup` says why).
 *
 * **Each tick schedules the next**, rather than an interval firing on its own,
 * because how long to wait is the tick's answer: `poll.every` after it started,
 * so a loop keeps the rhythm it had; or, when a channel is still behind — a
 * synced backlog longer than one slice — `poll.catchUpSeconds` after it
 * finished. The hours window still applies to every tick. And two ticks never
 * overlap, which an interval allowed whenever one took longer than the cadence.
 *
 * The first tick runs at once. It used to wait out the rest of the interval
 * since the last one, because a tick then fetched — minutes of relay and judge
 * calls — and `bun run dev` restarts on every save; a pass now reads the kernel,
 * and with nothing new since the last one it judges nothing.
 */
export function startPolling(
  root: string,
  /** Called with what a tick judged worth interrupting for. Local delivery only. */
  onAttention: (notes: { id: string; title: string }[]) => void = () => {},
): boolean {
  if (loops.has(root)) return true;
  const { poll, kernel } = settingsFor(root);
  if (!poll.enabled || !kernel.enabled) return false;

  const name = basename(root);

  /** One tick; resolves to whether a channel is still behind. */
  const tick = async (): Promise<boolean> => {
    const started = Date.now();
    // The timer keeps its cadence through the night; the tick is what stays home.
    // Local time, like every stamp in this log: the window is about a working
    // day, and a working day is where the machine is.
    if (!withinHours(new Date().getHours(), poll.hours)) {
      info('intake', `${name} outside polling hours ${poll.hours!.from}–${poll.hours!.until}, tick skipped`);
      return false;
    }
    try {
      const res = await pollOnce(root);
      if (res.idle) {
        // The kernel could not answer: nothing was judged, and nothing is lost —
        // the next tick reads the same events.
        warn('intake', `${name} read nothing — ${res.idle}`);
        return false;
      }
      if (res.held) {
        // Loud, because a held tick looks exactly like a quiet channel from the
        // outside and the two mean opposite things: nothing to write, versus
        // plenty to write and no way to judge it.
        warn('intake', `${name} held — ${res.held}`);
        return false;
      }

      // One line per channel, always — a channel with nothing new is a row of
      // zeroes rather than a silence, because "quiet" and "not synced" are the
      // two readings this log exists to separate.
      for (const c of res.channels) {
        // A kernel that refused the batch is a warning, not a hold: the cards
        // stand, and the next pass judges the same events again.
        if (c.kernel && !c.kernel.ok) warn('intake', `${name}/${c.channel} ${channelLine(c)}`);
        else info('intake', `${name}/${c.channel} ${channelLine(c)}`);
      }

      // The tick's own line, after the channels, so the summary reads as a total
      // of what is above it. A tick that brings the next one forward says so here.
      const behind = isBehind(res);
      info(
        'intake',
        `${name} ${tickLine(res, Date.now() - started)}` +
          (behind ? `  behind — ${nextTick(poll.catchUpSeconds * 1000)}` : ''),
      );
      // After the log, so a tick that writes and interrupts says both.
      onAttention(res.notify);
      if (res.notify.length) {
        info('intake', `${name} ${count(res.notify.length, 'note')} worth interrupting for`);
      }
      return behind;
    } catch (e) {
      // A tick that throws must not stop the loop: the next one may well work,
      // and a poller that dies on one bad pass is worse than one that is noisy.
      warn('intake', `${name} tick failed — ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  info(
    'intake',
    `${name} polling every ${poll.everySeconds}s` +
      (poll.hours ? `, ${poll.hours.from}–${poll.hours.until} local time` : '') +
      ' — triaging what the kernel’s connectors gathered; next tick now',
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(run, ms);
    // Never hold the process open on our account. A timer is not a reason for a
    // server to refuse to exit.
    timer.unref?.();
  };
  const run = async () => {
    const started = Date.now();
    const behind = await tick();
    schedule(
      behind
        ? poll.catchUpSeconds * 1000
        : Math.max(0, started + poll.everySeconds * 1000 - Date.now()),
    );
  };
  loops.set(root, () => {
    // A tick in flight finishes, and then schedules nothing.
    stopped = true;
    clearTimeout(timer);
  });
  void run();
  return true;
}

/**
 * Start every vault the server knows, at startup, and say for each whether it
 * is polling.
 *
 * Before this the loop started on the first request that named a vault, so a
 * server with no board open polled nothing: intake went days without a tick
 * while the process ran, and nothing said so. Running the server is now enough.
 * A vault that did not opt in gets its one line here and nowhere else — at
 * startup it answers "why is nothing polling", and on a request it is not news.
 */
export function pollAtStartup(
  roots: string[],
  onAttention: (root: string, notes: { id: string; title: string }[]) => void = () => {},
): void {
  for (const root of roots) {
    if (startPolling(root, (notes) => onAttention(root, notes))) continue;
    const { poll } = settingsFor(root);
    info(
      'intake',
      `${basename(root)} not polling — ` +
        (poll.enabled ? 'the kernel block is off, so there is nothing to triage' : 'poll.enabled is off'),
    );
  }
}

/** Stop polling one vault, or all of them. Used by tests and by shutdown. */
export function stopPolling(root?: string): void {
  for (const [key, cancel] of loops) {
    if (root && key !== root) continue;
    cancel();
    loops.delete(key);
  }
}
