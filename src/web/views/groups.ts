import { NONE } from '../../schema/vocabulary.ts';
import type { Group, QueryResponse } from '../types.ts';

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
 * `empties` is an argument rather than a fork because it is a real per-shape
 * decision, argued both ways in ARCHITECTURE: a board keeps an empty declared
 * column because it is somewhere to *drag to*, and a canvas drops it because a
 * canvas drag moves a position without changing a facet, so an empty band would be
 * decoration with no affordance. A table follows the canvas — it offers nothing to
 * drag either — which is a policy it never actually had, only a behaviour.
 */
export function groupsFor(
  data: QueryResponse,
  opts: { lane?: string | undefined; empties: 'keep' | 'drop' } = { empties: 'keep' },
): Group[] {
  // Ungrouped: one nameless group holding everything, which is what every shape
  // was open-coding.
  if (!data.groups) return [{ value: '', ids: data.ids }];

  const mine =
    'lane' in opts ? data.groups.filter((g) => g.lane === opts.lane) : data.groups.filter((g) => !g.lane);
  const ordered = data.axis.length
    ? [...mine].sort((a, b) => rank(data.axis, a.value) - rank(data.axis, b.value))
    : mine;
  return opts.empties === 'drop' ? ordered.filter((g) => g.ids.length) : ordered;
}

/** A value the axis does not declare sorts after the ones it does, in place. */
function rank(axis: string[], value: string): number {
  const i = axis.indexOf(value);
  return i === -1 ? axis.length : i;
}

/**
 * The absence refinement, in words.
 *
 * Five places rendered it four ways: "no value" on board columns, board lanes and
 * table sections, "none" in the filter panel, and the raw `(none)` on a canvas
 * band — the wire form, shown to the user. "no value" reads as a statement where
 * "none" beside a count reads as a quantity.
 */
export function labelFor(value: string): string {
  if (value === NONE) return 'no value';
  return value;
}
