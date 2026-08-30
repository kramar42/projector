import { groupsFor } from './groups.ts';
import { NONE } from '../../schema/vocabulary.ts';
import { arrangePlacements, calendarPage, dateAxis, placements } from '../../view/calendar.ts';
import { paramsOf } from '../query.ts';
import type { Facets, QueryResponse } from '../types.ts';

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
   * What each column *is* — the grouped axis's value, in the same order.
   *
   * Positions alone are enough to walk a grid and not enough to write to one: a
   * card created in a column inherits that column's value, so `n` needs the value
   * the index stands for. Kept here rather than re-derived at the call site
   * because it comes from the same `groupsFor` call the cells do, and two
   * derivations of one order is how they come to disagree.
   */
  columns: string[];
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

const EMPTY: Grid = { cells: [], columns: [], continuous: false };

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
export function gridOf(
  data: QueryResponse | null,
  /**
   * What a calendar's grid is built from, because its cells are not in the
   * payload: the page comes off the URL and the axis off the vocabulary. The
   * other shapes ignore it, and a calendar handed nothing walks nowhere rather
   * than walking columns the screen is not drawing.
   */
  calendar?: { search: string; facets: Facets; today?: string },
): Grid {
  if (!data) return EMPTY;
  if (data.spec.shape === 'canvas') return EMPTY;

  /**
   * A calendar is a one-lane board whose columns are the page's days, in
   * reading order, with the unscheduled rail as the last column. The same two
   * pure calls the view makes (`calendarPage`, `placements`, then its saved
   * arrangement) over the same inputs, so the walk and the drawing cannot
   * disagree — the promise this module already makes about `groupsFor`.
   *
   * The drawn rows are a *layout* of one run of days, not lanes: a lane would
   * put a different date at every (lane, column) and leave `columns` — which is
   * what `n` reads to know where a card is created — unable to name one. So
   * `l` reads across the page the way the dates do, and — since the walk steps
   * over empty cells exactly as it steps over an empty board column — it lands
   * on the next day that has a card, which on a mostly-empty month is the walk
   * you want.
   */
  if (data.spec.shape === 'calendar') {
    if (!calendar) return EMPTY;
    const axis = dateAxis(calendar.facets, data.spec.show);
    if (!axis) return EMPTY;
    const today = calendar.today ?? new Date().toISOString().slice(0, 10);
    const page = calendarPage(Object.fromEntries(paramsOf(calendar.search)), today);
    const placed = arrangePlacements(
      placements(data.ids, (id) => data.notes[id]?.facets[axis] ?? [], page),
      data.spec.order,
    );
    const days = page.days.flat();
    return {
      cells: [[...days.map((d) => placed.byDay.get(d) ?? []), placed.unscheduled]],
      columns: [...days, NONE],
      continuous: false,
    };
  }

  if (data.spec.shape === 'table') {
    // One lane. A table's sections are its columns, and it drops the empty ones
    // exactly as it draws them — a section with nothing in it has no row to land
    // on, so a cursor must not be able to step into it.
    const sections = groupsFor(data, { lanes: 'all', empties: 'drop' });
    return {
      cells: [sections.map((s) => s.ids)],
      columns: sections.map((s) => s.value),
      continuous: true,
    };
  }

  const lanes: (string | undefined)[] = data.groupOrder.secondary.length
    ? data.groupOrder.secondary
    : [undefined];
  // `empties: 'keep'`, matching the board: a declared column with nothing in it
  // is still drawn, and `l` walking across has to count it or the cursor and the
  // columns disagree about which one is third.
  const perLane = lanes.map((lane) => groupsFor(data, { lane, empties: 'keep' }));
  return {
    cells: perLane.map((groups) => groups.map((g) => g.ids)),
    // Every lane draws the same columns in the same declared order, so the first
    // lane's values name them all.
    columns: (perLane[0] ?? []).map((g) => g.value),
    continuous: false,
  };
}

/** Lane, column and position — where one card sits, or `null` if it is not drawn. */
export type Spot = [lane: number, column: number, row: number];

/**
 * Which drawn copy of a note the keyboard is on.
 *
 * A note can be drawn several times — a facet with two values puts it in two
 * columns — so an id alone does not name a placement. `near` is the copy the
 * cursor was last put on, and it is a **hint, never an authority**: it is
 * honoured only while the cell it names still holds that id, and anything that
 * moves the note — a filter, a regroup, an agent's write — silently falls back
 * to the first placement rather than leaving the cursor pointing at a copy that
 * is no longer drawn.
 *
 * That division is what keeps the cursor an *id* (see `cursor.ts`) while making
 * the second copy reachable at all. Answering "the first placement"
 * unconditionally is what made it unreachable: clicking an echo set the cursor
 * to an id whose resolved placement was, by definition, the other one — so the
 * ring jumped back across the board and `j` then walked the column you had just
 * clicked away from.
 */
