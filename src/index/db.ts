import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The index is derived and disposable. Nothing here is authoritative — a cold
 * `pj reindex` from the card files is always correct, so the schema is free to
 * change without a migration.
 */
const SCHEMA = `
CREATE TABLE notes (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  file          TEXT NOT NULL,
  body          TEXT NOT NULL,
  created       TEXT,
  updated       TEXT,
  -- Derived from the project: block, which is not a facet — so unlike kind and
  -- project, this column is not shadowing a row in the facets table.
  is_project    INTEGER NOT NULL DEFAULT 0,
  fingerprint   TEXT
);
CREATE TABLE facets (
  record_id TEXT NOT NULL,
  facet     TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (record_id, facet, value)
);
CREATE TABLE links (
  record_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  ref       TEXT NOT NULL,
  raw       TEXT NOT NULL
);
CREATE TABLE cache (
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  json       TEXT,
  fetched_at TEXT,
  error      TEXT,
  PRIMARY KEY (kind, ref)
);
CREATE INDEX idx_facets_lookup ON facets(facet, value);
CREATE INDEX idx_links_record ON links(record_id);
CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, title, body, tokenize='porter unicode61');
`;

export function openDb(path: string, { fresh = false } = {}): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  if (fresh) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        rmSync(path + suffix);
      } catch {
        /* not present */
      }
    }
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const hasRecords = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='notes'")
    .get() as { n: number };
  if (!hasRecords.n) db.exec(SCHEMA);
  return db;
}
