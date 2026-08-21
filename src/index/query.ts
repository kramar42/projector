import type { DatabaseSync } from 'node:sqlite';
import { bucketOf, compareValues, facetRank, isOrdered, orderValues } from '../schema/facets.ts';
import { LINK_KINDS } from '../schema/links.ts';
import type { Facets, Rec } from '../schema/types.ts';
import { adjacency, nodesIn, refsOf, walk } from './refs.ts';

/**
 * One query compiler, for the server and the CLI.
 *
 * Filtering runs in memory over the record map rather than in SQL. That is not a
 * performance trade — at this scale both are free — it is what lets a pseudo-facet
 * be indistinguishable from a real one. `blocked` and `triage` have no row
 * in the `facets` table, so in SQL each would need its own expression in the
 * filter, in the grouping and in the histogram; in JS they need one function and
 * the rest of the engine cannot tell them apart. SQLite keeps the two jobs it is
 * actually better at: full-text and the recursive `blocks` closure.
 */

/** Absence of any value for a facet. Also the trailing group's label, as in P0. */
export const NONE = '(none)';

export type { Dir } from './refs.ts';
import type { Dir } from './refs.ts';

export interface Focus {
  id: string;
  /** A reference facet name, or an edge type while both still exist. */
  via: string;
  dir: Dir;
  /** Hops from the focus. Omit for unlimited. */
  depth?: number;
}

export interface Query {
  /** facet or pseudo-facet → any of these values. `NONE` matches absence. */
  filter?: Record<string, string[]>;
  q?: string;
  focus?: Focus;
  /**
   * Grouping axes, primary first. A second one is what `swimlanes` was going to
   * be — board rows, table sub-sections, canvas nested clusters — so it is a
   * position in this list rather than a key of its own.
   */
  groupBy?: string[];
  /** `facet:asc` ranks by declared order, not alphabetically. */
  sort?: string[];
  /**
   * A grouping option, not a board option — it reads identically for a board's
   * columns and a table's sections.
   */
  uncategorised?: 'end' | 'start' | 'hide';
}

export interface ValueCount {
  value: string;
  count: number;
  selected: boolean;
}

export interface FacetCount {
  facet: string;
  label: string;
  pseudo: boolean;
  values: ValueCount[];
}

/**
 * One group. `lane` is set only when a second grouping axis is in play, and then
 * `value × lane` is the cell — a board's matrix, a table's sub-section.
 */
export interface Group {
  value: string;
  lane?: string;
  ids: string[];
}

export interface QueryResult {
  ids: string[];
  /** Ancestors pulled in for connectivity. Disjoint from `ids`. */
  context: string[];
  groups: Group[] | null;
  /** Distinct values of the primary axis, in order — a board's columns. */
  axis: string[];
  /** Distinct values of the secondary axis, in order — a board's lanes. */
  lanes: string[];
  counts: FacetCount[];
  total: number;
  /**
   * Records left by focus and search, before the facet filter — so
   * `universe - total` is exactly how many the filter is hiding. The sidebar says
   * that number out loud: the worst failure mode of global filtering is "the card
   * isn't there and I don't know why".
   */
  universe: number;
  /** Group memberships, which exceeds `total` when a grouped facet is multi-valued. */
  placements: number;
}

// ---------------------------------------------------------------- pseudo-facets

interface Ctx {
  records: Map<string, Rec>;
  /** Records named by another record through any declared reference facet. */
  nodes: Set<string>;
  /** Records with at least one blocker that is not done. */
  blocked: Set<string>;
  facets: Facets;
  today: string;
}

interface Pseudo {
  label: string;
  values: string[];
  of: (rec: Rec, ctx: Ctx) => string[];
}

const DAY = 86_400_000;

/** Whole days between two `YYYY-MM-DD` dates, or null if the first is unparseable. */
function daysSince(date: string | undefined, today: string): number | null {
  if (!date) return null;
  const a = Date.parse(date);
  const b = Date.parse(today);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / DAY);
}

