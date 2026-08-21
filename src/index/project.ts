import type { Kind, ProjectRepo, Rec, ResolvedProject } from '../schema/types.ts';
import { resolvePath } from '../config.ts';
import { adjacency, chains } from './refs.ts';

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

/** What a record is part of. An ordinary reference facet, read by name. */
export function parentsOf(rec: Pick<Rec, 'facets'>): string[] {
  return rec.facets.parent ?? [];
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

  // The membership chains this record sits on, walked through the same
  // adjacency the focus control uses — so the config chain and the portfolio
  // canvas can never disagree about who belongs to whom.
  const adj = adjacency('project', byId);
  // A project record is its own innermost context, so it starts from itself;
  // anything else starts from the projects it names.
  const starts = rec.project ? [rec.id] : (rec.facets.project ?? []).filter((k) => byId.has(k));

  // Outermost-first, so instructions read general → specific and repos
  // accumulate the same way. A chain arrives nearest-first, hence the reverse.
  const order: Rec[] = [];
  const seen = new Set<string>();
  for (const start of starts) {
    for (const chain of chains(start, adj)) {
      for (const key of [...chain].reverse()) {
        const owner = byId.get(key);
        if (!owner?.project || seen.has(key)) continue;
        seen.add(key);
        order.push(owner);
      }
    }
  }

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
