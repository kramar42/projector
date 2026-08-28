import type { DatabaseSync } from 'node:sqlite';
import type { Facets, Note } from '../schema/types.ts';
import { isRef } from '../schema/facets.ts';
import { blockedBy, unblocks } from '../index/blocking.ts';
import { computedReader, projectRollups, runQuery, type Group } from '../index/query.ts';
import { inboundCounts, refsOf } from '../index/refs.ts';
import { summariseViews, type SavedViewSummary, type ViewSpec } from './spec.ts';
import { toDTO, type NoteDTO } from './dto.ts';


/**
 * The answer to a `ViewSpec`.
 *
 * `ViewSpec` is the one description of a view, shared by a URL, a `views/*.yaml`
 * file and `pj` flags — this is the other half of that promise. The two surfaces
 * could not drift on the *request* and drifted freely on the *response*, because
 * this assembly lived inside the hono handler and the CLI had no way to reach it.
 * One module, two adapters: `GET /api/query` and `pj ls --json`.
 */
export interface QueryPayload {
  /** The resolved view: the saved one with the URL's overrides applied. */
  spec: ViewSpec;
  /**
   * The saved view `spec` was resolved from, or null for an ad-hoc query.
   *
   * A URL carries overrides, so a control that changes a view has to know what it
   * is overriding. Without this the client could only diff against the resolved
   * spec — which is to say against itself — and its writes were string surgery on
   * the query params instead.
   */
  savedSpec: ViewSpec | null;
  /**
   * Keyed by id, because a note in three columns is one note. P1 embedded the
   * whole note per group and shipped it three times.
   */
  notes: Record<string, NoteDTO>;
  ids: string[];
  context: string[];
  groups: ReturnType<typeof runQuery>['groups'];
  groupOrder: ReturnType<typeof runQuery>['groupOrder'];
  counts: ReturnType<typeof runQuery>['counts'];
  total: number;
  universe: number;
  placements: number;
  layout: string | null;
  relations: { src: string; dst: string; type: string }[];
  rollups: ReturnType<typeof projectRollups>;
  views: SavedViewSummary[];
}

/**
 * What the payload needs to exist.
 *
 * Dependencies are accepted rather than created: the server hands over its
 * memoised handle — keyed on an exact stamp of every file it read — and the CLI
 * builds its own. Loading `root` in here would quietly bypass that memo, and its
 * contract forbids awaiting between the load and the last read of it.
 */
export interface PayloadDeps {
  facets: Facets;
  db: DatabaseSync;
  notes: Map<string, Note>;
  /** Every saved view, projected to what a picker needs. */
  views: ViewSpec[];
  /** Overridable so a test does not depend on the day it runs. */
  today?: string;
  /** The Jira host bare `jira:` refs link to, for this vault. */
  jiraBase?: string | null;
}

export function queryPayload(
  deps: PayloadDeps,
  spec: ViewSpec,
  saved: ViewSpec | null = null,
): QueryPayload {
  const { facets, db, notes, views } = deps;
  const today = deps.today ?? new Date().toISOString().slice(0, 10);

  // A graph has to stay connected to be readable; a column does not. Only a
  // canvas honours it, and along the relation it is laid out by.
  const layout = spec.shape === 'canvas' ? layoutRelation(spec.show, facets) : undefined;
  const res = runQuery(db, notes, facets, spec.query, { connect: layout });

  // A composition's columns are its children's answers, so they replace the
  // grouping this query produced — which is none, a lists view having no axis of
  // its own. Everything downstream reads `groups`/`groupOrder` and needs no case
  // of its own: the board draws three columns, and finds no `groupBy` to drag
  // against, which is exactly right for columns no drop could write.
  const composed = composeLists(deps, spec, today);

  // Ordered here, so every surface receives the view's curated order rather than
  // each renderer deciding whether to honour it.
  const groups =
    composed?.groups ?? res.groups?.map((g) => ({ ...g, ids: applyOrder(g.ids, spec.order?.[g.value]) })) ?? res.groups;

  const ids = composed?.ids ?? res.ids;
  const shown = [...ids, ...res.context];
  const byId: Record<string, NoteDTO> = {};
  // One walk for every note on screen, rather than the same walk once per note.
  const inbound = inboundCounts(notes, facets);
  // Same bargain, for the aggregates every computed axis stands on.
  const computedOf = computedReader(notes, facets, today);
  for (const id of shown) {
    const rec = notes.get(id);
    if (!rec) continue;
    byId[id] = toDTO(rec, {
      facets,
      today,
      jiraBase: deps.jiraBase ?? null,
      computed: computedOf(rec),
      refCount: inbound.get(id) ?? 0,
      blockedBy: blockedBy(id, notes, facets),
      unblocks: unblocks(id, notes, facets),
    });
  }

  return {
    spec,
    savedSpec: saved,
    notes: byId,
    ids,
    context: res.context,
    groups,
    groupOrder: composed ? { primary: composed.primary, secondary: [] } : res.groupOrder,
    counts: res.counts,
    total: composed ? ids.length : res.total,
    universe: res.universe,
    placements: composed
      ? composed.groups.reduce((n, g) => n + g.ids.length, 0)
      : res.placements,
    // Computed here rather than in the client, so the relation a canvas lays out
    // by and the one `connect` walked cannot come apart (C8).
    layout: layout ?? null,
    relations: relationsAmong(notes, facets, new Set(shown), spec.show),
    // Only a table asks for these, but they are cheap and deriving them here
    // keeps every number on screen deterministic (C8).
    rollups: projectRollups(notes, facets),
    views: summariseViews(views),
  };
}

