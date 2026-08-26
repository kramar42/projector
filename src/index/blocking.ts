import type { Facets, Note } from '../schema/types.ts';
import { adjacency, inboundCounts, walk } from './refs.ts';
import { isRef } from '../schema/facets.ts';
import { isProject } from './project.ts';

/**
 * What blocks what — one answer, from the note map.
 *
 * There were two. `refsOf` drops a self-reference and a value naming no note,
 * so the `blocked` axis obeyed both rules; the SQL closure in `queries.ts` obeyed
 * neither and was depth-capped at 10. In one payload, a note carrying
 * `blocks: [itself]` therefore read `clear` on the axis while its own DTO said it
 * was blocked by itself and listed itself ten times as something it would unblock.
 * `pj check` rejects that note, so a tended vault never held it — but the app
 * rendered the contradiction rather than refusing it, which is a poor place to
 * keep an invariant.
 *
 * ARCHITECTURE already argues that filtering belongs in memory so there is one
 * traversal. This is that argument applied to the last place that ignored it: the
 * recursive CTE was the only graph walk outside `refs.ts`.
 */

/**
 * A note is finished when it carries a value some facet declares `closed`.
 *
 * The one place that rule is written — it had two spellings, both naming
 * `status` and `done` in code, and neither could see that the seeded vocabulary
 * also has `archived`. An archived note therefore blocked its dependents
 * forever, which nothing anywhere had decided; it was what the literal happened
 * to say.
 *
 * Any facet may declare it, and a note needs only one such value. That is not
 * generality for its own sake: which axis carries a lifecycle is a vault's
 * choice, and a vault with two of them means both.
 */
export function isClosed(rec: Note | undefined, facets: Facets): boolean {
  if (!rec) return false;
  for (const [name, def] of Object.entries(facets)) {
    if (!def.closed?.length) continue;
    if (rec.facets[name]?.some((v) => def.closed!.includes(v))) return true;
  }
  return false;
}

/** Every facet a vault has declared blocking. */
export function blockingFacets(facets: Facets): string[] {
  return Object.entries(facets)
    .filter(([, def]) => def.blocking)
    .map(([name]) => name);
}

/**
 * Those of them that name notes, so they have an other end to walk.
 *
 * A blocking *label* facet blocks by being non-empty and has nowhere to walk to,
 * which is why the two lists are not the same list.
 */
function blockingRefs(facets: Facets): string[] {
  return blockingFacets(facets).filter((name) => isRef(facets[name]));
}

/** Neighbours along every blocking reference at once, merged. */
export function blockingEdges(notes: Map<string, Note>, facets: Facets): { out: Map<string, string[]>; in: Map<string, string[]> } {
  const out = new Map<string, string[]>();
  const inward = new Map<string, string[]>();
  for (const via of blockingRefs(facets)) {
    const adj = adjacency(via, notes);
    for (const [k, v] of adj.out) out.set(k, [...(out.get(k) ?? []), ...v]);
    for (const [k, v] of adj.in) inward.set(k, [...(inward.get(k) ?? []), ...v]);
  }
  return { out, in: inward };
}

/**
 * The notes this one is waiting on, with whether each is finished.
 *
 * A *local* read now. The relation used to be stored the other way round — a
 * blocker naming what it held up — so answering "what am I waiting on" meant
 * inverting the whole graph, and recording it meant editing the other note. Both
 * are gone: the edge lives on the note that is stuck, which is the note you open
 * when you are stuck.
 *
 * Direct, not transitive: a blocker's own blockers are its problem, and the card
 * face draws this list.
 */
export function blockedBy(
  id: string,
  notes: Map<string, Note>,
  /**
   * The vocabulary, for the two facts a blocker carries besides its title.
   *
   * It was optional, so that a caller wanting only titles need not hold it, and
   * an omitted one cost nothing but the note mark. `done` reads the vocabulary
   * now — that is where `closed` is declared — so an omitted one would answer
   * "nothing is finished" in a shape whose whole job is saying which blockers
   * still stand. A wrong answer is worse than a plain one, so it is required.
   */
  facets: Facets,
): { id: string; title: string; via: string; done: boolean; isProject: boolean; refCount: number }[] {
  const inbound = inboundCounts(notes, facets);
  // Per relation, so each blocker can say which axis it arrived on: a vault with
  // both `blocked_by` and `needs_review` draws one list and has to distinguish
  // them. Through `adjacency` rather than the raw facet, so a self-reference and
  // a value naming no note are dropped exactly as they are everywhere else.
  return blockingRefs(facets).flatMap((via) =>
    (adjacency(via, notes).out.get(id) ?? []).flatMap((src) => {
      const rec = notes.get(src);
      return rec
        ? [
            {
              id: rec.id,
              title: rec.title,
              via,
              done: isClosed(rec, facets),
              isProject: isProject(rec),
              refCount: inbound.get(rec.id) ?? 0,
            },
          ]
        : [];
    }),
  );
}

/**
 * Everything downstream of this note — what finishing it would unblock.
 *
 * Transitive and uncapped, because `walk` visits each node once and so cannot
 * loop; the SQL version needed a depth cap for exactly the cycle `walk` handles
 * by construction. The origin is excluded: "what this unblocks" is not itself.
 */
export function unblocks(id: string, notes: Map<string, Note>, facets: Facets): string[] {
  const reached = walk(id, blockingEdges(notes, facets).in);
  reached.delete(id);
  return [...reached];
}

/**
 * Why each note cannot proceed: the blocking facets it is failing, by name.
 *
 * A set of ids before, because the axis it feeds had two hardcoded values — one
 * for an unfinished blocker and one for a non-empty `waiting_on`. Those were
 * always the same question asked of two facets, so the answer is now which
 * facets rather than which of two reasons, and a vault declaring a third gets a
 * third value for free.
 *
 * The type decides what unsatisfied means: a reference blocks while something it
 * names is not closed, anything else blocks while it holds a value.
 */
export function blockedSet(notes: Map<string, Note>, facets: Facets): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, via: string) => out.set(id, [...(out.get(id) ?? []), via]);
  for (const via of blockingFacets(facets)) {
    if (isRef(facets[via])) {
      for (const [src, blockers] of adjacency(via, notes).out) {
        if (blockers.some((b) => !isClosed(notes.get(b), facets))) add(src, via);
      }
    } else {
      for (const rec of notes.values()) if (rec.facets[via]?.length) add(rec.id, via);
    }
  }
  return out;
}
