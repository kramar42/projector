import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../config.ts';

/**
 * Which candidates were declined, and which of those somebody took back. A
 * third SQLite file, deliberately.
 *
 * `.index.db` is derived from the note files and rebuilt from scratch whenever
 * they change. `.enrich.db` is a cache: TTL'd, clearable, and losing it costs one
 * refetch. A decline is neither — it is a judgement, not reproducible, and the
 * reason it needs somewhere to live. Different lifecycles, different stores,
 * which is the same argument `server/enrich.ts` makes for not being a table in
 * the index.
 *
 * **Where intake got to is not here.** It used to be — a cursor per channel, and
 * the state each tracked source item was last seen in — because intake fetched,
 * and a fetcher has to remember where it stopped. It fetches nothing now: the
 * kernel's connectors gather, and intake's cursor is the newest `intake/` event
 * it wrote to the kernel (`connectors.ts`), so a second record here could only
 * disagree with it (C11). A store from before loses those tables when it opens.
 *
 * Still not load-bearing: lose this file and a later pass may offer again what
 * was declined. Noisier, never wrong, and never a duplicate note, because
 * `source_fingerprint` on the notes is what stops those.
 */

const SCHEMA = `
-- A candidate somebody judged as "not a note", so a later pass stops offering it.
--
-- Only *judgements* land here, never a channel's own mechanical skip. The
-- difference is reproducibility: a channel declining a merge commit or a session
-- with no prompt re-derives that answer identically on every pass, so storing it
-- would be storing something derivable (C11). A judgement about whether work
-- matters is not reproducible — a different threshold or a different model
-- answers differently — and that is precisely why it needs somewhere to live.
--
-- Not load-bearing: lose this table and a later pass may offer again what was
-- declined. Noisier, never wrong, and never a
-- duplicate note, because \`source_fingerprint\` on the notes is what stops those.
CREATE TABLE IF NOT EXISTS suppressed (
  -- The candidate's fingerprint, which is derived from the thing itself and not
  -- its wording, so a later pass matches what was judged rather than something that
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
  -- Both still suppress, because both have to stop a later pass re-proposing the
  -- thing. Only one of them teaches: suppressions({ wasJudged: false }) is what
  -- classify.ts calibrates from.
  was_judged  INTEGER NOT NULL DEFAULT 0,
  -- The connector event declined, by its kernel id, when a pass declined one:
  -- what bringing it back offers to the judge again. Null for a card a person
  -- declined, whose event the card does not record.
  event       TEXT
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
  at          TEXT NOT NULL,
  -- The connector event to offer again, carried over from the decline, and when
  -- a pass offered it: once, so a rescue the judge answers is not asked twice.
  event       TEXT,
  offered     TEXT
);

`;

/**
 * Bring a store from before into shape, in place.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, and dropping
 * this file to get the new shape would cost every decline in it.
 */
function migrate(conn: DatabaseSync): void {
  const columns = (table: string) =>
    new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));

  // The suppressions table predates knowing who decided. An existing row is
  // defaulted to 'person', which is what every row written before the
  // classifier existed actually was.
  const supp = columns('suppressed');
  if (supp.size && !supp.has('decided_by')) {
    conn.exec("ALTER TABLE suppressed ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'person'");
  }
  // And `was_judged`, where 0 is right for every row that predates it: the only
  // writer that sets it is the delete cascade, and until it could, nothing told a
  // declined offer apart from a discarded note.
  if (supp.size && !supp.has('was_judged')) {
    conn.exec('ALTER TABLE suppressed ADD COLUMN was_judged INTEGER NOT NULL DEFAULT 0');
  }
  // The connector event a decline was of, which a row from before never knew.
  if (supp.size && !supp.has('event')) conn.exec('ALTER TABLE suppressed ADD COLUMN event TEXT');
  const resc = columns('rescued');
  if (resc.size && !resc.has('event')) conn.exec('ALTER TABLE rescued ADD COLUMN event TEXT');
  if (resc.size && !resc.has('offered')) conn.exec('ALTER TABLE rescued ADD COLUMN offered TEXT');

  // `kernel_status` was `pj kernel import`'s own record of the status events it
  // had sent; the kernel answers that now (`projector/vault-status-events`).
  // `watermark` and `seen` were intake's cursors and the state each tracked item
  // was last fetched in; the kernel answers where intake got to now
  // (`projector/intake-newest`), and its connectors key a moved item as a new
  // event. A second record of either could only disagree with the kernel (C11),
  // so a store that still has them loses them. Nothing else is touched, and
  // nothing reads them.
  conn.exec('DROP TABLE IF EXISTS kernel_status');
  conn.exec('DROP TABLE IF EXISTS watermark');
  conn.exec('DROP TABLE IF EXISTS seen');
}

const connections = new Map<string, DatabaseSync>();

