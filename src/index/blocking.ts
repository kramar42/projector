import type { Facets, Rec } from '../schema/types.ts';
import { adjacency, inboundCounts, walk } from './refs.ts';
import { isProject } from './project.ts';

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

/**
 * A record is finished when it carries a value some facet declares `closed`.
 *
 * The one place that rule is written — it had two spellings, both naming
 * `status` and `done` in code, and neither could see that the seeded vocabulary
 * also has `archived`. An archived card therefore blocked its dependents
 * forever, which nothing anywhere had decided; it was what the literal happened
 * to say.
 *
 * Any facet may declare it, and a record needs only one such value. That is not
 * generality for its own sake: which axis carries a lifecycle is a vault's
 * choice, and a vault with two of them means both.
 */
export function isClosed(rec: Rec | undefined, facets: Facets): boolean {
  if (!rec) return false;
  for (const [name, def] of Object.entries(facets)) {
    if (!def.closed?.length) continue;
    if (rec.facets[name]?.some((v) => def.closed!.includes(v))) return true;
  }
  return false;
}

/**
 * The records this one is waiting on, with whether each is finished.
 *
 * A *local* read now. The relation used to be stored the other way round — a
 * blocker naming what it held up — so answering "what am I waiting on" meant
 * inverting the whole graph, and recording it meant editing the other card. Both
 * are gone: the edge lives on the card that is stuck, which is the card you open
 * when you are stuck.
 *
 * Direct, not transitive: a blocker's own blockers are its problem, and the card
 * face draws this list.
 */
export function blockedBy(
  id: string,
  records: Map<string, Rec>,
  /**
   * The vocabulary, for the two facts a blocker carries besides its title.
   *
   * It was optional, so that a caller wanting only titles need not hold it, and
   * an omitted one cost nothing but the record mark. `done` reads the vocabulary
   * now — that is where `closed` is declared — so an omitted one would answer
   * "nothing is finished" in a shape whose whole job is saying which blockers
   * still stand. A wrong answer is worse than a plain one, so it is required.
   */
  facets: Facets,
): { id: string; title: string; done: boolean; isProject: boolean; refCount: number }[] {
  // Through `adjacency` rather than the raw facet, so a self-reference and a
  // value naming no record are dropped here exactly as they are everywhere else.
  const blockers = adjacency('blocked_by', records).out.get(id) ?? [];
  const inbound = inboundCounts(records, facets);
  return blockers.flatMap((src) => {
    const rec = records.get(src);
    return rec
      ? [
          {
            id: rec.id,
            title: rec.title,
            done: isClosed(rec, facets),
            isProject: isProject(rec),
            refCount: inbound.get(rec.id) ?? 0,
          },
        ]
      : [];
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
  const reached = walk(id, adjacency('blocked_by', records).in);
  reached.delete(id);
  return [...reached];
}

/**
 * Every record still waiting on something unfinished.
 *
 * One local rule since the relation was inverted: a record is blocked when any
 * record it names is not closed. It used to walk every *other* record's outward
 * edges and mark their targets — the same answer, arrived at backwards, because
 * the edge was stored on the wrong end.
 *
 * The `blocked` pseudo-facet reads this; it used to compute it inline, which is
 * how the rule came to have two spellings.
 */
export function blockedSet(records: Map<string, Rec>, facets: Facets): Set<string> {
  const out = new Set<string>();
  for (const [src, blockers] of adjacency('blocked_by', records).out) {
    if (blockers.some((b) => !isClosed(records.get(b), facets))) out.add(src);
  }
  return out;
}
