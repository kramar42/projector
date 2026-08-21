import { listTranscripts, liveById, summarise } from '../sources/claude.ts';
import { ago } from '../sources/run.ts';
import { evidenceFor } from './match.ts';
import type { Candidate, Channel, ChannelReport, Skipped } from './types.ts';

/**
 * Claude sessions that moved since the last sweep.
 *
 * The channel that most needs the three-way answer, because most sessions are
 * not work: a session can be work already tracked (link it), work nobody has
 * filed (a card), or a question asked and answered (neither). Only the first is
 * decidable here — a uuid already on a card is a fact — so the other two arrive
 * as evidence and the skill chooses between them.
 *
 * Cheap by construction: `listTranscripts` stats the directory and opens nothing.
 * Only what survives the window and the turn threshold gets parsed.
 */

/**
 * Sessions with fewer real turns than this are noise — a one-shot question, a
 * `--resume` that was abandoned, an accidental launch. Below the line they are
 * reported as skipped rather than dropped, so a sweep never looks like it saw
 * less than it did.
 */
const MIN_TURNS = 3;

/**
 * Whether a transcript's mtime is lying about activity.
 *
 * Its own function so the rule is testable without a home directory: the channel
 * reads the real `~/.claude`, which a unit test has no business constructing.
 */
export function touchedButIdle(lastAt: string | undefined, since: Date): boolean {
  if (!lastAt) return false;
  const t = Date.parse(lastAt);
  return Number.isFinite(t) && t < since.getTime();
}

export const claudeChannel: Channel = {
  name: 'claude',
  defaultDays: 7,

  collect(ctx): ChannelReport {
    const live = liveById();
    // Oldest first: the cursor has to advance monotonically, so a truncated run
    // must stop at a boundary with nothing older left behind it. See `run.ts`.
    const transcripts = listTranscripts({ since: ctx.since }).reverse();
    const candidates: Candidate[] = [];
    const skipped: Skipped[] = [];
    let examinedTo: string | null = null;
    let truncated = false;

    for (const t of transcripts) {
      if (candidates.length >= ctx.limit) {
        truncated = true;
        break;
      }
      // The cursor covers everything looked at, including what is skipped: a
      // session declined for being two turns long should not be re-offered
      // tomorrow for being two turns long.
      examinedTo = t.modifiedAt;

      const fingerprint = `claude:${t.uuid}`;
      const linkedTo = ctx.links.get(fingerprint) ?? [];
      const s = live.get(t.uuid);

      if (linkedTo.length) {
        skipped.push({
          fingerprint,
          title: s?.name ?? t.uuid.slice(0, 8),
          why: `already linked from ${linkedTo.join(', ')}`,
        });
        continue;
      }

      const sum = summarise(t.file);

      // mtime found it; the transcript decides whether anything happened.
      //
      // Discovery has to be mtime — it runs over every transcript there has
      // ever been and must not open any of them — but a file's mtime moves for
      // reasons that are not activity: something rewrote 8 of these in three
      // seconds on one afternoon, resurfacing sessions finished a month
      // earlier. The survivors are parsed anyway, so the real last timestamp is
      // already in hand and costs nothing to believe over the filesystem's.
      if (touchedButIdle(sum.lastAt, ctx.since)) {
        skipped.push({
          fingerprint,
          title: sum.opening || t.uuid.slice(0, 8),
          why: `file touched ${t.modifiedAt.slice(0, 10)}, but no activity since ${sum.lastAt?.slice(0, 10)}`,
        });
        continue;
      }

      if (sum.turns < MIN_TURNS) {
        skipped.push({
          fingerprint,
          title: sum.opening || t.uuid.slice(0, 8),
          why: `${sum.turns} turn(s) — below the threshold for work`,
        });
        continue;
      }

      candidates.push({
        channel: 'claude',
        fingerprint,
        title: sum.opening || `session ${t.uuid.slice(0, 8)}`,
        links: [fingerprint],
        when: sum.lastAt ?? t.modifiedAt,
        detail: [sum.cwd, sum.branch].filter(Boolean).join(' @ '),
        fields: [
          { k: 'turns', v: String(sum.turns) },
          { k: 'last', v: ago(sum.lastAt ?? t.modifiedAt) },
          { k: 'state', v: s?.alive ? 'running' : 'idle' },
          { k: 'cwd', v: sum.cwd ?? '' },
          { k: 'branch', v: sum.branch ?? '' },
        ].filter((f) => f.v),
        evidence: evidenceFor(ctx, {
          fingerprint,
          links: [fingerprint],
          cwd: sum.cwd,
          branch: sum.branch,
          text: sum.opening,
        }),
      });
    }

    return {
      channel: 'claude',
      cursor: ctx.cursor,
      nextCursor: examinedTo,
      fetched: true,
      truncated,
      candidates,
      skipped,
    };
  },
};
