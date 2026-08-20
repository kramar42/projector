import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { paths, resolvePath } from '../config.ts';
import { frontmatterSchema, listCardFiles, loadCard, renderCard, writeCardFile } from '../schema/card.ts';
import { join as joinFm, parseDoc, patchKey, patchYamlFile, serialize, split } from '../schema/frontmatter.ts';
import { loadFacets } from '../schema/facets.ts';
import { parseLink } from '../schema/links.ts';
import { readAll } from '../index/indexer.ts';
import { ancestorChains } from '../index/project.ts';
import { EDGE_TYPES, type Edge, type EdgeType } from '../schema/types.ts';
import { slugify, uniqueId } from '../import/slug.ts';

/**
 * Every write in the app funnels through this module.
 *
 * Two rules hold throughout: a frontmatter-only change never touches body bytes,
 * and no write proceeds when the file changed on disk since the client read it —
 * an agent editing the same card must never be silently overwritten (C1, C3).
 */

export class Conflict extends Error {
  mtime: number;
  constructor(mtime: number) {
    super('file changed on disk');
    this.mtime = mtime;
  }
}

export class Invalid extends Error {}

function fileFor(root: string, id: string): string {
  const p = paths(root);
  const direct = join(p.cards, `${id}.md`);
  if (existsSync(direct)) return direct;
  // The filename may drift from the id, so fall back to a scan.
  for (const f of listCardFiles(p.cards)) {
    const res = loadCard(f);
    if (res.ok && res.rec.id === id) return f;
  }
  throw new Invalid(`no card with id "${id}"`);
}

export function mtimeOf(file: string): number {
  return Math.floor(statSync(file).mtimeMs);
}

function guard(file: string, baseMtime?: number): void {
  if (baseMtime === undefined) return;
  const current = mtimeOf(file);
  // A one-second tolerance: some filesystems round mtime, and a write we just
  // made ourselves should not read as somebody else's change.
  if (Math.abs(current - baseMtime) > 1000) throw new Conflict(current);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Apply several frontmatter keys in one atomic write, bumping `updated`. */
function patchAll(file: string, patch: Record<string, unknown>): void {
  let text = readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(patch)) text = patchKey(text, key, value);
  text = patchKey(text, 'updated', today());
  writeCardFile(file, text);
}

// ---------------------------------------------------------------- validation

/**
 * Validate facet names and values against the vocabulary before writing.
 * A closed facet rejects unknown values; a scoped facet is only valid where it
 * applies. Every facet is writable — there is no special kind.
 */
export function checkFacets(
  root: string,
  id: string,
  facets: Record<string, string[]>,
  records: Map<string, ReturnType<typeof Object>>,
): void {
  const defs = loadFacets(paths(root).facets);
  for (const [name, values] of Object.entries(facets)) {
    const def = defs[name];
    if (!def) throw new Invalid(`unknown facet "${name}"`);
    if (!def.open) {
      for (const v of values) {
        if (!def.values.includes(v)) {
          throw new Invalid(`"${v}" is not allowed for "${name}" (allowed: ${def.values.join(', ')})`);
        }
      }
    }
    if (def.scope?.under && values.length) {
      const chains = ancestorChains(id, records as never);
      if (!chains.some((c) => c.includes(def.scope!.under))) {
        throw new Invalid(`"${name}" only applies to records beneath "${def.scope.under}"`);
      }
    }
  }
}

// ---------------------------------------------------------------- operations

export interface PatchCardInput {
  title?: string;
  facets?: Record<string, string[]>;
  links?: string[];
  body?: string;
  kind?: 'card' | 'node';
  project?: Record<string, unknown> | null;
  baseMtime?: number;
}

export function patchCard(root: string, id: string, input: PatchCardInput): { mtime: number } {
  const file = fileFor(root, id);
  guard(file, input.baseMtime);

  if (input.facets) {
    const { records } = readAll(paths(root).cards);
    checkFacets(root, id, input.facets, records as never);
  }
  if (input.title !== undefined && !input.title.trim()) throw new Invalid('title cannot be empty');

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.facets !== undefined) {
    // Drop empty facets rather than storing an empty array.
    const clean = Object.fromEntries(Object.entries(input.facets).filter(([, v]) => v.length));
    patch.facets = Object.keys(clean).length ? clean : undefined;
  }
  if (input.links !== undefined) patch.links = input.links.length ? input.links : undefined;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.project !== undefined) patch.project = input.project ?? undefined;

  if (Object.keys(patch).length) patchAll(file, patch);

  if (input.body !== undefined) {
    // The body is written verbatim; only this call path may touch it.
    const text = readFileSync(file, 'utf8');
    const { yaml } = split(text);
    writeCardFile(file, `---\n${yaml}---\n${input.body}`);
    patchAll(file, {});
  }

  return { mtime: mtimeOf(file) };
}

