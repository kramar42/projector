import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { settingsFor } from '../settings.ts';
import { parseLink } from '../schema/links.ts';
import { repoIndex, matchBranch, matchCwd, matchJiraKeys } from '../intake/match.ts';
import type { IntakeContext } from '../intake/types.ts';
import type { VaultRead } from '../intake/run.ts';
import type { Activity } from './types.ts';

/**
 * What counts as work: the repos and directories whose traces `pj did` reads.
 *
 * Three explicit sources and no guessed folder. The repos project notes declare
 * and the workspaces notes recorded are what intake already trusts; `did.roots`
 * in the vault's config widens it to every repo under a directory, which is how
 * a workspace with forty repos and a dozen project notes gets all forty.
 */
export interface Scope {
  roots: string[];
  repos: { path: string; name: string }[];
}

/** Directories never worth descending into looking for a repo. */
const SKIP = new Set(['node_modules', 'target', 'dist', 'build', 'vendor']);

/**
 * Every git repo or worktree under a directory, not descending into one.
 *
 * Bounded by depth because a root is a person's workspace, not a filesystem:
 * four levels reaches `work/bluerock/tms/platform` and stops short of anything
 * a build tool made.
 */
export function reposUnder(dir: string, depth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    if (existsSync(join(d, '.git'))) {
      out.push(d);
      return;
    }
    if (left === 0) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.') || SKIP.has(e)) continue;
      const p = join(d, e);
      try {
        // statSync follows links, so a projection like `environments/` reaches
        // its targets; the path set below collapses the duplicates.
        if (statSync(p).isDirectory()) walk(p, left - 1);
      } catch {
        /* a dangling link is not a repo */
      }
    }
  };
  walk(resolve(dir), depth);
  return out;
}

export function scopeOf(vault: VaultRead): Scope {
  const settings = settingsFor(vault.root);
  const roots = new Set(settings.did.roots.map((r) => resolve(r)));
  if (settings.workspaces) roots.add(resolve(settings.workspaces));
  for (const raw of vault.links.keys()) {
    const link = parseLink(raw);
    if (link.kind === 'workspace') roots.add(resolve(link.ref.trim()));
  }
  const paths = new Set<string>();
  for (const r of repoIndex(ctxOf(vault))) paths.add(r.path);
  // A workspace inside a root is already covered by it, and listing both only
  // makes the scope line longer.
  const outer = [...roots].filter((r) => ![...roots].some((o) => o !== r && inside(r, o))).sort();
  for (const root of outer) for (const p of reposUnder(root)) paths.add(p);
  return {
    roots: outer,
    repos: [...paths].sort().map((path) => ({ path, name: basename(path) })),
  };
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** Whether a working directory is inside the scope — a root or a repo. */
export function inScope(scope: Scope, cwd: string | undefined): boolean {
  if (!cwd) return false;
  const here = resolve(cwd);
  // The app's own headless runs are not anybody's work (see intake/claude.ts).
  if (here.split(sep).includes('.projector')) return false;
  return scope.roots.some((r) => inside(here, r)) || scope.repos.some((r) => inside(here, r.path));
}

/** The matcher's context: the vault, read once. */
export function ctxOf(vault: VaultRead): IntakeContext {
  return { ...vault };
}

/**
 * Vault notes an activity is about, by the same mechanical reasons intake uses.
 *
 * Only the mechanical ones: a directory inside a project's repo, a branch named
 * for a note, a Jira key a note links. Shared vocabulary is left out — a daily
 * summary grouped under the wrong project is worse than one left ungrouped.
 */
export function notesFor(
  ctx: IntakeContext,
  opts: { cwd?: string; branch?: string; text?: string; links?: string[] },
): Activity['notes'] {
  const out: { id: string; why: string }[] = [];
  const add = (id: string, why: string) => {
    if (!out.some((n) => n.id === id)) out.push({ id, why });
  };
  for (const l of opts.links ?? []) for (const id of ctx.links.get(l) ?? []) add(id, `links ${l}`);
  for (const m of [
    ...matchCwd(ctx, opts.cwd),
    ...matchBranch(ctx, opts.branch),
    ...matchJiraKeys(ctx, opts.text),
  ]) {
    add(m.id, m.why);
  }
  return out.length ? out.slice(0, 4) : undefined;
}
