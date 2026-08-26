import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ProjectRepo } from '../schema/types.ts';

/**
 * Multi-repo worktree workspaces.
 *
 * Five of the details here were
 * bugs they had already paid for — each is commented where it applies. The
 * workspace lives outside every repository, so there is nothing to git-exclude.
 */

export interface RepoResult {
  name: string;
  path: string;
  created: boolean;
  error: string | null;
}

type Git = (args: string[], cwd?: string) => { ok: boolean; out: string; err: string };

export const realGit: Git = (args, cwd) => {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out), err: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
};

/** The branch a new worktree starts from: declared, else origin/HEAD, else HEAD. */
/**
 * The revision a new worktree branches from — `git worktree add -b <branch> <base>`.
 *
 * A *revision*, so `origin/main` keeps its prefix: branching from the remote tip
 * is the point. `intake/git.ts` asks a different question of the same repo — which
 * local branch name is the base, for comparing against `git branch` output — and
 * its answer strips the prefix. Both are right; a comment there used to claim they
 * were the same rule.
 */
export function worktreeBase(repo: ProjectRepo, git: Git): string {
  if (repo.base) return repo.base;
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo.path);
  if (head.ok && head.out.trim()) return head.out.trim();
  const local = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo.path);
  return local.out.trim() || 'HEAD';
}

/**
 * Add one repo's worktree. Never throws: a failure is part of the result, so one
 * unavailable repo does not stop the others.
 */
export function addWorktree(
  repo: ProjectRepo,
  workspace: string,
  branch: string,
  git: Git,
): RepoResult {
  const name = basename(repo.path);
  const target = join(workspace, name);

  if (!existsSync(repo.path)) {
    return { name, path: target, created: false, error: `repo not found at ${repo.path}` };
  }

  // Prune unconditionally, including when the folder is already there. Without
  // this, deleting a finished workspace by hand — ordinary housekeeping — leaves
  // the repo believing the worktree exists, and reopening fails with
  // "missing but already registered worktree".
  git(['worktree', 'prune'], repo.path);

  // An existing folder means this workspace was already prepared: reopening is
  // idempotent rather than an error.
  if (existsSync(target)) return { name, path: target, created: false, error: null };

  const exists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo.path).ok;
  const res = exists
    ? git(['worktree', 'add', target, branch], repo.path)
    : git(['worktree', 'add', target, '-b', branch, worktreeBase(repo, git)], repo.path);

  if (!res.ok) {
    const detail = (res.err.trim() || res.out.trim()).slice(0, 400);
    return { name, path: target, created: false, error: `git worktree add failed: ${detail}` };
  }
  return { name, path: target, created: true, error: null };
}

export function prepareWorkspace(
  workspace: string,
  repos: ProjectRepo[],
  branch: string,
  git: Git = realGit,
): RepoResult[] {
  mkdirSync(workspace, { recursive: true });
  return repos.map((r) => addWorktree(r, workspace, branch, git));
}

/**
 * Escape a string for an AppleScript double-quoted literal.
 *
 * Shell quoting alone is not enough: `shlex`-style quoting of a string
 * containing an apostrophe emits a double quote, which would end the
 * AppleScript literal early. Escape backslashes and double quotes on top of it.
 */
export function appleScriptQuote(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Single-quote for the shell, the POSIX way. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function terminalScript(workspace: string, prompt: string): string {
  const cmd = `cd ${shellQuote(workspace)} && claude ${shellQuote(prompt)}`;
  return [
    'tell application "Terminal"',
    '\tactivate',
    `\tdo script "${appleScriptQuote(cmd)}"`,
    'end tell',
  ].join('\n');
}

/** Branch name for a card: the project's template, a lone Jira key, else the id. */
export function branchFor(
  cardId: string,
  opts: { template?: string; jiraKeys?: string[] },
): string {
  if (opts.template) return opts.template.replace(/\{card\}/g, cardId).replace(/\{id\}/g, cardId);
  if (opts.jiraKeys?.length === 1) return opts.jiraKeys[0]!;
  return cardId;
}

export { workspacePath } from './workspaceName.ts';
