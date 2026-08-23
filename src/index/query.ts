import type { DatabaseSync } from 'node:sqlite';
import { bucketOf, compareValues, daysBetween, facetRank, isOrdered, orderValues } from '../schema/facets.ts';
import { LINK_KINDS } from '../schema/links.ts';
import type { Facets, Rec } from '../schema/types.ts';
import { adjacency, nodesIn, walk } from './refs.ts';
import { blockedSet, blockingFacets } from './blocking.ts';

/**
 * One query compiler, for the server and the CLI.
 *
 * Filtering runs in memory over the record map rather than in SQL. That is not a
 * performance trade — at this scale both are free — it is what lets a computed axis
 * be indistinguishable from a real one. `blocked` and `triage` have no row
 * in the `facets` table, so in SQL each would need its own expression in the
 * filter, in the grouping and in the histogram; in JS they need one function and
 * the rest of the engine cannot tell them apart. SQLite keeps the two jobs it is
 * actually better at: full-text and the recursive `blocks` closure.
 */

/** Absence of any value for a facet. Also the trailing group's label, as in P0. */
export { NONE } from '../schema/vocabulary.ts';
import { NONE } from '../schema/vocabulary.ts';

export type { Dir } from './refs.ts';
import type { Dir } from './refs.ts';

export interface Focus {
  id: string;
  /**
   * Which relation to walk. Absent means the first the vocabulary declares.
   *
   * It defaulted to `'parent'` in three places — the URL parser, the serialiser
   * and the intent — which was a facet name written into modules that cannot
   * read `facets.yaml`, and a vault without that relation focused on nothing.
   * The default belongs where the vocabulary is known, which is here.
   */
  via?: string;
  dir: Dir;
  /** Hops from the focus. Omit for unlimited. */
  depth?: number;
}

export interface Query {
  /** facet or computed axis → any of these values. `NONE` matches absence. */
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
}

export interface ValueCount {
  value: string;
  count: number;
  selected: boolean;
}

