import { useCallback, useRef, useState } from 'react';

/**
 * Which records a gesture has picked out, for the shapes that have to remember.
 *
 * Selection was a `useState` inside `BoardView` and a `BulkBar` declared beside
 * it, so a board could act on twelve cards at once and the other two shapes could
 * not act on any. Cleaning 130 imported cards is the same job whichever shape you
 * happen to be looking at.
 *
 * A canvas deliberately does **not** use this. React Flow already owns node
 * selection — `node.selected`, maintained by `applyNodeChanges` — and a marquee
 * drag updates its copy without going near ours, so a second set would drift the
 * first time somebody dragged a box. There the ids are *derived* from the nodes.
 * That is why `BulkBar` takes ids rather than this: a shape supplies them however
 * it honestly has them, and only the two that keep their own set come here.
 *
 * The functions are pure and the hook is a thin wrapper, for the same reason
 * `dropOutcome` is pure: the interesting part is a set transform, and it is
 * testable without a DOM.
 */

/**
 * Toggle one id, additively or not.
 *
 * `additive` is cmd/ctrl held — the one gesture every shape agrees on. Without
 * it the click *replaces* the selection, which is what makes a plain click on an
 * unselected card mean "just this one".
 */
export function toggled(
  selected: ReadonlySet<string>,
  id: string,
  additive: boolean,
): Set<string> {
  const next = additive ? new Set(selected) : new Set<string>();
  if (additive && selected.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Extend a selection along the rows a shape actually draws.
 *
 * Indices rather than ids, and the row list rather than the result set. A card
 * whose grouped facet holds several values is drawn once per matching section —
 * two rows, one id — so an id cannot say which of them was shift-clicked, and
 * `indexOf` would silently measure to the first.
 *
 * The run is added to what was already selected rather than replacing it, which
 * is what lets several ranges be collected. With no anchor, or an anchor that has
 * since left the rows, it degrades to picking the one row: a shift-click that
 * cannot mean a range still has an obvious smaller meaning.
 */
export function ranged(
  selected: ReadonlySet<string>,
  rows: readonly string[],
  anchor: number | null,
  index: number,
): Set<string> {
  const row = rows[index];
  if (row === undefined) return new Set(selected);
  if (anchor === null || rows[anchor] === undefined) return new Set([...selected, row]);
  const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
  return new Set([...selected, ...rows.slice(lo, hi + 1)]);
}

export interface Selection {
  ids: ReadonlySet<string>;
  /**
   * Toggle one record. `index` is its position among the drawn rows, and becomes
   * the anchor a later `extend` measures from — the shape that has no rows to
   * count simply omits it.
   */
  toggle: (id: string, additive: boolean, index?: number) => void;
  /** Extend from the anchor to `index`. Only a shape with an order can offer it. */
  extend: (rows: readonly string[], index: number) => void;
  clear: () => void;
}

export function useSelection(): Selection {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set<string>());
  const anchor = useRef<number | null>(null);

  const toggle = useCallback((id: string, additive: boolean, index?: number) => {
    anchor.current = index ?? null;
    setIds((cur) => toggled(cur, id, additive));
  }, []);

  // The anchor stays where it was, so a second shift-click grows or shrinks the
  // same run rather than starting a new one from wherever it landed.
  const extend = useCallback((rows: readonly string[], index: number) => {
    setIds((cur) => ranged(cur, rows, anchor.current, index));
  }, []);

  const clear = useCallback(() => {
    anchor.current = null;
    setIds(new Set<string>());
  }, []);

  return { ids, toggle, extend, clear };
}
