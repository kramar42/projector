import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../config.ts';

/**
 * Where the last sweep got to, per channel. A third SQLite file, deliberately.
 *
 * `.index.db` is derived from the card files and rebuilt from scratch whenever
 * they change. `.enrich.db` is a cache: TTL'd, clearable, and losing it costs one
 * refetch. Watermarks are neither — lose them and the next sweep re-proposes
 * every message and commit of the last three months. Different lifecycles,
 * different stores, which is the same argument `server/enrich.ts` already makes
 * for not being a table in the index.
 *
 * **What keeps this safe is that the watermark is not load-bearing.**
 * Correctness comes from `source_fingerprint` on the cards: a candidate already
 * captured is dropped whether or not the cursor knows about it. The watermark
 * only decides how far back to *look*, so deleting this file degrades a sweep to
 * a seven-day window — noisier, never wrong, and never duplicating a card.
 *
 * Nothing here is card data, so C1 is untouched: no question about the work has
 * two answers.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watermark (
  channel   TEXT PRIMARY KEY,
  -- Channel-defined and opaque: an ISO timestamp for the ones ck fetches, a
  -- Slack ts or a Gmail date for the ones an agent fetches through MCP.
  cursor    TEXT,
  ran_at    TEXT NOT NULL,
  -- What the run saw and what came of it, for intake status. Advisory.
  seen      INTEGER NOT NULL DEFAULT 0,
  captured  INTEGER NOT NULL DEFAULT 0
);
`;

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
  connections.set(file, conn);
  return conn;
}

export interface Watermark {
  channel: string;
  cursor: string | null;
  ranAt: string;
  seen: number;
  captured: number;
}

export function watermarks(dataRoot: string): Watermark[] {
  const rows = openIntakeDb(dataRoot)
    .prepare('SELECT channel, cursor, ran_at, seen, captured FROM watermark ORDER BY channel')
    .all() as unknown as { channel: string; cursor: string | null; ran_at: string; seen: number; captured: number }[];
  return rows.map((r) => ({
    channel: r.channel,
    cursor: r.cursor,
    ranAt: r.ran_at,
    seen: r.seen,
    captured: r.captured,
  }));
}

export function watermarkFor(dataRoot: string, channel: string): Watermark | null {
  return watermarks(dataRoot).find((w) => w.channel === channel) ?? null;
}

/**
 * Move a channel's cursor forward.
 *
 * Called **after** a proposal has been resolved, never after fetching: a sweep
 * abandoned halfway must not swallow what it had already listed. The consequence
 * is deliberate — once committed, an item declined as "not a card" does not come
 * back, and the cursor is the only record that it was ever considered. A
 * rejection worth keeping belongs on a card with `status: archived`, which keeps
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
         -- nothing has no new boundary to record, and overwriting with null
         -- would reopen the whole window on the next sweep.
         cursor   = COALESCE(excluded.cursor, watermark.cursor),
         ran_at   = excluded.ran_at,
         seen     = excluded.seen,
         captured = excluded.captured`,
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
