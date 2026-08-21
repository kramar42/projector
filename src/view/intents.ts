import { DIRS, NONE, type Dir, type Shape } from '../schema/vocabulary.ts';
import { specToParams, type ViewSpec } from './spec.ts';

/**
 * Editing a view, as operations on a `ViewSpec`.
 *
 * The sidebar used to edit the *URL* — nine hand-built encodings of things
 * `specToParams` already knows how to write, plus its own idea of what a
 * parameter is. That is how a control came to read the resolved spec and write
 * the query string, which produced two bugs that could only exist in the gap
 * between them: unchecking a value on a saved view narrowed the filter instead of
 * clearing it, and "clear" did nothing at all to a saved view's filters.
 *
 * So a control names what it wants — `toggleFilterValue(spec, 'status', 'done')`
 * — and one place turns the result back into a URL. Every function here is pure
 * and takes the spec it is changing, which is also why they are testable without
 * a browser.
 */

const replaceQuery = (spec: ViewSpec, patch: Partial<ViewSpec['query']>): ViewSpec => ({
  ...spec,
  query: { ...spec.query, ...patch },
});

export function setShape(spec: ViewSpec, shape: Shape): ViewSpec {
  return { ...spec, shape };
}

export function setShow(spec: ViewSpec, show: string[]): ViewSpec {
  return { ...spec, show };
}

/**
 * Set one grouping axis by position: 0 is the primary, 1 the secondary.
 *
 * Clearing the primary while a secondary is set promotes the secondary rather
 * than dropping both — `group=,project` has no meaning, and the sidebar's old
 * `[value, group[1]].filter(Boolean).join(',')` silently discarded the second
 * axis in exactly that case.
 */
export function setGroupBy(spec: ViewSpec, at: 0 | 1, facet: string | null): ViewSpec {
  const axes = [...(spec.query.groupBy ?? [])];
  if (facet) axes[at] = facet;
  else axes.splice(at, 1);
  const groupBy = axes.filter(Boolean).slice(0, 2);
  return replaceQuery(spec, { groupBy: groupBy.length ? groupBy : undefined });
}

export function setSort(spec: ViewSpec, key: string, dir: 'asc' | 'desc'): ViewSpec {
  return replaceQuery(spec, { sort: key ? [`${key}:${dir}`] : undefined });
}

export function setUncategorised(spec: ViewSpec, where: 'end' | 'start' | 'hide'): ViewSpec {
  return replaceQuery(spec, { uncategorised: where });
}

export function setSearch(spec: ViewSpec, q: string): ViewSpec {
  return replaceQuery(spec, { q: q.trim() ? q : undefined });
}

/**
 * Toggle one value of one facet.
 *
 * Reads the values off the spec it is given, which is the whole fix: the old
 * version read them off the URL while the checkbox rendered from the resolved
 * spec, so on `?view=home` a *checked* `planning` had an empty current list and
 * toggling it produced "only planning" — silently dropping `active`.
 */
export function toggleFilterValue(spec: ViewSpec, facet: string, value: string): ViewSpec {
  const current = spec.query.filter?.[facet] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  return replaceQuery(spec, { filter: { ...spec.query.filter, [facet]: next } });
}

/** Every facet filter emptied, plus the text search. Focus is its own control. */
export function clearFilters(spec: ViewSpec): ViewSpec {
  const filter = Object.fromEntries(Object.keys(spec.query.filter ?? {}).map((f) => [f, []]));
  return replaceQuery(spec, { filter, q: undefined });
}

export function setFocus(
  spec: ViewSpec,
  focus: { id: string; via?: string; dir?: Dir; depth?: number },
): ViewSpec {
  const prev = spec.query.focus;
  return replaceQuery(spec, {
    focus: {
      id: focus.id,
      via: focus.via ?? prev?.via ?? 'parent',
      dir: focus.dir ?? prev?.dir ?? 'in',
      ...(focus.depth ?? prev?.depth ? { depth: focus.depth ?? prev?.depth } : {}),
    },
  });
}

export function clearFocus(spec: ViewSpec): ViewSpec {
  return replaceQuery(spec, { focus: undefined });
}

// ---------------------------------------------------------------- serialising

/** `null` removes a URL key; `''` keeps it present and empty. */
export type Patch = Record<string, string | null>;

/**
 * The URL patch that turns `saved` into `next`.
 *
 * A URL carries *overrides*, because the server merges a view file's parameters
 * under the query string's — so the only honest thing to put in it is the
 * difference. Three cases, and the third is the one hand-rolled string surgery
 * kept getting wrong:
 *
 * - equal to the saved view → `null`, drop the key and inherit
 * - different → the value
 * - **empty where the saved view had something** → `''`, which is what says
 *   "explicitly nothing" rather than "no opinion". `parseSpec` reads an empty
 *   `f.status=` as an empty filter on purpose; absent would mean inherit, and the
 *   saved selection would come straight back.
 *
 * `shape` is the one key with no empty form — `parseSpec` reads `shape=` as
 * `board` rather than as "none" — and it needs none: a resolved spec always has a
 * shape, so it either differs and is written or matches and is dropped.
 */
export function specToPatch(next: ViewSpec, saved: ViewSpec | null): Patch {
  const to = specToParams(next);
  const from = saved ? specToParams(saved) : {};
  const patch: Patch = {};

  for (const key of new Set([...Object.keys(to), ...Object.keys(from)])) {
    const a = to[key];
    const b = from[key];
    if (a === b) {
      patch[key] = null;
    } else if (a === undefined || a === '') {
      // Gone from the spec, or emptied. Only worth saying when the saved view
      // would otherwise refill it — and `shape` has no empty form to say it with.
      patch[key] = b !== undefined && b !== '' && key !== 'shape' ? '' : null;
    } else {
      patch[key] = a;
    }
  }
  return patch;
}

/** Whether a patch says anything — which is exactly "this view has unsaved changes". */
export function patchIsEmpty(patch: Patch): boolean {
  return Object.values(patch).every((v) => v === null);
}

export { NONE, DIRS };
