import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { paths, resolvePath } from '../config.ts';
import { frontmatterSchema, listCardFiles, loadCard, renderCard, writeCardFile } from '../schema/card.ts';
import { join as joinFm, parseDoc, patchKey, patchYamlFile, serialize, split } from '../schema/frontmatter.ts';
import { loadFacets } from '../schema/facets.ts';
import { isRef } from '../schema/facets.ts';
import { parseLink } from '../schema/links.ts';
import { readAll } from '../index/indexer.ts';
import { viewFileFor } from './views.ts';
import type { Rec } from '../schema/types.ts';
import { loadFacets as loadDefs } from '../schema/facets.ts';
import { slugify, uniqueId } from '../schema/slug.ts';
import { nextValues, type AxisMove, type DragMode } from '../view/dropOutcome.ts';

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
 *
 * A closed facet rejects unknown values, a single-valued one rejects a second,
 * and a reference facet rejects a cycle. Every facet is writable and every facet
 * is checked the same way — `project` included. There is no special kind.
 *
 * `records` is only needed for reference facets, so it is optional: a caller
 * writing labels does not have to read the vault first.
 */
export function checkFacets(
  root: string,
  id: string,
  facets: Record<string, string[]>,
  records?: Map<string, Rec>,
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
    if (def.single && values.length > 1) {
      throw new Invalid(`"${name}" holds one value at a time, and this sets ${values.length}`);
    }
    // A typed value has to *be* what the type says, or every comparison
    // downstream is guessing. This is where `checkDue` used to live, hardcoded
    // to one field name.
    if (def.type === 'date') {
      for (const v of values) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
          throw new Invalid(`"${name}" is a date facet, and "${v}" is not YYYY-MM-DD`);
        }
      }
    }
    if (def.type === 'number') {
      for (const v of values) {
        if (!Number.isFinite(Number(v))) throw new Invalid(`"${name}" is a number facet, and "${v}" is not a number`);
      }
    }
    if (isRef(def) && records) {
      for (const v of values) {
        if (v === id) throw new Invalid(`"${name}" cannot point at its own record`);
        if (wouldCycle(id, v, (cur) => records.get(cur)?.facets[name] ?? [])) {
          throw new Invalid(`"${v}" already reaches "${id}" through "${name}" — that would make a cycle`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- operations

/**
 * One facet's values merged into a map, dropping the axis when it empties.
 *
 * An emptied facet is deleted rather than stored as `[]`, which is the rule the
 * frontmatter writer expects — it was spelled out at `bulkMove` and `bulkFacet`
 * and is now needed a third time, which is three chances for one rule to drift.
 * Pure, so it is asserted directly rather than through a filesystem.
 */
export function withFacet(
  current: Record<string, string[]>,
  name: string,
  values: string[],
): Record<string, string[]> {
  const next = { ...current };
  if (values.length) next[name] = values;
  else delete next[name];
  return next;
}

/** How a caller means its values: replace the axis, or name a delta on it. */
export type FacetMode = 'set' | 'add' | 'remove';

/**
 * One axis's next values, from what is on disk and what the caller asked for.
 *
 * `set` is the only mode that discards what it did not see. `add` and `remove`
 * name a *delta*, which is what a toggle actually is — and the difference is not
 * cosmetic: a chip click that says "the axis is now [k8s, temporal]" reverts a
 * value an agent added since the click's own render, silently and inside the
 * guard's tolerance. One that says "remove kafka" cannot.
 */
export function applyMode(current: string[], values: string[], mode: FacetMode): string[] {
  if (mode === 'set') return [...values];
  if (mode === 'add') return [...new Set([...current, ...values])];
  return current.filter((v) => !values.includes(v));
}

export interface PatchCardInput {
  title?: string;
  /**
   * The whole map, replaced. `pj set` expresses every removal by omitting a key
   * — `--facet f=`, a fully-consumed `--remove`, `--parent none` — so this
   * meaning must not change. A caller sending one axis wants `facet` below.
   */
  facets?: Record<string, string[]>;
  /**
   * One axis, merged over what is on disk *inside* the guard.
   *
   * The browser cannot know the whole map without re-reading the file, and the
   * copy it holds is as old as its last render — sending it back reverts any
   * other axis an agent changed in the meantime, silently, because the write
   * still satisfies `guard`'s tolerance. Naming the one axis is what makes the
   * panel's write as narrow as the edit that caused it (C3).
   *
   * `mode` narrows it the last step. Naming the axis still leaves the client
   * asserting what that *whole axis* now holds, which is as old as its last
   * render — so a toggle on `tech` reverts a value an agent added to `tech` a
   * moment earlier, inside the guard's tolerance, with nothing to report.
   * `add`/`remove` name the delta instead, and a toggle *is* a delta.
   */
  facet?: { name: string; values: string[]; mode?: FacetMode };
  links?: string[];
  body?: string;
  project?: Record<string, unknown> | null;
  baseMtime?: number;
}

export function patchCard(root: string, id: string, input: PatchCardInput): { mtime: number } {
  const file = fileFor(root, id);
  guard(file, input.baseMtime);

  if (input.facets) checkFacets(root, id, input.facets, readAll(paths(root).cards).records);
  if (input.title !== undefined && !input.title.trim()) throw new Invalid('title cannot be empty');

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.facets !== undefined) {
    // Drop empty facets rather than storing an empty array.
    const clean = Object.fromEntries(Object.entries(input.facets).filter(([, v]) => v.length));
    patch.facets = Object.keys(clean).length ? clean : undefined;
  }
  if (input.facet) {
    // Read *after* the guard, so this sees the file the guard just approved
    // rather than the one the client last rendered. Everything the client does
    // not name survives, which is the whole point of the narrow form.
    const { records } = readAll(paths(root).cards);
    const { name, values, mode = 'set' } = input.facet;
    const current = records.get(id)?.facets ?? {};
    const next = applyMode(current[name] ?? [], values, mode);
    const merged = withFacet(current, name, next);
    checkFacets(root, id, next.length ? { [name]: next } : {}, records);
    patch.facets = Object.keys(merged).length ? merged : undefined;
  }
  if (input.links !== undefined) patch.links = input.links.length ? input.links : undefined;
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
    /** Overrides the slug derived from the title. Refused if already taken. */
    id?: string;
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
  const id = input.id ?? uniqueId(slugify(title), new Set(records.keys()));
  if (input.id) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.id)) throw new Invalid(`"${input.id}" is not a lowercase slug`);
    // Never silently pick a different id than the caller asked for: something is
    // about to reference this one by name.
    if (records.has(input.id)) throw new Invalid(`id "${input.id}" is already taken`);
  }
  // `parent` is a reference facet, so a caller's `parent` is one more facet
  // value rather than a separate structure.
  const facets = { ...(input.facets ?? {}), ...(input.parent ? { parent: [input.parent] } : {}) };
  if (Object.keys(facets).length) checkFacets(root, id, facets, records);

  const text = renderCard({
    id,
    title,
    facets,
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
 * Delete a card file, and drop every reference that pointed at it so the graph
 * does not keep dangling values. The files are in git, so this is recoverable.
 */
export function deleteCard(root: string, id: string): { removedEdges: number } {
  const file = fileFor(root, id);
  const p = paths(root);
  const { records } = readAll(p.cards);
  const refFacets = Object.entries(loadDefs(p.facets))
    .filter(([, def]) => isRef(def))
    .map(([name]) => name);
  let removedEdges = 0;

  for (const rec of records.values()) {
    if (rec.id === id) continue;
    const facets = { ...rec.facets };
    let touched = false;
    for (const name of refFacets) {
      const kept = (facets[name] ?? []).filter((v) => v !== id);
      if (kept.length === (facets[name] ?? []).length) continue;
      removedEdges += (facets[name] ?? []).length - kept.length;
      touched = true;
      if (kept.length) facets[name] = kept;
      else delete facets[name];
    }
    if (touched) patchAll(rec.file, { facets: Object.keys(facets).length ? facets : undefined });
  }

  rmSync(file);
  // Assets belong to the card; nothing else references them.
  const assets = join(p.assets, id);
  if (existsSync(assets)) rmSync(assets, { recursive: true });
  return { removedEdges };
}

/**
 * Would pointing `from` at `to` close a loop?
 *
 * Takes the outward neighbours as a function rather than a record map, so one
 * implementation serves a `parent` edge and a reference facet alike — the check
 * is about the shape of the graph, not about where it is stored.
 */
function wouldCycle(from: string, to: string, outOf: (id: string) => string[]): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...outOf(cur));
  }
  return false;
}

