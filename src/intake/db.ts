import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../config.ts';

/**
 * Where the last sweep got to, per channel. A third SQLite file, deliberately.
 *
 * `.index.db` is derived from the note files and rebuilt from scratch whenever
 * they change. `.enrich.db` is a cache: TTL'd, clearable, and losing it costs one
 * refetch. Watermarks are neither — lose them and the next sweep re-proposes
 * every message and commit of the last three months. Different lifecycles,
 * different stores, which is the same argument `server/enrich.ts` already makes
 * for not being a table in the index.
 *
 * **What keeps this safe is that the watermark is not load-bearing.**
 * Correctness comes from `source_fingerprint` on the notes: a candidate already
 * captured is dropped whether or not the cursor knows about it. The watermark
 * only decides how far back to *look*, so deleting this file degrades a sweep to
 * a seven-day window — noisier, never wrong, and never duplicating a note.
 *
 * Nothing here is note data, so C1 is untouched: no question about the work has
 * two answers.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watermark (
  channel   TEXT PRIMARY KEY,
  -- Channel-defined and opaque: an ISO timestamp for the ones pj fetches, a
  -- Slack ts or a Gmail date for the ones an agent fetches through MCP.
  cursor    TEXT,
  ran_at    TEXT NOT NULL,
  -- What the run saw and what came of it, for intake status. Advisory.
  seen      INTEGER NOT NULL DEFAULT 0,
  captured  INTEGER NOT NULL DEFAULT 0,
  -- Where the last sweep *would* move the cursor to, and when it proposed that.
  -- Written by a sweep, read only by \`commit --advance\`. A sweep still advances
  -- nothing: an abandoned one leaves a pending value nobody promotes.
  pending_cursor TEXT,
  pending_seen   INTEGER,
  pending_at     TEXT
);
`;

/**
 * Add the pending columns to a store that predates them.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, and dropping
 * this file to get the new shape would cost a real re-sweep — the watermarks in
 * it are the only reason the next run does not re-propose three months of mail.
 */
function migrate(conn: DatabaseSync): void {
  const have = new Set(
    (conn.prepare('PRAGMA table_info(watermark)').all() as { name: string }[]).map((r) => r.name),
  );
  for (const [col, type] of [
    ['pending_cursor', 'TEXT'],
    ['pending_seen', 'INTEGER'],
    ['pending_at', 'TEXT'],
  ] as const) {
    if (!have.has(col)) conn.exec(`ALTER TABLE watermark ADD COLUMN ${col} ${type}`);
  }
}

const connections = new Map<string, DatabaseSync>();

