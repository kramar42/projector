import type { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listNoteFiles, loadNote } from '../schema/note.ts';
import type { Note } from '../schema/types.ts';
import { isProject } from './project.ts';
import { openDb } from './db.ts';
import { paths } from '../config.ts';

export interface IndexResult {
  db: DatabaseSync;
  /** True when the persisted index answered and nothing was re-read. */
  cached: boolean;
  notes: Map<string, Note>;
  /** Files that could not be parsed at all; `pj check` reports them. */
  unreadable: { file: string; errors: string[] }[];
  duplicates: { id: string; files: string[] }[];
}

/** Read every note file. Parse failures are collected, never thrown. */
export function readAll(
  cardsDir: string,
  files: string[] = listNoteFiles(cardsDir),
): {
  notes: Map<string, Note>;
  unreadable: { file: string; errors: string[] }[];
  duplicates: { id: string; files: string[] }[];
} {
  const notes = new Map<string, Note>();
  const unreadable: { file: string; errors: string[] }[] = [];
  const seen = new Map<string, string[]>();

  for (const file of files) {
    const res = loadNote(file, cardsDir);
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

const STAMP_VERSION = 'v1';

/**
 * An exact stamp of everything `reindex` reads: every note file's mtime, the
 * vocabulary, the views, and the walk's own ignore file. The same contract as
 * the server memo's stamp (C1): if any byte could have changed, the stamp
 * changes. Sums use BigInt so a large vault cannot silently lose mtime bits.
 */
export function indexStamp(notesDir: string): { stamp: string; files: string[] } {
  const files = listNoteFiles(notesDir);
  const extra = [join(notesDir, '.projector', 'facets.yaml'), join(notesDir, '.projector', 'ignore')];
  try {
    for (const v of readdirSync(join(notesDir, '.projector', 'views'))) {
      extra.push(join(notesDir, '.projector', 'views', v));
    }
  } catch {
    // no views dir, nothing to stamp
  }
  let count = 0;
  let sum = 0n;
  let max = 0n;
  for (const f of [...files, ...extra]) {
    const st = statSync(f, { throwIfNoEntry: false });
    if (!st) continue;
    count++;
    const m = BigInt(Math.floor(st.mtimeMs));
    sum += m;
    if (m > max) max = m;
  }
  return { stamp: `${STAMP_VERSION}:${files.length}:${count}:${sum}:${max}`, files };
}

/**
 * Rebuild the whole index from the note files — unless the persisted one was
 * built from exactly these bytes. The server's memo cannot help the CLI, which
 * is a fresh process per command; the gate makes the second `pj` of the day
 * cost a stat-walk instead of a parse of every note. `force` is `pj reindex`'s
 * contract: a command named reindex must actually reindex.
 */
export function reindex(dataRoot: string, { force = false } = {}): IndexResult {
  const p = paths(dataRoot);
  const { stamp, files } = indexStamp(p.notes);

  if (!force) {
    try {
      const db = openDb(p.db);
      const row = db.prepare("SELECT value FROM meta WHERE key = 'payload'").get() as
        | { value: string }
        | undefined;
      if (row) {
        const payload = JSON.parse(row.value) as {
          stamp: string;
          notes: [string, Note][];
          unreadable: IndexResult['unreadable'];
          duplicates: IndexResult['duplicates'];
        };
        if (payload.stamp === stamp) {
          return {
            db,
            cached: true,
            notes: new Map(payload.notes),
            unreadable: payload.unreadable,
            duplicates: payload.duplicates,
          };
        }
      }
      db.close();
    } catch {
      // absent, pre-meta schema, or unreadable payload — rebuild below
    }
  }

  const { notes, unreadable, duplicates } = readAll(p.notes, files);
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
  db.prepare("INSERT INTO meta (key, value) VALUES ('payload', ?)").run(
    JSON.stringify({ stamp, notes: [...notes.entries()], unreadable, duplicates }),
  );
  db.exec('COMMIT');

  return { db, cached: false, notes, unreadable, duplicates };
}
