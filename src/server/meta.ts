import type { DatabaseSync } from 'node:sqlite';
import type { Facets } from '../schema/types.ts';
import type { Shape } from '../schema/vocabulary.ts';
import type { ViewSpec } from '../view/spec.ts';
import { counts } from '../index/queries.ts';
import { enrichmentStats } from './enrich.ts';
import { listVaults } from '../vault.ts';

/**
 * What the client needs once per vault, rather than once per query.
 *
 * It was an inline object literal in the route, which meant it had no type — so
 * `src/web/types.ts` declared what it *hoped* the shape was and nothing ever
 * checked the two against each other. That is how `views[].title` came to be
 * required on the client and optional here, and how the same view list ended up
 * projected in two places with two encodings of a missing `name`.
 */
export interface Meta {
  vault: string;
  vaultName: string;
  /** The facet vocabulary, so the client never guesses an axis or a label. */
  facets: Facets;
  counts: Record<string, number>;
  enrichment: Record<string, number>;
  views: SavedViewSummary[];
}

/** A saved view as a picker needs it: enough to list and open, not to run. */
export interface SavedViewSummary {
  name: string;
  title: string;
  shape: Shape;
}

/**
 * One projection of the view list, used by both the meta route and the query
 * payload. `name` is optional on a `ViewSpec` because an ad-hoc spec has none;
 * a *saved* one always does, and falling back to the empty string here is what
 * stops the two routes disagreeing about which.
 */
export function summariseViews(views: ViewSpec[]): SavedViewSummary[] {
  return views.map((v) => ({
    name: v.name ?? '',
    title: v.title ?? v.name ?? '',
    shape: v.shape,
  }));
}

export function meta(
  root: string,
  deps: { facets: Facets; db: DatabaseSync; views: ViewSpec[] },
): Meta {
  return {
    vault: root,
    vaultName: listVaults().find((v) => v.path === root)?.name ?? root,
    facets: deps.facets,
    counts: counts(deps.db),
    enrichment: enrichmentStats(root),
    views: summariseViews(deps.views),
  };
}
