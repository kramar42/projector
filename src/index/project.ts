import type { Kind, ProjectRepo, Rec, ResolvedProject } from '../schema/types.ts';
import { resolvePath } from '../config.ts';

/**
 * Card or node, from the `kind` facet.
 *
 * A derived accessor, like `isProject` — the value is stored as an ordinary
 * facet so it filters and groups through the one code path, and this is just the
 * convenient way to ask. `parseCard` guarantees the facet is present, so the
 * fallback here only covers records built in memory.
 */
export function kindOf(rec: Pick<Rec, 'facets'>): Kind {
  return rec.facets.kind?.[0] === 'node' ? 'node' : 'card';
}

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

/** Union, nearest last. A nested project needs its parent's repos plus its own. */
function mergeRepos(inherited: ProjectRepo[], own: ProjectRepo[], base: string): ProjectRepo[] {
  const norm = (r: ProjectRepo) => ({ ...r, path: resolvePath(r.path, base) });
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
 * Every record carrying a `project:` block, keyed by its id.
 *
 * A project's key *is* its record id. There is no separate `key` field: the
 * `project` facet stores record ids like every other reference in the model, so
 * membership, the canvas and the roll-ups all address the same name.
 */
export function projectRecords(byId: Map<string, Rec>): Map<string, Rec> {
  const out = new Map<string, Rec>();
  for (const rec of byId.values()) {
    if (rec.project) out.set(rec.id, rec);
  }
  return out;
}

/** The project keys a record belongs to. Membership is the facet, nothing else. */
export function projectsOf(rec: Rec): string[] {
  return rec.facets.project ?? [];
}

/**
 * Resolve a record's effective project config from its `project` facet.
 *
 * Membership is the facet and only the facet — parent edges are decomposition and
 * carry no config. A record may belong to several projects, so the chain is
 * walked for each and the results merged with the same rules that already apply
 * within one chain: `repos` union, `instructions` concatenate outermost-first so
 * the most specific advice reads last, and other keys take the nearest value.
 *
 * Returns null when the record names no project that exists.
 */
export function resolveProject(
  id: string,
  byId: Map<string, Rec>,
  dataRoot: string,
): ResolvedProject | null {
  const rec = byId.get(id);
  if (!rec) return null;
  const registry = projectRecords(byId);

  // Outermost-first order across every project the record belongs to, so
  // instructions read general → specific and repos accumulate the same way.
  const order: Rec[] = [];
  const seen = new Set<string>();

  const walk = (key: string, trail: Set<string>) => {
    const owner = registry.get(key);
    if (!owner || trail.has(key)) return;
    trail.add(key);
    // Ancestors first: a project's own project is more general than it is.
    for (const up of projectsOf(owner)) walk(up, trail);
    if (!seen.has(owner.id)) {
      seen.add(owner.id);
      order.push(owner);
    }
  };

  // A project record is its own innermost context, then whatever it belongs to.
  const roots = rec.project ? [...projectsOf(rec), rec.id] : projectsOf(rec);
  for (const key of roots) walk(key, new Set());

  if (!order.length) return null;

  let repos: ProjectRepo[] = [];
  const instructions: string[] = [];
  const chain: string[] = [];
  let key: string | undefined;
  let jira: string | undefined;
  let branch: string | undefined;

  for (const owner of order) {
    const p = owner.project!;
    chain.push(owner.id);
    repos = mergeRepos(repos, p.repos ?? [], dataRoot);
    key = owner.id;
    if (p.jira) jira = p.jira;
    if (p.branch) branch = p.branch;
    const ins = extractInstructions(owner.body);
    if (ins) instructions.push(`<!-- from ${owner.id} -->\n${ins}`);
  }

  return { key: key ?? id, repos, jira, branch, instructions, chain };
}
