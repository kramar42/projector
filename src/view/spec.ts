import { NONE, type Dir, type Focus, type Query, type Via } from '../index/query.ts';

/**
 * The one description of a view, shared by the three places that describe one:
 * a URL, a saved `views/*.yaml`, and `ck` flags.
 *
 * A `ViewSpec` is a `Query` plus how to draw it. The split matters: everything in
 * the query half is derivable and therefore a live control, while `nodes` and
 * `order` are hand-curated arrangement and exist only in a named file (C9).
 */

export type Shape = 'board' | 'canvas' | 'table';

export const SHAPES: readonly Shape[] = ['board', 'canvas', 'table'];
export const VIAS: readonly Via[] = ['parent', 'member-of', 'blocks'];
export const DIRS: readonly Dir[] = ['down', 'up', 'both'];
export const EDGE_KINDS: readonly string[] = ['parent', 'blocks', 'relates', 'member-of'];

export interface ViewSpec {
  /** Set when this came from a saved view; absent for an ad-hoc query. */
  name?: string;
  title?: string;
  shape: Shape;
  query: Query;
  /** Which edge types the canvas draws. Layout always follows `parent`. */
  edges: string[];
  /**
   * Which facets are visible on a record. A board and a canvas draw them as chips;
   * a table draws the same list as its columns — one parameter, so switching shape
   * never asks the question twice.
   */
  chips: string[];
  /** Saved views only: positions, and card order within a column. */
  nodes?: Record<string, { x?: number; y?: number }>;
  order?: Record<string, string[]>;
}

// ---------------------------------------------------------------- parsing

function one<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * `(none)` travels as itself rather than as a bare `none`, so a facet that one
 * day has a literal value `none` cannot collide with the absence refinement.
 */
function values(raw: string | undefined): string[] {
  return list(raw).map((v) => (v === '(none)' ? NONE : v));
}

function focusOf(params: Record<string, string>): Focus | undefined {
  const id = params.focus?.trim();
  if (!id) return undefined;
  const depth = Number(params.depth);
  return {
    id,
    via: one(params.via, VIAS) ?? 'parent',
    dir: one(params.dir, DIRS) ?? 'down',
    depth: Number.isInteger(depth) && depth > 0 ? depth : undefined,
  };
}

/**
 * Read a spec out of flat string parameters — `URLSearchParams` entries on the
 * server, parsed flags in the CLI. Anything unrecognised is ignored rather than
 * rejected: a stale bookmark should open, not error.
 */
export function parseSpec(params: Record<string, string>): ViewSpec {
  const filter: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(params)) {
    if (!key.startsWith('f.')) continue;
    const facet = key.slice(2);
    const picked = values(raw);
    // An empty `f.status=` is meaningful: it says "no status filter", which is
    // how the URL can override a default selection instead of merging with it.
    if (facet) filter[facet] = picked;
  }

  const query: Query = { filter };
  if (params.q?.trim()) query.q = params.q;
  const focus = focusOf(params);
  if (focus) query.focus = focus;
  // `group=priority,project` is primary then secondary — the second axis is a
  // position in this list, which is why there is no `swimlanes` key.
  const grouping = list(params.group);
  if (grouping.length) query.groupBy = grouping.slice(0, 2);
  const sort = list(params.sort);
  if (sort.length) query.sort = sort;
  const uncategorised = one(params.uncategorised, ['end', 'start', 'hide'] as const);
  if (uncategorised) query.uncategorised = uncategorised;

  const shape = one(params.shape, SHAPES) ?? 'board';
  // A graph has to stay connected to be readable; a column does not.
  query.connect = shape === 'canvas' ? one(params.connect, ['ancestors', 'none'] as const) ?? 'ancestors' : 'none';

  const edges = list(params.edges);
  const chips = list(params.chips);
  return {
    shape,
    query,
    edges: edges.length ? edges.filter((e) => EDGE_KINDS.includes(e)) : ['parent', 'blocks'],
    chips,
  };
}

// ---------------------------------------------------------------- serialising

/** The inverse of `parseSpec`, for *save current as…* and for round-trip tests. */
export function specToParams(spec: ViewSpec): Record<string, string> {
  const out: Record<string, string> = { shape: spec.shape };
  const q = spec.query;
  for (const [facet, picked] of Object.entries(q.filter ?? {})) {
    out[`f.${facet}`] = picked.map((v) => (v === NONE ? '(none)' : v)).join(',');
  }
  if (q.q) out.q = q.q;
  if (q.groupBy?.length) out.group = q.groupBy.join(',');
  if (q.sort?.length) out.sort = q.sort.join(',');
  if (q.uncategorised) out.uncategorised = q.uncategorised;
  if (q.focus) {
    out.focus = q.focus.id;
    out.via = q.focus.via;
    out.dir = q.focus.dir;
    if (q.focus.depth !== undefined) out.depth = String(q.focus.depth);
  }
  if (spec.shape === 'canvas' && q.connect === 'none') out.connect = 'none';
  if (spec.edges.length) out.edges = spec.edges.join(',');
  if (spec.chips.length) out.chips = spec.chips.join(',');
  return out;
}

