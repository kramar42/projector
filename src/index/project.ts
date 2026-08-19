import type { ProjectRepo, Rec, ResolvedProject } from '../schema/types.ts';
import { resolvePath } from '../config.ts';

/** Parent ids of a record, in declaration order. A record may have several. */
export function parentsOf(rec: Rec): string[] {
  return rec.edges.filter((e) => e.type === 'parent').map((e) => e.to);
}

/**
 * Every ancestor chain from `id` up to a root, nearest-first.
 * Cycles are broken by refusing to revisit an id within the same chain, so a
 * malformed graph degrades instead of hanging.
 */
export function ancestorChains(id: string, byId: Map<string, Rec>): string[][] {
  const chains: string[][] = [];
  const walk = (cur: string, acc: string[]) => {
    if (acc.includes(cur)) {
      chains.push(acc);
      return;
    }
    const next = [...acc, cur];
    const rec = byId.get(cur);
    const parents = rec ? parentsOf(rec) : [];
    const live = parents.filter((p) => byId.has(p) && !next.includes(p));
    if (!live.length) {
      chains.push(next);
      return;
    }
    for (const p of live) walk(p, next);
  };
  walk(id, []);
  return chains;
}

/** The `## Instructions` section of a body, or '' when absent. */
export function extractInstructions(body: string): string {
  const m = body.match(/^##+\s+Instructions\s*$/im);
  if (!m || m.index === undefined) return '';
  const after = body.slice(m.index + m[0].length);
  const next = after.search(/^##\s+/m);
  return (next === -1 ? after : after.slice(0, next)).trim();
}

export function isProject(rec: Rec): boolean {
  return rec.project !== undefined;
}

function mergeRepos(inherited: ProjectRepo[], own: ProjectRepo[], replace: boolean, base: string): ProjectRepo[] {
  const norm = (r: ProjectRepo) => ({ ...r, path: resolvePath(r.path, base) });
  if (replace) return own.map(norm);
  const out = inherited.map(norm);
  const seen = new Set(out.map((r) => r.path));
  for (const r of own.map(norm)) {
    if (!seen.has(r.path)) {
      out.push(r);
      seen.add(r.path);
    }
  }
  return out;
}

/**
 * Resolve a record's effective project config by walking its parent chain
 * root-down and merging every `project:` block found.
 *
 * `repos` unions down the chain (a sub-project adds repos rather than
 * re-listing its parent's), `instructions` concatenate root-first so the most
 * specific advice reads last, and every other key takes the nearest value.
 * Returns null when no ancestor — including the record itself — is a project.
 */
export function resolveProject(
  id: string,
  byId: Map<string, Rec>,
  dataRoot: string,
): ResolvedProject | null {
  const chains = ancestorChains(id, byId);
  if (!chains.length) return null;

  // Prefer the chain carrying the most project records; ties go to the first declared.
  const scored = chains.map((c) => ({
    chain: c,
    projects: c.filter((cid) => {
      const r = byId.get(cid);
      return r ? isProject(r) : false;
    }),
  }));
  scored.sort((a, b) => b.projects.length - a.projects.length);
  const best = scored[0];
  if (!best || !best.projects.length) return null;

  // best.chain is nearest-first; merge root-down.
  const rootDown = [...best.chain].reverse();
  let repos: ProjectRepo[] = [];
  const instructions: string[] = [];
  const projectChain: string[] = [];
  let key: string | undefined;
  let jira: string | undefined;
  let branch: string | undefined;

  for (const cid of rootDown) {
    const rec = byId.get(cid);
    if (!rec?.project) continue;
    projectChain.push(cid);
    const p = rec.project;
    repos = mergeRepos(repos, p.repos ?? [], p.repos_replace === true, dataRoot);
    if (p.key) key = p.key;
    else key = key ?? cid;
    if (p.jira) jira = p.jira;
    if (p.branch) branch = p.branch;
    const ins = extractInstructions(rec.body);
    if (ins) instructions.push(`<!-- from ${cid} -->\n${ins}`);
  }

  const nearest = projectChain[projectChain.length - 1];
  const nearestRec = nearest ? byId.get(nearest) : undefined;
  return {
    key: nearestRec?.project?.key ?? nearest ?? key ?? id,
    repos,
    jira,
    branch,
    instructions,
    chain: projectChain,
  };
}

/**
 * The derived `project` facet: the nearest project record at or above a record.
 * `root` is the topmost project in the same chain, so a board can group at
 * either altitude without either being stored in a file.
 */
export function derivedProject(
  id: string,
  byId: Map<string, Rec>,
): { nearest: string | null; root: string | null } {
  const chains = ancestorChains(id, byId);
  for (const chain of chains) {
    const projects = chain.filter((cid) => {
      const r = byId.get(cid);
      return r ? isProject(r) : false;
    });
    if (projects.length) {
      const nearestId = projects[0]!;
      const rootId = projects[projects.length - 1]!;
      const keyOf = (cid: string) => byId.get(cid)?.project?.key ?? cid;
      return { nearest: keyOf(nearestId), root: keyOf(rootId) };
    }
  }
  return { nearest: null, root: null };
}
