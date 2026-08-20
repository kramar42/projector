import { paths } from '../config.ts';
import { readAll } from '../index/indexer.ts';
import { parentsOf, resolveProject } from '../index/project.ts';
import { readCached } from '../server/enrich.ts';
import type { Rec, ResolvedProject } from '../schema/types.ts';
import type { Resolved } from '../server/enrich.ts';

/**
 * Everything known about one card, assembled in one place.
 *
 * This is the layer the skills consume: instead of an agent re-deriving a card's
 * project, repos, instructions and link state by reading files, it asks once and
 * gets a complete, deterministic picture. Nothing here is a judgement — it is
 * assembly (C8).
 */
export interface CardContext {
  id: string;
  kind: 'card' | 'node';
  title: string;
  isProject: boolean;
  file: string;
  facets: Record<string, string[]>;
  body: string;
  project: ResolvedProject | null;
  parents: { id: string; title: string }[];
  children: { id: string; title: string; kind: string }[];
  /** Records that must finish before this one, and whether they have. */
  blockedBy: { id: string; title: string; done: boolean }[];
  /** Records this one unblocks, directly. */
  blocks: { id: string; title: string }[];
  relates: { id: string; title: string }[];
  /** Links with whatever enrichment is cached. Never fetches. */
  links: { raw: string; kind: string; ref: string; enrichment?: Resolved }[];
  siblings: { id: string; title: string }[];
}

const brief = (r: Rec) => ({ id: r.id, title: r.title });

function isDone(rec: Rec): boolean {
  return (rec.facets.status ?? []).includes('done');
}

export function cardContext(id: string, dataRoot: string): CardContext | null {
  const p = paths(dataRoot);
  const { records } = readAll(p.cards);
  const rec = records.get(id);
  if (!rec) return null;

  const parentIds = parentsOf(rec);
  const links = rec.links.map((l) => ({ raw: l.raw, kind: l.kind, ref: l.ref }));
  const enriched = readCached(dataRoot, links.map((l) => l.raw));
  const byRef = new Map(enriched.map((e) => [e.ref, e]));

  const edgesTo = (type: string) =>
    rec.edges.filter((e) => e.type === type).map((e) => records.get(e.to)).filter((r): r is Rec => !!r);

  // Records pointing at this one with a `blocks` edge are its blockers.
  const blockers = [...records.values()].filter((r) =>
    r.edges.some((e) => e.type === 'blocks' && e.to === id),
  );

  const siblings = parentIds.length
    ? [...records.values()].filter(
        (r) => r.id !== id && parentsOf(r).some((pid) => parentIds.includes(pid)),
      )
    : [];

  return {
    id: rec.id,
    kind: rec.kind,
    title: rec.title,
    isProject: !!rec.project,
    file: rec.file.replace(p.root + '/', ''),
    facets: rec.facets,
    body: rec.body,
    project: resolveProject(id, records, dataRoot),
    parents: parentIds.map((pid) => records.get(pid)).filter((r): r is Rec => !!r).map(brief),
    children: [...records.values()]
      .filter((r) => parentsOf(r).includes(id))
      .map((r) => ({ id: r.id, title: r.title, kind: r.kind })),
    blockedBy: blockers.map((r) => ({ ...brief(r), done: isDone(r) })),
    blocks: edgesTo('blocks').map(brief),
    relates: edgesTo('relates').map(brief),
    links: links.map((l) => ({ ...l, enrichment: byRef.get(l.raw) })),
    siblings: siblings.map(brief),
  };
}

/**
 * Cards a triage pass should look at, with the reason each one needs attention.
 * Deterministic, so a skill gets its worklist rather than inventing one.
 */
export interface Untriaged {
  id: string;
  title: string;
  reasons: string[];
  facets: Record<string, string[]>;
  /** A bare URL as a title is what the research import left behind. */
  titleIsUrl: boolean;
}

export function untriaged(dataRoot: string): Untriaged[] {
  const { records } = readAll(paths(dataRoot).cards);
  const out: Untriaged[] = [];
  for (const rec of records.values()) {
    if (rec.kind !== 'card') continue;
    const reasons: string[] = [];
    if (!rec.facets.project?.length && !rec.project) reasons.push('no project');
    if (!rec.facets.priority?.length) reasons.push('no priority');
    if (!rec.facets.status?.length) reasons.push('no status');
    const titleIsUrl = /^https?:\/\//.test(rec.title);
    if (titleIsUrl) reasons.push('title is a bare URL');
    if (!reasons.length) continue;
    out.push({ id: rec.id, title: rec.title, reasons, facets: rec.facets, titleIsUrl });
  }
  // Most-incomplete first: those are where a triage pass buys the most.
  return out.sort((a, b) => b.reasons.length - a.reasons.length || a.id.localeCompare(b.id));
}

/** Render a context as markdown — what a briefing embeds and a human can read. */
export function renderContext(ctx: CardContext): string {
  const L: string[] = [];
  L.push(`# ${ctx.title}`);
  L.push('');
  L.push(`- id: \`${ctx.id}\`  ·  kind: ${ctx.kind}${ctx.isProject ? ' (project)' : ''}`);
  L.push(`- file: \`${ctx.file}\``);
  const facets = Object.entries(ctx.facets)
    .map(([k, v]) => `${k}=${v.join(',')}`)
    .join('  ');
  if (facets) L.push(`- facets: ${facets}`);

  if (ctx.project) {
    L.push('');
    L.push('## Project');
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
    L.push('> This card has no project, so it inherits no repos and no instructions.');
  }

  const rel = (label: string, items: { id: string; title: string }[]) => {
    if (!items.length) return;
    L.push('');
    L.push(`## ${label}`);
    L.push('');
    for (const i of items) L.push(`- ${i.title}  \`${i.id}\``);
  };
  rel('Parent', ctx.parents);
  rel('Children', ctx.children);
  if (ctx.blockedBy.length) {
    L.push('');
    L.push('## Blocked by');
    L.push('');
    for (const b of ctx.blockedBy) L.push(`- ${b.done ? '✓' : '✗'} ${b.title}  \`${b.id}\``);
  }
  rel('Blocks', ctx.blocks);
  rel('Relates to', ctx.relates);

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
        const why = l.enrichment?.error ?? l.enrichment?.note ?? 'not resolved yet';
        L.push(`- **${l.kind}** \`${l.ref}\` — ${why}`);
      }
    }
  }

  if (ctx.body.trim()) {
    L.push('');
    L.push('## Card body');
    L.push('');
    L.push(ctx.body.trim());
  }
  return L.join('\n') + '\n';
}
