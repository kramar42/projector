import type { DatabaseSync } from 'node:sqlite';
import type { Facets } from '../schema/types.ts';
import { isRef } from '../schema/facets.ts';

/**
 * What SQL is still for.
 *
 * Filtering, grouping and counting all run in memory over the record map — see
 * `src/index/query.ts` for why. What is left here is the two jobs SQLite is
 * genuinely better at: full text, and the recursive `blocks` closure. Both read
 * the `facets` table, since a relation is a facet value like any other.
 */
export interface Row {
  id: string;
  title: string;
  updated: string | null;
}



/**
 * Records matching an FTS query, most relevant first.
 *
 * `limit` is optional and there is no default. It used to default to 25, which
 * intake passed deliberately and `pj search` did not pass at all — so the command
 * silently truncated at 25 and printed that as the total. A caller that wants a
 * cap says so.
 */
export function search(db: DatabaseSync, query: string, limit?: number): Row[] {
  const sql =
    `SELECT r.id, r.title, r.updated
       FROM fts JOIN records r ON r.id = fts.id
       WHERE fts MATCH ? ORDER BY rank` + (limit === undefined ? '' : ' LIMIT ?');
  const args = limit === undefined ? [query] : [query, limit];
  return db.prepare(sql).all(...args) as unknown as Row[];
}

export function counts(db: DatabaseSync, facets: Facets): Record<string, number> {
  const one = (sql: string, ...args: string[]) =>
    (db.prepare(sql).get(...args) as { n: number }).n;
  // Which facets are relations is the vocabulary's answer. It was three names in
  // the SQL, so a vault's own relation went uncounted and a renamed one dropped
  // out of `pj stats` silently — the only place a wrong number here would show.
  const refs = Object.entries(facets)
    .filter(([, def]) => isRef(def))
    .map(([name]) => name);
  const placeholders = refs.map(() => '?').join(', ') || 'NULL';
  return {
    records: one('SELECT count(*) AS n FROM records'),
    projects: one('SELECT count(*) AS n FROM records WHERE is_project = 1'),
    // A container is a record something names — derived, like the glyph, and
    // across every relation rather than one of them.
    containers: one(
      `SELECT count(DISTINCT value) AS n FROM facets WHERE facet IN (${placeholders})`,
      ...refs,
    ),
    // Relations are facet values, so there is no separate table to count.
    relations: one(
      `SELECT count(*) AS n FROM facets WHERE facet IN (${placeholders})`,
      ...refs,
    ),
    links: one('SELECT count(*) AS n FROM links'),
    facetValues: one('SELECT count(*) AS n FROM facets'),
  };
}
