import type { DatabaseSync } from 'node:sqlite';

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

/** Ids that block `id`: records naming it in their `blocks` facet. */
export function blockersOf(db: DatabaseSync, id: string): { id: string; title: string; done: boolean }[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.title,
              EXISTS (SELECT 1 FROM facets f
                      WHERE f.record_id = r.id AND f.facet = 'status' AND f.value = 'done') AS done
       FROM facets b JOIN records r ON r.id = b.record_id
       WHERE b.facet = 'blocks' AND b.value = ?`,
    )
    .all(id) as unknown as { id: string; title: string; done: number }[];
  return rows.map((r) => ({ id: r.id, title: r.title, done: r.done === 1 }));
}

/**
 * Transitive `blocks` closure downstream of `id` — what finishing this unblocks.
 * Depth-capped, so a cycle in the graph cannot hang the query.
 */
export function unblocks(db: DatabaseSync, id: string, maxDepth = 10): { id: string; depth: number }[] {
  return db
    .prepare(
      `WITH RECURSIVE chain(n, depth) AS (
         SELECT ?, 0
         UNION
         SELECT b.value, c.depth + 1 FROM facets b JOIN chain c ON b.record_id = c.n
         WHERE b.facet = 'blocks' AND c.depth < ?
       )
       SELECT n AS id, depth FROM chain WHERE depth > 0 ORDER BY depth, n`,
    )
    .all(id, maxDepth) as unknown as { id: string; depth: number }[];
}

export function search(db: DatabaseSync, query: string, limit = 25): Row[] {
  return db
    .prepare(
      `SELECT r.id, r.title, r.updated
       FROM fts JOIN records r ON r.id = fts.id
       WHERE fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(query, limit) as unknown as Row[];
}

export function counts(db: DatabaseSync): Record<string, number> {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    records: one('SELECT count(*) AS n FROM records'),
    projects: one('SELECT count(*) AS n FROM records WHERE is_project = 1'),
    // A container is a record something is part of — derived, like the glyph.
    containers: one("SELECT count(DISTINCT value) AS n FROM facets WHERE facet = 'parent'"),
    // Relations are facet values, so there is no separate table to count.
    relations: one(
      "SELECT count(*) AS n FROM facets WHERE facet IN ('parent', 'blocks', 'project')",
    ),
    links: one('SELECT count(*) AS n FROM links'),
    facetValues: one('SELECT count(*) AS n FROM facets'),
  };
}