/**
 * Computed axes, offered in the filter panel exactly like the facets in
 * `facets.yaml`. Every one of them is deterministic (C8): a count, a date
 * comparison or the presence of an edge — never a judgement.
 *
 * Every one of them *computes*, and every one computes over something a facet
 * cannot describe: a `project:` block, the reference graph, an absence, or the
 * app-written `updated` field. `due` used to sit here bucketing a stored value —
 * that is what an ordered facet's own `buckets` do now, so it left.
 */
/**
 * Which of the three triage facets a record is actually missing.
 *
 * Two absences are deliberate rather than gaps, so neither is reported. A
 * **project** record needs neither a project of its own nor a priority: it is
 * where configuration lives, not a piece of work, and ranking a portfolio is a
 * decision rather than a triage step. A **node** — anything another record names
 * through a reference facet — needs no status, because a card that things hang
 * off is a grouping, and giving a grouping a lifecycle puts a container on the
 * work board.
 *
 * The one definition of "needs triage", behind the `triage` axis. The CLI used to
 * carry a second copy in `untriaged()` — where only the CLI exempted a project
 * from `needs-project` — until the worklist became `views/triage.yaml`, which
 * both surfaces read.
 */
export function triageGaps(rec: Rec, isNode: boolean): string[] {
  const missing: string[] = [];
  if (!rec.project) {
    if (!rec.facets.project?.length) missing.push('needs-project');
    if (!rec.facets.priority?.length) missing.push('needs-priority');
  }
  if (!isNode && !rec.facets.status?.length) missing.push('needs-status');
  return missing;
}

export const PSEUDO: Record<string, Pseudo> = {
  type: {
    label: 'Type',
    values: ['project', 'node', 'plain'],
    // A project owns configuration, a node is named by another record, and the
    // rest are plain. The values are deliberately exclusive: a project that is
    // also linked remains a project, so the three counts always add up.
    of: (rec, ctx) => [rec.project ? 'project' : ctx.nodes.has(rec.id) ? 'node' : 'plain'],
  },
  /**
   * Why a record cannot proceed, if it cannot.
   *
   * Both reasons are *derived*, which is why neither is a `status` value any
   * more: `blocked` is an unfinished `blocks` edge and `waiting` is a non-empty
   * `waiting_on`. Storing either alongside the thing it is computed from gives
   * two answers to one question, and nothing to arbitrate between them.
   */
  blocked: {
    label: 'Blocked',
    values: ['blocked', 'waiting', 'clear'],
    of: (rec, ctx) => {
      const why: string[] = [];
      if (ctx.blocked.has(rec.id)) why.push('blocked');
      if (rec.facets.waiting_on?.length) why.push('waiting');
      return why.length ? why : ['clear'];
    },
  },
  triage: {
    label: 'Triage',
    values: ['needs-project', 'needs-priority', 'needs-status', 'complete'],
    of: (rec, ctx) => {
      const missing = triageGaps(rec, ctx.nodes.has(rec.id));
      return missing.length ? missing : ['complete'];
    },
  },
  staleness: {
    label: 'Touched',
    values: ['week', 'month', 'older', 'undated'],
    of: (rec, ctx) => {
      const d = daysSince(rec.updated, ctx.today);
      if (d === null) return ['undated'];
      return [d <= 7 ? 'week' : d <= 31 ? 'month' : 'older'];
    },
  },
  /**
   * Which kinds of external reference a record carries.
   *
   * Every axis on a card was askable except this one: most records here hold a
   * link (110 of 191 at the time of writing) and there was no way to ask which. A
   * record with none yields no value, so "nothing linked" is the ordinary
   * `(none)` refinement.
   */
  linked: {
    label: 'Linked',
    values: [...LINK_KINDS],
    of: (rec) => [...new Set(rec.links.map((l) => l.kind).filter(Boolean))],
  },
};

/**
 * Every record's values for one axis, as the axis presents them.
 *
 * An **ordered facet presents buckets and compares raw**: a date has as many
 * values as there are days, so filtering and grouping see `overdue · today ·
 * week · later` while sorting and range filters see the date itself. That is the
 * one place the two representations differ, and `rankOf` is the other side of it.
 */
