import type { Facets, Rec } from '../schema/types.ts';

/**
 * How records point at each other, and how to walk it.
 *
 * One module, because there is one kind of relation. A **reference facet** holds
 * record ids as its values (`ref: true` in `facets.yaml`); an **edge** is the
 * older mechanism for the same thing. Both yield the same `src names dst` pairs,
 * so everything downstream — focus, the canvas, roll-ups, config inheritance,
 * cycle refusal — walks one shape and never learns which held it.
 *
 * `pairsFor` is the only place that still knows edges exist. When `parent` and
 * `blocks` become reference facets it collapses into `refsOf`, and this module
 * has no branch left in it.
 */

/** Which way to walk. `out` follows a record's own references; `in` finds the records naming it. */
export type Dir = 'out' | 'in' | 'both';

export interface Ref {
  src: string;
  dst: string;
}

/**
 * The references a reference facet holds.
 *
 * No per-facet knowledge: a value that resolves to a record is a reference, and
 * one that does not is a dangling value the validator reports. A record naming
 * itself is dropped rather than becoming a self-loop.
 */
export function refsOf(facet: string, records: Map<string, Rec>): Ref[] {
  const out: Ref[] = [];
  for (const rec of records.values()) {
    for (const value of rec.facets[facet] ?? []) {
      if (value !== rec.id && records.has(value)) out.push({ src: rec.id, dst: value });
    }
  }
  return out;
}

/** The pairs `via` names — a reference facet, or an edge type while those exist. */
function pairsFor(via: string, records: Map<string, Rec>, facets: Facets): Ref[] {
  if (facets[via]?.ref) return refsOf(via, records);
  const out: Ref[] = [];
  for (const rec of records.values()) {
    for (const e of rec.edges) {
      if (e.type === via && records.has(e.to)) out.push({ src: rec.id, dst: e.to });
    }
  }
  return out;
}

export interface Adjacency {
  out: Map<string, string[]>;
  in: Map<string, string[]>;
}

/**
 * Neighbours along one relation, both ways round.
 *
 * There is no per-relation direction rule. A pair is always `src names dst`, and
 * what that *means* — container, blocker, membership — is the relation's
 * business rather than the engine's.
 */
export function adjacency(via: string, records: Map<string, Rec>, facets: Facets): Adjacency {
  const outward = new Map<string, string[]>();
  const inward = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const { src, dst } of pairsFor(via, records, facets)) {
    add(outward, src, dst);
    add(inward, dst, src);
  }
  return { out: outward, in: inward };
}

/** Everything reachable from `from`, including it. `depth` omitted means unlimited. */
export function walk(from: string, edges: Map<string, string[]>, depth?: number): Set<string> {
  const seen = new Set<string>([from]);
  let frontier = [from];
  let hops = 0;
  while (frontier.length && (depth === undefined || hops < depth)) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const n of edges.get(cur) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
    hops++;
  }
  return seen;
}

/**
 * Every chain of outward references from `id`, nearest-first.
 *
 * Distinct from `walk`, which answers *what is reachable*: this answers *by which
 * routes*, which is what config inheritance needs — a chain has an order, and
 * outermost-first is what makes the most specific instruction read last. Cycles
 * are broken by refusing to revisit an id within the same chain, so a malformed
 * graph degrades instead of hanging.
 */
export function chains(id: string, adj: Adjacency): string[][] {
  const out: string[][] = [];
  const step = (cur: string, acc: string[]) => {
    if (acc.includes(cur)) {
      out.push(acc);
      return;
    }
    const next = [...acc, cur];
    const live = (adj.out.get(cur) ?? []).filter((n) => !next.includes(n));
    if (!live.length) {
      out.push(next);
      return;
    }
    for (const n of live) step(n, next);
  };
  step(id, []);
  return out;
}

/**
 * Would pointing `from` at `to` close a loop?
 *
 * Takes the outward neighbours as a function rather than a record map, so one
 * implementation serves an edge and a reference facet alike — the check is about
 * the shape of the graph, not about where it is stored.
 */
export function wouldCycle(from: string, to: string, outOf: (id: string) => string[]): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...outOf(cur));
  }
  return false;
}