/**
 * Move records along one or more facets, one card at a time.
 *
 * Distinct from `bulkFacet` because the two are different operations that happen
 * to write the same field. "Make these twelve cards say `now`" is uniform, and
 * that is what `bulkFacet` does. "Move these twelve from `now` to `month`, keeping
 * whatever else each of them says" is *per card* — every card's answer depends on
 * its own values, and a uniform `values` array cannot express one.
 *
 * The board used to compute the single-card answer with `nextValues` and then
 * throw it away whenever more than one card was selected, sending uniform values
 * instead. So the same gesture produced different results by selection count:
 * shift-dragging `now`→`month` removed `now` for one card and `month` for two.
 * One transform, applied here, is what makes that unrepresentable.
 *
 * It also writes only the named facets, so a value an agent changed since the
 * client's last read cannot be reverted — which the old whole-map replacement did
 * silently, with no conflict to report.
 */
export function bulkMove(
  root: string,
  ids: string[],
  moves: readonly AxisMove[],
  mode: DragMode,
): { changed: number } {
  const { records } = readAll(paths(root).cards);
  let changed = 0;
  for (const id of ids) {
    const rec = records.get(id);
    if (!rec) continue;
    // A drag across a matrix board crosses two axes and is still one gesture, so
    // both endpoints fold into one map and one write. Writing per axis would bump
    // `updated` twice and let the second write land on a card the first changed —
    // and would leave the card half moved when the second value is refused.
    let facets = rec.facets;
    const check: Record<string, string[]> = {};
    let touched = false;
    for (const { facet, from, to } of moves) {
      const current = facets[facet] ?? [];
      const next = nextValues(current, from, to, mode);
      if (same(current, next)) continue;
      // A cleared axis has nothing to validate — `withFacet` drops the key.
      if (next.length) check[facet] = next;
      facets = withFacet(facets, facet, next);
      touched = true;
    }
    if (!touched) continue;
    // Every axis is checked before any of them is written.
    checkFacets(root, id, check, records);
    patchAll(rec.file, { facets: Object.keys(facets).length ? facets : undefined });
    changed++;
  }
  return { changed };
}

