import { advance } from '../intake/run.ts';
import { materialise } from '../intake/materialise.ts';
import { settingsFor } from '../settings.ts';
import { sweep } from '../intake/run.ts';

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
 * **It does not make the queue quiet, and nothing here pretends otherwise.**
 * Every session and every commit becomes a note, because deciding that one of them
 * does not matter is a judgement and there is not one in this file. See
 * `docs/NEXT.md` — the half that judges is the next piece, and until it exists a
 * vault turning this on is asking for everything it did, written down.
 */

export interface PollResult {
  vault: string;
  created: string[];
  /** Already in the vault, or already answered for. */
  skipped: number;
  /** Channels that could not be reached this tick, with the reason. */
  unreachable: { channel: string; reason: string }[];
  advanced: string[];
}

/**
 * One tick for one vault. Exported so a test can run it without a timer, which is
 * the only way to assert what a loop does without waiting for it.
 */
export async function pollOnce(root: string): Promise<PollResult> {
  const out: PollResult = { vault: root, created: [], skipped: 0, unreachable: [], advanced: [] };
  const { reports } = await sweep(root);

  for (const report of reports) {
    if (!report.fetched) {
      // Slack and Gmail every tick, by design — they have no credential here and
      // are fetched by an agent through MCP. A failing channel lands here too,
      // since `collectSafely` gives a thrown collect the same shape.
      out.unreachable.push({ channel: report.channel, reason: report.reason ?? 'not fetched here' });
      continue;
    }
    const res = materialise(root, report);
    out.created.push(...res.created);
    out.skipped += res.skipped;
  }

  /**
   * Advance only the channels this tick actually resolved.
   *
   * A channel that could not be reached recorded a pending cursor of null, so it
   * has nothing to promote and `advance` skips it — but naming them explicitly
   * says the intent rather than relying on that. `captured` is the count of notes
   * written, which for once is knowable: unlike `pj add` from a conversation,
   * this run wrote them and can attribute them.
   */
  for (const report of reports) {
    if (!report.fetched) continue;
    const moved = advance(root, { channel: report.channel, captured: out.created.length });
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
export function startPolling(root: string, log: (msg: string) => void = () => {}): boolean {
  if (timers.has(root)) return true;
  const { poll } = settingsFor(root);
  if (!poll.enabled) return false;

  const tick = async () => {
    try {
      const res = await pollOnce(root);
      if (res.created.length) log(`intake: ${res.created.length} new in ${root}`);
      for (const u of res.unreachable) {
        // Not an error and not silent. A channel that has been unreachable for a
        // week is worth noticing, and a poller that swallowed it would look like
        // a quiet channel — the reading the sweep is careful never to produce.
        log(`intake: ${u.channel} not fetched — ${u.reason}`);
      }
    } catch (e) {
      // A tick that throws must not stop the timer: the next one may well work,
      // and a poller that dies on one bad sweep is worse than one that is noisy.
      log(`intake: tick failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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