export function createCard(
  root: string,
  input: {
    title: string;
    kind?: 'card' | 'node';
    parent?: string;
    facets?: Record<string, string[]>;
    body?: string;
    links?: string[];
    /**
     * A stable hash of whatever this card came from. A sweep that runs twice
     * must converge rather than refill the inbox, so a fingerprint already
     * present short-circuits instead of creating a duplicate.
     */
    fingerprint?: string;
  },
): { id: string; existed?: boolean } {
  const title = input.title.trim();
  if (!title) throw new Invalid('title cannot be empty');
  const p = paths(root);
  mkdirSync(p.cards, { recursive: true });
  const { records } = readAll(p.cards);

  if (input.fingerprint) {
    for (const rec of records.values()) {
      if (rec.source_fingerprint === input.fingerprint) return { id: rec.id, existed: true };
    }
  }
  const id = uniqueId(slugify(title), new Set(records.keys()));
  const facets = input.facets ?? {};
  if (Object.keys(facets).length) checkFacets(root, id, facets, records as never);

  const text = renderCard({
    id,
    kind: input.kind ?? 'card',
    title,
    facets,
    edges: input.parent ? [{ type: 'parent', to: input.parent }] : [],
    links: (input.links ?? []).map(parseLink),
    source_fingerprint: input.fingerprint,
    created: today(),
    updated: today(),
    body: input.body ? `\n${input.body}\n` : '\n',
  });
  writeCardFile(join(p.cards, `${id}.md`), text);
  return { id };
}

/**
 * Delete a card file, and drop every edge that pointed at it so the graph does
 * not keep dangling references. The files are in git, so this is recoverable.
 */
export function deleteCard(root: string, id: string): { removedEdges: number } {
  const file = fileFor(root, id);
  const p = paths(root);
  const { records } = readAll(p.cards);
  let removedEdges = 0;

  for (const rec of records.values()) {
    if (rec.id === id) continue;
    const kept = rec.edges.filter((e) => e.to !== id);
    if (kept.length !== rec.edges.length) {
      removedEdges += rec.edges.length - kept.length;
      patchAll(rec.file, { edges: kept.length ? kept : undefined });
    }
  }

  rmSync(file);
  // Assets belong to the card; nothing else references them.
  const assets = join(p.assets, id);
  if (existsSync(assets)) rmSync(assets, { recursive: true });
  return { removedEdges };
}

export function setEdges(
  root: string,
  id: string,
  edges: Edge[],
  baseMtime?: number,
): { mtime: number } {
  const file = fileFor(root, id);
  guard(file, baseMtime);
  const { records } = readAll(paths(root).cards);

  for (const e of edges) {
    if (!(EDGE_TYPES as readonly string[]).includes(e.type)) throw new Invalid(`unknown edge type "${e.type}"`);
    if (e.to === id) throw new Invalid('a record cannot point at itself');
    if (!records.has(e.to)) throw new Invalid(`edge target "${e.to}" does not exist`);
  }

  // A parent edge that would create a cycle is refused: the project chain and
  // every tree layout assume the parent graph is acyclic.
  for (const e of edges.filter((x) => x.type === 'parent')) {
    if (wouldCycle(id, e.to, records as never)) {
      throw new Invalid(`"${e.to}" is already beneath "${id}" — that would make a cycle`);
    }
  }

  patchAll(file, { edges: edges.length ? edges : undefined });
  return { mtime: mtimeOf(file) };
}

function wouldCycle(
  child: string,
  parent: string,
  records: Map<string, { edges: { type: string; to: string }[] }>,
): boolean {
  if (child === parent) return true;
  const seen = new Set<string>();
  const stack = [parent];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === child) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of records.get(cur)?.edges ?? []) {
      if (e.type === 'parent') stack.push(e.to);
    }
  }
  return false;
}

/** Set one facet's values on many records at once. */
export function bulkFacet(
  root: string,
  ids: string[],
  facet: string,
  values: string[],
  mode: 'set' | 'add' | 'remove',
): { changed: number } {
  const { records } = readAll(paths(root).cards);
  let changed = 0;
  for (const id of ids) {
    const rec = records.get(id);
    if (!rec) continue;
    const current = rec.facets[facet] ?? [];
    let next: string[];
    if (mode === 'set') next = [...values];
    else if (mode === 'add') next = [...new Set([...current, ...values])];
    else next = current.filter((v) => !values.includes(v));
    if (same(current, next)) continue;
    const facets = { ...rec.facets };
    if (next.length) facets[facet] = next;
    else delete facets[facet];
    checkFacets(root, id, next.length ? { [facet]: next } : {}, records as never);
    patchAll(rec.file, { facets: Object.keys(facets).length ? facets : undefined });
    changed++;
  }
  return { changed };
}

