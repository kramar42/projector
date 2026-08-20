import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config.ts';

/**
 * A memo over "read the whole vault", keyed on a stamp of the files it was built
 * from.
 *
 * P0–P4 rebuilt the index on every request, which was the right call while it
 * cost nothing: at 159 cards a full reindex is ~37ms, and a cache that can go
 * stale is worse than one that cannot exist. P5 makes the query interactive —
 * live search means several requests per second while typing, and each one also
 * wants a disjunctive facet histogram — so 37ms of synchronous work per
 * keystroke stops being free.
 *
 * The stamp keeps C1 intact rather than trading it away. It is not a heuristic
 * or a TTL: it is an exact function of what `load` reads — every card, view and
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

  visit(p.cards);
  visit(p.views);
  if (existsSync(p.facets)) visit(p.facets);

  // `newest` alone misses a file replaced by an older copy; `sum` catches two
  // files touched inside one millisecond; `count` catches adds and removes.
  return `${count}:${newest}:${sum}`;
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
  if (hit && hit.stamp === stamp) return hit.value;

  const value = build(root);
  entries.set(root, { stamp, value });
  if (hit) dispose?.(hit.value);
  return value;
}

/** Drop a vault's memo, or every vault's when called with no argument. */
export function invalidate(root?: string): void {
  if (root === undefined) entries.clear();
  else entries.delete(root);
}
