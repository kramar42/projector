import type { DatabaseSync } from 'node:sqlite';
import { facetRank, orderValues } from '../schema/facets.ts';
import type { Facets } from '../schema/types.ts';

export interface Row {
  id: string;
  kind: string;
  title: string;
  updated: string | null;
  is_project: number;
  project: string | null;
}

export const UNCATEGORISED = '(none)';

export interface ListOpts {
  groupBy?: string;
  kind?: 'card' | 'node';
  /** facet → one of these values must be present. */
  filter?: Record<string, string[]>;
  includeNodes?: boolean;
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
  const { sql: fSql, args: fArgs } = filterClause(opts.filter);
  const kindSql = opts.kind ? ' AND r.kind = ?' : opts.includeNodes ? '' : " AND r.kind = 'card'";
  const args: string[] = [];
  if (opts.kind) args.push(opts.kind);
  const rows = db
    .prepare(
      `SELECT r.id, r.kind, r.title, r.updated, r.is_project, r.project
       FROM records r WHERE 1=1${kindSql}${fSql}
       ORDER BY r.updated DESC NULLS LAST, r.id`,
    )
    .all(...args, ...fArgs) as unknown as Row[];
  return rows;
}

export function valuesFor(db: DatabaseSync, recordId: string, facet: string): string[] {
  return (
    db
      .prepare('SELECT value FROM facets WHERE record_id = ? AND facet = ? ORDER BY value')
      .all(recordId, facet) as unknown as { value: string }[]
  ).map((r) => r.value);
}

export interface Group {
  value: string;
  rows: Row[];
}

/**
 * Group rows by a facet. A row whose facet holds several values appears in
 * every matching group — that is the whole point of the model, not a special
 * case. Rows with no value for the facet land in a single trailing group.
 */
export function groupBy(db: DatabaseSync, rows: Row[], facet: string, facets: Facets): Group[] {
  const buckets = new Map<string, Row[]>();
  const seen = new Set<string>();
  const none: Row[] = [];

  for (const row of rows) {
    const vals = valuesFor(db, row.id, facet);
    if (!vals.length) {
      none.push(row);
      continue;
    }
    for (const v of vals) {
      seen.add(v);
      const list = buckets.get(v) ?? [];
      list.push(row);
      buckets.set(v, list);
    }
  }

  const ordered = orderValues(facets[facet], seen);
  const groups: Group[] = ordered
    .filter((v) => buckets.has(v))
    .map((v) => ({ value: v, rows: buckets.get(v)! }));
  if (none.length) groups.push({ value: UNCATEGORISED, rows: none });
  return groups;
}

/** Ids that block `id`: sources of a `blocks` edge pointing at it. */
export function blockersOf(db: DatabaseSync, id: string): { id: string; title: string; done: boolean }[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.title,
              EXISTS (SELECT 1 FROM facets f
                      WHERE f.record_id = r.id AND f.facet = 'status' AND f.value = 'done') AS done
       FROM edges e JOIN records r ON r.id = e.src
       WHERE e.dst = ? AND e.type = 'blocks'`,
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
         SELECT e.dst, c.depth + 1 FROM edges e JOIN chain c ON e.src = c.n
         WHERE e.type = 'blocks' AND c.depth < ?
       )
       SELECT n AS id, depth FROM chain WHERE depth > 0 ORDER BY depth, n`,
    )
    .all(id, maxDepth) as unknown as { id: string; depth: number }[];
}

/**
 * Actionable cards: open status, and no blocker that is not done.
 * Deterministic by construction (C8) — this is a query, never a judgement.
 */
export function nextUp(db: DatabaseSync, facets: Facets): Row[] {
  const open = listRecords(db, { filter: { status: ['planning', 'active'] } });
  const unblocked = open.filter((r) => blockersOf(db, r.id).every((b) => b.done));
  const def = facets.priority;
  return unblocked.sort((a, b) => {
    const pa = Math.min(...(valuesFor(db, a.id, 'priority').map((v) => facetRank(def, v)) || []), Number.MAX_SAFE_INTEGER);
    const pb = Math.min(...(valuesFor(db, b.id, 'priority').map((v) => facetRank(def, v)) || []), Number.MAX_SAFE_INTEGER);
    if (pa !== pb) return pa - pb;
    return (b.updated ?? '').localeCompare(a.updated ?? '');
  });
}

export function search(db: DatabaseSync, query: string, limit = 25): Row[] {
  return db
    .prepare(
      `SELECT r.id, r.kind, r.title, r.updated, r.is_project, r.project
       FROM fts JOIN records r ON r.id = fts.id
       WHERE fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(query, limit) as unknown as Row[];
}

export function counts(db: DatabaseSync): Record<string, number> {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    records: one('SELECT count(*) AS n FROM records'),
    cards: one("SELECT count(*) AS n FROM records WHERE kind = 'card'"),
    nodes: one("SELECT count(*) AS n FROM records WHERE kind = 'node'"),
    projects: one('SELECT count(*) AS n FROM records WHERE is_project = 1'),
    edges: one('SELECT count(*) AS n FROM edges'),
    links: one('SELECT count(*) AS n FROM links'),
    facetValues: one('SELECT count(*) AS n FROM facets'),
  };
}