/**
 * A `shape: lists` view's columns: one per child view, in declared order.
 *
 * Grouping cannot express this. A grouped board derives its columns from one
 * axis over one result set, and two of the three questions a triage board asks —
 * "carries a priority but no status" and the mirror of it — are conditions on
 * *different* axes, which no single filter can hold apart. Composition answers
 * them by running the queries separately and putting the answers side by side.
 *
 * A column's value is the child's **title**, because that is what the board
 * prints as a column name; the validator refuses two children whose titles
 * collide, since one column would swallow the other. A child that does not exist
 * is skipped rather than thrown on — `pj check` names it, and a stale reference
 * should cost a column, not the view.
 */
function composeLists(
  deps: PayloadDeps,
  spec: ViewSpec,
  today: string,
): { groups: Group[]; primary: string[]; ids: string[] } | null {
  if (spec.shape !== 'lists' || !spec.lists?.length) return null;
  const byName = new Map(deps.views.map((v) => [v.name ?? '', v]));

  const groups: Group[] = [];
  const primary: string[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const name of spec.lists) {
    const child = byName.get(name);
    if (!child) continue;
    const res = runQuery(deps.db, deps.notes, deps.facets, child.query, { today });
    const value = child.title ?? name;
    primary.push(value);
    // A child of a composition is flat, so the one group it would have had is
    // the nameless one — which is the key its own `order` is stored under.
    groups.push({ value, ids: applyOrder(res.ids, child.order?.['']) });
    for (const id of res.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return { groups, primary, ids };
}

/**
 * Which relation a canvas lays out by: the first *reference* facet in `show`.
 *
 * It lived in `spec.ts` and was that module's only reason to touch `Facets` and
 * `isRef` — which is to say its only reason to be unreachable from a browser.
 * The client never needed it: `layout` arrives computed, precisely so the
 * relation a canvas draws and the one `connect` walked cannot come apart (C8).
 */
export function layoutRelation(show: string[], facets: Facets): string | undefined {
  return show.find((name) => isRef(facets[name]));
}

/**
 * A column's cards in the order the saved view curates, then the rest.
 *
 * An id in `order` that no longer matches is skipped rather than held open, and a
 * card the order has never seen goes after the pinned ones — so a stored order
 * survives cards coming and going without needing to be rewritten.
 *
 * This ran in the browser, applied twice by two different paths in `BoardView` and
 * not at all in `TableView`, and never here — so `pj ls --view portfolio` and the
 * board disagreed about card order, as did a board column and a table section of
 * the same view. It is a property of the answer, not of one renderer.
 */
export function applyOrder(ids: string[], order: string[] | undefined): string[] {
  if (!order?.length) return ids;
  const have = new Set(ids);
  const pinned = order.filter((id) => have.has(id));
  const seen = new Set(pinned);
  return [...pinned, ...ids.filter((id) => !seen.has(id))];
}


function relationsAmong(
  notes: Map<string, Note>,
  facets: Facets,
  ids: Set<string>,
  show: string[],
): { src: string; dst: string; type: string }[] {
  const out: { src: string; dst: string; type: string }[] = [];
  for (const via of show) {
    if (!isRef(facets[via])) continue;
    for (const e of refsOf(via, notes)) {
      if (ids.has(e.src) && ids.has(e.dst)) out.push({ ...e, type: via });
    }
  }
  return out;
}
