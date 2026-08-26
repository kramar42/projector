import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../config.ts';
import { parseLink } from '../schema/links.ts';
import { NOT_ENRICHED, registry } from '../enrich/registry.ts';
import { isUnavailable, type Enrichment, type Fetcher, type Unavailable } from '../enrich/types.ts';

/**
 * The enrichment cache, and the stale-while-revalidate policy around it.
 *
 * Deliberately its own SQLite file rather than a table in the index: the index is
 * derived from the note files and rebuilt from scratch on every request, which
 * would throw away network data that cost a second to fetch. Different
 * lifecycles, different stores.
 *
 * A read never waits on the network. It answers from cache — possibly with
 * nothing — and schedules a refresh for whatever is missing or stale. When that
 * refresh lands the server signals it, and the client asks again.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enrichment (
  ref        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  json       TEXT,
  error      TEXT,
  needsSetup INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL
);
`;

export type State = 'fresh' | 'stale' | 'missing' | 'error' | 'unsupported';

export interface Resolved {
  ref: string;
  kind: string;
  state: State;
  data?: Enrichment;
  error?: string;
  needsSetup?: boolean;
  fetchedAt?: number;
  /** Why a kind has no fetcher, when that is the situation. */
  reason?: string;
}

/**
 * One connection per vault. A single module-level handle would serve whichever
 * vault happened to be opened first and silently answer for the others.
 */
const connections = new Map<string, DatabaseSync>();

