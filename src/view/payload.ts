import type { DatabaseSync } from 'node:sqlite';
import type { Facets, Rec } from '../schema/types.ts';
import { isRef } from '../schema/facets.ts';
import { parentsOf } from '../index/project.ts';
import { blockersOf, unblocks } from '../index/queries.ts';
import { projectRollups, runQuery } from '../index/query.ts';
import { refsOf } from '../index/refs.ts';
import type { ViewSpec } from './spec.ts';
import { toDTO, type CardDTO } from './dto.ts';
import { summariseViews, type SavedViewSummary } from '../server/meta.ts';

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
   * Keyed by id, because a card in three columns is one card. P1 embedded the
   * whole card per group and shipped it three times.
   */
  cards: Record<string, CardDTO>;
  ids: string[];
  context: string[];
  groups: ReturnType<typeof runQuery>['groups'];
  axis: ReturnType<typeof runQuery>['axis'];
  lanes: ReturnType<typeof runQuery>['lanes'];
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
  records: Map<string, Rec>;
  /** Every saved view, projected to what a picker needs. */
  views: ViewSpec[];
  /** Overridable so a test does not depend on the day it runs. */
  today?: string;
}

export function queryPayload(
  deps: PayloadDeps,
  spec: ViewSpec,
  saved: ViewSpec | null = null,
): QueryPayload {
  const { facets, db, records, views } = deps;
  const today = deps.today ?? new Date().toISOString().slice(0, 10);

  // A graph has to stay connected to be readable; a column does not. Only a
  // canvas honours it, and along the relation it is laid out by.
  const layout = spec.shape === 'canvas' ? layoutRelation(spec.show, facets) : undefined;
  const res = runQuery(db, records, facets, spec.query, { connect: layout });

  const shown = [...res.ids, ...res.context];
  const cards: Record<string, CardDTO> = {};
  for (const id of shown) {
    const rec = records.get(id);
    if (!rec) continue;
    cards[id] = toDTO(rec, {
      facets,
      today,
      childCount: countChildren(records, id),
      blockedBy: blockersOf(db, id),
      unblocks: unblocks(db, id).map((u) => u.id),
    });
  }

  return {
    spec,
    savedSpec: saved,
    cards,
    ids: res.ids,
    context: res.context,
    groups: res.groups,
    axis: res.axis,
    lanes: res.lanes,
    counts: res.counts,
    total: res.total,
    universe: res.universe,
    placements: res.placements,
    // Computed here rather than in the client, so the relation a canvas lays out
    // by and the one `connect` walked cannot come apart (C8).
    layout: layout ?? null,
    relations: relationsAmong(records, facets, new Set(shown), spec.show),
    // Only a table asks for these, but they are cheap and deriving them here
    // keeps every number on screen deterministic (C8).
    rollups: projectRollups(records, facets, today),
    views: summariseViews(views),
  };
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

export function countChildren(records: Map<string, Rec>, id: string): number {
  let n = 0;
  for (const rec of records.values()) if (parentsOf(rec).includes(id)) n++;
  return n;
}

function relationsAmong(
  records: Map<string, Rec>,
  facets: Facets,
  ids: Set<string>,
  show: string[],
): { src: string; dst: string; type: string }[] {
  const out: { src: string; dst: string; type: string }[] = [];
  for (const via of show) {
    if (!isRef(facets[via])) continue;
    for (const e of refsOf(via, records)) {
      if (ids.has(e.src) && ids.has(e.dst)) out.push({ ...e, type: via });
    }
  }
  return out;
}
