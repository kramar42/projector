import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { evidenceFor, repoIndex } from './match.ts';
import type { Candidate, Channel, ChannelReport, Skipped } from './types.ts';

/**
 * His own commits in the project repos, with nothing tracking them.
 *
 * The unit is a **branch, not a commit.** Six commits on one branch are one piece
 * of work, and `git:<repo>@<sha>` per commit meant six cards and a fingerprint
 * that grew a seventh tomorrow. `git:<repo>@<branch>` is stable while the work
 * continues, so a sweep run again after three more commits finds the card it
 * already made.
 *
 * The exception is the base branch, where each commit stands alone: commits land
 * on `main` from unrelated pieces of work, and grouping them would produce one
 * candidate titled after whichever happened to be first.
 *
 * `git` is called with an argument array — no shell — and only ever to read.
 */

interface Commit {
  sha: string;
  date: string;
  subject: string;
  branch: string;
}

/**
 * A separator a commit subject cannot contain, written as an escape so it is
 * visible in the source. `execFile` refuses a NUL in an argument but not this,
 * so unlike `agent/history.ts` git needs no `%xNN` indirection to emit it.
 */
const FIELD = '\u001f';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The identity to filter on: the repo's own `user.email`, overridable. */
function authorFor(repo: string): string | null {
  if (process.env.PROJECTOR_GIT_AUTHOR) return process.env.PROJECTOR_GIT_AUTHOR;
  return git(repo, ['config', 'user.email'])?.trim() || null;
}

/**
 * The base's *local branch name*, for comparing against `git branch` output.
 *
 * Bare, so `origin/main` becomes `main`: the names this is compared with come from
 * `git branch --format=%(refname:short)`, which never carries a remote prefix.
 * `pj work` asks a different question — the revision to branch from — and keeps
 * the prefix. This comment used to claim they were the same rule; they are two
 * rules that happen to run the same two git commands.
 */
function localBaseName(repo: string): string {
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  if (head) return head.replace(/^origin\//, '');
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || 'main';
}

/** `ORG/repo` from the origin URL, for a `gh:` link. Null when there is no remote. */
export function originSlug(repo: string): string | null {
  const url = git(repo, ['remote', 'get-url', 'origin'])?.trim();
  if (!url) return null;
  const m = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1]! : null;
}

/**
 * Local branches only. `--all` would drag in every someone else's remote branch, and
 * the author filter is not enough on its own: a someone else's branch containing one
 * of his commits is not his work in flight.
 */
function commitsSince(repo: string, since: string, author: string): Commit[] {
  const out = git(repo, [
    'log',
    '--branches',
    '--no-merges',
    `--author=${author}`,
    `--since=${since}`,
    '--date=iso-strict',
    `--format=%H${FIELD}%aI${FIELD}%s${FIELD}%D`,
    '--reverse',
  ]);
  if (!out) return [];
  const commits: Commit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [sha, date, subject, decoration] = line.split(FIELD);
    if (!sha || !date) continue;
    commits.push({
      sha,
      date,
      subject: subject ?? '',
      // `%D` names the refs pointing *at this commit*; only the tip of a branch
      // carries one, so the branch is resolved separately below.
      branch: (decoration ?? '')
        .split(', ')
        .map((d) => d.replace(/^HEAD -> /, ''))
        .find((d) => d && !d.startsWith('tag: ') && !d.startsWith('origin/')) ?? '',
    });
  }
  return commits;
}

