import type { DatabaseSync } from 'node:sqlite';
import { facetRank } from '../schema/facets.ts';
import type { Facets } from '../schema/types.ts';

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
  due: string | null;
  updated: string | null;
}

export interface ListOpts {
  /** facet → one of these values must be present. */
  filter?: Record<string, string[]>;
}

function filterClause(filter: Record<string, string[]> | undefined): { sql: string; args: string[] } {
  if (!filter || !Object.keys(filter).length) return { sql: '', args: [] };
  const parts: string[] = [];
  const args: string[] = [];
  for (const [facet, values] of Object.entries(filter)) {
    if (!values.length) continue;
    const marks = values.map(() => '?').join(', ');
    parts.push(
      `EXISTS (SELECT 1 FROM facets f WHERE f.record_id = r.id AND f.facet = ? AND f.value IN (${marks}))`,
    );
    args.push(facet, ...values);
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
}

export function listRecords(db: DatabaseSync, opts: ListOpts = {}): Row[] {
  const { sql, args } = filterClause(opts.filter);
  return db
    .prepare(
      `SELECT r.id, r.title, r.due, r.updated
       FROM records r WHERE 1=1${sql}
       ORDER BY r.updated DESC NULLS LAST, r.id`,
    )
    .all(...args) as unknown as Row[];
}

export function valuesFor(db: DatabaseSync, recordId: string, facet: string): string[] {
  return (
    db
      .prepare('SELECT value FROM facets WHERE record_id = ? AND facet = ? ORDER BY value')
      .all(recordId, facet) as unknown as { value: string }[]
  ).map((r) => r.value);
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

/**
 * Actionable cards: open status, nobody waited on, and no blocker that is not
 * done. Deterministic by construction (C8) — this is a query, never a judgement.
 *
 * A deadline outranks an intention, so `due` sorts before `priority`: a card
 * due tomorrow is next whatever bucket it was filed in. Cards with no deadline
 * fall through to priority, which is where most of them live.
 */
export function nextUp(db: DatabaseSync, facets: Facets): Row[] {
  // `kind` is an ordinary facet, so cards-only is a filter like any other rather
  // than a clause of its own.
  const open = listRecords(db, { filter: { kind: ['card'], status: ['planning', 'active'] } });
  const actionable = open.filter(
    (r) => blockersOf(db, r.id).every((b) => b.done) && !valuesFor(db, r.id, 'waiting_on').length,
  );
  const def = facets.priority;
  return actionable.sort((a, b) => {
    const da = a.due ?? '\uffff';
    const dbv = b.due ?? '\uffff';
    if (da !== dbv) return da.localeCompare(dbv);
    const pa = Math.min(...(valuesFor(db, a.id, 'priority').map((v) => facetRank(def, v)) || []), Number.MAX_SAFE_INTEGER);
    const pb = Math.min(...(valuesFor(db, b.id, 'priority').map((v) => facetRank(def, v)) || []), Number.MAX_SAFE_INTEGER);
    if (pa !== pb) return pa - pb;
    return (b.updated ?? '').localeCompare(a.updated ?? '');
  });
}

export function search(db: DatabaseSync, query: string, limit = 25): Row[] {
  return db
    .prepare(
      `SELECT r.id, r.title, r.due, r.updated
       FROM fts JOIN records r ON r.id = fts.id
       WHERE fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(query, limit) as unknown as Row[];
}

export function counts(db: DatabaseSync): Record<string, number> {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    records: one('SELECT count(*) AS n FROM records'),
    // `kind` lives in the facets table like every other facet; there is no
    // column shadowing it in `records`.
    cards: one("SELECT count(*) AS n FROM facets WHERE facet = 'kind' AND value = 'card'"),
    nodes: one("SELECT count(*) AS n FROM facets WHERE facet = 'kind' AND value = 'node'"),
    projects: one('SELECT count(*) AS n FROM records WHERE is_project = 1'),
    // Relations are facet values, so there is no separate table to count.
    relations: one(
      "SELECT count(*) AS n FROM facets WHERE facet IN ('parent', 'blocks', 'project')",
    ),
    links: one('SELECT count(*) AS n FROM links'),
    facetValues: one('SELECT count(*) AS n FROM facets'),
  };
}
