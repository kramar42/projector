import type { Rec } from '../schema/types.ts';
import { adjacency, walk } from './refs.ts';

/**
 * What blocks what — one answer, from the record map.
 *
 * There were two. `refsOf` drops a self-reference and a value naming no record,
 * so the `blocked` axis obeyed both rules; the SQL closure in `queries.ts` obeyed
 * neither and was depth-capped at 10. In one payload, a card carrying
 * `blocks: [itself]` therefore read `clear` on the axis while its own DTO said it
 * was blocked by itself and listed itself ten times as something it would unblock.
 * `pj check` rejects that card, so a tended vault never held it — but the app
 * rendered the contradiction rather than refusing it, which is a poor place to
 * keep an invariant.
 *
 * ARCHITECTURE already argues that filtering belongs in memory so there is one
 * traversal. This is that argument applied to the last place that ignored it: the
 * recursive CTE was the only graph walk outside `refs.ts`.
 */

/** A record is finished when it says so. The one place that rule is written. */
export function isDone(rec: Rec | undefined): boolean {
  return !!rec?.facets.status?.includes('done');
}

/**
 * Records that name this one as blocked, with whether each is finished.
 *
 * Direct, not transitive: a blocker's own blockers are its problem, and the card
 * face draws this list.
 */
export function blockedBy(
  id: string,
  records: Map<string, Rec>,
): { id: string; title: string; done: boolean }[] {
  const inward = adjacency('blocks', records).in.get(id) ?? [];
  return inward.flatMap((src) => {
    const rec = records.get(src);
    return rec ? [{ id: rec.id, title: rec.title, done: isDone(rec) }] : [];
  });
}

/**
 * Everything downstream of this record — what finishing it would unblock.
 *
 * Transitive and uncapped, because `walk` visits each node once and so cannot
 * loop; the SQL version needed a depth cap for exactly the cycle `walk` handles
 * by construction. The origin is excluded: "what this unblocks" is not itself.
 */
export function unblocks(id: string, records: Map<string, Rec>): string[] {
  const reached = walk(id, adjacency('blocks', records).out);
  reached.delete(id);
  return [...reached];
}

/**
 * Every record something unfinished is waiting on.
 *
 * `src blocks dst`, so an unfinished record blocks each of its targets. The
 * `blocked` pseudo-facet reads this; it used to compute it inline, which is how
 * the rule came to have two spellings.
 */
export function blockedSet(records: Map<string, Rec>): Set<string> {
  const out = new Set<string>();
  for (const [src, targets] of adjacency('blocks', records).out) {
    if (isDone(records.get(src))) continue;
    for (const dst of targets) out.add(dst);
  }
  return out;
}