/** Which local branches contain a commit. The tip decoration only covers tips. */
function branchesContaining(repo: string, sha: string): string[] {
  const out = git(repo, ['branch', '--format=%(refname:short)', '--contains', sha]);
  return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

export const gitChannel: Channel = {
  name: 'git',
  defaultDays: 7,

  collect(ctx): ChannelReport {
    // One entry per path: `repoIndex` reports a repo once per project that
    // declares it — which is what cwd matching wants and would make this scan
    // `staging` twice, since both `project-a` and `mapping` name it.
    const repos = [...new Map(repoIndex(ctx).map((r) => [r.path, r])).values()];
    const candidates: Candidate[] = [];
    const skipped: Skipped[] = [];
    let examinedTo: string | null = null;
    let truncated = false;
    const missing: string[] = [];

    if (!repos.length) {
      return {
        channel: 'git',
        cursor: ctx.cursor,
        nextCursor: null,
        fetched: true,
        reason: 'no project note declares any repos, so there is nothing to sweep',
        candidates,
        skipped,
      };
    }

    const since = ctx.since.toISOString();
    // One entry per (repo, branch), so a branch accumulates its commits.
    const groups = new Map<string, { repo: string; name: string; branch: string; commits: Commit[] }>();
    const loose: { repo: string; name: string; commit: Commit }[] = [];

    for (const repo of repos) {
      if (!existsSync(repo.path)) {
        missing.push(repo.path);
        continue;
      }
      const author = authorFor(repo.path);
      if (!author) {
        missing.push(`${repo.path} (no git user.email)`);
        continue;
      }
      const base = localBaseName(repo.path);
      for (const c of commitsSince(repo.path, since, author)) {
        if (!examinedTo || c.date > examinedTo) examinedTo = c.date;
        const branch = c.branch || branchesContaining(repo.path, c.sha).find((b) => b !== base) || base;
        if (branch === base) {
          loose.push({ repo: repo.path, name: repo.name, commit: { ...c, branch } });
          continue;
        }
        const key = `${repo.name}@${branch}`;
        const g = groups.get(key) ?? { repo: repo.path, name: repo.name, branch, commits: [] };
        g.commits.push(c);
        groups.set(key, g);
      }
    }

    const emit = (c: Candidate) => {
      if (candidates.length >= ctx.limit) {
        truncated = true;
        return;
      }
      const captured = c.evidence?.capturedAs ?? [];
      const linked = c.evidence?.linkedTo ?? [];
      if (captured.length || linked.length) {
        skipped.push({
          fingerprint: c.fingerprint,
          title: c.title,
          why: captured.length ? `already captured as ${captured.join(', ')}` : `already linked from ${linked.join(', ')}`,
        });
        return;
      }
      candidates.push(c);
    };

    // Branches first: a named branch is a piece of work, a commit on the base is
    // an event. Oldest branch first, by its earliest commit.
    const ordered = [...groups.values()].sort((a, b) =>
      (a.commits[0]?.date ?? '').localeCompare(b.commits[0]?.date ?? ''),
    );
    for (const g of ordered) {
      if (truncated) break;
      const slug = originSlug(g.repo);
      const fingerprint = `git:${g.name}@${g.branch}`;
      const links = slug ? [`gh:branch:${slug}@${g.branch}`] : [];
      const text = [g.branch, ...g.commits.map((c) => c.subject)].join(' ');
      emit({
        channel: 'git',
        fingerprint,
        title: g.commits[0]?.subject || g.branch,
        links,
        when: g.commits.at(-1)?.date,
        detail: `${g.name} @ ${g.branch} — ${g.commits.length} commit(s)`,
        fields: [
          { k: 'repo', v: g.name },
          { k: 'branch', v: g.branch },
          { k: 'commits', v: g.commits.map((c) => `${c.sha.slice(0, 8)} ${c.subject}`).join(' · ') },
        ],
        evidence: evidenceFor(ctx, { fingerprint, links, cwd: g.repo, branch: g.branch, text }),
      });
    }

    for (const l of loose.sort((a, b) => a.commit.date.localeCompare(b.commit.date))) {
      if (truncated) break;
      const slug = originSlug(l.repo);
      const fingerprint = `git:${l.name}@${l.commit.sha}`;
      const links = slug ? [`gh:commit:${slug}@${l.commit.sha}`] : [];
      emit({
        channel: 'git',
        fingerprint,
        title: l.commit.subject,
        links,
        when: l.commit.date,
        detail: `${l.name} @ ${l.commit.branch} — one commit on the base branch`,
        fields: [
          { k: 'repo', v: l.name },
          { k: 'sha', v: l.commit.sha.slice(0, 8) },
        ],
        evidence: evidenceFor(ctx, {
          fingerprint,
          links,
          cwd: l.repo,
          branch: l.commit.branch,
          text: l.commit.subject,
        }),
      });
    }

    return {
      channel: 'git',
      cursor: ctx.cursor,
      nextCursor: examinedTo,
      fetched: true,
      truncated,
      reason: missing.length ? `skipped ${missing.length} repo(s): ${missing.join(', ')}` : undefined,
      candidates,
      skipped,
    };
  },
};
