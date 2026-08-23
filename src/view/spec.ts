import type { Focus, Query } from '../index/query.ts';
import { DIRS, NONE, SHAPES, type Dir, type Shape } from '../schema/vocabulary.ts';

export { DIRS, NONE, SHAPES, type Dir, type Shape };

/**
 * The one description of a view, shared by the three places that describe one:
 * a URL, a saved `views/*.yaml`, and `pj` flags.
 *
 * A `ViewSpec` is a `Query` plus how to draw it. The split matters: everything in
 * the query half is derivable and therefore a live control, while `nodes` and
 * `order` are hand-curated arrangement and exist only in a named file (C9).
 */

/**
 * Every parameter name a spec is made of, `f.<facet>` aside.
 *
 * One list, because there were three: this module's reader, the client's
 * "which params belong to the query" predicate, and the CLI's flag list — which
 * was short by `shape` and `show`, so `pj ls --shape canvas`
 * simply did not exist. Adding a key here is what makes every surface able to say
 * it.
 */
export const SPEC_PARAMS = [
  'view',
  'shape',
  'group',
  'sort',
  'q',
  'focus',
  'via',
  'dir',
  'depth',
  'show',
] as const;

export interface ViewSpec {
  /** Set when this came from a saved view; absent for an ad-hoc query. */
  name?: string;
  title?: string;
  shape: Shape;
  query: Query;
  /**
   * Which facets this view surfaces, in order.
   *
   * One list, because how each is drawn follows from what it is. A **label**
   * facet is a chip on a face and a column in a table; a **reference** facet is
   * that *and* a line on a canvas, and the first reference in this list is what
   * the canvas lays out by. There used to be two keys — `chips` and
   * `edges.show` — asking the same question, and "why does my canvas draw
   * nothing" was answered by the one you forgot.
   */
  show: string[];
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
  // `via` is a relation name, so it is not validated against a list here: an
  // unknown one simply finds no neighbours, which is what a stale bookmark
  // should do. Absent it stays absent — the vocabulary supplies the default,
  // and this module cannot read the vocabulary.
  const via = params.via?.trim();
  return {
    id,
    ...(via ? { via } : {}),
    dir: one(params.dir, DIRS) ?? 'in',
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

  const shape = one(params.shape, SHAPES) ?? 'board';

  return {
    shape,
    query,
    // Facet names are not checked against a list, for the same reason `via` is
    // not: one declared in `facets.yaml` must work without a second place
    // enumerating what exists. An unknown one draws nothing.
    show: list(params.show),
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
  if (q.focus) {
    out.focus = q.focus.id;
    if (q.focus.via) out.via = q.focus.via;
    out.dir = q.focus.dir;
    if (q.focus.depth !== undefined) out.depth = String(q.focus.depth);
  }
  if (spec.show.length) out.show = spec.show.join(',');
  return out;
}

// ---------------------------------------------------------------- saved views

/**
 * Read a saved view file.
 *
 * One spelling per key. A view file and a URL describe the same thing, so this
 * is the file half of `parseSpec` and nothing else — there is no second reading
 * for keys an older version wrote.
 */
/**
 * Every key a view file may hold: what `specFromFile` reads below, plus the two
 * `saveArrangement` writes.
 *
 * A view file was the one document nothing checked the *shape* of. Card
 * frontmatter has a schema and `facets.yaml` has `validateVocabulary`, but a view
 * with a misspelled or retired key parsed fine and did nothing — which is how an
 * `uncategorised:` line survived in the seeded `due.yaml` long after it had
 * stopped meaning anything there.
 *
 * It is a second list beside the reader, which is a pair that drifts. The drift
 * that actually happens is writer-first — `specToFile` learns a key and this
 * forgets — so `spec.test.ts` holds the two against each other. Reader-first
 * drift stays a human check, and is the cheaper direction: a key read but not
 * listed makes `pj check` reject a file that works, loudly.
 */
export const VIEW_KEYS: readonly string[] = [
  'shape',
  'title',
  'filter',
  'focus',
  'q',
  'groupBy',
  'sort',
  'show',
  // Arrangement. Written by `saveArrangement`, never by hand.
  'nodes',
  'order',
];

export function specFromFile(name: string, raw: Record<string, unknown>): ViewSpec {
  const params: Record<string, string> = {};
  params.shape = one(String(raw.shape ?? ''), SHAPES) ?? 'board';

  for (const [facet, value] of Object.entries((raw.filter ?? {}) as Record<string, unknown>)) {
    const picked = Array.isArray(value) ? value.map(String) : [String(value)];
    params[`f.${facet}`] = picked.join(',');
  }

  const focus = raw.focus as { id?: string; via?: string; dir?: string; depth?: number } | undefined;
  if (focus?.id) {
    params.focus = String(focus.id);
    if (focus.via) params.via = focus.via;
    params.dir = String(focus.dir ?? 'in');
    if (focus.depth !== undefined) params.depth = String(focus.depth);
  }

  if (typeof raw.q === 'string') params.q = raw.q;
  if (Array.isArray(raw.groupBy)) params.group = raw.groupBy.map(String).join(',');
  if (Array.isArray(raw.sort)) params.sort = raw.sort.map(String).join(',');
  if (Array.isArray(raw.show)) params.show = raw.show.map(String).join(',');

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
    ...(spec.show.length ? { show: spec.show } : {}),
  };
}

/** A saved view as a picker needs it: enough to list and open, not to run. */
export interface SavedViewSummary {
  name: string;
  title: string;
  shape: Shape;
}

/**
 * One projection of the view list, used by the meta route and the query payload.
 *
 * Here rather than in `src/server/` because it is a projection of a `ViewSpec` —
 * a view concept that happened to be first used by a route. Having it there made
 * `view/payload.ts` import `server/meta.ts`, which imports this file: a directory
 * cycle that survived only because the client's re-export is `export type`, so
 * erasure hid that `payload.ts` transitively reaches `node:sqlite`. `name` is optional on a `ViewSpec` because an ad-hoc spec has none;
 * a *saved* one always does, and falling back to the empty string here is what
 * stops the two routes disagreeing about which.
 */
export function summariseViews(views: ViewSpec[]): SavedViewSummary[] {
  return views.map((v) => ({
    name: v.name ?? '',
    title: v.title ?? v.name ?? '',
    shape: v.shape,
  }));
}

