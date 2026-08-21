import { NONE } from './views/dragSemantics.ts';
import type { Meta, Query, Shape, ViewSpec } from './types.ts';

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
const VIEW_PARAM = 'view';

/** Params that belong to the query, so the rest can be preserved verbatim. */
function isQueryParam(key: string): boolean {
  return (
    key.startsWith('f.') ||
    ['view', 'shape', 'group', 'sort', 'q', 'focus', 'via', 'dir', 'depth', 'connect', 'edges', 'chips', 'uncategorised'].includes(key)
  );
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

export function openCardOf(search: string): string | null {
  return paramsOf(search).get(CARD_PARAM);
}

export function savedViewOf(search: string): string | null {
  return paramsOf(search).get(VIEW_PARAM);
}

// ---------------------------------------------------------------- writing

export type Patch = Record<string, string | null>;

/**
 * Apply a patch to the current search string. `null` removes a key; `''` keeps it
 * with an empty value, which for `f.<facet>` is the difference between "no
 * opinion" and "explicitly nothing" — the latter is how the URL overrides a
 * saved view's default selection instead of inheriting it.
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

/**
 * Toggling one facet value.
 *
 * A value already selected is removed; the last one going out leaves the key
 * present and empty rather than absent, because a saved view whose default is
 * `status: [planning, active]` must be overridable to "any status" — and an
 * absent key means "inherit", not "none".
 */
export function toggleValue(search: string, facet: string, value: string, saved: boolean): Patch {
  const key = `f.${facet}`;
  const current = wireValues(paramsOf(search).get(key));
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  if (next.length) return { [key]: next.map(toWire).join(',') };
  // Nothing selected: drop the key outright unless a saved view would refill it.
  return { [key]: saved ? '' : null };
}

export function clearFilters(search: string, saved: boolean): Patch {
  const patch: Patch = { q: null, ...clearFocus(saved) };
  for (const key of paramsOf(search).keys()) {
    if (key.startsWith('f.')) patch[key] = saved ? '' : null;
  }
  return patch;
}

/**
 * Removing the focus.
 *
 * Deleting the key is not enough on a saved view: the server merges the file's
 * parameters under the URL's, so an absent `focus` means "inherit" and the saved
 * one comes straight back. An empty one means "explicitly none" — the same
 * sentinel the facet filters use, for the same reason.
 */
export function clearFocus(saved: boolean): Patch {
  return { focus: saved ? '' : null, via: null, dir: null, depth: null };
}

/** `(none)` travels as itself so a literal value `none` cannot collide with it. */
function toWire(value: string): string {
  return value === NONE ? '(none)' : value;
}

function wireValues(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v === '(none)' ? NONE : v));
}

// ---------------------------------------------------------------- reading back

/**
 * Whether the URL diverges from the saved view it names — what the sidebar shows
 * as *modified*. Compared on the wire form rather than the parsed objects: the
 * server already merged them, so the question is only which keys were overridden.
 */
export function overriddenKeys(search: string, spec: ViewSpec | undefined): string[] {
  if (!spec?.name) return [];
  const params = paramsOf(search);
  const out: string[] = [];
  for (const [key] of params) {
    if (key === VIEW_PARAM || key === CARD_PARAM || !isQueryParam(key)) continue;
    out.push(key);
  }
  return out;
}

export const SHAPES: { value: Shape; label: string }[] = [
  { value: 'board', label: 'Board' },
  { value: 'canvas', label: 'Canvas' },
  { value: 'table', label: 'Table' },
];

export const DIRS = ['out', 'in', 'both'] as const;

/** Edge types, while `parent` and `blocks` are still edges rather than references. */
const EDGE_TYPES = ['parent', 'blocks'] as const;

/**
 * Every relation a focus can walk and a canvas can draw.
 *
 * Reference facets come from the vocabulary rather than a list here, so
 * declaring one in `facets.yaml` is all it takes for it to appear in both
 * controls — there is no second place naming the relations that exist.
 */
export function relations(meta: Meta): string[] {
  const refs = Object.entries(meta.facets)
    .filter(([, def]) => def.ref)
    .map(([name]) => name);
  return [...EDGE_TYPES, ...refs];
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

/** Which facet a drag writes, so the board can say so before you drag. */
export function dragFacet(query: Query): string | null {
  return query.groupBy?.[0] ?? null;
}

/**
 * Stored card order first, then everything else in the order the query produced.
 *
 * Ordering three cards out of sixty pins those three to the top rather than
 * scattering the rest, and a card that appears later is never lost — it lands at
 * the end instead of vanishing from a list that did not mention it.
 */
export function applyOrder(ids: string[], order: string[] | undefined): string[] {
  if (!order?.length) return ids;
  const have = new Set(ids);
  const pinned = order.filter((id) => have.has(id));
  const seen = new Set(pinned);
  return [...pinned, ...ids.filter((id) => !seen.has(id))];
}
