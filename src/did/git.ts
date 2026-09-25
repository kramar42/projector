import { execFileSync } from 'node:child_process';
import { originSlug } from '../intake/git.ts';
import { settingsFor } from '../settings.ts';
import type { IntakeContext } from '../intake/types.ts';
import { within, type Day } from './day.ts';
import { notesFor, type Scope } from './scope.ts';
import type { Activity, SourceReport } from './types.ts';

/**
 * Your commits on the day, in every repo in scope.
 *
 * Differs from the intake channel on purpose. Intake reads local branches only,
 * because a remote branch carrying one of your commits is not work *in flight*;
 * here it is still work *done*, and a branch deleted after its PR merged is
 * exactly where yesterday's commits went. So remotes count, and the same commit
 * reached through two clones or a worktree is one commit.
 *
 * **The author date decides the day.** A rebase or a cherry-pick rewrites the
 * committer date; it does not make the work happen again. `--since` still filters
 * on the committer date, which is never earlier than the author's, so it can only
 * over-fetch — the window is applied to the author date below.
 */

const REC = '\u001e';
const FIELD = '\u001f';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export interface RawCommit {
  sha: string;
  date: string;
  subject: string;
  body: string;
  /** The ref the commit was reached through, as `--source` names it. */
  ref: string;
}

export function parseCommits(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const rec of out.split(REC)) {
    const trimmed = rec.replace(/^\n+/, '');
    if (!trimmed) continue;
    const [sha, date, subject, body, ref] = trimmed.split(FIELD);
    if (!sha || !date) continue;
    commits.push({ sha, date, subject: subject ?? '', body: (body ?? '').trim(), ref: (ref ?? '').trim() });
  }
  return commits;
}

/** A branch name from a `--source` ref: `refs/remotes/origin/feat/x` → `feat/x`. */
export function branchOf(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '');
}

/**
 * The lines of a commit body worth a reader's time: prose, not trailers, and
 * not the whole essay.
 */
function bodyLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[A-Z][A-Za-z-]+: /.test(l))
    .slice(0, 3)
    .map((l) => (l.length > 160 ? l.slice(0, 157) + '…' : l));
}

export function gitSource(ctx: IntakeContext, scope: Scope, day: Day): SourceReport {
  const configured = settingsFor(ctx.root).gitAuthor;
  const seen = new Set<string>();
  const activities: Activity[] = [];
  const unreadable: string[] = [];

  for (const repo of scope.repos) {
    const author = configured ?? git(repo.path, ['config', 'user.email'])?.trim();
    if (!author) {
      unreadable.push(`${repo.name} (no user.email)`);
      continue;
    }
    const out = git(repo.path, [
      'log',
      '--branches',
      '--remotes',
      '--source',
      '--no-merges',
      `--author=${author}`,
      `--since=${day.start.toISOString()}`,
      '--date=iso-strict',
      `--format=${REC}%H${FIELD}%aI${FIELD}%s${FIELD}%b${FIELD}%S`,
    ]);
    if (out === null) {
      unreadable.push(repo.name);
      continue;
    }
    const slug = originSlug(repo.path);
    for (const c of parseCommits(out)) {
      if (!within(c.date, day)) continue;
      // A cherry-pick is a new sha for the same work; the author date and
      // subject together are what it keeps.
      const twin = `${c.date}\u0000${c.subject}`;
      if (seen.has(c.sha) || seen.has(twin)) continue;
      seen.add(c.sha);
      seen.add(twin);
      const branch = branchOf(c.ref);
      activities.push({
        source: 'git',
        at: c.date,
        kind: 'commit',
        title: c.subject,
        ref: slug ? `gh:commit:${slug}@${c.sha}` : `${repo.name}@${c.sha.slice(0, 10)}`,
        where: branch ? `${repo.name} @ ${branch}` : repo.name,
        detail: bodyLines(c.body),
        notes: notesFor(ctx, { cwd: repo.path, branch, text: `${c.subject}\n${c.body}` }),
      });
    }
  }
  activities.sort((a, b) => a.at.localeCompare(b.at));
  return {
    source: 'git',
    fetched: true,
    reason: unreadable.length ? `could not read ${unreadable.join(', ')}` : undefined,
    activities,
  };
}
