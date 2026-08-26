import { paths } from '../config.ts';
import { readAll } from '../index/indexer.ts';
import { isRef, loadFacets } from '../schema/facets.ts';
import { blockingEdges, isClosed } from '../index/blocking.ts';
import { resolveProject } from '../index/project.ts';
import { readCached } from '../server/enrich.ts';
import type { Note, ResolvedProject } from '../schema/types.ts';
import type { Resolved } from '../server/enrich.ts';

/**
 * Everything known about one note, assembled in one place.
 *
 * This is the layer the skills consume: instead of an agent re-deriving a note's
 * project, repos, instructions and link state by reading files, it asks once and
 * gets a complete, deterministic picture. Nothing here is a judgement — it is
 * assembly (C8).
 */
export interface NoteContext {
  id: string;
  title: string;
  isProject: boolean;
  file: string;
  facets: Record<string, string[]>;
  body: string;
  project: ResolvedProject | null;
  /**
   * What this note points at and what points back, keyed by relation.
   *
   * They were four fields — `parents`, `children`, `blocks` and the outbound half
   * of blocking — three of which named `parent` by reading `rec.facets.parent`.
   * So an agent briefing described a vault's decomposition only if that vault
   * happened to call it `parent`, and saw no other relation at all.
   *
   * `inbound` carries only the relations whose vocabulary named their other end,
   * the same rule the panel draws by: nothing computes an inverse it has no word
   * for.
   */
  refs: Record<string, Related>;
  inbound: Record<string, Related>;
  /** Notes that must finish before this one, and whether they have. */
  blockedBy: { id: string; title: string; done: boolean }[];
  /** Links with whatever enrichment is cached. Never fetches. */
  links: { raw: string; kind: string; ref: string; enrichment?: Resolved }[];
  /**
   * Notes sharing a container with this one.
   *
   * "Container" is any single-valued reference — one value is what makes a
   * sibling a sibling, and there is no second thing to be beside. It read
   * `parent` by name, which is the same rule with one vault's word for it.
   */
  siblings: { id: string; title: string }[];
}

/**
 * Notes along one relation, carrying the word for it.
 *
 * The label travels with the notes so `renderContext` stays a function of the
 * context alone — the context is the assembled picture, and the heading over a
 * list is part of the picture rather than something a renderer looks up.
 */
export interface Related {
  /** What this vault calls the relation, or its inverse for an inbound list. */
  label: string;
  /**
   * `done` is present only on a **blocking** relation, where whether the other
   * end is finished is the whole point of the list. There used to be a second
   * `## Blocked by` section rendering exactly that, so a note drew its blockers
   * twice — once under the facet's own label without their state, once under a
   * hardcoded heading with it.
   */
  notes: { id: string; title: string; done?: boolean }[];
}

const brief = (r: Note) => ({ id: r.id, title: r.title });

export function noteContext(id: string, dataRoot: string): NoteContext | null {
  const p = paths(dataRoot);
  const { notes } = readAll(p.notes);
  const facets = loadFacets(p.facets);
  const rec = notes.get(id);
  if (!rec) return null;

  const links = rec.links.map((l) => ({ raw: l.raw, kind: l.kind, ref: l.ref }));
  const enriched = readCached(dataRoot, links.map((l) => l.raw));
  const byRef = new Map(enriched.map((e) => [e.ref, e]));

  // Both directions at once, across every relation the vault declares blocking:
  // what this note is waiting on, and what is waiting on it.
  const adj = blockingEdges(notes, facets);
  const along = (m: Map<string, string[]>) =>
    (m.get(id) ?? []).map((n) => notes.get(n)).filter((r): r is Note => !!r);
  const blockers = along(adj.out);

  const relations = Object.entries(facets).filter(([, def]) => isRef(def));
  const resolve = (ids: string[]) =>
    ids.map((n) => notes.get(n)).filter((r): r is Note => !!r).map(brief);

  const refs: Record<string, Related> = {};
  const inbound: Record<string, Related> = {};
  for (const [via, def] of relations) {
    const out = resolve(rec.facets[via] ?? []).map((r) =>
      def.blocking ? { ...r, done: isClosed(notes.get(r.id), facets) } : r,
    );
    if (out.length) refs[via] = { label: def.label, notes: out };
    if (!def.inverse) continue;
    const naming = [...notes.values()].filter((r) => (r.facets[via] ?? []).includes(id));
    if (naming.length) inbound[via] = { label: def.inverse, notes: naming.map(brief) };
  }

  // Beside, not under: a sibling shares a container, and a container is what a
  // single-valued reference names.
  const beside = new Map<string, Note>();
  for (const [via, def] of relations) {
    if (!def.single) continue;
    const mine = rec.facets[via] ?? [];
    if (!mine.length) continue;
    for (const r of notes.values()) {
      if (r.id !== id && (r.facets[via] ?? []).some((v) => mine.includes(v))) beside.set(r.id, r);
    }
  }

  return {
    id: rec.id,
    title: rec.title,
    isProject: !!rec.project,
    file: rec.file.replace(p.root + '/', ''),
    facets: rec.facets,
    body: rec.body,
    project: resolveProject(id, notes, dataRoot),
    refs,
    inbound,
    blockedBy: blockers.map((r) => ({ ...brief(r), done: isClosed(r, facets) })),
    links: links.map((l) => ({ ...l, enrichment: byRef.get(l.raw) })),
    siblings: [...beside.values()].map(brief),
  };
}

