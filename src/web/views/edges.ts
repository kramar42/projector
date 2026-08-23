/**
 * Which lines a canvas draws, and which way they point.
 *
 * Three decisions, none of them about appearance:
 *
 * **One edge per pair, whatever the types.** `parent` and `project` agreeing is
 * the *expected* shape for a record inside a project, so drawing both put two
 * identical lines on top of each other with no way to tell there were two.
 * Collapsing means a pair that agrees reads as one relationship, and a pair that
 * *disagrees* still shows as two edges pointing at different records — the case
 * worth seeing.
 *
 * **Every edge flips.** A reference facet is stored on the record that depends —
 * child, member, the card that is stuck — and points at what it depends on; drawn
 * the other way, so the arrow points the way the graph opens. This was once a
 * per-relation question answered by the server, because `blocks` was stored
 * backwards from the other two. It is not a question any more.
 *
 * **The most structural type leads.** A pair joined by several relations is
 * styled by one of them, and the order is fixed rather than incidental.
 *
 * Kept apart from the styling it feeds so the decision is testable without React
 * Flow, and so the colours and dash patterns stay one edit away from the
 * stylesheet rather than buried in a reducer.
 */

export interface EdgeSpec {
  src: string;
  dst: string;
  /** Every relation joining this pair, in the order the payload listed them. */
  types: string[];
  /** The one that decides how the line looks. */
  lead: string;
}

/** Structural before incidental: containment explains a layout, blocking does not. */
const LEAD_ORDER = ['parent', 'project', 'blocked_by'];

export function edgesFor(raw: { src: string; dst: string; type: string }[]): EdgeSpec[] {
  const byPair = new Map<string, { src: string; dst: string; types: string[] }>();
  for (const e of raw) {
    const key = `${e.dst}\u0000${e.src}`;
    const found = byPair.get(key);
    if (found) found.types.push(e.type);
    else byPair.set(key, { src: e.dst, dst: e.src, types: [e.type] });
  }

  return [...byPair.values()].map((pair) => ({
    ...pair,
    lead: LEAD_ORDER.find((t) => pair.types.includes(t)) ?? pair.types[0]!,
  }));
}
