import { isRef } from './facets.ts';
import type { Facets, Note } from './types.ts';

/**
 * What folding a candidate into a note would change about it.
 *
 * `merged()` composes what a merge *can* compose, and it deliberately leaves the
 * survivor's classification alone: a rule that combined two `status` values would
 * have to guess which note you meant, and there is no answer to that. Which is
 * right, and which left a hole — a sweep could discover that a ticket had moved
 * to blocked and had no way to say so, because the only route to an existing note
 * was a merge and a merge refuses to touch labels.
 *
 * So the division is exact rather than approximate. **A reference facet is
 * merge's**, which unions both ends and needs no decision — a note is a member of
 * both projects, part of both parents. **Everything else is a question**, because
 * one value has to win, and the person is the only one who can say which. This
 * module states the question; it decides nothing.
 *
 * Pure, so every rule below is asserted directly rather than through a vault.
 */

/** An axis where the candidate proposes something the note does not already say. */
export interface FoldRow {
  facet: string;
  /** What the note holds now. Empty when it holds nothing — a clean addition. */
  before: string[];
  /** What the candidate proposes. Never empty; a row exists because there is one. */
  after: string[];
}

/** Which side of a row was chosen. `before` keeps the note as it is. */
export type Side = 'before' | 'after';

/**
 * The app's own bookkeeping, which a fold never asks about.
 *
 * `intake` marks the candidate as unjudged and `extends` is how it named its
 * target — both belong to the pipeline, and both stop existing the moment the
 * candidate does.
 */
const PIPELINE = new Set(['intake', 'extends']);

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The rows a fold would ask about, in the vocabulary's own order.
 *
 * Three kinds of axis are absent, each for its own reason. A **reference** axis is
 * merge's to union. An axis the candidate says **nothing** about has nothing to
 * propose. And an axis where the two **already agree** is not a question — showing
 * it would pad the table with rows whose two columns read identically, which is
 * how a dialog teaches people to click past it.
 */
export function foldRows(candidate: Note, target: Note, defs: Facets): FoldRow[] {
  const rows: FoldRow[] = [];
  for (const facet of Object.keys(defs)) {
    if (PIPELINE.has(facet)) continue;
    if (isRef(defs[facet]!)) continue;
    const after = candidate.facets[facet] ?? [];
    if (!after.length) continue;
    const before = target.facets[facet] ?? [];
    if (same(before, after)) continue;
    rows.push({ facet, before, after });
  }
  return rows;
}

/**
 * The default answer: keep the note as it is, everywhere.
 *
 * Which is exactly what folding did before this existed, and that is the argument
 * for it. A dialog whose default changes things is one you have to read before
 * you can safely dismiss it; this one can be dismissed unread and behave the way
 * it always did, so the cost of adding it to the path is zero for anyone who does
 * not want it. Taking every proposal is then one click on the other column.
 */
export function defaultSides(rows: readonly FoldRow[]): Record<string, Side> {
  return Object.fromEntries(rows.map((r) => [r.facet, 'before' as Side]));
}

/**
 * The facets to write, given what was chosen.
 *
 * Only the axes where the proposal won: an axis left on `before` is one the note
 * already answers for, and writing its current value back would be a write that
 * changes nothing while touching the file's `updated` stamp.
 */
export function foldResult(
  rows: readonly FoldRow[],
  sides: Record<string, Side>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    if (sides[row.facet] === 'after') out[row.facet] = row.after;
  }
  return out;
}