function open(dataRoot: string): DatabaseSync {
  const file = paths(dataRoot).enrichDb;
  const existing = connections.get(file);
  if (existing) return existing;
  mkdirSync(dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL;');
  conn.exec(SCHEMA);
  connections.set(file, conn);
  return conn;
}

/**
 * Refreshes in flight, so N notes linking the same PR cause one fetch. Keyed by
 * vault as well as ref: a `doc:` ref is vault-relative, so the same string means
 * different files in different vaults.
 *
 * It holds a **promise** per ref rather than just the key, so a second caller can
 * wait for a fetch it did not start. As a bare set, "someone else is already
 * fetching this" and "there is nothing to fetch" were the same answer: the ref was
 * skipped, the caller was told the queue had drained, and it read the cache back
 * before the value landed. The browser survives that — one SSE listener catches
 * the signal whenever it fires — but `pj enrich <ref>` printed `missing` for a ref
 * that was being fetched as it printed.
 *
 * Waiting cannot deadlock: a borrowed promise always belongs to a fetch that
 * started earlier, so the wait graph only ever points backwards in time.
 */
const inFlight = new Map<string, { promise: Promise<void>; done: () => void }>();
const flightKey = (root: string, ref: string) => `${root}\u0000${ref}`;

/** A promise plus its resolver, so a fetch can be awaited by someone else. */
function slot(): { promise: Promise<void>; done: () => void } {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}

export interface EnrichOptions {
  dataRoot: string;
  /**
   * Called once a batch of refreshes has **landed**, so the client can re-ask.
   *
   * This is an invalidation signal, not a completion one: it fires only when
   * something was actually fetched and stored. "The queue has drained" is what
   * `refresh`'s returned promise says, and conflating the two cost a caller a
   * minute per run — see the note on `refresh`.
   */
  onRefreshed?: () => void;
  /**
   * The fetchers to use, defaulting to the registry for this vault.
   *
   * A seam for tests, and the only way this module's concurrency contract can be
   * asserted rather than hoped for: every real fetcher either needs a network, a
   * token or the `gh` CLI, or — `doc:` — resolves inside a microtask, which is
   * fast enough that "waited for the other caller's fetch" and "happened to read
   * after it" produce the same result. A fetcher that takes a controllable tick
   * tells the two apart. `readCached` keeps the real registry either way, since
   * what it reports about a kind does not depend on who fetches it.
   */
  fetchers?: Record<string, Fetcher>;
}

export function readCached(dataRoot: string, refs: string[]): Resolved[] {
  const conn = open(dataRoot);
  const fetchers = registry(dataRoot);
  const out: Resolved[] = [];

  const stmt = conn.prepare('SELECT * FROM enrichment WHERE ref = ?');
  for (const raw of [...new Set(refs)]) {
    const link = parseLink(raw);
    const fetcher = fetchers[link.kind];
    if (!fetcher) {
      out.push({
        ref: raw,
        kind: link.kind,
        state: 'unsupported',
        reason: NOT_ENRICHED[link.kind] ?? `no fetcher for "${link.kind}"`,
      });
      continue;
    }
    const row = stmt.get(raw) as
      | { ref: string; kind: string; json: string | null; error: string | null; needsSetup: number; fetched_at: number }
      | undefined;

    if (!row) {
      out.push({ ref: raw, kind: link.kind, state: 'missing' });
      continue;
    }
    const age = (Date.now() - row.fetched_at) / 1000;
    const expired = fetcher.ttl > 0 && age > fetcher.ttl;
    if (row.error) {
      out.push({
        ref: raw,
        kind: link.kind,
        state: expired ? 'stale' : 'error',
        error: row.error,
        needsSetup: row.needsSetup === 1,
        fetchedAt: row.fetched_at,
      });
      continue;
    }
    out.push({
      ref: raw,
      kind: link.kind,
      state: expired ? 'stale' : 'fresh',
      data: row.json ? (JSON.parse(row.json) as Enrichment) : undefined,
      fetchedAt: row.fetched_at,
    });
  }
  return out;
}

function store(dataRoot: string, ref: string, kind: string, value: Enrichment | Unavailable): void {
  const conn = open(dataRoot);
  const now = Date.now();
  if (isUnavailable(value)) {
    conn
      .prepare(
        `INSERT INTO enrichment (ref, kind, json, error, needsSetup, fetched_at)
         VALUES (?, ?, NULL, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET json=NULL, error=excluded.error,
           needsSetup=excluded.needsSetup, fetched_at=excluded.fetched_at`,
      )
      .run(ref, kind, value.reason, value.needsSetup ? 1 : 0, now);
    return;
  }
  conn
    .prepare(
      `INSERT INTO enrichment (ref, kind, json, error, needsSetup, fetched_at)
       VALUES (?, ?, ?, NULL, 0, ?)
       ON CONFLICT(ref) DO UPDATE SET json=excluded.json, error=NULL,
         needsSetup=0, fetched_at=excluded.fetched_at`,
    )
    .run(ref, kind, JSON.stringify(value), now);
}

/**
 * Fetch whatever needs it, in the background.
 *
 * Failures are cached like successes: a ref that cannot resolve should say so
 * once and stop being retried on every render.
 *
 * **Returns a promise that resolves when the queue has drained**, including
 * immediately when there was nothing to fetch. The server ignores it — a read
 * never waits on the network — and `pj enrich` awaits it.
 *
 * It used to return `void`, so the only way to know the work had finished was
 * `onRefreshed` — which fires on exactly one of this function's two exits. The
 * early return below is the other, and it is the *common* case: an already-fresh
 * ref, or a kind with no fetcher. `pj enrich` therefore raced the callback against
 * a 60-second fallback timer and lost every time, which is how a command whose
 * work took 0ms took a minute to come back.
 *
 * A ref another caller is already fetching is neither of those: it is not ours to
 * fetch and it is not settled either, so it is **borrowed** rather than skipped —
 * see `inFlight`. `onRefreshed` still fires only when this call stored something,
 * because a borrower has nothing to announce that the owner will not announce.
 */
export function refresh(opts: EnrichOptions, refs: string[], force = false): Promise<void> {
  const fetchers = opts.fetchers ?? registry(opts.dataRoot);
  const todo: { ref: string; kind: string }[] = [];
  /** Fetches someone else started that this call is nonetheless waiting for. */
  const borrowed: Promise<void>[] = [];

  for (const r of force ? [...new Set(refs)] : readCached(opts.dataRoot, refs)
    .filter((x) => x.state === 'missing' || x.state === 'stale')
    .map((x) => x.ref)) {
    const link = parseLink(r);
    if (!fetchers[link.kind]) continue;
    const running = inFlight.get(flightKey(opts.dataRoot, r));
    if (running) {
      borrowed.push(running.promise);
      continue;
    }
    todo.push({ ref: r, kind: link.kind });
  }
  // Nothing of our own to fetch. Still not necessarily nothing to wait for.
  if (!todo.length) {
    return borrowed.length ? Promise.all(borrowed).then(() => undefined) : Promise.resolve();
  }

  const own = new Map<string, () => void>();
  for (const t of todo) {
    const s = slot();
    inFlight.set(flightKey(opts.dataRoot, t.ref), s);
    own.set(t.ref, s.done);
  }

  return (async () => {
    // Small concurrency: these are subprocesses and HTTP calls, and a board can
    // reference dozens of links at once.
    const queue = [...todo];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        // Everything inside the `try`, `parseLink` included. A throw above it left
        // the key in the map forever, which used to cost one un-refetchable ref
        // and would now hang anyone waiting on it.
        try {
          const fetcher = fetchers[next.kind]!;
          const link = parseLink(next.ref);
          store(opts.dataRoot, next.ref, next.kind, await fetcher.fetch(link.ref));
        } catch (err) {
          // A fetcher that throws is a bug, but it must not take the server down.
          store(opts.dataRoot, next.ref, next.kind, {
            unavailable: true,
            reason: `fetcher failed: ${(err as Error).message}`,
          });
        } finally {
          inFlight.delete(flightKey(opts.dataRoot, next.ref));
          own.get(next.ref)?.();
        }
      }
    });
    // Ours and anything borrowed: the promise says "every ref this call asked
    // about has settled", not "the refs this call happened to own have settled".
    await Promise.all([...workers, ...borrowed]);
    opts.onRefreshed?.();
  })();
}

export function enrichmentStats(dataRoot: string): Record<string, number> {
  const conn = open(dataRoot);
  const rows = conn
    .prepare('SELECT kind, count(*) AS n, sum(error IS NOT NULL) AS failed FROM enrichment GROUP BY kind')
    .all() as unknown as { kind: string; n: number; failed: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.kind] = r.n;
    if (r.failed) out[`${r.kind}:failed`] = r.failed;
  }
  return out;
}

/** Drop cached entries so the next read refetches. */
export function clearEnrichment(dataRoot: string, refs?: string[]): number {
  const conn = open(dataRoot);
  if (!refs?.length) {
    const n = (conn.prepare('SELECT count(*) AS n FROM enrichment').get() as { n: number }).n;
    conn.exec('DELETE FROM enrichment');
    return n;
  }
  const stmt = conn.prepare('DELETE FROM enrichment WHERE ref = ?');
  let n = 0;
  for (const r of refs) n += stmt.run(r).changes as number;
  return n;
}
