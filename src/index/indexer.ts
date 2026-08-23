import type { DatabaseSync } from 'node:sqlite';
import { listNoteFiles, loadNote } from '../schema/note.ts';
import type { Note } from '../schema/types.ts';
import { isProject } from './project.ts';
import { openDb } from './db.ts';
import { paths } from '../config.ts';

export interface IndexResult {
  db: DatabaseSync;
  notes: Map<string, Note>;
  /** Files that could not be parsed at all; `pj check` reports them. */
  unreadable: { file: string; errors: string[] }[];
  duplicates: { id: string; files: string[] }[];
}

/** Read every card file. Parse failures are collected, never thrown. */
export function readAll(cardsDir: string): {
  notes: Map<string, Note>;
  unreadable: { file: string; errors: string[] }[];
  duplicates: { id: string; files: string[] }[];
} {
  const notes = new Map<string, Note>();
  const unreadable: { file: string; errors: string[] }[] = [];
  const seen = new Map<string, string[]>();

  for (const file of listNoteFiles(cardsDir)) {
    const res = loadNote(file);
    if (!res.ok) {
      unreadable.push({ file: res.file, errors: res.errors });
      continue;
    }
    const rec = res.rec;
    const files = seen.get(rec.id) ?? [];
    files.push(file);
    seen.set(rec.id, files);
    if (!notes.has(rec.id)) notes.set(rec.id, rec);
  }

  const duplicates = [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({ id, files }));

  return { notes, unreadable, duplicates };
}

/** Rebuild the whole index from the card files. */
export function reindex(dataRoot: string): IndexResult {
  const p = paths(dataRoot);
  const { notes, unreadable, duplicates } = readAll(p.notes);
  const db = openDb(p.db, { fresh: true });

  const insRec = db.prepare(
    `INSERT INTO notes (id, title, file, body, created, updated, is_project, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFacet = db.prepare('INSERT OR IGNORE INTO facets (record_id, facet, value) VALUES (?, ?, ?)');
  const insLink = db.prepare('INSERT INTO links (record_id, kind, ref, raw) VALUES (?, ?, ?, ?)');
  const insFts = db.prepare('INSERT INTO fts (id, title, body) VALUES (?, ?, ?)');

  db.exec('BEGIN');
  for (const rec of notes.values()) {
    insRec.run(
      rec.id,
      rec.title,
      rec.file,
      rec.body,
      rec.created ?? null,
      rec.updated ?? null,
      isProject(rec) ? 1 : 0,
      rec.source_fingerprint ?? null,
    );
    for (const [facet, values] of Object.entries(rec.facets)) {
      for (const v of values) insFacet.run(rec.id, facet, v);
    }
    for (const l of rec.links) insLink.run(rec.id, l.kind, l.ref, l.raw);
    insFts.run(rec.id, rec.title, rec.body);
  }
  db.exec('COMMIT');

  return { db, notes, unreadable, duplicates };
}
