import { DIRS, NONE, type Dir, type Shape, negate } from '../schema/vocabulary.ts';
import { SPEC_PARAMS, specToParams, type ViewSpec } from './spec.ts';

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

export function setSearch(spec: ViewSpec, q: string): ViewSpec {
  return replaceQuery(spec, { q: q.trim() ? q : undefined });
}

/**
 * Put one value of one axis into one of the three states it has: in, out, or
 * neither.
 *
 * A gesture names the state it *wants*, so both forms of the value are removed
 * first and at most one is put back. Toggling on a value that was excluded is
 * therefore one click rather than two, and — the part worth the function — two
 * clicks can never leave the axis holding `project-a` and `-project-a` at once, which is a
 * query that matches nothing and that neither click asked for.
 *
 * The wire can still carry that contradiction if a URL is written by hand, and
 * `splitSelection` says why it is answered rather than refused. What is ruled out
 * here is *arriving* at it by clicking.
 *
 * The values come off the spec this is given, which was the whole of the earlier
 * fix here: the old version read them off the URL while the checkbox rendered from
 * the resolved spec, so on `?view=home` a *checked* `planning` had an empty
 * current list and toggling it produced "only planning" — silently dropping
 * `active`.
 */
function pickFilterValue(
  spec: ViewSpec,
  facet: string,
  value: string,
  want: 'in' | 'out',
): ViewSpec {
  const current = spec.query.filter?.[facet] ?? [];
  const token = want === 'in' ? value : negate(value);
  const held = current.includes(token);
  const without = current.filter((v) => v !== value && v !== negate(value));
  return replaceQuery(spec, {
    filter: { ...spec.query.filter, [facet]: held ? without : [...without, token] },
  });
}

export function toggleFilterValue(spec: ViewSpec, facet: string, value: string): ViewSpec {
  return pickFilterValue(spec, facet, value, 'in');
}

/**
 * Filter a value *out* — the gesture a high-cardinality axis needs.
 *
 * Excluding one project is not selecting the other twelve: it keeps every note
 * with no project at all, and it stays true when a thirteenth arrives. See `NOT`.
 */
export function excludeFilterValue(spec: ViewSpec, facet: string, value: string): ViewSpec {
  return pickFilterValue(spec, facet, value, 'out');
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
      ...(focus.via ?? prev?.via ? { via: focus.via ?? prev?.via } : {}),
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
 *
 * **`search` is the third side, and leaving it out made a whole class of override
 * unclearable.** A patch only mentions keys it can see, and it was computed from
 * two specs — so a key that lives *only* in the URL was mentioned by neither. On
 * a saved view that never showed, because the saved side carried the key and so
 * the loop visited it. On an ad-hoc query it meant `focus`, `q` and `group` could
 * be set from the URL and never removed: the ✕ ran, the spec lost its focus, and
 * the patch that came back said nothing about it. `blankQuery` below documents the
 * mirror image of the same mistake — iterating one side cannot clear the other's.
 *
 * Only *override* keys are taken from the URL. `card` and `view` live there too
 * and are neither: `card` is which panel is open and `view` is which saved view
 * the diff is *against*. Unioning them in would close the panel and drop the view
 * on every edit, since neither spec writes them back.
 */
export function specToPatch(next: ViewSpec, saved: ViewSpec | null, search = ''): Patch {
  const to = specToParams(next);
  const from = saved ? specToParams(saved) : {};
  const inUrl = [...new URLSearchParams(search.replace(/^\?/, '')).keys()].filter(
    (k) => k !== 'view' && ((SPEC_PARAMS as readonly string[]).includes(k) || k.startsWith('f.')),
  );
  const patch: Patch = {};

  for (const key of new Set([...Object.keys(to), ...Object.keys(from), ...inUrl])) {
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

/**
 * Drop every override, optionally landing on a view.
 *
 * `SPEC_PARAMS` covers the fixed keys, and the facet filters have to come from
 * somewhere too — they are `f.<facet>`, one per axis, so there is no fixed list of
 * them. Both the URL's and the resolved spec's are cleared: iterating only the URL
 * cannot clear a key the *saved view* supplies, and iterating only the spec cannot
 * clear an override for an axis the spec no longer carries.
 */
export function blankQuery(spec: ViewSpec | null, search: string, view: string | null = null): Patch {
  const patch: Patch = {};
  for (const key of SPEC_PARAMS) patch[key] = null;
  for (const facet of Object.keys(spec?.query.filter ?? {})) patch[`f.${facet}`] = null;
  for (const key of new URLSearchParams(search.replace(/^\?/, '')).keys()) {
    if (key.startsWith('f.')) patch[key] = null;
  }
  if (view) patch.view = view;
  return patch;
}

/**
 * The parameters a change of *view* is not entitled to touch.
 *
 * Everything else in a spec answers "what is this view" — a canvas view is a
 * canvas, `due` groups by `due`, `project-a` walks `parent` out of one note — so
 * landing on a view means taking its answers. A text search does not answer
 * that. It is what you are looking *for*, carried from view to view the way
 * `?note=` and `?sel=` are, and having to retype it at every hop is the whole
 * reason it is here.
 *
 * One entry, and a list rather than a special case, because the question it
 * settles ("is this the view's to say?") is the one a new parameter has to be
 * asked too.
 */
const CARRIED: readonly string[] = ['q'];

/**
 * Land on another saved view.
 *
 * A blank query plus the name, minus whatever the URL carries that the new view
 * has no opinion on. The *override* rides along and the old view's own `q:` does
 * not: the spec's search is whichever of those two won, so reading it here would
 * turn a view's stored search into a sticky one that outlives the view.
 *
 * A key left out of the patch is a key `patchSearch` does not write, so the URL
 * keeps it verbatim — which is also why an explicitly empty `q=` is *not* carried
 * and falls through to `blankQuery`'s `null`. Empty means "this view's search,
 * suppressed", and it stops meaning anything the moment the view changes.
 */
export function changeView(spec: ViewSpec | null, search: string, view: string): Patch {
  const patch = blankQuery(spec, search, view);
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  for (const key of CARRIED) if (params.get(key)) delete patch[key];
  return patch;
}

/** Whether a patch says anything — which is exactly "this view has unsaved changes". */
export function patchIsEmpty(patch: Patch): boolean {
  return Object.values(patch).every((v) => v === null);
}

export { NONE, DIRS };
