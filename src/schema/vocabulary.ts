import type { FacetDef } from './types.ts';

/**
 * The wire primitives — the handful of values that a URL, a `views/*.yaml` file,
 * `pj` flags and the browser all have to agree on.
 *
 * They are here rather than beside the code that uses them most because of where
 * they are used *least conveniently*. `NONE` lived in `index/query.ts`, which
 * imports the facet loader, which imports `node:fs` — so the one module that
 * understands the wire encoding, `view/spec.ts`, could not be imported by the
 * client, and the client re-declared `NONE` in the drag module and transcribed
 * 183 lines of types by hand. A constant that three tiers must share belongs
 * below all three.
 *
 * Nothing here reads a file or touches a database. That is the whole point — which
 * is also why the two predicates about a facet's *type* live here rather than in
 * `facets.ts`, whose one job that needs `node:fs` is loading the file.
 */

/** A reference facet holds record ids: it is a relation, and it can be walked. */
export function isRef(def: FacetDef | undefined): boolean {
  return def?.type === 'ref';
}

/** An ordered facet compares its values rather than matching them. */
export function isOrdered(def: FacetDef | undefined): boolean {
  return def?.type === 'date' || def?.type === 'number';
}

/**
 * The absence refinement, as it travels.
 *
 * `(none)` rather than a bare `none`, so a facet that one day carries a literal
 * value `none` cannot collide with "this record has no value for this axis".
 */
export const NONE = '(none)';

/** The three projections of one card database. */
export type Shape = 'board' | 'canvas' | 'table';

export const SHAPES: readonly Shape[] = ['board', 'canvas', 'table'];

/** Which way a focus traversal walks a reference facet. */
export type Dir = 'out' | 'in' | 'both';

export const DIRS: readonly Dir[] = ['out', 'in', 'both'];