/** Re-parent many records at once — the way a card gets a project. */
export function bulkParent(root: string, ids: string[], parent: string | null): { changed: number } {
  const { records } = readAll(paths(root).cards);
  if (parent && !records.has(parent)) throw new Invalid(`parent "${parent}" does not exist`);
  let changed = 0;
  for (const id of ids) {
    const rec = records.get(id);
    if (!rec || id === parent) continue;
    if (parent && wouldCycle(id, parent, records as never)) continue;
    const others = rec.edges.filter((e) => e.type !== 'parent');
    const next: Edge[] = parent ? [...others, { type: 'parent' as EdgeType, to: parent }] : others;
    patchAll(rec.file, { edges: next.length ? next : undefined });
    changed++;
  }
  return { changed };
}

export function bulkDelete(root: string, ids: string[]): { deleted: number } {
  let deleted = 0;
  for (const id of ids) {
    try {
      deleteCard(root, id);
      deleted++;
    } catch {
      /* already gone */
    }
  }
  return { deleted };
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Replace a card's whole frontmatter from raw YAML.
 *
 * Validated before anything is written: it must parse, satisfy the skeleton
 * schema, and pass the same facet checks as any other write. `id` is refused
 * because other cards' edges point at it — renaming would silently orphan them.
 */
export function putFrontmatter(
  root: string,
  id: string,
  yamlText: string,
  baseMtime?: number,
): { mtime: number; warnings: string[] } {
  const file = fileFor(root, id);
  guard(file, baseMtime);

  const text = readFileSync(file, 'utf8');
  const { body } = split(text);

  let parsed: unknown;
  try {
    parsed = parseDoc(yamlText).toJS();
  } catch (err) {
    throw new Invalid(`invalid YAML: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Invalid('frontmatter must be a mapping');

  const draft = parsed as Record<string, unknown>;
  if (draft.id !== undefined && draft.id !== id) {
    throw new Invalid(
      `id cannot be changed here — other records' edges point at "${id}". Delete and recreate instead.`,
    );
  }
  draft.id = id;

  const check = frontmatterSchema.safeParse(draft);
  if (!check.success) {
    throw new Invalid(
      check.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }

  const { records } = readAll(paths(root).cards);
  const facets: Record<string, string[]> = {};
  for (const [k, v] of Object.entries((check.data.facets ?? {}) as Record<string, unknown>)) {
    const arr = Array.isArray(v) ? v : [v];
    facets[k] = arr.filter((x) => x != null).map(String);
  }
  checkFacets(root, id, facets, records as never);

  const warnings: string[] = [];
  for (const e of check.data.edges ?? []) {
    if (!records.has(e.to)) warnings.push(`edge target "${e.to}" does not exist yet`);
    if (e.to === id) throw new Invalid('an edge cannot point at its own record');
  }
  for (const e of (check.data.edges ?? []).filter((x) => x.type === 'parent')) {
    if (wouldCycle(id, e.to, records as never)) {
      throw new Invalid(`parent "${e.to}" is already beneath "${id}" — that would make a cycle`);
    }
  }

  // Re-render through the canonical serializer so key order and flow style match
  // every other file, then restore the body untouched.
  writeCardFile(file, joinFm(serialize(check.data), body));
  return { mtime: mtimeOf(file), warnings };
}

// ---------------------------------------------------------------- canvas

/** Persist canvas node positions and sizes. Cards are untouched — views own arrangement. */
export function saveCanvas(
  root: string,
  name: string,
  nodes: Record<string, { x?: number; y?: number; size?: string }>,
): void {
  const file = join(paths(root).canvases, `${name}.yaml`);
  if (!existsSync(file)) throw new Invalid(`no canvas "${name}"`);
  const rounded = Object.fromEntries(
    Object.entries(nodes).map(([id, n]) => [
      id,
      {
        ...(n.x !== undefined ? { x: Math.round(n.x) } : {}),
        ...(n.y !== undefined ? { y: Math.round(n.y) } : {}),
        ...(n.size ? { size: n.size } : {}),
      },
    ]),
  );
  // A view file is plain YAML, so it needs the YAML patcher, not the frontmatter
  // one. Storing positions only means anything under a manual layout.
  const text = patchYamlFile(readFileSync(file, 'utf8'), { nodes: rounded, layout: 'manual' });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- assets

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** Save a pasted image beside its card and return the relative markdown path. */
export function saveAsset(root: string, id: string, mime: string, bytes: Buffer): { path: string } {
  const ext = EXT[mime];
  if (!ext) throw new Invalid(`unsupported image type "${mime}"`);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const dir = join(paths(root).assets, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${hash}.${ext}`);
  if (!existsSync(file)) writeFileSync(file, bytes);
  return { path: `assets/${id}/${hash}.${ext}` };
}

export { fileFor, resolvePath, dirname };
