import type { DatabaseSync } from 'node:sqlite';
import { listCardFiles, loadCard } from '../schema/card.ts';
import type { Rec } from '../schema/types.ts';
import { isProject } from './project.ts';
import { openDb } from './db.ts';
import { paths } from '../config.ts';

export interface IndexResult {
  db: DatabaseSync;
  records: Map<string, Rec>;
  /** Files that could not be parsed at all; `ck check` reports them. */
  unreadable: { file: string; errors: string[] }[];
  duplicates: { id: string; files: string[] }[];
}

/** Read every card file. Parse failures are collected, never thrown. */
export function readAll(cardsDir: string): {
  records: Map<string, Rec>;
  unreadable: { file: string; errors: string[] }[];
  duplicates: { id: string; files: string[] }[];
} {
  const records = new Map<string, Rec>();
  const unreadable: { file: string; errors: string[] }[] = [];
  const seen = new Map<string, string[]>();

  for (const file of listCardFiles(cardsDir)) {
    const res = loadCard(file);
    if (!res.ok) {
      unreadable.push({ file: res.file, errors: res.errors });
      continue;
    }
    const rec = res.rec;
    const files = seen.get(rec.id) ?? [];
    files.push(file);
    seen.set(rec.id, files);
    if (!records.has(rec.id)) records.set(rec.id, rec);
  }

  const duplicates = [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({ id, files }));

  return { records, unreadable, duplicates };
}

/** Rebuild the whole index from the card files. */
export function reindex(dataRoot: string): IndexResult {
  const p = paths(dataRoot);
  const { records, unreadable, duplicates } = readAll(p.cards);
  const db = openDb(p.db, { fresh: true });

  const insRec = db.prepare(
    `INSERT INTO records (id, kind, title, file, body, created, updated, is_project, project, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFacet = db.prepare('INSERT OR IGNORE INTO facets (record_id, facet, value) VALUES (?, ?, ?)');
  const insEdge = db.prepare('INSERT OR IGNORE INTO edges (src, dst, type) VALUES (?, ?, ?)');
  const insLink = db.prepare('INSERT INTO links (record_id, kind, ref, raw) VALUES (?, ?, ?, ?)');
  const insFts = db.prepare('INSERT INTO fts (id, title, body) VALUES (?, ?, ?)');

  db.exec('BEGIN');
  for (const rec of records.values()) {
    insRec.run(
      rec.id,
      rec.kind,
      rec.title,
      rec.file,
      rec.body,
      rec.created ?? null,
      rec.updated ?? null,
      isProject(rec) ? 1 : 0,
      rec.facets.project?.[0] ?? null,
      rec.source_fingerprint ?? null,
    );
    for (const [facet, values] of Object.entries(rec.facets)) {
      for (const v of values) insFacet.run(rec.id, facet, v);
    }
    for (const e of rec.edges) insEdge.run(rec.id, e.to, e.type);
    for (const l of rec.links) insLink.run(rec.id, l.kind, l.ref, l.raw);
    insFts.run(rec.id, rec.title, rec.body);
  }
  db.exec('COMMIT');

  return { db, records, unreadable, duplicates };
}