export interface AxisCount {
  facet: string;
  label: string;
  computed: boolean;
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
  /**
   * The values each grouping level presents, in the order its axis declares.
   *
   * A board reads `primary` as its columns and `secondary` as its lanes; a table
   * as sections and sub-sections; a canvas as bands. Named for the grouping
   * rather than for any of those, because all three read the same two lists.
   *
   * These were `axis` and `lanes` — one field named after the concept and its
   * twin after a board's rendering, and `axis` meaning a *list of values* while
   * the same word everywhere else means the thing you group by.
   */
  groupOrder: { primary: string[]; secondary: string[] };
  counts: AxisCount[];
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

// ---------------------------------------------------------------- computed axes

interface Ctx {
  /** Records named by another record through any declared reference facet. */
  nodes: Set<string>;
  /** Per record, the blocking facets it is failing — empty for one that is not. */
  blocked: Map<string, string[]>;
  facets: Facets;
  today: string;
}

interface Computed {
  label: string;
  /**
   * The values this axis admits, in order.
   *
   * A function of the vocabulary rather than a list, because `triage` names one
   * value per *expected* facet and a vault decides which those are. The three
   * places that read it — the histogram, the grouping order and the sort rank —
   * all hold a `Ctx` already, so nothing needed threading to make it askable.
   */
  values: (facets: Facets) => string[];
  of: (rec: Rec, ctx: Ctx) => string[];
}


/** `daysBetween`, with the nullable date the `staleness` axis actually has. */
function daysSince(date: string | undefined, today: string): number | null {
  return date ? daysBetween(date, today) : null;
}

/** Which facets a vault expects a well-filed card to carry, in declaration order. */
export function expectedFacets(facets: Facets): string[] {
  return Object.entries(facets)
    .filter(([, def]) => def.expected)
    .map(([name]) => name);
}

/**
 * The expected facets a record is missing.
 *
 * It named `project`, `priority` and `status` in code, and carried two
 * exemptions with them: a project record needed neither a project nor a
 * priority, and a node needed no status. Both were *policy* — which is to say
 * they belonged in the view that asks the question, not in the engine that
 * answers it. `views/triage.yaml` filters `type` for exactly this, and a filter
 * you can see and change beats an exemption you cannot.
 *
 * What is left is one sentence with no facet in it, and a vault choosing which
 * axes it means. The one definition of "needs triage", behind the `triage` axis.
 */
export function triageGaps(rec: Rec, facets: Facets): string[] {
  return expectedFacets(facets)
    .filter((name) => !rec.facets[name]?.length)
    .map((name) => `needs-${name}`);
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
export const COMPUTED: Record<string, Computed> = {
  type: {
    label: 'Type',
    values: () => ['project', 'node', 'plain'],
    // A project owns configuration, a node is named by another record, and the
    // rest are plain. The values are deliberately exclusive: a project that is
    // also linked remains a project, so the three counts always add up.
    of: (rec, ctx) => [rec.project ? 'project' : ctx.nodes.has(rec.id) ? 'node' : 'plain'],
  },
  /**
   * Why a record cannot proceed, if it cannot — one value per blocking facet.
   *
   * Derived, which is why none of these is a `status` value: storing a reason
   * alongside the thing it is computed from gives two answers to one question,
   * with nothing to arbitrate between them.
   *
   * The values were `blocked` and `waiting`, hardcoded, which was this same axis
   * with a vault's two blocking facets written into the engine. Naming the facets
   * says the same thing and lets a vault declare a third.
   */
  blocked: {
    label: 'Blocked',
    values: (facets) => [...blockingFacets(facets), 'clear'],
    of: (rec, ctx) => ctx.blocked.get(rec.id) ?? ['clear'],
  },
  triage: {
    label: 'Triage',
    values: (facets) => [...expectedFacets(facets).map((n) => `needs-${n}`), 'complete'],
    of: (rec, ctx) => {
      const missing = triageGaps(rec, ctx.facets);
      return missing.length ? missing : ['complete'];
    },
  },
  staleness: {
    label: 'Touched',
    values: () => ['week', 'month', 'older', 'undated'],
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
    values: () => [...LINK_KINDS],
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
  const computed = COMPUTED[facet];
  if (computed) return computed.of(rec, ctx);
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
  return { nodes: nodesIn(records, facets), blocked: blockedSet(records, facets), facets, today };
}

// ---------------------------------------------------------------- traversal

/** The relation a focus walks: the one it names, or the vault's first. */
export function viaOf(focus: Focus, facets: Facets): string {
  return focus.via ?? firstRef(facets) ?? '';
}

/** The first reference facet the vocabulary declares — the default relation. */
export function firstRef(facets: Facets): string | undefined {
  return Object.entries(facets).find(([, def]) => def.type === 'ref')?.[0];
}

/**
 * The records a focus selects, including the focus itself.
 *
 * `both` is the union of two separate walks, not one walk over both directions —
 * the latter would drag in every sibling's subtree and stop being a focus.
 */
export function focused(focus: Focus & { via: string }, records: Map<string, Rec>): Set<string> {
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

function comparator(sort: string[] | undefined, ctx: Ctx): Comparator {
  const keys = (sort?.length ? sort : ['updated:desc']).map((s) => {
    const [name, dirRaw] = s.split(':');
    return { name: name ?? '', sign: dirRaw === 'desc' ? -1 : 1 };
  });

  const rankOf = (rec: Rec, name: string): number => {
    const def = ctx.facets[name];
    const values = valuesOf(rec, name, ctx);
    if (!values.length) return Number.MAX_SAFE_INTEGER;
    const computed = COMPUTED[name];
    // A facet's own declared order is its sort order; `priority:asc` means
    // now → month → backlog, which is the whole point of declaring it.
    const order = computed ? computed.values(ctx.facets) : def?.values;
    return Math.min(...values.map((v) => (order ? indexOrLast(order, v) : facetRank(def, v))));
  };

  /**
   * An ordered facet sorts by its raw value, not its bucket.
   *
   * A record carrying none sorts last in *both* directions: "no deadline" is not
   * the earliest one, and reversing the sort must not make it the most urgent.
   */
  const ordered = (a: Rec, b: Rec, name: string, sign: number): number => {
    const def = ctx.facets[name];
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
      // Record fields first, and unconditionally.
      //
      // These three names are reserved, so in a valid vault no facet can wear
      // one and the order here decides nothing. It decides everything in a vault
      // that ignored the error: `updated:desc` is the *default* sort, so a facet
      // shadowing it would break the resting view of every board. Testing the
      // vocabulary first also made the winner depend on the facet's type — a
      // `date` one beat the field while a `label` one lost to it.
      if (name === 'updated' || name === 'created') {
        cmp = (a[name] ?? '').localeCompare(b[name] ?? '');
      } else if (name === 'title') {
        cmp = a.title.localeCompare(b.title);
      } else if (isOrdered(ctx.facets[name])) {
        cmp = ordered(a, b, name, sign);
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
 * Which values of one axis the query admits, or `null` for all of them.
 *
 * A filter on the facet a view *groups by* is a statement about which columns the
 * view has, not only about which cards land in them. Grouping by `status`,
 * filtering it to `active` and still drawing a `frozen` column is the view
 * contradicting itself — and it is what left `due` with a permanently empty
 * `later` column and `triage` with a permanently empty `complete` one, columns no
 * card could reach by construction.
 *
 * It also settles an incoherence rather than adding a rule. The axis kept every
 * *declared* value whatever the filter said and dropped every undeclared one, so
 * whether an excluded value survived came down to whether somebody had written it
 * in `facets.yaml`. One question now answers for both.
 *
 * `null` for an axis the filter does not mention, and — the part worth the
 * paragraph — for one selected by range (`f.due=>2026-09-01`), where the tokens
 * are expressions rather than value names and nothing here can say which buckets
 * they cover. Narrowing on a range would hide every column at once, and it would
 * cost the property that makes this safe at all: every hit keeps a column to sit
 * in, because to match a name selection a card must carry one of the names. A
 * card admitted by a range need not.
 */
function admitted(selection: string[] | undefined): Set<string> | null {
  if (!selection?.length) return null;
  if (selection.some((v) => RANGE.test(v))) return null;
  return new Set(selection);
}

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
function histogram(base: Rec[], filter: Record<string, string[]>, ctx: Ctx): AxisCount[] {
  const names = [...Object.keys(ctx.facets), ...Object.keys(COMPUTED)];
  const out: AxisCount[] = [];

  for (const facet of names) {
    const selected = filter[facet] ?? [];
    const computed = COMPUTED[facet];

    // Offered? Ask the universe, ignoring the facet filter entirely.
    let anywhere = false;
    const seen = new Set<string>();
    for (const rec of base) {
      for (const v of valuesOf(rec, facet, ctx)) {
        anywhere = true;
        seen.add(v);
      }
    }

    // The axis's vocabulary: what it declares, plus any value the data holds that
    // it did not. For an open facet with no `values:` this is just the data.
    const declared = computed ? computed.values(ctx.facets) : orderValues(ctx.facets[facet], seen);

    // An axis the *query mentions* stays offered, even with nothing selected on
    // it. `f.due=` is the query saying "explicitly nothing here", which is a
    // different statement from silence — and it is what stops the control
    // disappearing while you are using it. Deselecting the last value used to
    // remove the row, so there was no way left to put the filter back.
    //
    // Silence still narrows: an axis nothing in the universe carries and the query
    // never names is not offered, which is what keeps a focus on one subtree from
    // listing every axis in the vault.
    if (!anywhere && !selected.length && !(facet in filter)) continue;

    // Counted how? Lift this facet's own selection, keep the rest.
    const rest = Object.fromEntries(Object.entries(filter).filter(([k]) => k !== facet));
    const tally = new Map<string, number>();
    for (const rec of base) {
      if (!matches(rec, rest, ctx)) continue;
      const values = valuesOf(rec, facet, ctx);
      if (!values.length) tally.set(NONE, (tally.get(NONE) ?? 0) + 1);
      for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
    }

    const withNone = tally.has(NONE) || selected.includes(NONE) || base.some((rec) => !valuesOf(rec, facet, ctx).length);
    // Every declared value is listed, at zero if need be: the panel says what the
    // axis *is*, not what happens to be matching. There used to be a filter here
    // keeping only values the data held or the query had selected, which is what
    // made a declared-but-unused value — `energy: delegate`, every bucket of an
    // unused `due` — impossible to select even though grouping drew it a column.
    const values = [...declared, ...(withNone ? [NONE] : [])].map((v) => ({
      value: v,
      count: tally.get(v) ?? 0,
      selected: selected.includes(v),
    }));

    if (values.some((v) => v.value !== NONE || v.selected)) {
      out.push({
        facet,
        label: computed?.label ?? ctx.facets[facet]?.label ?? facet,
        computed: Boolean(computed),
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
  const scope = query.focus ? focused({ ...query.focus, via: viaOf(query.focus, facets) }, records) : null;
  const text = query.q ? ftsIds(db, query.q) : null;

  const universe: Rec[] = [];
  for (const rec of records.values()) {
    if (scope && !scope.has(rec.id)) continue;
    if (text && !text.has(rec.id)) continue;
    universe.push(rec);
  }

  const hits = universe.filter((rec) => matches(rec, filter, ctx));
  hits.sort(comparator(query.sort, ctx));
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
  let primary: string[] = [];
  let secondary: string[] = [];
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
      const computed = COMPUTED[facet];
      // Every value the query *admits* gets a group, empty or not: a priority
      // board missing its `now` column reads as though the column did not exist,
      // and an empty admitted column is somewhere to drag a card to. A value the
      // filter excludes is not this axis being empty, it is this axis being
      // smaller — which is the distinction the board could not draw.
      //
      // Intersected with the vocabulary rather than replacing it, so the axis
      // stays a subset of what the facet declares. A selection naming a value no
      // card carries and no vocabulary declares is a broken URL, not a column.
      const admit = admitted(filter[facet]);
      const order = (computed ? computed.values(facets) : orderValues(facets[facet], seen)).filter(
        (v) => admit === null || admit.has(v),
      );
      // `(none)` needs no test of its own, and no policy either. A card with no
      // value here is a hit only when the selection names `(none)`, so the column
      // is absent exactly when nothing is uncategorised or the filter excluded it.
      //
      // There used to be an `uncategorised: end | start | hide` option. `start`
      // had no user in any vault; `hide` had one, and it was dead config — the
      // view already filtered the axis it grouped by, so `(none)` could not
      // appear. Where `hide` was live it was a broken duplicate of a filter: it
      // dropped the cards from the groups but left them in `ids`, so the count
      // over-reported and a canvas — which draws its nodes from `ids` — went on
      // drawing them, in the band meant for context records.
      if (none.length) {
        order.push(NONE);
        buckets.set(NONE, none);
      }
      return { order, buckets };
    };

    const first = spread(grouping[0]!);
    primary = first.order;

    if (grouping.length === 1) {
      groups = primary.map((value) => ({ value, ids: first.buckets.get(value) ?? [] }));
    } else {
      const second = spread(grouping[1]!);
      secondary = second.order;
      const laneOf = new Map<string, Set<string>>();
      for (const lane of secondary) laneOf.set(lane, new Set(second.buckets.get(lane) ?? []));
      // Every cell of the matrix, in reading order. A card multi-valued on both
      // axes lands in every cell it belongs to, exactly as it lands in every
      // column on a one-axis board.
      groups = [];
      for (const lane of secondary) {
        const inLane = laneOf.get(lane)!;
        for (const value of primary) {
          groups.push({
            value,
            lane,
            ids: (first.buckets.get(value) ?? []).filter((id) => inLane.has(id)),
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
    groupOrder: { primary, secondary },
    counts: histogram(universe, filter, ctx),
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
): Record<string, Rollup> {
  // The one graph aggregate directly, rather than a whole `Ctx`. Building one
  // meant taking a `today` this function never asks about — the clock rode in
  // because it is welded to the vocabulary and the aggregates in one struct,
  // which is the argument for splitting `Ctx` made by the code rather than by a
  // reviewer. The node set left with the triage exemption that needed it.
  const waitedOn = blockedSet(records, facets);
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
      if (waitedOn.has(id)) blocked++;
      // `triageGaps` directly: reaching through the computed axis needed a `Ctx`,
      // and it is the same answer one layer less indirect.
      if (triageGaps(member, facets).length) untriaged++;
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
