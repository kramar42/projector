import { SPEC_PARAMS } from '../view/spec.ts';
import type { Meta, Shape, ViewSpec } from './types.ts';

/**
 * The URL is the view (C9).
 *
 * Every control in the sidebar writes here and nowhere else, which is what makes
 * a view shareable, back-buttonable and — crucially — *not* sticky: nothing you
 * adjust survives unless you name it and it becomes a file.
 *
 * `?card=` is deliberately untouched by all of this: it is where you are looking,
 * not what you are looking at, and it predates the query model. `?sel=` joined it
 * for the same reason.
 */

export const NOTE_PARAM = 'note';

/**
 * Which notes are picked out.
 *
 * The app's, not the query's — what you have singled out rather than what you
 * asked for — and keeping it out of `isQueryParam` is load-bearing twice. A saved
 * view must not note a selection, and a click must not re-ask the server: the
 * result set cannot have changed, so a selection inside the query would spend a
 * round trip per pick to be told the same answer. It used to cost more than that —
 * `useLive` blanked its payload before refetching, so every click flashed the
 * pane to "loading…" — and the parameter has stayed out of the query for the
 * reason that outlived the flash.
 *
 * It lives in the URL rather than in a component so that it survives a change of
 * shape — the same notes are the same notes whether you are looking at a
 * board, a table or a canvas — and a reload.
 */
export const SEL_PARAM = 'sel';

/** Params that belong to the query, so the rest can be preserved verbatim. */
function isQueryParam(key: string): boolean {
  return key.startsWith('f.') || (SPEC_PARAMS as readonly string[]).includes(key);
}

/**
 * Every key the app writes: the query, which panel is open, and what is selected.
 *
 * A key missing from here is deleted from the address bar by `strippedOfStrays`,
 * so this list is what keeps `?sel=` alive rather than treating it as the fossil
 * `?filterstyle=` became.
 *
 * The vault is not here and is not missing — it lives in `localStorage`, because
 * it is which library you opened rather than what you are looking at.
 */
function isOwnParam(key: string): boolean {
  return key === NOTE_PARAM || key === SEL_PARAM || isQueryParam(key);
}

/**
 * The same search with keys the app does not own dropped — or `null` when it
 * carries none, which is the overwhelmingly common case and the caller's signal
 * that there is nothing to rewrite.
 *
 * If the URL is the view (C9), a key nothing reads is not part of it. `patchSearch`
 * preserves what it does not recognise, on purpose — it writes what it is told —
 * so a parameter that stops existing keeps riding along in any URL that was
 * bookmarked, shared or left open while it did. `?filterstyle=box|chip|edge` was
 * one: three filter-value treatments compared at real repetition, of which two
 * and the parameter were deleted, and it was still in the address bar long after
 * the code that read it was gone.
 *
 * Returning `null` rather than an unchanged string is what keeps the caller's
 * rewrite from looping: `URLSearchParams` re-encodes as it serialises, so a
 * round-trip is not guaranteed to be a fixed point and "unchanged" cannot be
 * decided by comparing the output.
 */
export function strippedOfStrays(search: string): string | null {
  const params = paramsOf(search);
  const strays = [...params.keys()].filter((k) => !isOwnParam(k));
  if (strays.length === 0) return null;
  for (const key of strays) params.delete(key);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function paramsOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

/** What to send to `/api/query`: the query params, and nothing else. */
export function apiSearch(search: string): string {
  const out = new URLSearchParams();
  for (const [k, v] of paramsOf(search)) if (isQueryParam(k)) out.append(k, v);
  const s = out.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------- writing

export type Patch = Record<string, string | null>;

/** The picked-out ids, as the URL carries them. */
export function selectionOf(search: string): Set<string> {
  const raw = paramsOf(search).get(SEL_PARAM);
  return new Set(raw ? raw.split(',').filter(Boolean) : []);
}

/**
 * The patch that writes a selection. Empty removes the key rather than writing an
 * empty one, so a cleared selection leaves no trace in a shared URL.
 */
export function selectionPatch(ids: ReadonlySet<string>): Patch {
  return { [SEL_PARAM]: ids.size ? [...ids].join(',') : null };
}

/**
 * Apply a patch to the current search string. `null` removes a key; `''` keeps it
 * present and empty.
 *
 * What those two mean is `view/intents.ts`'s business now — this only writes what
 * it is told. It used to decide as well, from the query string alone, while the
 * controls rendered from the resolved spec; a checkbox drawn from one source and
 * toggled against the other is how unchecking a saved view's filter came to
 * narrow it instead.
 */
export function patchSearch(search: string, patch: Patch): string {
  const params = paramsOf(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}






// ---------------------------------------------------------------- reading back

/** The shapes with their button labels — the only thing `vocabulary.ts` has no opinion about. */
export const SHAPES: { value: Shape; label: string }[] = [
  { value: 'board', label: 'Board' },
  { value: 'canvas', label: 'Canvas' },
  { value: 'table', label: 'Table' },
];


/**
 * Every relation a focus can walk and a canvas can draw: the reference facets.
 *
 * Read from the vocabulary rather than a list here, so declaring one in
 * `facets.yaml` is all it takes for it to appear in every control — there is no
 * second place naming the relations that exist.
 */
export function relations(meta: Meta): string[] {
  return Object.entries(meta.facets)
    .filter(([, def]) => def.type === 'ref')
    .map(([name]) => name);
}

/** A one-line reading of the query, for the sidebar footer and the page title. */
export function describe(spec: ViewSpec, total: number): string {
  const bits: string[] = [`${total} ${spec.shape === 'canvas' ? 'notes' : 'cards'}`];
  const q = spec.query;
  const filters = Object.entries(q.filter ?? {}).filter(([, v]) => v.length);
  if (filters.length) bits.push(filters.map(([f, v]) => `${f}=${v.join('|')}`).join(' '));
  if (q.focus) bits.push(`${q.focus.via} ${q.focus.dir} from ${q.focus.id}`);
  if (q.q) bits.push(`"${q.q}"`);
  if (q.groupBy?.length) bits.push(`by ${q.groupBy.join(' × ')}`);
  return bits.join(' · ');
}

