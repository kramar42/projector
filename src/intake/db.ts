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
  -- Slack ts or a Gmail date for externally fetched channels.
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
  at          TEXT NOT NULL,
  -- Who decided: 'model' or 'person'. Not decoration — a model's decline is a
  -- prediction that may be wrong, and a person's is the ground truth you would
  -- check it against. Calibration cannot use a pile that does not say which is
  -- which, and neither can a reader deciding how much to trust an empty board.
  decided_by  TEXT NOT NULL DEFAULT 'person',
  -- Whether the thing declined had already been accepted as a note.
  --
  -- Deleting an unjudged card is *declining an offer*, and it is the same act the
  -- classifier performs when it drops a candidate — one record, differing only in
  -- who made it. Deleting a note you accepted and worked on is not that act. It
  -- says the work is finished with, which is a fact about the work rather than
  -- about the offer, and a classifier taught from it learns to withhold the kind
  -- of thing you keep for a month and then let go.
  --
  -- Both still suppress, because both have to stop a later sweep re-proposing the
  -- thing. Only one of them teaches: suppressions({ wasJudged: false }) is what
  -- classify.ts calibrates from.
  was_judged  INTEGER NOT NULL DEFAULT 0
);

-- A decline somebody took back.
--
-- The most valuable row in this file, and the one that had nowhere to go: an
-- un-suppression means the judgement was wrong in the expensive direction, and
-- that is worth more than any number of declines it got right. A dismissal only
-- says the reader agreed; this says they did not.
--
-- Kept when the suppression row is deleted, which is the point -- the pile is
-- where a wrong call is corrected, and the correction is the thing to learn from.
CREATE TABLE IF NOT EXISTS rescued (
  fingerprint TEXT PRIMARY KEY,
  channel     TEXT,
  title       TEXT,
  -- Why it had been declined. The example is the pairing: this text, and the
  -- fact that a person disagreed with it.
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

  // Same reasoning for the suppressions table, which predates knowing who
  // decided. An existing row is defaulted to 'person', which is what every row
  // written before the classifier existed actually was.
  const supp = new Set(
    (conn.prepare('PRAGMA table_info(suppressed)').all() as { name: string }[]).map((r) => r.name),
  );
  if (supp.size && !supp.has('decided_by')) {
    conn.exec("ALTER TABLE suppressed ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'person'");
  }

  // And `was_judged`, where 0 is right for every row that predates it: the only
  // writer that sets it is the delete cascade, and until it could, nothing told a
  // declined offer apart from a discarded note.
  if (supp.size && !supp.has('was_judged')) {
    conn.exec('ALTER TABLE suppressed ADD COLUMN was_judged INTEGER NOT NULL DEFAULT 0');
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

export type DecidedBy = 'model' | 'person';

export interface Suppression {
  fingerprint: string;
  channel: string | null;
  title: string | null;
  reason: string;
  at: string;
  decidedBy: DecidedBy;
  /** True when what was declined had already been accepted as a note. */
  wasJudged: boolean;
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
  entry: {
    fingerprint: string;
    reason: string;
    channel?: string;
    title?: string;
    /** Defaults to 'person': a caller that does not say is a person at a keyboard. */
    by?: DecidedBy;
    /** True when what is being declined had already been accepted. See `was_judged`. */
    wasJudged?: boolean;
  },
): Suppression {
  const at = new Date().toISOString();
  const by: DecidedBy = entry.by ?? 'person';
  const wasJudged = entry.wasJudged ?? false;
  openIntakeDb(dataRoot)
    .prepare(
      `INSERT INTO suppressed (fingerprint, channel, title, reason, at, decided_by, was_judged)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         channel = COALESCE(excluded.channel, suppressed.channel),
         title   = COALESCE(excluded.title, suppressed.title),
         reason  = excluded.reason,
         at      = excluded.at,
         -- A person overruling the model is the point of the pile being readable,
         -- so the later decision wins and says whose it was.
         decided_by = excluded.decided_by,
         was_judged = excluded.was_judged`,
    )
    .run(
      entry.fingerprint,
      entry.channel ?? null,
      entry.title ?? null,
      entry.reason,
      at,
      by,
      wasJudged ? 1 : 0,
    );
  return {
    fingerprint: entry.fingerprint,
    channel: entry.channel ?? null,
    title: entry.title ?? null,
    reason: entry.reason,
    at,
    decidedBy: by,
    wasJudged,
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
export interface Restored {
  fingerprint: string;
  /**
   * The channel whose cursor was walked back, or null when none could be named.
   * Null is not a failure: the row is gone either way, and a sweep that already
   * reaches this item needed no help.
   */
  rewound: string | null;
}

/**
 * Which channel to reach back into, for a fingerprint.
 *
 * Every channel builds `<name>:<whatever it identifies things by>` — `git:repo@sha`,
 * `jira:KEY`, `claude:<uuid>` — so the prefix is the channel, and a row written
 * before `channel` was recorded still says which one it came from. Nothing here
 * checks the name against the registry: `resetWatermark` matches a row or matches
 * nothing, and a fingerprint with no colon simply names no channel.
 */
function channelOf(row: { fingerprint: string; channel: string | null }): string | null {
  if (row.channel) return row.channel;
  const at = row.fingerprint.indexOf(':');
  return at > 0 ? row.fingerprint.slice(0, at) : null;
}

export function unsuppress(dataRoot: string, fingerprint: string): Restored | null {
  const conn = openIntakeDb(dataRoot);
  const row = conn
    .prepare('SELECT fingerprint, channel, title, reason FROM suppressed WHERE fingerprint = ?')
    .get(fingerprint) as Suppression | undefined;
  if (!row) return null;

  // Recorded before the delete, and kept after it. A rescue is the one signal
  // that says the judgement was wrong the expensive way, and it existed nowhere
  // until now — the row it corrects was simply removed.
  conn
    .prepare(
      `INSERT INTO rescued (fingerprint, channel, title, reason, at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         reason = excluded.reason, at = excluded.at`,
    )
    .run(row.fingerprint, row.channel ?? null, row.title ?? null, row.reason, new Date().toISOString());
  conn.prepare('DELETE FROM suppressed WHERE fingerprint = ?').run(fingerprint);

  /**
   * Walk that channel's cursor back, or the un-hiding means nothing.
   *
   * Every channel fetches forward of its watermark, so removing the row only
   * stops the item being *filtered* — it does not bring it back within reach, and
   * for anything but the last sweep's work it never will. A pile whose one repair
   * is a no-op is worse than no pile, because it reads as a repair.
   *
   * **The whole cursor, not a step back to the item.** Rewinding precisely would
   * mean knowing when the underlying thing happened, and a cursor is
   * channel-defined and opaque — an ISO date for the ones `pj` fetches, a Slack
   * `ts` or a Gmail date for the ones an agent does — so there is often nothing an
   * item's timestamp could be compared against. Recording the time on the row
   * would fix that for a candidate the classifier dropped and not for a card you
   * deleted, because a card records the fingerprint and the links and never the
   * source's own clock.
   *
   * So it falls back to the channel's default window, which is cheap for the
   * reason this store already gives about losing itself: everything behind the
   * cursor is either on a note — where `source_fingerprint` stops it being
   * captured twice — or still suppressed. A re-sweep re-proposes almost nothing.
   * What it costs is the only real limit here, and it is worth saying out loud:
   * **an item older than that window does not come back on its own.**
   */
  const channel = channelOf(row);
  if (channel) resetWatermark(dataRoot, channel);
  return { fingerprint, rewound: channel };
}

export interface Rescue {
  fingerprint: string;
  channel: string | null;
  title: string | null;
  reason: string;
  at: string;
}

/** Declines somebody took back, newest first. The corpus worth learning from. */
export function rescues(dataRoot: string, limit = 12): Rescue[] {
  return openIntakeDb(dataRoot)
    .prepare(
      `SELECT fingerprint, channel, title, reason, at FROM rescued ORDER BY at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Rescue[];
}

export interface SuppressionQuery {
  channel?: string;
  /**
   * Narrow to declined offers (`false`) or to discarded notes (`true`).
   *
   * A fact filter rather than a policy one: the caller that wants a corpus to
   * learn from asks for `false`, and the surface that shows the pile asks for
   * neither, because a reader is owed the whole pile.
   */
  wasJudged?: boolean;
  /** Free text over the title, the reason and the fingerprint. */
  q?: string;
  /** Page size. One more than this is fetched to answer `more` without a count. */
  limit?: number;
  /**
   * Keep reading below this row, which is the previous page's last one.
   *
   * A cursor rather than an offset because the list only ever grows, and it grows
   * at the end being read from: a sweep landing between two pages of an offset
   * walk shifts every row down one, so the reader sees a row twice and never sees
   * another. Paging on the value being sorted by cannot do that.
   *
   * **The whole row, not its `at`.** `at` is `Date.toISOString()`, so a sweep that
   * declines four candidates in one synchronous loop writes four rows with the
   * same millisecond — and `at DESC` alone is then not an order at all, so which
   * of the four a page ends on is the engine's choice and `at < ?` skips the other
   * three outright. Ordering by `(at, fingerprint)` makes the sequence total, and
   * a cursor that names both halves lands exactly between two rows.
   */
  before?: { at: string; fingerprint: string };
}

export interface SuppressionPage {
  rows: Suppression[];
  /** True when there is at least one more row behind this page. */
  more: boolean;
  /** Every suppression, ignoring `q` and the page — what the footer counts. */
  total: number;
  /**
   * How many match the filter, ignoring the page — what a pager counts.
   *
   * `total` cannot do this job: the moment a surface pages, "3 of 21" while
   * searching means three of the twenty-one *unfiltered* rows, which is two
   * populations in one sentence — the mistake `byModel` below was written to
   * stop. Equal to `total` when nothing is being filtered on, and read from the
   * same scan so the three can never disagree.
   */
  matching: number;
  /**
   * How many of `total` the classifier decided, on the same terms.
   *
   * Counted here rather than off the rows in hand, because the surface says the
   * two numbers in one breath and they have to be one population. It used to
   * count `decidedBy === 'model'` over the *loaded page*, so "21 — 12 by the
   * classifier" was 12-of-50 against 21-of-everything: two denominators, one
   * sentence, and a second `more` moved one number and not the other.
   */
  byModel: number;
}

const DEFAULT_PAGE = 50;

/**
 * A page of the declined pile, newest judgement first.
 *
 * Paged because it never shrinks: every sweep that declines something adds to it
 * and nothing removes a row but an explicit rescue. A surface that read the whole
 * table would get slower for exactly the vaults that use the feature most.
 */
export function suppressions(dataRoot: string, opts: SuppressionQuery = {}): SuppressionPage {
  const conn = openIntakeDb(dataRoot);
  const limit = Math.max(1, Math.min(500, opts.limit ?? DEFAULT_PAGE));

  /**
   * What the reader asked to see, kept apart from where the page starts.
   *
   * They read as one `WHERE` on the page query and they are two different
   * questions: the filter is the population, and the cursor is a position within
   * it. Counting `matching` means asking the first without the second, which a
   * single accumulated clause cannot be asked for.
   */
  const filter: string[] = [];
  const filterArgs: (string | number)[] = [];

  if (opts.channel) {
    filter.push('channel = ?');
    filterArgs.push(opts.channel);
  }
  if (opts.wasJudged !== undefined) {
    filter.push('was_judged = ?');
    filterArgs.push(opts.wasJudged ? 1 : 0);
  }
  if (opts.q?.trim()) {
    // Three columns, because a reader looking for something they half-remember
    // may remember the wording of the reason rather than the title.
    filter.push('(title LIKE ? OR reason LIKE ? OR fingerprint LIKE ?)');
    const like = `%${opts.q.trim()}%`;
    filterArgs.push(like, like, like);
  }

  const where = [...filter];
  const args = [...filterArgs];
  if (opts.before) {
    // The compound comparison spelled out, because SQLite has no row-value form
    // here: strictly older, or the same instant and further down the tie-break.
    where.push('(at < ? OR (at = ? AND fingerprint < ?))');
    args.push(opts.before.at, opts.before.at, opts.before.fingerprint);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // One more than asked for: `more` is then a fact about what was read rather
  // than a second COUNT over a growing table.
  const rows = conn
    .prepare(
      `SELECT fingerprint, channel, title, reason, at, decided_by AS decidedBy, was_judged
         FROM suppressed ${clause} ORDER BY at DESC, fingerprint DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as unknown as (Omit<Suppression, 'wasJudged'> & {
    was_judged: number;
  })[];

  // All three counts in one statement: they are the same scan, and separate
  // statements are how they could ever disagree. The filter goes in as a
  // `FILTER` clause rather than a `WHERE`, so the population and the subset of
  // it are counted over one pass.
  const counts = conn
    .prepare(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE decided_by = 'model') AS m,
              count(*) FILTER (WHERE ${filter.length ? filter.join(' AND ') : '1'}) AS k
         FROM suppressed`,
    )
    .get(...filterArgs) as { n: number; m: number; k: number };
  const page = rows.slice(0, limit).map(({ was_judged, ...r }) => ({
    ...r,
    wasJudged: Boolean(was_judged),
  }));
  return {
    rows: page,
    more: rows.length > limit,
    total: counts.n,
    matching: counts.k,
    byModel: counts.m,
  };
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
