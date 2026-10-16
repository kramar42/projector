import { execFileSync } from 'node:child_process';

/**
 * Read-only git, for what a repository says about itself: where its origin is
 * and which branch is its base. `git` is called with an argument array — no
 * shell — and only ever to read. Shared by `pj did` and intake's triage, which
 * both turn a commit into a link.
 */

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

/** `ORG/repo` from the origin URL, for a `gh:` link. Null when there is no remote. */
export function originSlug(repo: string): string | null {
  const url = git(repo, ['remote', 'get-url', 'origin'])?.trim();
  if (!url) return null;
  const m = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1]! : null;
}

/**
 * The base's *local branch name*: `origin/HEAD` without its remote prefix, else
 * the checked-out branch, else `main`. Bare, because it is compared with branch
 * names a commit carries, which never have one.
 */
export function localBaseName(repo: string): string {
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  if (head) return head.replace(/^origin\//, '');
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || 'main';
}
