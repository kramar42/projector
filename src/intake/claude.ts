import { resolve, sep } from 'node:path';
import { listTranscripts, liveById, describeTranscript } from '../sources/claude.ts';
import { ago } from '../sources/run.ts';
import { parseLink } from '../schema/links.ts';
import { evidenceFor, repoIndex } from './match.ts';
import type { Candidate, Channel, ChannelReport, IntakeContext, Skipped } from './types.ts';

/**
 * Claude sessions that moved since the last sweep.
 *
 * The channel that most needs the three-way answer, because most sessions are
 * not work: a session can be work already tracked (link it), work nobody has
 * filed (a note), or a question asked and answered (neither). Only the first is
 * decidable here — a uuid already on a note is a fact — so the other two arrive
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

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

/**
 * Whether a session's directory makes it this vault's work.
 *
 * A machine's `~/.claude` holds every session ever run on it — personal
 * projects, one-off questions, and the app's own headless runs, which live under
 * a vault's `.projector`. None of that is this vault's work, and offering it
 * produced cards about a projector design discussion and about the relay's own
 * prompt. So a session counts only inside a repo some project note declares or a
 * workspace some note recorded (`workspace:` links); the app's own sessions are
 * named for what they are. Deterministic, and widened by declaring a repo.
 */
export function placeOf(
  cwd: string | undefined,
  repos: string[],
  workspaces: string[],
): 'work' | 'app' | 'outside' | 'unknown' {
  if (!cwd) return 'unknown';
  const here = resolve(cwd);
  if (here.split(sep).includes('.projector')) return 'app';
  if (repos.some((r) => inside(here, r)) || workspaces.some((w) => inside(here, w))) return 'work';
  return 'outside';
}

function workspacesIn(ctx: IntakeContext): string[] {
  const out: string[] = [];
  for (const raw of ctx.links.keys()) {
    const link = parseLink(raw);
    if (link.kind === 'workspace') out.push(resolve(link.ref.trim()));
  }
  return out;
}

export const claudeChannel: Channel = {
  name: 'claude',
  defaultDays: 7,

  collect(ctx): ChannelReport {
    const live = liveById();
    const repos = repoIndex(ctx).map((r) => r.path);
    const workspaces = workspacesIn(ctx);
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

      // Before the transcript is opened and before it counts against the limit.
      // `sweep` would move a suppressed candidate to `skipped` anyway — but only
      // after this loop had counted it, so twenty-five declined sessions filled
      // the limit, every run reported itself truncated with nothing to show, and
      // the cursor never moved. Declining is what a reader does most; it must
      // not be what stalls the channel.
      if (ctx.suppressed.has(fingerprint)) {
        skipped.push({ fingerprint, title: s?.name ?? t.uuid.slice(0, 8), why: 'suppressed earlier' });
        continue;
      }

      // One read of the transcript, and the state comes with it. This used to be
      // `summarise` here and `sessionState(alive ?? false, lastTurn(file), …)`
      // below — the same assembly the enrichment fetcher also wrote out, each
      // opening the file twice.
      const found = describeTranscript(t, s ?? null);
      const sum = found.summary;

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

      const place = placeOf(sum.cwd, repos, workspaces);
      if (place !== 'work') {
        skipped.push({
          fingerprint,
          title: sum.opening || t.uuid.slice(0, 8),
          why:
            place === 'app'
              ? 'the app’s own session, under a .projector directory'
              : place === 'unknown'
                ? 'no working directory recorded'
                : `${sum.cwd} is outside every declared repo and recorded workspace`,
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
          { k: 'state', v: found.state },
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
