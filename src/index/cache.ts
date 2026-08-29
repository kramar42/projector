import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { paths } from '../config.ts';
import { indexStamp } from './indexer.ts';
import { info } from '../server/log.ts';

/**
 * A memo over "read the whole vault", keyed on a stamp of the files it was built
 * from.
 *
 * P0–P4 rebuilt the index on every request, which was the right call while it
 * cost nothing: at 159 notes a full reindex is ~37ms, and a cache that can go
 * stale is worse than one that cannot exist. P5 makes the query interactive —
 * live search means several requests per second while typing, and each one also
 * wants a disjunctive facet histogram — so 37ms of synchronous work per
 * keystroke stops being free.
 *
 * The stamp keeps C1 intact rather than trading it away. It is not a heuristic
 * or a TTL: it is an exact function of what `load` reads — every note, view and
 * facet file's mtime, plus how many there are — and it costs ~0.5ms to compute,
 * 75× less than the rebuild it avoids. If any of those bytes could have changed,
 * the answer is rebuilt. So the app still cannot disagree with what an agent
 * just wrote.
 *
 * Mutating routes additionally call `invalidate` through `bump`, so our own
 * writes never depend on mtime resolution being finer than a burst of them.
 */

interface Entry<T> {
  stamp: string;
  handle: string;
  value: T;
}

const entries = new Map<string, Entry<unknown>>();

/**
 * mtimes, and how many files there are, for everything `load` reads.
 *
 * This is the index's own stamp (`indexStamp`), shared rather than shadowed:
 * it already covers every note file, the vocabulary, the views and the walk's
 * ignore file, and it honours the same `.gitignore`/`.projector/ignore` rules
 * the walk does — which is what keeps it linear in *notes*, not in whatever
 * else a workspace-sized vault happens to contain. Assets are deliberately
 * outside it: they are served straight from disk and never shape the index.
 */
export function stampOf(root: string): string {
  return indexStamp(paths(root).notes).stamp;
}

/**
 * Which `index.db` the cached value has open, by identity rather than content.
 *
 * `stampOf` skips dotfiles on purpose, so it cannot see the index at all — and
 * it should not, since the index is this memo's own output. But the index is
 * *derived and disposable* (C1), which means any other process may throw it away
 * and write a new one: `reindex` opens it `fresh`, and that unlinks the file
 * along with its `-wal` and `-shm`. A `pj reindex` or a plain `pj ls` in another
 * terminal therefore leaves this process holding a `DatabaseSync` onto an
 * unlinked inode, and every read through it fails with `disk I/O error` until
 * the server is restarted.
 *
 * The inode is the exact discriminator. Writes through our own handle do not
 * change it; a replacement always does. Content, size and mtime all move under
 * normal use — WAL checkpoints included — so any of those would rebuild on a
 * request that changed nothing.
 */
function handleOf(root: string): string {
  try {
    const st = statSync(paths(root).db);
    return `${st.dev}:${st.ino}`;
  } catch {
    return 'absent';
  }
}

/**
 * `build(root)` unless nothing it reads has changed since last time.
 *
 * `dispose` is called with the superseded value. **The caller must use the
 * returned value synchronously** — there must be no `await` between `cached()`
 * and the last read of what it returned, or a concurrent request could rebuild
 * and dispose it mid-handler. Every call site is a GET handler that returns
 * without suspending; a future one that needs to await should copy out what it
 * needs first.
 */
export function cached<T>(
  root: string,
  build: (root: string) => T,
  dispose?: (value: T) => void,
  /**
   * The caller's word that nothing has changed since the entry was made — the
   * server passes this for a vault its watcher holds, because every watcher
   * event and every write clears the entry through `bump`, so an entry that
   * still exists was vouched for by the same trust window `/api/cli/stamp`
   * already extends to the CLI. What it buys is skipping the stamp: an exact
   * stamp is a stat-walk of the vault, which is the whole per-request cost on
   * a workspace-sized one. The db handle is still checked — the watcher skips
   * dotfiles, so another process replacing `index.db` is invisible to it.
   */
  vouched = false,
): T {
  const hit = entries.get(root) as Entry<T> | undefined;
  if (hit && vouched && hit.handle === handleOf(root)) return hit.value;
  const stamp = stampOf(root);
  if (hit && hit.stamp === stamp && hit.handle === handleOf(root)) return hit.value;

  const started = Date.now();
  const value = build(root);
  // The one line about work that happens *inside* a request but is not the
  // request's own: a rebuild is triggered by a file changing, and how long the
  // vault takes to reload is exactly the number you want when the app feels
  // slow. A cache hit says nothing, so this is one line per actual rebuild.
  info('index', `${basename(root)} rebuilt in ${Date.now() - started}ms`);
  // After `build`, which is what created the file whose identity this is.
  entries.set(root, { stamp, handle: handleOf(root), value });
  if (hit) {
    try {
      dispose?.(hit.value);
    } catch {
      // Closing a database whose file was unlinked under it can fail, and that
      // is precisely the case this rebuild exists to recover from. The stale
      // value is already unreachable; failing here would turn one broken route
      // into every route.
    }
  }
  return value;
}

/** Drop a vault's memo, or every vault's when called with no argument. */
export function invalidate(root?: string): void {
  if (root === undefined) entries.clear();
  else entries.delete(root);
}
