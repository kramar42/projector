import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config.ts';

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

/** mtimes, and how many files there are, for everything `load` reads. */
export function stampOf(root: string): string {
  const p = paths(root);
  let count = 0;
  let newest = 0;
  let sum = 0;

  const visit = (path: string) => {
    let st;
    try {
      st = statSync(path);
    } catch {
      return; // absent counts as absent; its disappearance changes `count`
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(path, { withFileTypes: true })) {
        // Dotfiles are the derived index and the enrichment cache, which are
        // outputs of this function's consumers — including them would make
        // every rebuild invalidate itself.
        if (e.name.startsWith('.')) continue;
        visit(join(path, e.name));
      }
      return;
    }
    count++;
    sum += st.mtimeMs;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };

  visit(p.notes);
  visit(p.views);
  if (existsSync(p.facets)) visit(p.facets);

  // `newest` alone misses a file replaced by an older copy; `sum` catches two
  // files touched inside one millisecond; `count` catches adds and removes.
  return `${count}:${newest}:${sum}`;
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
export function cached<T>(root: string, build: (root: string) => T, dispose?: (value: T) => void): T {
  const stamp = stampOf(root);
  const hit = entries.get(root) as Entry<T> | undefined;
  if (hit && hit.stamp === stamp && hit.handle === handleOf(root)) return hit.value;

  const value = build(root);
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
