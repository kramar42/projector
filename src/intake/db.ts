import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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

-- A candidate somebody judged as "not a note", so a later sweep stops offering it.
--
-- Only *judgements* land here, never a channel's own mechanical skip. The
-- difference is reproducibility: a channel declining a merge commit or a session
-- with no prompt re-derives that answer identically on every sweep, so storing it
-- would be storing something derivable (C11). A judgement about whether work
-- matters is not reproducible — a different threshold or a different model
-- answers differently — and that is precisely why it needs somewhere to live.
--
-- Still not load-bearing, on the same argument as the watermark: lose this table
-- and a re-sweep re-proposes what was declined. Noisier, never wrong, and never a
-- duplicate note, because \`source_fingerprint\` on the notes is what stops those.
CREATE TABLE IF NOT EXISTS suppressed (
  -- The candidate's fingerprint, which is derived from the thing itself and not
  -- its wording, so a re-sweep matches what was judged rather than something that
  -- merely reads like it.
  fingerprint TEXT PRIMARY KEY,
  channel     TEXT,
  title       TEXT,
  -- Never null. A suppression with no reason cannot be reviewed, and the whole
  -- safety of a threshold is that the pile it hides stays readable.
  reason      TEXT NOT NULL,
  at          TEXT NOT NULL
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

/**
 * Remove a write-ahead log whose database is gone.
 *
 * This store is in WAL mode, so it is three files. Deleting the database and
 * leaving the sidecars — which is what deleting "the file" looks like to anyone
 * who has not thought about WAL — makes the next open fail outright with a disk
 * I/O error. That would break the property the whole design rests on: losing this
 * store is meant to cost a wider sweep, never a working command.
 *
 * Narrow on purpose. It fires only when the database itself is absent and a
 * sidecar is present, which is unambiguously "somebody deleted it" and has
 * nothing left to lose — the authoritative file is already gone. Any other I/O
 * failure, a full disk or a permission problem, still raises where the caller can
 * see it rather than being swept up as a stale log.
 */
function dropOrphanedWal(file: string): void {
  if (existsSync(file)) return;
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(file + suffix)) rmSync(file + suffix, { force: true });
  }
}

/** One connection per vault, as with enrichment: a shared handle would answer for the wrong vault. */
export function openIntakeDb(dataRoot: string): DatabaseSync {
  const file = paths(dataRoot).intakeDb;
  const existing = connections.get(file);
  if (existing) return existing;
  mkdirSync(dirname(file), { recursive: true });
  dropOrphanedWal(file);
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
 * abandoned halfway must not swallow what it had already listed.
 *
 * Once committed, an item declined as "not a note" is behind the cursor. What
 * keeps that from losing it is `suppress` — a declined candidate recorded by
 * fingerprint, with its reason, readable afterwards through `suppressions` and
 * reversible through `unsuppress`. Before that table existed the cursor was the
 * only trace that anything had been considered, and the advice was to keep the
 * rejection as a note with `status: archived` — which is still right for one
 * considered no, and absurd at the volume a sweep of your own commits produces.
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

// --------------------------------------------------------------- suppressions

export interface Suppression {
  fingerprint: string;
  channel: string | null;
  title: string | null;
  reason: string;
  at: string;
}

/**
 * Record that a candidate was judged not to deserve a note.
 *
 * The counterpart to `pj add`: capture says yes and writes a file, this says no
 * and writes a row. Both are needed for a sweep to converge, and only one of them
 * existed — a declined candidate used to leave nothing behind but a moved cursor,
 * so nothing could tell "seen and rejected" from "never fetched", and the
 * rejection could not inform anything later.
 *
 * Re-suppressing the same fingerprint replaces the reason rather than failing:
 * the second judgement is the current one, and a caller re-running a sweep should
 * not have to care whether it already answered for this item.
 */
export function suppress(
  dataRoot: string,
  entry: { fingerprint: string; reason: string; channel?: string; title?: string },
): Suppression {
  const at = new Date().toISOString();
  openIntakeDb(dataRoot)
    .prepare(
      `INSERT INTO suppressed (fingerprint, channel, title, reason, at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         channel = COALESCE(excluded.channel, suppressed.channel),
         title   = COALESCE(excluded.title, suppressed.title),
         reason  = excluded.reason,
         at      = excluded.at`,
    )
    .run(entry.fingerprint, entry.channel ?? null, entry.title ?? null, entry.reason, at);
  return {
    fingerprint: entry.fingerprint,
    channel: entry.channel ?? null,
    title: entry.title ?? null,
    reason: entry.reason,
    at,
  };
}

/**
 * Un-hide a candidate, so the next sweep offers it again.
 *
 * The reason this exists at all is an asymmetry worth stating: getting the
 * ordering wrong costs a reader some scrolling, and suppressing wrongly costs them
 * the item. So every suppression has to be reversible and the pile has to be
 * readable, or raising a threshold is an act of faith.
 */
export function unsuppress(dataRoot: string, fingerprint: string): boolean {
  return (
    (openIntakeDb(dataRoot)
      .prepare('DELETE FROM suppressed WHERE fingerprint = ?')
      .run(fingerprint).changes as number) > 0
  );
}

/** Everything suppressed, newest judgement first. `channel` narrows it. */
export function suppressions(dataRoot: string, channel?: string): Suppression[] {
  const conn = openIntakeDb(dataRoot);
  const rows = (
    channel
      ? conn
          .prepare(
            `SELECT fingerprint, channel, title, reason, at FROM suppressed
              WHERE channel = ? ORDER BY at DESC`,
          )
          .all(channel)
      : conn
          .prepare(
            `SELECT fingerprint, channel, title, reason, at FROM suppressed ORDER BY at DESC`,
          )
          .all()
  ) as unknown as Suppression[];
  return rows;
}

/**
 * Every suppressed fingerprint, for the sweep to drop candidates against.
 *
 * A set rather than a query per candidate, for the reason `readVault` gives about
 * the index: one round trip answers for a whole run.
 */
export function suppressedFingerprints(dataRoot: string): Set<string> {
  const rows = openIntakeDb(dataRoot)
    .prepare('SELECT fingerprint FROM suppressed')
    .all() as unknown as { fingerprint: string }[];
  return new Set(rows.map((r) => r.fingerprint));
}
