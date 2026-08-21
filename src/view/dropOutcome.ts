import { NONE, isRef } from '../schema/vocabulary.ts';
import type { Facets } from '../schema/types.ts';

/**
 * What a drop means, decided in one place.
 *
 * The board used to decide this across a `useEffect` body, four early returns and
 * a JSX closure, with a 35-line tested module beside it covering the two easiest
 * parts. Everything that could be wrong was in the untested half, and two things
 * were: a drop wrote different values depending on how many cards happened to be
 * selected — shift-dragging `now`→`month` removed `now` for one card and `month`
 * for two — and a reorder under a secondary grouping axis spliced a per-lane
 * index into the cross-lane list, landing the card somewhere else.
 *
 * So the geometry, the selection and the modifiers go in, and an *intent* comes
 * out. The caller translates an intent into a request and nothing else. Both
 * inputs and output are plain data, which is why this is testable without a DOM.
 */

export type DragMode = 'replace' | 'add' | 'remove';

/** Which mode a drop means, from the modifier keys held at the moment of release. */
export function modeFor(input: { altKey?: boolean; shiftKey?: boolean }): DragMode {
  if (input.shiftKey) return 'remove';
  if (input.altKey) return 'add';
  return 'replace';
}

/**
 * The new values of one card's grouped facet after a drop.
 *
 * Plain drag replaces, matching Trello muscle memory. Holding ⌥ adds instead, so
 * a card deliberately sits in two columns at once; ⇧ removes only the value it
 * was dragged from. "Card in two columns" is therefore always a gesture, never
 * an accident — which is what makes a multi-valued grouping facet safe to use.
 *
 * Dropping into the uncategorised column clears the facet.
 *
 * It reads `current`, so it is **per card**. That is the whole reason the bulk
 * path may not compute values of its own: twelve cards dragged together each need
 * their own answer, and a uniform `values` array cannot express one.
 */
export function nextValues(
  current: string[],
  from: string,
  to: string,
  mode: DragMode,
): string[] {
  const fromValue = from === NONE ? '' : from;
  const without = current.filter((v) => v !== fromValue);
  if (mode === 'remove') return without;
  if (mode === 'add') return to === NONE || current.includes(to) ? current : [...current, to];
  if (to === NONE) return without;
  return [...without.filter((v) => v !== to), to];
}

// ---------------------------------------------------------------- intents

/** Rewrite one column's card order. Only possible where there is a file to store it in. */
export interface ReorderIntent {
  kind: 'reorder';
  column: string;
  ids: string[];
}

/**
 * Move cards along a facet. `from`/`to`/`mode` rather than final values, because
 * the values are per card and the server applies `nextValues` to each.
 */
export interface FacetIntent {
  kind: 'facet';
  ids: string[];
  facet: string;
  from: string;
  to: string;
  mode: DragMode;
}

/** Nothing to do, and why — four silent early returns used to live here. */
export interface NoIntent {
  kind: 'none';
  why:
    | 'no column under the pointer'
    | 'no card being dragged'
    | 'dropped where it already was'
    | 'order has nowhere to live without a saved view';
}

export type DropIntent = ReorderIntent | FacetIntent | NoIntent;

export interface DropInput {
  /** The dragged card, and the column it came from. */
  cardId: string;
  from: string;
  /** The column dropped into, if the pointer was over one. */
  to: string | null;
  /**
   * The card dropped onto and where in it, if any. `below` decides which side of
   * that tile the card lands on — one comparison, computed by the caller from the
   * pointer and the tile's rectangle so this stays free of geometry.
   */
  onCard: { id: string; index: number; below: boolean } | null;
  /** The facet the board is grouped by. Without one, a drop cannot mean anything. */
  groupBy: string | undefined;
  mode: DragMode;
  /** Cards currently selected. A drag on an unselected card moves only that card. */
  selected: ReadonlySet<string>;
  /** The column's stored order — the same list a reorder writes back. */
  order: readonly string[];
  /** The saved view an order would be stored in, if there is one. */
  viewName: string | undefined;
}

export function dropOutcome(input: DropInput): DropIntent {
  const { cardId, from, to, onCard, groupBy, mode, selected, order, viewName } = input;
  if (!cardId) return { kind: 'none', why: 'no card being dragged' };
  if (!to) return { kind: 'none', why: 'no column under the pointer' };

  // Within a column a drag means order and nothing else.
  if (to === from) {
    if (!onCard || onCard.id === cardId) {
      return { kind: 'none', why: 'dropped where it already was' };
    }
    if (!viewName) return { kind: 'none', why: 'order has nowhere to live without a saved view' };

    // The index and the list it lands in must be the same list. It used to be the
    // per-lane cell's index spliced into the cross-lane column, which agreed only
    // when there was no second axis.
    const at = onCard.index + (onCard.below ? 1 : 0);
    const cut = order.indexOf(cardId);
    const without = order.filter((id) => id !== cardId);
    const index = cut !== -1 && cut < at ? at - 1 : at;
    return {
      kind: 'reorder',
      column: to,
      ids: [...without.slice(0, index), cardId, ...without.slice(index)],
    };
  }

  if (!groupBy) return { kind: 'none', why: 'no column under the pointer' };
  // Dragging a card that is not part of the selection moves just that card.
  const ids = selected.has(cardId) ? [...selected] : [cardId];
  return { kind: 'facet', ids, facet: groupBy, from, to, mode };
}

/**
 * Connecting two nodes on a canvas: a reference facet gaining a value.
 *
 * A different gesture from a board drop — no columns, no order, no selection — but
 * the same *write*, so it returns the same intent and lands on the same targeted
 * path. It used to spread the whole facet map from a possibly-stale payload, and
 * to re-derive "which way does this relation point" from `single` rather than
 * using the `layout` the server sends for exactly that reason.
 */
export function connectOutcome(input: {
  source: string;
  target: string;
  relation: string;
  facets: Facets;
  /** The relation the canvas lays out by, as sent in the payload. */
  layout: string | null;
  /**
   * What a record already says for this relation. A lookup rather than an array,
   * because which record *owns* the edge is decided below — a hierarchy flips it.
   */
  valuesOf: (id: string) => readonly string[];
}): DropIntent {
  const { source, target, relation, facets, layout, valuesOf } = input;
  if (!isRef(facets[relation])) return { kind: 'none', why: 'no column under the pointer' };

  // A hierarchy edge is stored on the child pointing up, so dragging parent→child
  // writes the child. Which relation is the hierarchy is the server's answer.
  const single = facets[relation]?.single === true;
  const hierarchy = relation === layout && single;
  const owner = hierarchy ? target : source;
  const to = hierarchy ? source : target;
  if (owner === to) return { kind: 'none', why: 'dropped where it already was' };
  const current = valuesOf(owner);
  if (current.includes(to)) return { kind: 'none', why: 'dropped where it already was' };

  // A single-valued relation *moves*: the value it already holds is the `from`, so
  // `nextValues` takes it off and puts the new one on. A multi-valued one adds,
  // keeping whatever the record already says.
  return single
    ? { kind: 'facet', ids: [owner], facet: relation, from: current[0] ?? '', to, mode: 'replace' }
    : { kind: 'facet', ids: [owner], facet: relation, from: '', to, mode: 'add' };
}
