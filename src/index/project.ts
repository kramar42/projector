import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProjectRepo, Note, ResolvedProject } from '../schema/types.ts';
import { paths, resolvePath } from '../config.ts';
import { adjacency, chains } from './refs.ts';


/** The file a project's instructions live in, beside its note. */
export const INSTRUCTIONS_FILE = 'AGENTS.md';

/**
 * How work on one project is done: `AGENTS.md` in the folder its note sits in.
 *
 * A file rather than a `project:` key, because instructions are the one piece of
 * a project's configuration that is *prose*, and prose in a YAML block scalar is
 * prose nobody edits. This is also the name every agent already opens without
 * being told to — which is the point of the change: a session that lands in
 * `platform/` with no `pj`, no index and no idea projector exists still reads the
 * rules it is meant to work under (C3, extended from one note to its folder).
 *
 * **The vault root is excluded.** A vault's own `AGENTS.md` is about the vault,
 * and letting it through here would attach it to every project note that happens
 * to sit at the root while attaching to no other note at all — inheritance along
 * the `project` facet, sourced from something that is not on the chain. Vault-wide
 * instructions are a separate question; see docs/NEXT.md.
 *
 * So a project that wants instructions is a project that is a folder. That is a
 * push rather than an accident: the folder is what makes the instructions
 * findable without this app, which is the only reason they left the frontmatter.
 */
function instructionsOf(owner: Note, dataRoot: string): string | null {
  const dir = dirname(owner.file);
  if (resolve(dir) === resolve(paths(dataRoot).notes)) return null;
  try {
    const text = readFileSync(join(dir, INSTRUCTIONS_FILE), 'utf8').trim();
    return text || null;
  } catch {
    return null; // absent is the ordinary case: most projects state no rules
  }
}


export function isProject(rec: Note): boolean {
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

/** The project keys a note belongs to. Membership is the facet, nothing else. */
export function projectsOf(rec: Note): string[] {
  return rec.facets.project ?? [];
}

/**
 * Resolve a note's effective project config from its `project` facet.
 *
 * Membership is the facet and only the facet — parent edges are decomposition and
 * carry no config. A note may belong to several projects, so every chain it sits
 * on is walked and the results merged into **one** outermost-first order rather
 * than concatenated chain by chain: `repos` union, `instructions` read general →
 * specific so the most specific advice reads last, and other keys take the
 * nearest value — which is now the last in that same order, and so the most
 * specific rather than whichever chain happened to be walked last.
 *
 * Returns null when the note names no project that exists.
 */
export function resolveProject(
  id: string,
  byId: Map<string, Note>,
  dataRoot: string,
): ResolvedProject | null {
  const rec = byId.get(id);
  if (!rec) return null;

  // The membership chains this note sits on, walked through the same
  // adjacency the focus control uses — so the config chain and the portfolio
  // canvas can never disagree about who belongs to whom.
  const adj = adjacency('project', byId);
  // A project note is its own innermost context, so it starts from itself;
  // anything else starts from the projects it names.
  const starts = rec.project ? [rec.id] : (rec.facets.project ?? []).filter((k) => byId.has(k));

  // Outermost-first, so instructions read general → specific and repos
  // accumulate the same way — across *every* chain at once rather than one chain
  // after another.
  //
  // Chain by chain was wrong the moment a note named two projects. Walking
  // `[a, note]` and then `[b, note]`, de-duplicating as it went, emitted
  // `a → note → b`: the note's own advice landed in the middle, and `b`'s
  // general rules read *after* the specific ones they were supposed to precede.
  // One parent hid it, because with one chain the two orders agree.
  //
  // A node's rank is its **longest** distance from a root, which is what makes
  // this a topological order: a project always reads before anything that names
  // it, on every path, and the shortest distance would not guarantee that. Ties
  // — two parents equally general — keep the order the note declared them in,
  // so the file is what decides and not the traversal.
  const rank = new Map<string, number>();
  const declared = new Map<string, number>();
  for (const start of starts) {
    for (const chain of chains(start, adj)) {
      [...chain].reverse().forEach((key, depth) => {
        rank.set(key, Math.max(rank.get(key) ?? 0, depth));
        if (!declared.has(key)) declared.set(key, declared.size);
      });
    }
  }
  const order: Note[] = [...rank.keys()]
    .sort((a, b) => rank.get(a)! - rank.get(b)! || declared.get(a)! - declared.get(b)!)
    .map((key) => byId.get(key))
    .filter((owner): owner is Note => owner?.project !== undefined);

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
    const ins = instructionsOf(owner, dataRoot);
    if (ins) instructions.push(`<!-- from ${owner.id} -->\n${ins}`);
  }

  return { key: key ?? id, repos, jira, branch, instructions, chain };
}
