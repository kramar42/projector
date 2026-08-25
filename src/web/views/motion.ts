import { groupsFor } from './groups.ts';
import type { QueryResponse } from '../types.ts';

/**
 * Where the cursor can go, per shape.
 *
 * The shape supplies the ordering and this decides the step — the same division
 * `BulkBar` already makes for ids, where "a shape supplies them however it
 * honestly has them" and the component acts on the list rather than on the
 * shape. Here the honest form is a **grid**: lanes hold columns, columns hold
 * cards, and every shape that can be walked at all is one of those.
 *
 * A board is the grid literally — swimlanes down, columns across, cards in a
 * pile. A table is the same grid drawn vertically: its sections *are* columns,
 * and the rows inside one are the pile. That the two collapse onto one structure
 * is why there is one module here rather than a `boardMotion` and a
 * `tableMotion` that agree about `j` by coincidence.
 *
 * Everything is pure and takes the grid it walks, for the same reason
 * `dropOutcome` is: the interesting part is an index transform, and it is
 * testable without a DOM.
 */

export interface Grid {
  /** lanes → columns → card ids, in the order the shape draws them. */
  cells: string[][][];
  /**
   * Does `j` run off the end of a column into the top of the next one?
   *
   * A table reads as one continuous list — a section heading is a divider, not a
   * wall — so falling through is what the eye already does. A board's columns sit
   * side by side and have visible ends, and a `j` that teleported the cursor to
   * the top of the next column would be a jump the layout does not suggest.
   *
   * The one genuine behavioural difference between the two shapes, which is why
   * it is a flag rather than two implementations.
   */
  continuous: boolean;
}

const EMPTY: Grid = { cells: [], continuous: false };

/**
 * The grid a payload draws, whichever shape it is drawn as.
 *
 * Built from `data` alone, which is what keeps the views out of it: `App` already
 * holds the payload, so the cursor needs nothing passed up from the component
 * tree and a view's only job is to *draw* the cursor it is given.
 *
 * A canvas returns nothing on purpose. Its nodes sit at arbitrary points on a
 * plane, so "the next one down" has no answer that is not invented — React Flow
 * owns selection there, and the commands act on that.
 */
export function gridOf(data: QueryResponse | null): Grid {
  if (!data) return EMPTY;
  if (data.spec.shape === 'canvas') return EMPTY;

  if (data.spec.shape === 'table') {
    // One lane. A table's sections are its columns, and it drops the empty ones
    // exactly as it draws them — a section with nothing in it has no row to land
    // on, so a cursor must not be able to step into it.
    const sections = groupsFor(data, { lanes: 'all', empties: 'drop' });
    return { cells: [sections.map((s) => s.ids)], continuous: true };
  }

  const lanes: (string | undefined)[] = data.groupOrder.secondary.length
    ? data.groupOrder.secondary
    : [undefined];
  // `empties: 'keep'`, matching the board: a declared column with nothing in it
  // is still drawn, and `l` walking across has to count it or the cursor and the
  // columns disagree about which one is third.
  return {
    cells: lanes.map((lane) => groupsFor(data, { lane, empties: 'keep' }).map((g) => g.ids)),
    continuous: false,
  };
}

/** Lane, column and position — where one card sits, or `null` if it is not drawn. */
export type Spot = [lane: number, column: number, row: number];

export function locate(grid: Grid, id: string | null): Spot | null {
  if (!id) return null;
  for (let lane = 0; lane < grid.cells.length; lane++) {
    const columns = grid.cells[lane]!;
    for (let column = 0; column < columns.length; column++) {
      const row = columns[column]!.indexOf(id);
      if (row !== -1) return [lane, column, row];
    }
  }
  return null;
}

/** Every drawn card, in the order the shape draws it. What `*` and a range use. */
export function drawn(grid: Grid): string[] {
  return grid.cells.flat(2);
}

export function first(grid: Grid): string | null {
  return drawn(grid)[0] ?? null;
}

export function last(grid: Grid): string | null {
  const all = drawn(grid);
  return all[all.length - 1] ?? null;
}

/**
 * One step from where the cursor is.
 *
 * `null` in means the cursor has not landed yet, and every direction answers with
 * the first drawn card — so the first keystroke of a session puts the cursor
 * somewhere sensible rather than requiring a click first.
 *
 * A cursor sitting on a card the current query does not draw — which is what
 * following a reference out of the view leaves behind — is the same case: it has
 * no spot, so a motion key re-enters the view at the top rather than doing
 * nothing. That is the honest answer to "move down from somewhere that is not
 * here", and it is what makes a detour recoverable without reaching for `H`.
 */
export function stepped(
  grid: Grid,
  from: string | null,
  along: 'row' | 'column' | 'lane',
  delta: number,
): string | null {
  const spot = locate(grid, from);
  if (!spot) return first(grid);
  const [lane, column, row] = spot;

  if (along === 'row') return alongRow(grid, lane, column, row, delta);

  /**
   * Across columns or lanes.
   *
   * Two things happen at once here, and both are about landing somewhere real.
   * The **position is kept and clamped**, so stepping from the ninth card of a
   * long column into a short one lands on that column's last card rather than
   * nowhere — which is what makes `l` then `h` put you back roughly where you
   * were. And an **empty column is stepped over** rather than stopping the cursor
   * dead: a board keeps a declared column with nothing in it because it is
   * somewhere to drag *to*, and there is nothing in it to put a cursor *on*.
   */
  const step = delta > 0 ? 1 : -1;
  let [l, c] = [lane, column];
  for (;;) {
    if (along === 'column') c += step;
    else l += step;
    const cell = grid.cells[l]?.[c];
    if (!cell) return null;
    if (cell.length) return cell[Math.min(row, cell.length - 1)]!;
  }
}

/**
 * Down or up within a column, and — on a continuous grid — through its end.
 *
 * The fall-through walks *columns within the lane* rather than the flat list of
 * every drawn card, so a table with lanes still reads down the page in the order
 * its sections are drawn.
 */
function alongRow(
  grid: Grid,
  lane: number,
  column: number,
  row: number,
  delta: number,
): string | null {
  const cell = grid.cells[lane]![column]!;
  const next = row + delta;
  if (next >= 0 && next < cell.length) return cell[next]!;
  if (!grid.continuous) return null;

  const columns = grid.cells[lane]!;
  let c = column;
  for (;;) {
    c += delta > 0 ? 1 : -1;
    const into = columns[c];
    if (!into) return null;
    if (into.length) return delta > 0 ? into[0]! : into[into.length - 1]!;
  }
}
