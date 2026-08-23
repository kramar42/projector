import type { DatabaseSync } from 'node:sqlite';
import type { Facets } from '../schema/types.ts';
import type { ViewSpec } from '../view/spec.ts';
import { summariseViews, type SavedViewSummary } from '../view/spec.ts';
export type { SavedViewSummary };
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



export function meta(
  root: string,
  deps: { facets: Facets; db: DatabaseSync; views: ViewSpec[] },
): Meta {
  return {
    vault: root,
    vaultName: listVaults().find((v) => v.path === root)?.name ?? root,
    facets: deps.facets,
    counts: counts(deps.db, deps.facets),
    enrichment: enrichmentStats(root),
    views: summariseViews(deps.views),
  };
}
