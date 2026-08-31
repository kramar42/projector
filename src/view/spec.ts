import type { Focus, Query } from '../index/query.ts';
import { DIRS, LISTS_AXIS, NONE, SHAPES, type Dir, type Shape } from '../schema/vocabulary.ts';
import {
  CAL_COLS_PARAM,
  CAL_ROWS_PARAM,
  CAL_START_PARAM,
  WEEK_DAYS,
  type CalendarConfig,
} from './calendar.ts';

export { DIRS, LISTS_AXIS, NONE, SHAPES, type Dir, type Shape };

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
 * was short by `shape` and `show`, so `pj ls --shape graph`
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
  CAL_COLS_PARAM,
  CAL_ROWS_PARAM,
  CAL_START_PARAM,
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
   * that *and* a line on a graph, and the first reference in this list is what
   * the graph lays out by. There used to be two keys — `chips` and
   * `edges.show` — asking the same question, and "why does my graph draw
   * nothing" was answered by the one you forgot.
   */
  show: string[];
  /** Reusable calendar geometry; the page anchor remains URL-only. */
  calendar?: CalendarConfig;
  /**
   * What to say when this view draws nothing, for a view whose emptiness is the
   * *goal* rather than a problem.
   *
   * `src/view/empty.ts` explains an empty result from facts — the filter, the
   * search, an axis nothing carries — and every one of those explanations reads
   * as a failure. On a queue, a rule board or a nudge list, an empty result is
   * the thing you were working towards, and reporting it as "no note matches
   * this filter" tells you nothing worked at the one moment something did.
   *
   * Which of the two a view is cannot be derived — it is what the view is *for*
   * — so this is a saved-file key with no live control and no URL, like `lists`
   * and the arrangement (C9).
   */
  whenEmpty?: string;
  /** Saved views only: positions, and card order within a column. */
  nodes?: Record<string, { x?: number; y?: number }>;
  order?: Record<string, string[]>;
  /**
   * The views this one draws as columns, in order — a **composition**.
   *
   * By reference rather than inline, because the same file is then two things at
   * once — a column here and a rule `pj audit` runs — and one object cannot
   * disagree with itself. One level deep: a view named here may not name others.
   *
   * Saved-file only, like `nodes` and `order` (C9). A composition is
   * hand-curated rather than derivable, so there is no live control that builds
   * one and no URL that carries it.
   *
   * Naming any makes `LISTS_AXIS` this view's primary grouping — implicitly, so
   * a file need not spell `groupBy: [lists]`, though it may. Everything else
   * stays a live control: `shape` draws it as a board, a table or a graph, a
   * second `groupBy` entry makes lanes, and `sort` and the filter apply across
   * every column. It was a *shape* once, which had to forbid the other three and
   * could not say why.
   */
  lists?: string[];
  /**
   * Keep this view out of the picker.
   *
   * Not hidden — `pj ls --view <name>` runs it, `pj audit` enumerates it, and it
   * is drawn in plain sight as a column of whatever composes it. It is absent
   * from the *index*, which is why the word is `unlisted` rather than `hidden`.
   *
   * Declared rather than derived from "is a column of something", because the
   * rules that are a column of nothing — an audit rule standing alone — want it
   * just as much, and a picker that silently loses entries when a composition is
   * added elsewhere is a surprise.
   */
  unlisted?: boolean;
  /**
   * What `pj audit` asserts about this view's result.
   *
   * `empty` is an *invariant*: zero is the only correct state and a violation
   * means something is inconsistent. Deliberately not an integer, which would
   * fold a *budget* — "about seven things this week" — into the same key, and a
   * budget overrun is not a defect. That distinction is the same line `pj check`
   * and `pj audit` draw, one level down. If a cap ever earns its place this
   * becomes `{ max: n }` with `empty` kept as sugar for zero.
   */
  expect?: 'empty';
}

// ---------------------------------------------------------------- parsing

function one<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * `canvas` was the original wire name for the graph projection. Keep old URLs
 * and saved views legible, but resolve them immediately so every new write uses
 * the name the reader sees.
 */
