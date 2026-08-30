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
 * The new values of one note's grouped facet after a drop.
 *
 * Plain drag replaces, matching Trello muscle memory. Holding ⌥ adds instead, so
 * a card deliberately sits in two columns at once; ⇧ removes only the value it
 * was dragged from. "Card in two columns" is therefore always a gesture, never
 * an accident — which is what makes a multi-valued grouping facet safe to use.
 *
 * Dropping into the uncategorised column removes **only the value dragged from**,
 * so it clears the facet for a note that had one value on this axis and leaves a
 * multi-valued note in its other columns rather than landing it in `(none)`. For
 * such a note that makes a plain drop into `(none)` return exactly what `⇧`
 * returns — the two gestures agree where the prose above says they differ.
 *
 * Left as it is on purpose, pending a judgement about how it feels in use: the
 * alternative (`return []` here) would clear every value of the axis, and because
 * `bulkMove` applies this per `AxisMove`, a diagonal drop into a `(none)` column
 * and a `(none)` lane would clear both axes at once. `test/gesture.test.ts` pins
 * the current answer for both the one-value and the many-value case, so whichever
 * way it goes is a deliberate edit rather than a drift.
 *
 * It reads `current`, so it is **per note**. That is the whole reason the bulk
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

/** One grouping axis's endpoints. */
export interface AxisMove {
  facet: string;
  from: string;
  to: string;
}

/**
 * Move notes along one or both grouping axes. Endpoints and a mode rather than
 * final values, because the values are per note and the server applies
 * `nextValues` to each.
 *
 * `moves` is a list because a matrix board has two axes and a diagonal drag
 * crosses both, and the two travel as one write. A note is one file: two writes
 * would be two reads, two validations and two `updated` bumps, with the second
 * landing on a note the first had already changed. One write is also one thing
 * to refuse — a diagonal drop onto a value the vocabulary rejects leaves the
 * note alone rather than half moved.
 */
export interface FacetIntent {
  kind: 'facet';
  ids: string[];
  moves: AxisMove[];
  mode: DragMode;
  /** The insertion indicated on a cross-column drop, once the move has landed. */
  insertion?: { column: string; ids: string[] };
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
  /** The dragged card, and the column and lane it came from. */
  cardId: string;
  from: string;
  fromLane: string;
  /** The column dropped into, if the pointer was over one. */
  to: string | null;
  /**
   * The lane dropped into, if the board has a second axis.
   *
   * A lane is not a drop target of its own: it is read off the column tile the
   * pointer is over, so one drop reports both coordinates and a diagonal drag
   * stays one gesture.
   */
  toLane: string | null;
  /**
   * The card dropped onto and where in it, if any. `below` decides which side of
   * that tile the card lands on — one comparison, computed by the caller from the
   * pointer and the tile's rectangle so this stays free of geometry.
   */
  onCard: { id: string; index: number; below: boolean } | null;
  /** The facet the board is grouped by. Without one, a drop cannot mean anything. */
  groupBy: string | undefined;
  /**
   * The facet the second axis lanes by, if there is one.
   *
   * A drop used to write `groupBy` and nothing else, so dragging a card into
   * another swimlane did nothing at all — or, if it landed on a tile, quietly
   * rewrote the column's stored order instead, which moves nothing on screen
   * because order cannot cross a lane.
   */
  laneBy: string | undefined;
  mode: DragMode;
  /** Cards currently selected. A drag on an unselected card moves only that card. */
  selected: ReadonlySet<string>;
  /** The column's stored order — the same list a reorder writes back. */
  order: readonly string[];
  /** The saved view an order would be stored in, if there is one. */
  viewName: string | undefined;
}

/** Insert cards at a target's original index, after removing any cards that travel with them. */
function reordered(order: readonly string[], ids: readonly string[], at: number): string[] {
  const moving = new Set(ids);
  const without = order.filter((id) => !moving.has(id));
  const index = order.slice(0, at).filter((id) => !moving.has(id)).length;
  return [...without.slice(0, index), ...ids, ...without.slice(index)];
}

export function dropOutcome(input: DropInput): DropIntent {
  const { cardId, from, fromLane, to, toLane, onCard, groupBy, laneBy, mode } = input;
  const { selected, order, viewName } = input;
  if (!cardId) return { kind: 'none', why: 'no card being dragged' };
  if (!to) return { kind: 'none', why: 'no column under the pointer' };

  // Both axes are read the same way, because a lane is a grouping position and
  // not a kind of its own — the same reason there is no `swimlanes` key. A drag
  // that crosses both names two moves and still writes once.
  const moves: AxisMove[] = [];
  if (groupBy && to !== from) moves.push({ facet: groupBy, from, to });
  if (laneBy && toLane !== null && toLane !== fromLane) {
    moves.push({ facet: laneBy, from: fromLane, to: toLane });
  }

  if (moves.length) {
    // Dragging a card that is not part of the selection moves just that card.
    const ids = selected.has(cardId) ? [...selected] : [cardId];
    // A target card also names a position. Before this was intentionally ignored
    // whenever the drop crossed a facet, so the first drop only put the card in
    // the new column and the reader had to drag it a second time to honour the
    // insertion line. The stored order is shared by a column across lanes, so a
    // lane-only move can and must write that order too: its target tile is the
    // exact offset in that shared list.
    const insertion =
      onCard && viewName
        ? { column: to, ids: reordered(order, ids, onCard.index + (onCard.below ? 1 : 0)) }
        : undefined;
    return { kind: 'facet', ids, moves, mode, ...(insertion ? { insertion } : {}) };
  }

  // Nothing crossed an axis, so the drag means order and nothing else. This is
  // the only branch a same-cell drop may reach: when the lane changed it is a
  // move, so dropping a card on a tile one swimlane down no longer writes an
  // arrangement that cannot show — order is per column, and cannot cross a lane.
  if (!onCard || onCard.id === cardId) {
    return { kind: 'none', why: 'dropped where it already was' };
  }
  if (!viewName) return { kind: 'none', why: 'order has nowhere to live without a saved view' };

  // The index and the list it lands in must be the same list. It used to be the
  // per-lane cell's index spliced into the cross-lane column, which agreed only
  // when there was no second axis.
  return {
    kind: 'reorder',
    column: to,
    ids: reordered(order, [cardId], onCard.index + (onCard.below ? 1 : 0)),
  };
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
   * What a note already says for this relation. A lookup rather than an array,
   * because which note *owns* the edge is decided below — a hierarchy flips it.
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
  // keeping whatever the note already says.
  return single
    ? { kind: 'facet', ids: [owner], moves: [{ facet: relation, from: current[0] ?? '', to }], mode: 'replace' }
    : { kind: 'facet', ids: [owner], moves: [{ facet: relation, from: '', to }], mode: 'add' };
}
