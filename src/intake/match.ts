import { basename, resolve } from 'node:path';
import { resolvePath } from '../config.ts';
import { search } from '../index/queries.ts';
import type { Evidence, IntakeContext, Match } from './types.ts';
import { fromWorkspacePath, slugBranch } from '../agent/workspaceName.ts';

/**
 * Mechanical evidence for "is this more work on something already tracked".
 *
 * Every function here answers with a *reason*, never a score: a session in a
 * project's repo is a fact, a title sharing four words with a note is a fact, and
 * neither is a verdict. Turning facts into "link it to that note" is a judgement
 * the `/capture` skill makes, out loud, on evidence it can quote.
 *
 * Deliberately not a similarity model. The one thing that would make this
 * unusable is a confident wrong answer — a session linked to the wrong note puts
 * its history somewhere nobody will look for it.
 */

/** Every repo any project note declares, with the project it came from. */
export function repoIndex(ctx: IntakeContext): { path: string; name: string; project: string }[] {
  const out: { path: string; name: string; project: string }[] = [];
  const seen = new Set<string>();
  for (const rec of ctx.notes.values()) {
    for (const r of rec.project?.repos ?? []) {
      const path = resolve(resolvePath(r.path, ctx.root));
      const key = `${rec.id}\0${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path, name: basename(path), project: rec.id });
    }
  }
  return out;
}

function titleOf(ctx: IntakeContext, id: string): string {
  return ctx.notes.get(id)?.title ?? id;
}

function push(into: Match[], ctx: IntakeContext, id: string, why: string): void {
  if (!ctx.notes.has(id)) return;
  if (into.some((m) => m.id === id)) return;
  into.push({ id, title: titleOf(ctx, id), why });
}



/** Notes reachable from a working directory: its worktree's project, or a repo's. */
export function matchCwd(ctx: IntakeContext, cwd: string | undefined): Match[] {
  if (!cwd) return [];
  const here = resolve(cwd);
  const out: Match[] = [];

  const ws = fromWorkspacePath(here);
  if (ws) {
    push(out, ctx, ws.project, 'worktree');
    // The branch half names the note in the common case, since `branchFor`
    // falls back to the note id.
    for (const rec of ctx.notes.values()) {
      if (slugBranch(rec.id) === ws.branchSlug) push(out, ctx, rec.id, 'worktree branch');
    }
  }

  // Longest path first, so a repo nested inside another attributes to the inner one.
  for (const repo of repoIndex(ctx).sort((a, b) => b.path.length - a.path.length)) {
    if (here === repo.path || here.startsWith(repo.path + '/')) push(out, ctx, repo.project, 'cwd');
  }
  return out;
}

const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/** Notes a branch name points at: one named after a note, or after a Jira key a note links. */
export function matchBranch(ctx: IntakeContext, branch: string | undefined): Match[] {
  if (!branch) return [];
  const out: Match[] = [];
  const segments = branch.split('/');

  for (const rec of ctx.notes.values()) {
    if (rec.id === branch || segments.includes(rec.id)) push(out, ctx, rec.id, 'branch');
  }
  for (const key of branch.toUpperCase().match(JIRA_KEY) ?? []) {
    for (const id of ctx.links.get(`jira:${key}`) ?? []) push(out, ctx, id, `branch names ${key}`);
  }
  return out;
}

/** Notes linking a Jira key mentioned in free text — a commit message, a prompt. */
export function matchJiraKeys(ctx: IntakeContext, text: string | undefined): Match[] {
  if (!text) return [];
  const out: Match[] = [];
  for (const key of text.toUpperCase().match(JIRA_KEY) ?? []) {
    for (const id of ctx.links.get(`jira:${key}`) ?? []) push(out, ctx, id, `mentions ${key}`);
  }
  return out;
}

/**
 * Words too common in this vault to distinguish two notes. Not a general
 * stopword list — the point is only to stop an FTS query being carried by "the",
 * "fix" and "work".
 */
const NOISE = new Set(
  ('the a an and or but for with without from into onto of to in on at by is are was were be been' +
    ' this that these those it its as if then than so we i you he she they them my our your' +
    ' do does did done doing make makes made let lets please can could should would will just' +
    ' not no yes ok okay now also very really more most some any all what which who how why when' +
    ' add adds added fix fixes fixed update updates updated change changes changed check checks' +
    ' work works working use uses used need needs needed want wants like get gets got run runs' +
    ' file files code line lines thing things stuff good bad new old first last next').split(/\s+/),
);

/**
 * An FTS5 query from arbitrary text.
 *
 * Every token is quoted: an opening prompt contains apostrophes, colons, dashes
 * and parentheses, all of which are operators to FTS5, and a syntax error here
 * would take out the whole sweep rather than one match. Returns null when nothing
 * distinctive survives — a query of pure noise matches everything, which is worse
 * than matching nothing.
 */
export function ftsOverlapQuery(text: string, maxTokens = 12): string | null {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || NOISE.has(raw)) continue;
    if (tokens.includes(raw)) continue;
    tokens.push(raw);
    if (tokens.length >= maxTokens) break;
  }
  return tokens.length < 2 ? null : tokens.map((t) => `"${t}"`).join(' OR ');
}

/** Notes whose text overlaps this text, by the vault's own full-text index. */
export function matchText(ctx: IntakeContext, text: string | undefined, limit = 2): Match[] {
  if (!text) return [];
  const q = ftsOverlapQuery(text);
  if (!q) return [];
  try {
    return search(ctx.db, q, limit).map((r) => ({ id: r.id, title: r.title, why: 'text' }));
  } catch {
    // A query FTS5 still refuses is a missing match, not a failed sweep.
    return [];
  }
}

/**
 * Assemble the evidence for one candidate.
 *
 * `matches` is ordered by how mechanical the reason is — a working directory
 * inside a project's repo is nearly proof, shared vocabulary is nearly nothing —
 * so the first entry is the one to argue with.
 */
export function evidenceFor(
  ctx: IntakeContext,
  opts: { fingerprint: string; links?: string[]; cwd?: string; branch?: string; text?: string },
): Evidence {
  const linkedTo = [...new Set((opts.links ?? []).flatMap((l) => ctx.links.get(l) ?? []))];
  const capturedAs = ctx.fingerprints.get(opts.fingerprint) ?? [];

  const matches: Match[] = [];
  for (const m of [
    ...matchCwd(ctx, opts.cwd),
    ...matchBranch(ctx, opts.branch),
    ...matchJiraKeys(ctx, opts.text),
    // Last and fewest. Shared vocabulary is the weakest reason on the list — two
    // is enough to notice a real overlap and few enough that it cannot bury the
    // mechanical matches above it.
    ...matchText(ctx, opts.text),
  ]) {
    if (!matches.some((x) => x.id === m.id)) matches.push(m);
  }

  const ev: Evidence = {};
  if (linkedTo.length) ev.linkedTo = linkedTo;
  if (capturedAs.length) ev.capturedAs = capturedAs;
  if (matches.length) ev.matches = matches;
  return ev;
}