// ---------------------------------------------------------------- saved views

/**
 * A saved view file, in the P5 schema.
 *
 * `kind: board|canvas` from P1 is read as `shape`, and the P1 canvas keys
 * (`include.under`, `include.filter`, `defaultSize`) are read as the query they
 * always were — so the seven files written before P5 keep opening, and the first
 * save rewrites them in the new shape.
 */
export function specFromFile(name: string, raw: Record<string, unknown>): ViewSpec {
  const params: Record<string, string> = {};
  const legacyKind = raw.kind === 'canvas' ? 'canvas' : raw.kind === 'board' ? 'board' : undefined;
  const shape = one(String(raw.shape ?? ''), SHAPES) ?? legacyKind ?? 'board';
  params.shape = shape;

  const include = (raw.include ?? {}) as { filter?: Record<string, unknown>; under?: string };
  const filter = (raw.filter ?? include.filter ?? {}) as Record<string, unknown>;
  for (const [facet, value] of Object.entries(filter)) {
    // The P1 spelling of "unblocked" was a filter key on a computed predicate;
    // it is the `blocked` pseudo-facet now.
    if (facet === 'blockedBy') {
      if (value === 'none') params['f.blocked'] = 'clear';
      continue;
    }
    const picked = Array.isArray(value) ? value.map(String) : [String(value)];
    params[`f.${facet}`] = picked.join(',');
  }

  const focus = (raw.focus ?? (include.under ? { id: include.under } : undefined)) as
    | { id?: string; via?: string; dir?: string; depth?: number }
    | undefined;
  if (focus?.id) {
    params.focus = String(focus.id);
    params.via = String(focus.via ?? 'parent');
    params.dir = String(focus.dir ?? 'down');
    if (focus.depth !== undefined) params.depth = String(focus.depth);
  }

  // P1 wrote a single facet; P5 writes a list. Both read.
  if (typeof raw.groupBy === 'string') params.group = raw.groupBy;
  else if (Array.isArray(raw.groupBy)) params.group = raw.groupBy.map(String).join(',');
  if (typeof raw.swimlanes === 'string' && params.group) params.group += `,${raw.swimlanes}`;
  if (Array.isArray(raw.sort)) params.sort = raw.sort.map(String).join(',');
  if (typeof raw.uncategorised === 'string') params.uncategorised = raw.uncategorised;

  const edges = (raw.edges ?? {}) as { show?: unknown };
  if (Array.isArray(edges.show)) params.edges = edges.show.map(String).join(',');

  // `face: { chips }` was a wrapper around one key once `size` went; `cardFacets`
  // and `columns` were earlier spellings of the same list.
  const face = (raw.face ?? {}) as { chips?: unknown };
  const chips = raw.chips ?? face.chips ?? raw.cardFacets ?? raw.columns;
  if (Array.isArray(chips)) params.chips = chips.map(String).join(',');

  const spec = parseSpec(params);
  spec.name = name;
  spec.title = String(raw.title ?? name);

  const nodes = raw.nodes as Record<string, { x?: number; y?: number }> | undefined;
  if (nodes && typeof nodes === 'object') spec.nodes = nodes;
  const order = raw.order as Record<string, string[]> | undefined;
  if (order && typeof order === 'object') spec.order = order;
  return spec;
}

/** What gets written for *save current as…*: the query half, never arrangement. */
export function specToFile(spec: ViewSpec, title: string): Record<string, unknown> {
  const q = spec.query;
  const filter: Record<string, string[]> = {};
  for (const [facet, picked] of Object.entries(q.filter ?? {})) {
    if (picked.length) filter[facet] = picked;
  }
  return {
    shape: spec.shape,
    title,
    ...(Object.keys(filter).length ? { filter } : {}),
    ...(q.focus ? { focus: q.focus } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(q.groupBy?.length ? { groupBy: q.groupBy } : {}),
    ...(q.sort?.length ? { sort: q.sort } : {}),
    ...(q.uncategorised ? { uncategorised: q.uncategorised } : {}),
    ...(spec.shape === 'canvas' ? { edges: { show: spec.edges } } : {}),
    ...(spec.chips.length ? { chips: spec.chips } : {}),
  };
}