function valuesOf(rec: Rec, facet: string, ctx: Ctx): string[] {
  const pseudo = PSEUDO[facet];
  if (pseudo) return pseudo.of(rec, ctx);
  const raw = rec.facets[facet] ?? [];
  const def = ctx.facets[facet];
  if (!def?.buckets?.length) return raw;
  return [...new Set(raw.map((v) => bucketOf(def, v, ctx.today)))];
}

/** The stored values, unbucketed — what sorting and range filters compare. */
function rawOf(rec: Rec, facet: string): string[] {
  return rec.facets[facet] ?? [];
}

function buildCtx(records: Map<string, Rec>, facets: Facets, today: string): Ctx {
  const blocked = new Set<string>();
  for (const { src, dst } of refsOf('blocks', records)) {
    // `src blocks dst`, so an unfinished record blocks each of its targets.
    if (!records.get(src)?.facets.status?.includes('done')) blocked.add(dst);
  }
  return { records, nodes: nodesIn(records, facets), blocked, facets, today };
}

// ---------------------------------------------------------------- traversal

/**
 * The records a focus selects, including the focus itself.
 *
 * `both` is the union of two separate walks, not one walk over both directions —
 * the latter would drag in every sibling's subtree and stop being a focus.
 */
export function focused(focus: Focus, records: Map<string, Rec>): Set<string> {
  const adj = adjacency(focus.via, records);
  if (focus.dir === 'out') return walk(focus.id, adj.out, focus.depth);
  if (focus.dir === 'in') return walk(focus.id, adj.in, focus.depth);
  const both = walk(focus.id, adj.out, focus.depth);
  for (const id of walk(focus.id, adj.in, focus.depth)) both.add(id);
  return both;
}

// ---------------------------------------------------------------- full text

