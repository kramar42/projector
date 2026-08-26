import { join, resolve } from 'node:path';

/**
 * How a workspace directory is named, and how to read one back.
 *
 * `pj work` names a workspace `<project>-wt-<branch>`, so a working directory
 * inside one says which project and which branch without reading anything —
 * which is how the intake sweep recognises a Claude session as work on a note.
 *
 * Both halves are here because they were not. `worktree.ts` encoded and
 * `intake/match.ts` decoded, each holding its own copy of the character class,
 * joined only by a comment restating the format in prose. The tell was that
 * `test/intake.test.ts` already imported `workspacePath` from `agent/` — the test
 * crossed the boundary the source refused to, so two test files asserted the same
 * string format independently.
 */

/**
 * A branch may contain slashes; a directory name may not. Anything outside the
 * safe set collapses to a single `-`, which is lossy on purpose: the slug is a
 * label to match on, never something to reverse.
 */
export function slugBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function workspacePath(parent: string, projectKey: string, branch: string): string {
  return join(parent, `${projectKey}-wt-${slugBranch(branch)}`);
}

const WORKSPACE = /^(.+)-wt-(.+)$/;

/**
 * The project and branch slug a path is inside, or null.
 *
 * Walks outward from the deepest segment, so a repo checked out *inside* a
 * workspace still answers. The branch comes back slugged rather than restored, so
 * a caller compares it against `slugBranch(candidate)` rather than the branch.
 */
export function fromWorkspacePath(cwd: string): { project: string; branchSlug: string } | null {
  for (const seg of resolve(cwd).split('/').reverse()) {
    const m = WORKSPACE.exec(seg);
    if (m) return { project: m[1]!, branchSlug: m[2]! };
  }
  return null;
}