export function locate(grid: Grid, id: string | null, near?: Spot | null): Spot | null {
  if (!id) return null;
  if (near) {
    const cell = grid.cells[near[0]]?.[near[1]];
    if (cell) {
      // The same row when it still holds the note, so a re-sort within one
      // column does not throw the hint away; otherwise wherever it sits now.
      const row = cell[near[2]] === id ? near[2] : cell.indexOf(id);
      if (row !== -1) return [near[0], near[1], row];
    }
  }
  for (let lane = 0; lane < grid.cells.length; lane++) {
    const columns = grid.cells[lane]!;
    for (let column = 0; column < columns.length; column++) {
      const row = columns[column]!.indexOf(id);
      if (row !== -1) return [lane, column, row];
    }
  }
  return null;
}

/** The note at one placement, or `null` where nothing is drawn. */
export function idAt(grid: Grid, spot: Spot | null): string | null {
  if (!spot) return null;
  return grid.cells[spot[0]]?.[spot[1]]?.[spot[2]] ?? null;
}

/**
 * Is this the placement the cursor is actually at?
 *
 * A note can be drawn several times — a facet with two values puts it in two
 * columns — and until this existed the views asked `cursor === id`, which is true
 * of *every* one of them. That made each placement a cursor: each drew the ring,
 * each took a tab stop, and each ran its own `scrollIntoView` on the same commit,
 * so the last in DOM order won and the board scrolled to the rightmost copy. On
 * the author's vault that measured a 2432px jump in a 1032px viewport, *away*
 * from the placement the keyboard was on, which ended up off-screen left.
 *
 * `locate` had always answered this — first lane, first column, first row — and
 * every step `j`/`k`/`h`/`l` takes is computed from it. The drawing simply did not
 * ask. So this is not a new rule: it is the existing one, exported, so that
 * stepping and drawing cannot disagree about where the cursor is.
 *
 * The indices line up because `gridOf` and the views make the same `groupsFor`
 * calls — `empties: 'keep'` per lane for a board, `'drop'` across one lane for a
 * table. That is load-bearing, and `client.test.ts` pins it.
 */
export function isCursorAt(spot: Spot | null, lane: number, column: number, row: number): boolean {
  return !!spot && spot[0] === lane && spot[1] === column && spot[2] === row;
}

/** Every drawn card, in the order the shape draws it. What `*` and a range use. */
export function drawn(grid: Grid): string[] {
  return grid.cells.flat(2);
}

/** The first drawn placement, in the order the shape draws them. */
export function firstSpot(grid: Grid): Spot | null {
  for (let lane = 0; lane < grid.cells.length; lane++) {
    const columns = grid.cells[lane]!;
    for (let column = 0; column < columns.length; column++) {
      if (columns[column]!.length) return [lane, column, 0];
    }
  }
  return null;
}

/** The last drawn placement. */
export function lastSpot(grid: Grid): Spot | null {
  for (let lane = grid.cells.length - 1; lane >= 0; lane--) {
    const columns = grid.cells[lane]!;
    for (let column = columns.length - 1; column >= 0; column--) {
      const cell = columns[column]!;
      if (cell.length) return [lane, column, cell.length - 1];
    }
  }
  return null;
}

export function first(grid: Grid): string | null {
  return idAt(grid, firstSpot(grid));
}

export function last(grid: Grid): string | null {
  return idAt(grid, lastSpot(grid));
}

/**
 * One step from where the cursor is, in placements.
 *
 * The spot-shaped half of `stepped`, and the one the dispatcher uses: a step has
 * to answer *which copy* it landed on, or walking into a column that draws the
 * same note twice would resolve back to the first copy on the next render and
 * undo itself.
 *
 * `null` in means the cursor has not landed yet, and every direction answers with
 * the first drawn placement — so the first keystroke of a session puts the cursor
 * somewhere sensible rather than requiring a click first.
 */
export function steppedTo(
  grid: Grid,
  from: Spot | null,
  along: 'row' | 'column' | 'lane',
  delta: number,
): Spot | null {
  if (!from) return firstSpot(grid);
  const [lane, column, row] = from;

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
    if (cell.length) return [l, c, Math.min(row, cell.length - 1)];
  }
}

/**
 * One step, by id — `steppedTo` for the callers that have no placement to offer.
 *
 * A cursor sitting on a card the current query does not draw — which is what
 * following a reference out of the view leaves behind — has no spot, so a motion
 * key re-enters the view at the top rather than doing nothing. That is the honest
 * answer to "move down from somewhere that is not here", and it is what makes a
 * detour recoverable without reaching for `H`.
 */
export function stepped(
  grid: Grid,
  from: string | null,
  along: 'row' | 'column' | 'lane',
  delta: number,
  near?: Spot | null,
): string | null {
  return idAt(grid, steppedTo(grid, locate(grid, from, near), along, delta));
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
): Spot | null {
  const cell = grid.cells[lane]![column]!;
  const next = row + delta;
  if (next >= 0 && next < cell.length) return [lane, column, next];
  if (!grid.continuous) return null;

  const columns = grid.cells[lane]!;
  let c = column;
  for (;;) {
    c += delta > 0 ? 1 : -1;
    const into = columns[c];
    if (!into) return null;
    if (into.length) return delta > 0 ? [lane, c, 0] : [lane, c, into.length - 1];
  }
}