/**
 * Remove a write-ahead log whose database is gone.
 *
 * This store is in WAL mode, so it is three files. Deleting the database and
 * leaving the sidecars — which is what deleting "the file" looks like to anyone
 * who has not thought about WAL — makes the next open fail outright with a disk
 * I/O error. That would break the property the whole design rests on: losing this
 * store is meant to cost some noise, never a working command.
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
 * and writes a row. Both are needed for intake to converge — a declined candidate
 * that left nothing behind could not be told from one never offered, and the
 * rejection could not inform anything later.
 *
 * Re-suppressing the same fingerprint replaces the reason rather than failing:
 * the second judgement is the current one, and a caller judging again should not
 * have to care whether it already answered for this item.
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
    /** The connector event declined, by kernel id, when a pass declined one. */
    event?: string;
  },
): Suppression {
  const at = new Date().toISOString();
  const by: DecidedBy = entry.by ?? 'person';
  const wasJudged = entry.wasJudged ?? false;
  openIntakeDb(dataRoot)
    .prepare(
      `INSERT INTO suppressed (fingerprint, channel, title, reason, at, decided_by, was_judged, event)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         channel = COALESCE(excluded.channel, suppressed.channel),
         title   = COALESCE(excluded.title, suppressed.title),
         event   = COALESCE(excluded.event, suppressed.event),
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
      entry.event ?? null,
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
 * Un-hide a candidate, so the next pass offers it again.
 *
 * The reason this exists at all is an asymmetry worth stating: getting the
 * ordering wrong costs a reader some scrolling, and suppressing wrongly costs them
 * the item. So every suppression has to be reversible and the pile has to be
 * readable, or raising a threshold is an act of faith.
 */
export interface Restored {
  fingerprint: string;
  /**
   * The connector event the next pass offers the judge again, by kernel id — or
   * null when the decline named none: a card a person declined, or a row from
   * before intake read the kernel. Null is not a failure: the row is gone either
   * way, and the item comes back when its source moves again.
   */
  event: string | null;
}

export function unsuppress(dataRoot: string, fingerprint: string): Restored | null {
  const conn = openIntakeDb(dataRoot);
  const row = conn
    .prepare('SELECT fingerprint, channel, title, reason, event FROM suppressed WHERE fingerprint = ?')
    .get(fingerprint) as (Suppression & { event: string | null }) | undefined;
  if (!row) return null;

  /**
   * Recorded before the delete, and kept after it. A rescue is the one signal
   * that says the judgement was wrong the expensive way.
   *
   * **And it is what brings the item back within reach.** The connector event was
   * judged, so it sits behind intake's cursor, and lifting the decline alone would
   * only stop it being filtered. The rescue carries the event, unoffered, and the
   * next pass reads it from the kernel and offers it to the judge once more
   * (`run.ts`) — a pile whose one repair is a no-op is worse than no pile.
   */
  conn
    .prepare(
      `INSERT INTO rescued (fingerprint, channel, title, reason, at, event, offered)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(fingerprint) DO UPDATE SET
         reason = excluded.reason, at = excluded.at,
         event = COALESCE(excluded.event, rescued.event), offered = NULL`,
    )
    .run(row.fingerprint, row.channel ?? null, row.title ?? null, row.reason, new Date().toISOString(), row.event ?? null);
  conn.prepare('DELETE FROM suppressed WHERE fingerprint = ?').run(fingerprint);
  return { fingerprint, event: row.event ?? null };
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

/**
 * Rescues a pass has yet to offer again: each carries its connector event, and
 * none is declined once more. Oldest first, so they are offered in the order
 * they were taken back.
 */
export function unofferedRescues(dataRoot: string): { fingerprint: string; channel: string | null; event: string }[] {
  return openIntakeDb(dataRoot)
    .prepare(
      `SELECT r.fingerprint, r.channel, r.event FROM rescued r
        WHERE r.event IS NOT NULL AND r.offered IS NULL
          AND NOT EXISTS (SELECT 1 FROM suppressed s WHERE s.fingerprint = r.fingerprint)
        ORDER BY r.at`,
    )
    .all() as unknown as { fingerprint: string; channel: string | null; event: string }[];
}

/** A pass offered this rescue again, whatever the judge said: it is not offered twice. */
export function markOffered(dataRoot: string, fingerprint: string): void {
  openIntakeDb(dataRoot)
    .prepare('UPDATE rescued SET offered = ? WHERE fingerprint = ?')
    .run(new Date().toISOString(), fingerprint);
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
   * at the end being read from: a pass landing between two pages of an offset
   * walk shifts every row down one, so the reader sees a row twice and never sees
   * another. Paging on the value being sorted by cannot do that.
   *
   * **The whole row, not its `at`.** `at` is `Date.toISOString()`, so a pass that
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
 * Paged because it never shrinks: every pass that declines something adds to it
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
 * Every suppressed fingerprint, for a pass to skip candidates against.
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
