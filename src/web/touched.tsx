import { createContext, useContext, useEffect, useState } from 'react';
import { foreignIds, onDataChange } from './api.ts';

/**
 * Which notes changed just now, and not because of you.
 *
 * This is the one thing a still surface cannot say by being still. Everything else
 * the app draws is either a fact about a record or a response to something the
 * reader did; a note moving on disk while they look at it is neither, and adopting
 * it silently — which is what `useLive` has always done, correctly — leaves a chip
 * changing colour under their eyes with nothing to explain it. See DESIGN.md's
 * **The Something Moved Rule** for why this earns the app's only animation.
 *
 * Three properties, and each one is a decision rather than a detail.
 *
 * **Foreign only.** `wasSelfWrite` filters the ids this tab just sent. Without it
 * the mark fires on every chip you click, because the server announces a route's
 * write immediately and the watcher announces the same bytes again when its
 * write-finish settles — your own edit, twice. A signal that fires on your own
 * actions is noise inside a minute.
 *
 * **It expires.** A pulse is an event, not a state: a note that stays marked is a
 * note you stop seeing marked. `TTL_MS` is how long the mark is worth having, and
 * it is deliberately longer than the animation — the animation says *just now*, the
 * mark says *recently*, and a reader who looks up from a terminal after four
 * seconds should still find out.
 *
 * **It is a Set of ids, not a diff.** What *changed* would need the previous
 * payload, and `useLive` holds one at the moment it swaps — so that is available
 * and is the obvious next step. It is not this: the panel says which fields moved
 * by diffing what it already has, and a face has no room to say more than that
 * something did.
 */
const TTL_MS = 6000;

interface Ctx {
  /** Did this note change outside this app, recently enough to say so? */
  touched: (id: string) => boolean;
  /** When, for a caller that wants to name the moment. */
  at: (id: string) => number | null;
}

const TouchedContext = createContext<Ctx>({ touched: () => false, at: () => null });

/**
 * One provider, because one subscription: the hook opens an `EventSource`, and a
 * component calling it directly would open another per mount. Four surfaces need
 * the answer — a board tile, a canvas node, a table row and the open panel — so it
 * is a context for the same reason enrichment is.
 */
export function TouchedProvider({ children }: { children: React.ReactNode }) {
  return <TouchedContext.Provider value={useForeignChange()}>{children}</TouchedContext.Provider>;
}

export function useTouched(): Ctx {
  return useContext(TouchedContext);
}

function useForeignChange(): Ctx {
  const [seen, setSeen] = useState<Record<string, number>>({});

  useEffect(
    () =>
      onDataChange((ids) => {
        const foreign = foreignIds(ids);
        if (!foreign.length) return;
        const now = Date.now();
        setSeen((prev) => {
          // Prune on the way through rather than on a timer: the only thing that
          // can add to this map is a change event, so a change event is the only
          // moment the map can be stale in a way anyone sees.
          const next: Record<string, number> = {};
          for (const [id, at] of Object.entries(prev)) if (now - at < TTL_MS) next[id] = at;
          for (const id of foreign) next[id] = now;
          return next;
        });
      }),
    [],
  );

  /**
   * A timer, and only while something is marked.
   *
   * Without it the last mark on screen never clears, because nothing re-renders
   * after the change that set it — the map prunes on the *next* event and there may
   * not be one. With it, the surface goes still again on its own, which is the
   * state this app is supposed to be in.
   */
  useEffect(() => {
    const oldest = Math.min(...Object.values(seen), Infinity);
    if (!Number.isFinite(oldest)) return;
    const t = setTimeout(
      () => setSeen((prev) => Object.fromEntries(
        Object.entries(prev).filter(([, at]) => Date.now() - at < TTL_MS),
      )),
      Math.max(0, TTL_MS - (Date.now() - oldest)) + 50,
    );
    return () => clearTimeout(t);
  }, [seen]);

  return {
    touched: (id) => seen[id] !== undefined,
    at: (id) => seen[id] ?? null,
  };
}
