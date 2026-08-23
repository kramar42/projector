import { NONE } from '../../schema/vocabulary.ts';
import type { Group, QueryResponse } from '../types.ts';

/**
 * What to do about a second grouping axis, per shape.
 *
 * It used to be one optional `lane` and a `'lane' in opts` test, which conflated
 * two different questions: "give me this lane" and "give me every lane". The two
 * shapes that pass no lane therefore got the *lane-less* groups — and once a
 * second axis is in play every group carries a lane, so both got nothing. A table
 * drew its header row and no rows at all while the footer read "27 shown"; a
 * canvas silently lost its bands and fell back to a tree layout. Neither had any
 * way to say what it meant, which is why this is a union rather than a third
 * branch on the old shape: a caller now has to state which of the three it wants,
 * and the compiler holds it to that.
 *
 *   `{ lane }`         one lane's groups. A board draws a row at a time, so it
 *                      asks per lane; `undefined` is the implicit single lane of
 *                      a one-axis board.
 *   `{ lanes: 'all' }` every group, ordered lane then value. A table renders both
 *                      levels in one section heading, so it wants the whole
 *                      matrix in reading order.
 *   `{ lanes: 'merged' }` one group per primary value, lanes folded back together.
 *                      A canvas draws one band per value of the primary axis and
 *                      cannot draw a second level at all — a node has one
 *                      position, so it cannot sit in two bands.
 */
export type Lanes = { lane: string | undefined } | { lanes: 'all' | 'merged' };

/**
 * One answer to "what are this shape's groups", for all three shapes.
 *
 * There were three, and they disagreed in small ways that nobody had decided.
 * Each shape spelled the ungrouped fallback differently, each had its own lane
 * predicate, and `axis` — the server's declared column order — was read by none
 * of them, so all three relied on `groups` happening to come out in that order.
 * It does today, by construction; relying on it is what makes a change to grouping
 * quietly reorder every board.
 *
 * Both arguments are real per-shape decisions rather than forks. `empties` is
 * argued both ways in ARCHITECTURE: a board keeps an empty declared column because
 * it is somewhere to *drag to*, and a canvas drops it because a canvas drag moves
 * a position without changing a facet, so an empty band would be decoration with
 * no affordance. A table follows the canvas — it offers nothing to drag either —
 * which is a policy it never actually had, only a behaviour. `Lanes` carries its
 * own reasoning above.
 */
export function groupsFor(
  data: QueryResponse,
  opts: { empties: 'keep' | 'drop' } & Lanes,
): Group[] {
  // Ungrouped: one nameless group holding everything, which is what every shape
  // was open-coding.
  if (!data.groups) return [{ value: '', ids: data.ids }];

  const chosen =
    'lanes' in opts
      ? opts.lanes === 'merged'
        ? mergeLanes(data.groups)
        : data.groups
      : data.groups.filter((g) => g.lane === opts.lane);

  const ordered = inDeclaredOrder(chosen, data);
  return opts.empties === 'drop' ? ordered.filter((g) => g.ids.length) : ordered;
}

/**
 * Lane order, then value order, both as the server declared them.
 *
 * `data.groupOrder` holds the values of each grouping level in the order its
 * axis declares. Comparing lane first is what
 * makes a table's sections read down the page in the same order a board's rows
 * read across it. With one lane — or none — the first comparison is always zero,
 * so this is exactly the value ordering the board already had.
 */
function inDeclaredOrder(groups: Group[], data: QueryResponse): Group[] {
  return [...groups].sort(
    (a, b) =>
      rank(data.groupOrder.secondary, a.lane ?? '') - rank(data.groupOrder.secondary, b.lane ?? '') ||
      rank(data.groupOrder.primary, a.value) - rank(data.groupOrder.primary, b.value),
  );
}

/**
 * One group per primary value, with every lane's members folded back in.
 *
 * A second axis splits `status: active` across one group per priority, and a
 * canvas has no way to draw that: the band it wants is all of them put back
 * together. Ids are deduplicated, because a card whose grouped facet holds several
 * values appears in each matching group and a band must not place it twice.
 */
function mergeLanes(groups: Group[]): Group[] {
  const byValue = new Map<string, string[]>();
  for (const g of groups) {
    const seen = byValue.get(g.value);
    if (seen) seen.push(...g.ids);
    else byValue.set(g.value, [...g.ids]);
  }
  return [...byValue].map(([value, ids]) => ({ value, ids: [...new Set(ids)] }));
}

/** A value the grouping order does not declare sorts after the ones it does. */
function rank(order: string[], value: string): number {
  const i = order.indexOf(value);
  return i === -1 ? order.length : i;
}

/**
 * The absence refinement, in words.
 *
 * Five places rendered it four ways: "no value" on board columns, board lanes and
 * table sections, "none" in the filter panel, and the raw `(none)` on a canvas
 * band — the wire form, shown to the user. "no value" reads as a statement where
 * "none" beside a count reads as a quantity.
 *
 * A sixth place was found later and was the same bug in the same shape: a table
 * section's *lane* half printed `section.lane` raw. Nothing had seen it, because
 * the table was dropping every laned section before it could be drawn.
 */
export function labelFor(value: string): string {
  if (value === NONE) return 'no value';
  return value;
}