/**
 * Notes a triage pass should look at, with the reason each one needs attention.
 * Deterministic, so a skill gets its worklist rather than inventing one.
 */
/** Render a context as markdown — what a briefing embeds and a human can read. */
export function renderContext(ctx: NoteContext): string {
  const L: string[] = [];
  L.push(`# ${ctx.title}`);
  L.push('');
  L.push(`- id: \`${ctx.id}\`${ctx.isProject ? '  ·  a project: it owns config its members inherit' : ''}`);
  L.push(`- file: \`${ctx.file}\``);
  const facets = Object.entries(ctx.facets)
    .map(([k, v]) => `${k}=${v.join(',')}`)
    .join('  ');
  if (facets) L.push(`- facets: ${facets}`);

  if (ctx.project) {
    L.push('');
    L.push('## Project config');
    L.push('');
    L.push(`- key: \`${ctx.project.key}\`  ·  chain: ${ctx.project.chain.join(' → ')}`);
    if (ctx.project.jira) L.push(`- jira project: \`${ctx.project.jira}\``);
    if (ctx.project.branch) L.push(`- branch template: \`${ctx.project.branch}\``);
    for (const r of ctx.project.repos) {
      L.push(`- repo: \`${r.path}\`${r.base ? ` (base \`${r.base}\`)` : ''}`);
    }
    if (ctx.project.instructions.length) {
      L.push('');
      L.push('### Project instructions');
      L.push('');
      L.push('These are inherited, outermost project first — the most specific advice reads last.');
      L.push('');
      for (const block of ctx.project.instructions) L.push(block);
    }
  } else {
    L.push('');
    L.push('> This note has no project, so it inherits no repos and no instructions.');
  }

  const rel = (label: string, items: { id: string; title: string; done?: boolean }[]) => {
    if (!items.length) return;
    L.push('');
    L.push(`## ${label}`);
    L.push('');
    // A tick only where finishing is the question — which is what `done` being
    // present means, and it is present only on a blocking relation.
    for (const i of items) {
      const mark = i.done === undefined ? '' : i.done ? '✓ ' : '✗ ';
      L.push(`- ${mark}${i.title}  \`${i.id}\``);
    }
  };
  // Headed by the vocabulary's own words, both ways round. It was four literal
  // headings, two of which only ever appeared in a vault calling its relation
  // `parent`.
  for (const r of Object.values(ctx.refs)) rel(r.label, r.notes);
  for (const r of Object.values(ctx.inbound)) rel(r.label, r.notes);

  if (ctx.links.length) {
    L.push('');
    L.push('## Links');
    L.push('');
    for (const l of ctx.links) {
      const d = l.enrichment?.data;
      if (d) {
        const badges = (d.badges ?? []).map((b) => b.label).join(', ');
        L.push(`- **${l.kind}** ${d.label}${badges ? ` [${badges}]` : ''} — ${d.title ?? ''}`);
        for (const f of d.fields ?? []) L.push(`  - ${f.k}: ${f.v}`);
        if (d.url) L.push(`  - url: ${d.url}`);
        if (d.command) L.push(`  - resume: \`${d.command}\``);
      } else {
        const why = l.enrichment?.error ?? l.enrichment?.reason ?? 'not resolved yet';
        L.push(`- **${l.kind}** \`${l.ref}\` — ${why}`);
      }
    }
  }

  if (ctx.body.trim()) {
    L.push('');
    L.push('## Note body');
    L.push('');
    L.push(ctx.body.trim());
  }
  return L.join('\n') + '\n';
}