/** Set one facet's values on many records at once. */
export function bulkFacet(
  root: string,
  ids: string[],
  facet: string,
  values: string[],
  mode: FacetMode,
): { changed: number } {
  const { records } = readAll(paths(root).cards);
  let changed = 0;
  for (const id of ids) {
    const rec = records.get(id);
    if (!rec) continue;
    const current = rec.facets[facet] ?? [];
    const next = applyMode(current, values, mode);
    if (same(current, next)) continue;
    const facets = withFacet(rec.facets, facet, next);
    checkFacets(root, id, next.length ? { [facet]: next } : {}, records);
    patchAll(rec.file, { facets: Object.keys(facets).length ? facets : undefined });
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
 * Set frontmatter fields by dotted path, with YAML values.
 *
 *   project.jira=SUPPORT
 *   project.repos=[{path: ~/Code/work/infra, base: main}]
 *   project={}                 → this is what "make it a project" is
 *   project=                   → and this is "stop being one"
 *
 * One mechanism rather than a verb per structure. `project:` is a block, not a
 * facet, so no amount of facet machinery reaches it — and a flat `key=value`
 * cannot express a list of maps, so the value is parsed as YAML. That also makes
 * `facets.priority=[now]` work, which is `--facet` spelled generally.
 *
 * Only the top-level keys actually touched are rewritten, so comments and hand
 * formatting elsewhere in the file survive (C1).
 */
export function patchFields(
  root: string,
  id: string,
  sets: Record<string, string>,
  baseMtime?: number,
): { mtime: number } {
  const file = fileFor(root, id);
  guard(file, baseMtime);

  const text = readFileSync(file, 'utf8');
  const { yaml } = split(text);
  const fm = (parseDoc(yaml ?? '').toJS() ?? {}) as Record<string, unknown>;
  const touched = new Set<string>();

  for (const [path, raw] of Object.entries(sets)) {
    const parts = path.split('.').filter(Boolean);
    if (!parts.length) throw new Invalid('a --set needs a field name');
    const top = parts[0]!;
    if (top === 'id') throw new Invalid('id cannot be changed — other records reference it');
    touched.add(top);

    let value: unknown;
    if (raw === '') value = undefined;
    else {
      try {
        value = parseDoc(raw).toJS();
      } catch (err) {
        throw new Invalid(`${path}: not valid YAML — ${(err as Error).message}`);
      }
    }

    // Walk to the parent of the leaf, creating plain objects on the way.
    let cursor: Record<string, unknown> = fm;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (next === undefined || next === null) cursor[part] = {};
      else if (typeof next !== 'object' || Array.isArray(next)) {
        throw new Invalid(`${path}: "${part}" is not a mapping`);
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts.at(-1)!;
    if (value === undefined) delete cursor[leaf];
    else cursor[leaf] = value;
  }

  // The same checks as any other write, against the result rather than the input.
  const check = frontmatterSchema.safeParse({ ...fm, id });
  if (!check.success) {
    throw new Invalid(
      check.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  const facets: Record<string, string[]> = {};
  for (const [k, v] of Object.entries((check.data.facets ?? {}) as Record<string, unknown>)) {
    facets[k] = (Array.isArray(v) ? v : [v]).filter((x) => x != null).map(String);
  }
  checkFacets(root, id, facets, readAll(paths(root).cards).records);

  for (const key of touched) patchAll(file, { [key]: fm[key] });
  return { mtime: mtimeOf(file) };
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
  checkFacets(root, id, facets, records);

  // Self-reference and cycles are already refused by `checkFacets`; a value
  // naming a record that does not exist yet is only a warning, because an agent
  // may write a card before the one it points at.
  const warnings: string[] = [];
  const defs = loadDefs(paths(root).facets);
  for (const [name, values] of Object.entries(facets)) {
    if (!isRef(defs[name])) continue;
    for (const v of values) {
      if (!records.has(v)) warnings.push(`"${name}" names "${v}", which is not a record yet`);
    }
  }

  // Re-render through the canonical serializer so key order and flow style match
  // every other file, then restore the body untouched.
  writeCardFile(file, joinFm(serialize(check.data), body));
  return { mtime: mtimeOf(file), warnings };
}

// ---------------------------------------------------------------- canvas

/** Persist canvas node positions and sizes. Cards are untouched — views own arrangement. */
/**
 * Arrangement: node positions, and card order within a column.
 *
 * Both are hand-curated, so both live in a named view and nowhere else (C9) —
 * which is what makes naming a view the act that buys manual arrangement. Cards
 * own identity and content; views own arrangement.
 */
export function saveArrangement(
  root: string,
  name: string,
  arrangement: { nodes?: Record<string, { x?: number; y?: number }>; order?: Record<string, string[]> },
): void {
  const p = paths(root);
  const file = viewFileFor(root, name);
  if (!existsSync(file)) throw new Invalid(`no view "${name}"`);
  const text0 = readFileSync(file, 'utf8');
  const before = (parse(text0) ?? {}) as { nodes?: Record<string, unknown>; order?: Record<string, unknown> };

  const patch: Record<string, unknown> = {};
  let live: Set<string> | null = null;
  /** Ids whose card is gone. The set is built at most once, and only if needed. */
  const dead = (ids: string[]): Set<string> => {
    const out = new Set<string>();
    for (const id of ids) {
      if (existsSync(join(p.cards, `${id}.md`))) continue;
      if (!live) {
        live = new Set<string>();
        for (const f of listCardFiles(p.cards)) {
          const res = loadCard(f);
          if (res.ok) live.add(res.rec.id);
        }
      }
      if (!live.has(id)) out.add(id);
    }
    return out;
  };

  if (arrangement.nodes) {
    // Merge, never replace. The client sends the nodes it currently renders, and
    // that is a filtered subset — replacing would silently discard the position
    // of everything the filter happened to hide.
    const merged: Record<string, { x?: number; y?: number }> = {
      ...((before.nodes ?? {}) as Record<string, { x?: number; y?: number }>),
    };
    for (const [id, n] of Object.entries(arrangement.nodes)) {
      merged[id] = {
        ...(n.x !== undefined ? { x: Math.round(n.x) } : {}),
        ...(n.y !== undefined ? { y: Math.round(n.y) } : {}),
      };
    }
    for (const id of dead(Object.keys(merged))) delete merged[id];
    patch.nodes = merged;
    // Storing positions only means anything under a manual layout.
    patch.layout = 'manual';
  }

  if (arrangement.order) {
    const merged: Record<string, string[]> = {
      ...((before.order ?? {}) as Record<string, string[]>),
    };
    // Per column, for the same reason: you reorder the column you are looking at.
    for (const [column, ids] of Object.entries(arrangement.order)) {
      const gone = dead(ids);
      const kept = ids.filter((id) => !gone.has(id));
      if (kept.length) merged[column] = kept;
      else delete merged[column];
    }
    patch.order = merged;
  }

  if (!Object.keys(patch).length) return;
  // A view file is plain YAML, so it needs the YAML patcher, not the frontmatter one.
  const text = patchYamlFile(text0, patch);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/**
 * Write a saved view — *save current as…*, and updating one in place.
 *
 * Only the query half is written: arrangement belongs to whatever the view
 * already holds, so saving a new query over an existing name keeps its positions
 * rather than throwing them away.
 */
export function saveView(root: string, name: string, body: Record<string, unknown>): { name: string } {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Invalid('a view needs a name');
  const p = paths(root);
  mkdirSync(p.views, { recursive: true });
  const file = viewFileFor(root, slug);

  let merged: Record<string, unknown> = body;
  if (existsSync(file)) {
    const before = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
    merged = { ...body };
    if (before.nodes) merged.nodes = before.nodes;
    if (before.order) merged.order = before.order;
    if (before.layout) merged.layout = before.layout;
  }

  // Through the YAML patcher rather than a bare stringify, so a view the app
  // wrote is formatted like one written by hand — short sequences inline. A file
  // you cannot tell from a hand-edited one is the point of keeping them as files.
  const text = patchYamlFile('', merged);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
  return { name: slug };
}

/** Delete a saved view. The cards it selected are untouched. */
export function deleteView(root: string, name: string): void {
  const file = viewFileFor(root, name);
  if (!existsSync(file)) throw new Invalid(`no view "${name}"`);
  rmSync(file);
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