/** One connection per vault, as with enrichment: a shared handle would answer for the wrong vault. */
export function openIntakeDb(dataRoot: string): DatabaseSync {
  const file = paths(dataRoot).intakeDb;
  const existing = connections.get(file);
  if (existing) return existing;
  mkdirSync(dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL;');
  conn.exec(SCHEMA);
  migrate(conn);
  connections.set(file, conn);
  return conn;
}

/**
 * Drop the cached handle for a vault, so the next call reopens.
 *
 * The connection is memoised per file, which means the schema work in
 * `openIntakeDb` runs once per process — and a test that wants to assert the
 * migration has no other way to make it run twice.
 */
export function closeIntakeDb(dataRoot: string): void {
  const file = paths(dataRoot).intakeDb;
  connections.get(file)?.close();
  connections.delete(file);
}

export interface Watermark {
  channel: string;
  cursor: string | null;
  ranAt: string;
  seen: number;
  captured: number;
  /** What the last sweep proposed, unpromoted. Null cursor means "hold where it is". */
  pending?: Pending;
}

export interface Pending {
  cursor: string | null;
  seen: number;
  at: string;
}

export function watermarks(dataRoot: string): Watermark[] {
  const rows = openIntakeDb(dataRoot)
    .prepare(
      `SELECT channel, cursor, ran_at, seen, captured, pending_cursor, pending_seen, pending_at
         FROM watermark ORDER BY channel`,
    )
    .all() as unknown as {
    channel: string;
    cursor: string | null;
    ran_at: string;
    seen: number;
    captured: number;
    pending_cursor: string | null;
    pending_seen: number | null;
    pending_at: string | null;
  }[];
  return rows.map((r) => ({
    channel: r.channel,
    cursor: r.cursor,
    ranAt: r.ran_at,
    seen: r.seen,
    captured: r.captured,
    // `pending_at` is what makes a pending note exist: a truncated run notes
    // a null cursor on purpose, and that is not the same as never having swept.
    ...(r.pending_at
      ? { pending: { cursor: r.pending_cursor, seen: r.pending_seen ?? 0, at: r.pending_at } }
      : {}),
  }));
}

/**
 * Note what a sweep would advance this channel to, without advancing it.
 *
 * The sweep used to write nothing at all, which is why resolving one meant
 * copying an opaque Slack `ts` from one process into the next by hand. It still
 * advances nothing — a pending value is inert until `commitWatermark` promotes
 * it — so an abandoned sweep swallows exactly as little as before.
 */
export function recordPending(
  dataRoot: string,
  channel: string,
  cursor: string | null,
  seen: number,
): void {
  const now = new Date().toISOString();
  openIntakeDb(dataRoot)
    .prepare(
      `INSERT INTO watermark (channel, cursor, ran_at, seen, captured, pending_cursor, pending_seen, pending_at)
       VALUES (?, NULL, ?, 0, 0, ?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         pending_cursor = excluded.pending_cursor,
         pending_seen   = excluded.pending_seen,
         pending_at     = excluded.pending_at`,
    )
    .run(channel, now, cursor, seen, now);
}

export function watermarkFor(dataRoot: string, channel: string): Watermark | null {
  return watermarks(dataRoot).find((w) => w.channel === channel) ?? null;
}

/**
 * Move a channel's cursor forward.
 *
 * Called **after** a proposal has been resolved, never after fetching: a sweep
 * abandoned halfway must not swallow what it had already listed. The consequence
 * is deliberate — once committed, an item declined as "not a note" does not come
 * back, and the cursor is the only note that it was ever considered. A
 * rejection worth keeping belongs on a note with `status: archived`, which keeps
 * its fingerprint.
 */
export function commitWatermark(
  dataRoot: string,
  channel: string,
  cursor: string | null,
  counts: { seen?: number; captured?: number } = {},
): Watermark {
  const now = new Date().toISOString();
  openIntakeDb(dataRoot)
    .prepare(
      `INSERT INTO watermark (channel, cursor, ran_at, seen, captured)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         -- A null cursor means "leave it where it was": a run that fetched
         -- nothing has no new boundary to note, and overwriting with null
         -- would reopen the whole window on the next sweep.
         cursor   = COALESCE(excluded.cursor, watermark.cursor),
         ran_at   = excluded.ran_at,
         seen     = excluded.seen,
         captured = excluded.captured,
         -- A promoted proposal is spent. Leaving it would let a second
         -- \`--advance\` re-commit a cursor that has already moved.
         pending_cursor = NULL,
         pending_seen   = NULL,
         pending_at     = NULL`,
    )
    .run(channel, cursor, now, counts.seen ?? 0, counts.captured ?? 0);
  return watermarkFor(dataRoot, channel)!;
}

/** Forget a channel's cursor, so the next sweep falls back to the default window. */
export function resetWatermark(dataRoot: string, channel?: string): number {
  const conn = openIntakeDb(dataRoot);
  if (!channel) {
    const n = (conn.prepare('SELECT count(*) AS n FROM watermark').get() as { n: number }).n;
    conn.exec('DELETE FROM watermark');
    return n;
  }
  return conn.prepare('DELETE FROM watermark WHERE channel = ?').run(channel).changes as number;
}
