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

/** A reference facet holds note ids: it is a relation, and it can be walked. */
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
 * A reference facet is stored on the note that *depends* — `parent` on the
 * child, `project` on the member, `blocked_by` on the note that is stuck — and
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
 * The hue families the stylesheet offers, which a facet's `hue:` picks from.
 *
 * The app owns the palette and the vault owns the choice — so this list is not a
 * facet name and belongs in code, while which axis takes which does not. It is
 * here rather than in `facets.ts` for the usual reason: the validator, the loader
 * and the client all need it, and this module reads no file.
 *
 * `theme.test.ts` holds it against the stylesheet, so a family named here with no
 * rule behind it is a build failure rather than a grey chip.
 */
export const HUES: readonly string[] = ['orange', 'green', 'purple', 'blue', 'pink', 'red', 'yellow'];

/**
 * The absence refinement, as it travels.
 *
 * `(none)` rather than a bare `none`, so a facet that one day carries a literal
 * value `none` cannot collide with "this note has no value for this axis".
 */
export const NONE = '(none)';

/**
 * The computed axis that says where a note sits in the reference graph.
 *
 * `project` · `node` · `plain` — configuration, named-by-something, neither. It is
 * the only axis of any kind whose value is a fact about a note's *position* rather
 * than about the note, which is why `setFocus` singles it out: a focus is also a
 * selection by position, so the two are one question asked twice and a focus is
 * the more specific answer. Every other axis, computed or stored, survives a focus
 * untouched, because "only what is due this week" is a preference and stays one.
 *
 * Here rather than in `index/query.ts`, where the axis itself lives, for the
 * reason at the top of this file: `intents.ts` is imported by the browser and
 * `query.ts` reaches `node:fs` through the facet loader. `COMPUTED` keys itself
 * from this constant, so the name cannot drift from the axis.
 */
export const STRUCTURE_AXIS = 'type';

/**
 * Filtering something *out*.
 *
 * A filter value is already not only a value: `(none)` is a refinement and
 * `>2026-09-01` is a range. This is the third — a negation, living beside `NONE`
 * for the same reason, that the URL, a `views/*.yaml` file, `pj --filter` and the
 * browser all have to read it the same way.
 *
 * It is **not** "select every other value", which is what it replaces, and it
 * differs from that twice over. It keeps the notes that carry *no* value on the
 * axis — most notes carry no project, so "hide this project" has to leave them
 * where they are — and it stays true when the vocabulary grows a value nobody has
 * ticked. Both are the reason a high-cardinality axis needs it at all: selecting
 * the other twelve projects is not the same query, and it stops being even close
 * on the day a thirteenth appears.
 *
 * `-` rather than `!` because the URL is the view (C9): `URLSearchParams`
 * percent-encodes `!`, and `?f.project=%21tos` is not something you can read in an
 * address bar. The cost is a collision with a literal negative number on a
 * `type: number` facet — no vault declares one, the seed does not offer one, and
 * numeric filtering goes through ranges, which is where a negative bound is
 * already spelled `>=-1`.
 */
export const NOT = '-';

/** A bare `-` is a value, not a negation of nothing. */
export function isNegated(value: string): boolean {
  return value.startsWith(NOT) && value.length > NOT.length;
}

export function negate(value: string): string {
  return `${NOT}${value}`;
}

/** The value a negation names, or the value itself. */
export function negated(value: string): string {
  return isNegated(value) ? value.slice(NOT.length) : value;
}

/**
 * One axis's selection, split into what it admits and what it rules out.
 *
 * Both halves apply, and that is the point: `f.project=project-a,-project-b` is "in project-a and
 * not in project-b", which a multi-valued axis can hold and which no positive selection
 * can express at any length. On a single-valued axis the negation is redundant
 * beside a positive and harmless — the same value cannot be both.
 *
 * A value named on both sides is a contradiction the wire can carry. Its honest
 * answer is an empty result rather than an error, so nothing here refuses it.
 */
export function splitSelection(selection: readonly string[]): {
  wanted: string[];
  unwanted: string[];
} {
  const wanted: string[] = [];
  const unwanted: string[] = [];
  for (const value of selection) {
    if (isNegated(value)) unwanted.push(negated(value));
    else wanted.push(value);
  }
  return { wanted, unwanted };
}

/** The three projections of one note database. */
export type Shape = 'board' | 'canvas' | 'table';

export const SHAPES: readonly Shape[] = ['board', 'canvas', 'table'];

/** Which way a focus traversal walks a reference facet. */
export type Dir = 'out' | 'in' | 'both';

export const DIRS: readonly Dir[] = ['out', 'in', 'both'];
