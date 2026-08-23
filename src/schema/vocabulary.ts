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
 * There is no list of which relations point at their container, because they all
 * do.
 *
 * A reference facet is stored on the record that *depends* — `parent` on the
 * child, `project` on the member, `blocked_by` on the card that is stuck — and
 * points at what it depends on. So a canvas flips every reference edge to draw
 * it, and dagre gets every one the same way round, roots on the left.
 *
 * It used to be a declared list, and had to be: `blocks` was stored on the
 * blocker and pointed *away* from the root of its own dependency tree, so no
 * property of the storage separated it from the other two. Inverting that
 * relation is what turned a list of exceptions into a rule, and a rule needs no
 * key in `facets.yaml` and no field in the payload.
 *
 * A vault whose own relation genuinely points outward — `supersedes`, say — draws
 * its arrows the other way on the canvas and is otherwise unaffected. That is a
 * cosmetic wrong answer for a case nobody has yet, and `points: out` is the
 * escape hatch to add on the day somebody does, rather than in advance.
 */

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
