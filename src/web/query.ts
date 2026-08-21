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
 * not what you are looking at, and it predates the query model.
 */

export const CARD_PARAM = 'card';

/** Params that belong to the query, so the rest can be preserved verbatim. */
function isQueryParam(key: string): boolean {
  return key.startsWith('f.') || (SPEC_PARAMS as readonly string[]).includes(key);
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
  const bits: string[] = [`${total} ${spec.shape === 'canvas' ? 'records' : 'cards'}`];
  const q = spec.query;
  const filters = Object.entries(q.filter ?? {}).filter(([, v]) => v.length);
  if (filters.length) bits.push(filters.map(([f, v]) => `${f}=${v.join('|')}`).join(' '));
  if (q.focus) bits.push(`${q.focus.via} ${q.focus.dir} from ${q.focus.id}`);
  if (q.q) bits.push(`"${q.q}"`);
  if (q.groupBy?.length) bits.push(`by ${q.groupBy.join(' × ')}`);
  return bits.join(' · ');
}