function shapeOf(raw: unknown): Shape {
  const value = String(raw ?? '');
  if (value === 'canvas') return 'graph';
  return one(value, SHAPES) ?? 'table';
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

  const shape = shapeOf(params.shape);

  const calendar: CalendarConfig = {};
  const days = Number(params[CAL_COLS_PARAM]);
  if (Number.isInteger(days) && days >= 1 && days <= 14) calendar.days = days;
  const rows = Number(params[CAL_ROWS_PARAM]);
  if (Number.isInteger(rows) && rows >= 1 && rows <= 12) calendar.rows = rows;
  if ((WEEK_DAYS as readonly string[]).includes(params[CAL_START_PARAM] ?? '')) {
    calendar.starts = params[CAL_START_PARAM] as CalendarConfig['starts'];
  }

  return {
    shape,
    query,
    // Facet names are not checked against a list, for the same reason `via` is
    // not: one declared in `facets.yaml` must work without a second place
    // enumerating what exists. An unknown one draws nothing.
    show: list(params.show),
    ...(Object.keys(calendar).length ? { calendar } : {}),
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
  if (spec.calendar?.days !== undefined) out[CAL_COLS_PARAM] = String(spec.calendar.days);
  if (spec.calendar?.rows !== undefined) out[CAL_ROWS_PARAM] = String(spec.calendar.rows);
  if (spec.calendar?.starts !== undefined) out[CAL_START_PARAM] = spec.calendar.starts;
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
 * A view file was the one document nothing checked the *shape* of. Note
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
  'calendar',
  // Composition and the two flags that ride with it. Saved-file only: no live
  // control writes them, so `specToFile` never emits one and only `specFromFile`
  // below reads them.
  'lists',
  'unlisted',
  'expect',
  // What an empty result means here, when it means success. Saved-file only for
  // the same reason: no control can derive what a view is *for*.
  'whenEmpty',
  // Arrangement. Written by `saveArrangement`, never by hand.
  'nodes',
  'order',
];

export function specFromFile(name: string, raw: Record<string, unknown>): ViewSpec {
  const params: Record<string, string> = {};
  params.shape = shapeOf(raw.shape);

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

  const calendar = raw.calendar as Record<string, unknown> | undefined;
  if (calendar && typeof calendar === 'object') {
    // `days`/`starts` follow the labels in the calendar controls. The internal
    // URL names remain `cols`/`start` because they describe page arithmetic.
    if (calendar.days !== undefined) params[CAL_COLS_PARAM] = String(calendar.days);
    if (calendar.rows !== undefined) params[CAL_ROWS_PARAM] = String(calendar.rows);
    if (calendar.starts !== undefined) params[CAL_START_PARAM] = String(calendar.starts);
  }

  const spec = parseSpec(params);
  spec.name = name;
  spec.title = String(raw.title ?? name);

  if (Array.isArray(raw.lists)) spec.lists = raw.lists.map(String);
  if (typeof raw.whenEmpty === 'string' && raw.whenEmpty.trim()) {
    spec.whenEmpty = raw.whenEmpty.trim();
  }
  if (raw.unlisted === true) spec.unlisted = true;
  if (raw.expect === 'empty') spec.expect = 'empty';

  // The same pin `withSavedOnly` applies, for the callers that never see a URL:
  // `pj ls --view`, `pj audit`, and every read of the view index. Without it a
  // composition drew its columns only when it arrived through the server.
  //
  // `shape: lists` in an older file lands on `table` by itself — it is not in
  // `SHAPES` any more, so `one()` falls through to the default — which is what
  // it always drew. `pj check` names it so the word can be dropped.
  if (spec.lists?.length) {
    const rest = (spec.query.groupBy ?? []).filter((axis) => axis !== LISTS_AXIS);
    spec.query.groupBy = [LISTS_AXIS, ...rest].slice(0, 2);
  }

  const nodes = raw.nodes as Record<string, { x?: number; y?: number }> | undefined;
  if (nodes && typeof nodes === 'object') spec.nodes = nodes;
  const order = raw.order as Record<string, string[]> | undefined;
  if (order && typeof order === 'object') spec.order = order;
  return spec;
}

/** What gets written for *save current as…*: the complete view currently on screen. */
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
    ...(spec.calendar && Object.keys(spec.calendar).length ? { calendar: spec.calendar } : {}),
    ...(spec.lists?.length ? { lists: spec.lists } : {}),
    ...(spec.unlisted ? { unlisted: true } : {}),
    ...(spec.whenEmpty ? { whenEmpty: spec.whenEmpty } : {}),
    ...(spec.expect ? { expect: spec.expect } : {}),
    ...(spec.nodes ? { nodes: spec.nodes } : {}),
    ...(spec.order ? { order: spec.order } : {}),
  };
}

/**
 * Carry a saved view's file-only keys onto the spec resolved from it.
 *
 * `specToParams`/`parseSpec` is the *query* round-trip, and deliberately narrow:
 * everything it carries is a live control. Arrangement and composition are
 * neither, so they survive a resolve only by being copied across — and both the
 * server (a URL over a saved view) and `pj ls --view` have to do it.
 *
 * One function because it was one line in the server and none in the CLI, which
 * is why `pj ls --view portfolio` quietly ignored a column's curated order. A
 * `lists` view would have failed the same way and far louder: every column
 * dropped, the board drawn empty, and nothing to say why.
 */
export function withSavedOnly(spec: ViewSpec, saved: ViewSpec | null | undefined): ViewSpec {
  spec.name = saved?.name;
  spec.title = saved?.title;
  spec.nodes = saved?.nodes;
  spec.order = saved?.order;
  spec.lists = saved?.lists;
  spec.unlisted = saved?.unlisted;
  spec.whenEmpty = saved?.whenEmpty;
  spec.expect = saved?.expect;
  // A composition's *primary* grouping is not an override anyone can win.
  //
  // Everything else about it is: the shape, the sort, the filter and a second
  // grouping axis are the same live controls they are on any other view, which
  // is the whole point of `LISTS_AXIS` being an axis rather than a shape. But
  // the columns *are* the children, so the first grouping position is spoken
  // for, and a URL that says otherwise is asking for a view this file is not.
  //
  // Written here rather than required in the file so `lists:` alone is a
  // complete composition, and re-asserted rather than trusted so `?group=` can
  // add a lane axis without being able to displace the columns.
  if (spec.lists?.length) {
    const rest = (spec.query.groupBy ?? []).filter((axis) => axis !== LISTS_AXIS);
    // Two levels, as everywhere: columns and lanes. There is no third to draw.
    spec.query.groupBy = [LISTS_AXIS, ...rest].slice(0, 2);
  }
  return spec;
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
  return views
    // `unlisted` is honoured here rather than at either call site, because this
    // is the only projection both of them use: filtering downstream is how the
    // picker and the payload would come to disagree about what exists.
    .filter((v) => !v.unlisted)
    .map((v) => ({
      name: v.name ?? '',
      title: v.title ?? v.name ?? '',
      shape: v.shape,
    }));
}
