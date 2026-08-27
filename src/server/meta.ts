import type { DatabaseSync } from 'node:sqlite';
import type { Facets } from '../schema/types.ts';
import type { ViewSpec } from '../view/spec.ts';
import { summariseViews, type SavedViewSummary } from '../view/spec.ts';
export type { SavedViewSummary };
import { counts } from '../index/queries.ts';
import { computedAxes } from '../index/query.ts';
import { enrichmentStats } from './enrich.ts';
import { listVaults } from '../vault.ts';
import { suppressions } from '../intake/db.ts';

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
  /**
   * The axes the app computes, so a picker can offer them beside the vault's own.
   *
   * `counts` carries these too, but per query and only while something in the
   * universe holds a value — which is right for a filter rail and wrong for a
   * column picker, where an axis has to stay tickable to be untickable. This is
   * the vocabulary answer: what exists, not what the current result set shows.
   */
  computed: { name: string; label: string }[];
  counts: Record<string, number>;
  enrichment: Record<string, number>;
  views: SavedViewSummary[];
  /**
   * How many candidates a sweep declined rather than filed.
   *
   * Not part of a query answer, because a declined candidate is not a note. It
   * belongs to the vault, and the sidebar needs it: with a classifier running an
   * empty board has two meanings — nothing happened, or everything was hidden —
   * and this is what lets the footer say which.
   */
  declined: number;
}



export function meta(
  root: string,
  deps: { facets: Facets; db: DatabaseSync; views: ViewSpec[] },
): Meta {
  return {
    vault: root,
    vaultName: listVaults().find((v) => v.path === root)?.name ?? root,
    facets: deps.facets,
    computed: computedAxes(),
    counts: counts(deps.db, deps.facets),
    enrichment: enrichmentStats(root),
    views: summariseViews(deps.views),
    /**
     * How many candidates were declined rather than filed.
     *
     * Here rather than on the query response because a declined candidate is not
     * a note — `/api/query` has nothing to say about it. It rides on meta for the
     * reason the sidebar needs it: with a classifier running, an empty board has
     * two meanings, and a count is what lets the footer say which.
     */
    declined: declinedCount(root),
  };
}

/** A count, not the rows — the surface fetches those when it opens. */
function declinedCount(root: string): number {
  try {
    // The total, not a page: the footer is counting everything.
    return suppressions(root).total;
  } catch {
    // Meta must answer even if the intake store cannot be opened; a missing
    // count is a missing footer line, not a vault that will not load.
    return 0;
  }
}