const FTS_SPECIAL = /["*(){}:^\-]/g;

/**
 * A live search box types prefixes, so the trailing token is matched as one:
 * `keyc` finds `keycloak`, which a bare MATCH does not. Tokens are quoted so
 * FTS5 reads them as text — an unbalanced quote or a stray `-` otherwise makes
 * MATCH throw, and a query that throws while you are still typing is a query
 * that looks broken.
 */
export function ftsPrefixQuery(input: string): string | null {
  const tokens = input
    .replace(FTS_SPECIAL, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
}

function ftsIds(db: DatabaseSync, input: string): Set<string> | null {
  const match = ftsPrefixQuery(input);
  if (match === null) return null;
  try {
    const rows = db.prepare('SELECT id FROM fts WHERE fts MATCH ?').all(match) as unknown as {
      id: string;
    }[];
    return new Set(rows.map((r) => r.id));
  } catch {
    // A query FTS5 still refuses matches nothing rather than failing the request.
    return new Set<string>();
  }
}

// ---------------------------------------------------------------- sort

type Comparator = (a: Rec, b: Rec) => number;

function comparator(sort: string[] | undefined, facets: Facets, ctx: Ctx): Comparator {
  const keys = (sort?.length ? sort : ['updated:desc']).map((s) => {
    const [name, dirRaw] = s.split(':');
    return { name: name ?? '', sign: dirRaw === 'desc' ? -1 : 1 };
  });

  const rankOf = (rec: Rec, name: string): number => {
    const def = facets[name];
    const values = valuesOf(rec, name, ctx);
    if (!values.length) return Number.MAX_SAFE_INTEGER;
    const pseudo = PSEUDO[name];
    // A facet's own declared order is its sort order; `priority:asc` means
    // now → month → backlog, which is the whole point of declaring it.
    const order = pseudo ? pseudo.values : def?.values;
    return Math.min(...values.map((v) => (order ? indexOrLast(order, v) : facetRank(def, v))));
  };

  /**
   * An ordered facet sorts by its raw value, not its bucket.
   *
   * A record carrying none sorts last in *both* directions: "no deadline" is not
   * the earliest one, and reversing the sort must not make it the most urgent.
   */
  const ordered = (a: Rec, b: Rec, name: string, sign: number): number => {
    const def = facets[name];
    const av = rawOf(a, name);
    const bv = rawOf(b, name);
    if (!av.length && !bv.length) return 0;
    if (!av.length) return 1 * sign;
    if (!bv.length) return -1 * sign;
    const pick = (vs: string[]) => vs.reduce((lo, v) => (compareValues(def, v, lo) < 0 ? v : lo));
    return compareValues(def, pick(av), pick(bv));
  };

  return (a, b) => {
    for (const { name, sign } of keys) {
      let cmp = 0;
      if (isOrdered(facets[name])) {
        cmp = ordered(a, b, name, sign);
      } else if (name === 'updated' || name === 'created') {
        cmp = (a[name] ?? '').localeCompare(b[name] ?? '');
      } else if (name === 'title') {
        cmp = a.title.localeCompare(b.title);
      } else {
        cmp = rankOf(a, name) - rankOf(b, name);
      }
      if (cmp !== 0) return cmp * sign;
    }
    return a.id.localeCompare(b.id);
  };
}

function indexOrLast(order: string[], value: string): number {
  const i = order.indexOf(value);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

// ---------------------------------------------------------------- the compiler

/** `>2026-09-01` / `<=5` — a comparison rather than a value to match. */
const RANGE = /^(<=|>=|<|>)(.+)$/;

/**
 * Does any raw value satisfy the comparison?
 *
 * Only an ordered facet can be compared, and it is compared *raw* — the bucket
 * is what the panel offers, the value is what a range means.
 */
function inRange(rec: Rec, facet: string, op: string, bound: string, ctx: Ctx): boolean {
  const def = ctx.facets[facet];
  if (!isOrdered(def)) return false;
  return rawOf(rec, facet).some((v) => {
    const c = compareValues(def, v, bound);
    return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
  });
}

function matches(rec: Rec, filter: Record<string, string[]>, ctx: Ctx): boolean {
  for (const [facet, wanted] of Object.entries(filter)) {
    if (!wanted.length) continue;
    const have = valuesOf(rec, facet, ctx);
    // `(none)` is a selectable refinement, not a value — most cards carry no
    // project, and reaching them is the point of having it.
    const ok = wanted.some((w) => {
      const range = RANGE.exec(w);
      if (range) return inRange(rec, facet, range[1]!, range[2]!, ctx);
      return have.length ? have.includes(w) : w === NONE;
    });
    if (!ok) return false;
  }
  return true;
}

/**
 * Disjunctive counts.
 *
 * A facet's own selection is lifted before counting its values, so the other
 * values still show what adding them would bring — count against the fully
 * filtered set instead and every unselected value reads 0, which makes the panel
 * a trapdoor you can narrow through but never widen.
 */
/**
 * Disjunctive counts.
 *
 * Two separate questions, and conflating them is a trapdoor:
 *
 * **Which facets are offered** is decided by the *universe* — what focus and the
 * search box left. Refining by one facet must never remove another, or narrowing
 * hard sheds the panel down to the one axis you already used and there is no way
 * to look sideways. (Amazon does not hide Price because you picked a Brand.) A
 * facet with no real value anywhere in the universe is still dropped, which is
 * what keeps `layer` — absent from 157 of 159 cards — out of the way.
 *
 * **What each value counts** lifts that facet's own selection and applies every
 * other one. Count against the fully filtered set instead and every unselected
 * value reads 0, so a selection could be narrowed but never widened.
 */
function histogram(
  base: Rec[],
  filter: Record<string, string[]>,
  facets: Facets,
  ctx: Ctx,
): FacetCount[] {
  const names = [...Object.keys(facets), ...Object.keys(PSEUDO)];
  const out: FacetCount[] = [];

  for (const facet of names) {
    const selected = filter[facet] ?? [];

    // Offered? Ask the universe, ignoring the facet filter entirely.
    let anywhere = false;
    const seen = new Set<string>();
    for (const rec of base) {
      for (const v of valuesOf(rec, facet, ctx)) {
        anywhere = true;
        seen.add(v);
      }
    }
    if (!anywhere && !selected.length) continue;

    // Counted how? Lift this facet's own selection, keep the rest.
    const rest = Object.fromEntries(Object.entries(filter).filter(([k]) => k !== facet));
    const tally = new Map<string, number>();
    for (const rec of base) {
      if (!matches(rec, rest, ctx)) continue;
      const values = valuesOf(rec, facet, ctx);
      if (!values.length) tally.set(NONE, (tally.get(NONE) ?? 0) + 1);
      for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
    }

    const pseudo = PSEUDO[facet];
    const declared = pseudo ? pseudo.values : orderValues(facets[facet], seen);
    const withNone = tally.has(NONE) || selected.includes(NONE) || base.some((rec) => !valuesOf(rec, facet, ctx).length);
    const values = [...declared, ...(withNone ? [NONE] : [])]
      // Every value the universe holds stays listed even at zero, so the panel
      // says what is available rather than only what is currently matching.
      .filter((v) => seen.has(v) || v === NONE || selected.includes(v))
      .map((v) => ({ value: v, count: tally.get(v) ?? 0, selected: selected.includes(v) }));

    if (values.some((v) => v.value !== NONE || v.selected)) {
      out.push({
        facet,
        label: pseudo?.label ?? facets[facet]?.label ?? facet,
        pseudo: Boolean(pseudo),
        values,
      });
    }
  }
  return out;
}

export interface RunOpts {
  /** Overridable so a test does not depend on the day it runs. */
  today?: string;
  /**
   * Keep ancestors of matched records along this relation, even when they do not
   * match, so a graph stays a graph. They come back as `context`, never as
   * matches — a filter that quietly widens its own result set is one you stop
   * trusting.
   *
   * A run option rather than a query key: it is decided by the *shape* and the
   * vocabulary together, which the query half knows nothing about. Passing the
   * relation rather than a flag is what stops a canvas laying out along one
   * hierarchy and pulling context from another.
   */
  connect?: string;
}

export function runQuery(
  db: DatabaseSync,
  records: Map<string, Rec>,
  facets: Facets,
  query: Query,
  opts: RunOpts = {},
): QueryResult {
  const ctx = buildCtx(records, facets, opts.today ?? new Date().toISOString().slice(0, 10));
  const filter = query.filter ?? {};

  // Focus and full text bound the universe; the facet filter refines inside it.
  // Both are outside the histogram's disjunction on purpose — lifting them per
  // facet would make counts describe a set nobody asked for.
  const scope = query.focus ? focused(query.focus, records) : null;
  const text = query.q ? ftsIds(db, query.q) : null;

  const universe: Rec[] = [];
  for (const rec of records.values()) {
    if (scope && !scope.has(rec.id)) continue;
    if (text && !text.has(rec.id)) continue;
    universe.push(rec);
  }

  const hits = universe.filter((rec) => matches(rec, filter, ctx));
  hits.sort(comparator(query.sort, facets, ctx));
  const ids = hits.map((r) => r.id);

  const context: string[] = [];
  if (opts.connect) {
    const { out: up } = adjacency(opts.connect, records);
    const have = new Set(ids);
    for (const id of ids) {
      // Ancestors only, and drawn as context: a filtered graph that renders as
      // scattered orphans is unreadable, but one that silently adds matches is
      // untrustworthy.
      for (const anc of walk(id, up, undefined)) {
        if (have.has(anc)) continue;
        have.add(anc);
        context.push(anc);
      }
    }
  }

  const grouping = (query.groupBy ?? []).filter(Boolean);
  let groups: Group[] | null = null;
  let axis: string[] = [];
  let lanes: string[] = [];
  let placements = ids.length;

  if (grouping.length) {
    // The axis values, and which records fall on each — one function, so a
    // second grouping axis is the same code as the first.
    const spread = (facet: string) => {
      const buckets = new Map<string, string[]>();
      const seen = new Set<string>();
      const none: string[] = [];
      for (const rec of hits) {
        const values = valuesOf(rec, facet, ctx);
        if (!values.length) {
          none.push(rec.id);
          continue;
        }
        for (const v of values) {
          seen.add(v);
          const list = buckets.get(v);
          if (list) list.push(rec.id);
          else buckets.set(v, [rec.id]);
        }
      }
      const pseudo = PSEUDO[facet];
      // Every declared value gets a group, empty or not: a priority board missing
      // its `now` column reads as though the column did not exist, and an empty
      // column is somewhere to drag a card to.
      const order = pseudo ? [...pseudo.values] : orderValues(facets[facet], seen);
      if (none.length && query.uncategorised !== 'hide') {
        if (query.uncategorised === 'start') order.unshift(NONE);
        else order.push(NONE);
        buckets.set(NONE, none);
      }
      return { order, buckets };
    };

    const primary = spread(grouping[0]!);
    axis = primary.order;

    if (grouping.length === 1) {
      groups = axis.map((value) => ({ value, ids: primary.buckets.get(value) ?? [] }));
    } else {
      const secondary = spread(grouping[1]!);
      lanes = secondary.order;
      const laneOf = new Map<string, Set<string>>();
      for (const lane of lanes) laneOf.set(lane, new Set(secondary.buckets.get(lane) ?? []));
      // Every cell of the matrix, in reading order. A card multi-valued on both
      // axes lands in every cell it belongs to, exactly as it lands in every
      // column on a one-axis board.
      groups = [];
      for (const lane of lanes) {
        const inLane = laneOf.get(lane)!;
        for (const value of axis) {
          groups.push({
            value,
            lane,
            ids: (primary.buckets.get(value) ?? []).filter((id) => inLane.has(id)),
          });
        }
      }
    }
    placements = groups.reduce((n, g) => n + g.ids.length, 0);
  }

  return {
    ids,
    context,
    groups,
    axis,
    lanes,
    counts: histogram(universe, filter, facets, ctx),
    total: ids.length,
    universe: universe.length,
    placements,
  };
}

// ---------------------------------------------------------------- roll-ups

export interface Rollup {
  /** Cards naming this project directly in their `project` facet. */
  direct: number;
  /** …plus everything in a project that belongs to this one, transitively. */
  total: number;
  blocked: number;
  untriaged: number;
  /** Most recent `updated` across the transitive set. */
  touched: string | null;
}

/**
 * Roll-ups for every project record — the numbers the projects table exists for.
 *
 * `direct` and `total` are both reported because the difference is the answer to
 * a real question: `project-b` has one direct member and seven transitive ones, so a
 * single number would either hide its portfolio or overstate its workload.
 * Transitive membership is the `project` walk, which is the same traversal the
 * focus control uses — not a second notion of hierarchy.
 */
export function projectRollups(
  records: Map<string, Rec>,
  facets: Facets,
  today: string,
): Record<string, Rollup> {
  const ctx = buildCtx(records, facets, today);
  const out: Record<string, Rollup> = {};
  for (const rec of records.values()) {
    if (!rec.project) continue;
    const reach = focused({ id: rec.id, via: 'project', dir: 'in' }, records);
    reach.delete(rec.id); // a project is not a member of itself

    let blocked = 0;
    let untriaged = 0;
    let touched: string | null = null;
    for (const id of reach) {
      const member = records.get(id);
      if (!member) continue;
      if (ctx.blocked.has(id)) blocked++;
      if (!PSEUDO.triage!.of(member, ctx).includes('complete')) untriaged++;
      if (member.updated && (!touched || member.updated > touched)) touched = member.updated;
    }

    out[rec.id] = {
      direct: [...records.values()].filter((r) => r.facets.project?.includes(rec.id)).length,
      total: reach.size,
      blocked,
      untriaged,
      touched,
    };
  }
  return out;
}
