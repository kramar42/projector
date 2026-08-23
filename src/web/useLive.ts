import { useCallback, useEffect, useRef, useState } from 'react';
import { onDataChange } from './api.ts';

/**
 * Fetch something, then refetch whenever a file under the data directory
 * changes. That covers our own writes and, more importantly, edits made by a
 * Claude session in another window — the app and an agent share one source of
 * truth, so the app has to notice (C3).
 *
 * **A refetch does not blank what is on screen.** It used to: the effect below
 * set `data` to `null` before asking, so every filter click replaced the pane
 * with `loading…` and then mounted a *new* view behind it. That is a remount and
 * not a repaint, and it cost far more than the frame it flashed — a board lost
 * its scroll position, a canvas refit its viewport and re-seeded React Flow's
 * store, and every facet section in the rail was rebuilt from the new payload,
 * all to answer a question the app already had an answer to.
 *
 * So the last payload stays up until the next one lands, and the swap is a single
 * commit. On localhost the round trip is about a millisecond and nothing is drawn
 * in between; on a slow one you are looking at the previous answer, which is the
 * honest thing to show while the next one is on its way.
 */
export function useLive<T>(
  load: () => Promise<T>,
  /** Refetch when these change, holding the current payload until the answer lands. */
  deps: unknown[],
  /**
   * Refetch *and* blank first. These are the deps that make the held payload
   * wrong rather than merely stale — the vault, and so far nothing else: a frame
   * of another library's cards is not something older, it is something else.
   */
  invalidates: unknown[] = [],
): { data: T | null; error: string | null; reload: () => void } {
  // One object, so a landed payload and a cleared error are one render and there
  // is no moment where the pane has the new data and the old failure.
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const gen = useRef(0);

  const reload = useCallback(() => {
    const mine = ++gen.current;
    loadRef.current().then(
      (data) => {
        // Ignore a response that a newer request has already superseded.
        if (mine === gen.current) setState({ data, error: null });
      },
      (e: Error) => {
        // The payload is kept: what to draw over a failure is the caller's
        // decision, and `App` draws the error rather than an empty pane.
        if (mine === gen.current) setState((prev) => ({ data: prev.data, error: e.message }));
      },
    );
  }, []);

  const held = useRef(invalidates);
  useEffect(() => {
    const wrong =
      invalidates.length !== held.current.length ||
      invalidates.some((v, i) => v !== held.current[i]);
    held.current = invalidates;
    // Compared against the ref rather than given an effect of its own, so that a
    // mount is one request: two effects over two dependency lists both fire on
    // the first render, and the second fetch would be the first one repeated.
    if (wrong) setState({ data: null, error: null });
    reload();
    // Both lists are the caller's own, passed through deliberately.
  }, [...deps, ...invalidates]);

  useEffect(() => onDataChange(reload), [reload]);

  return { data: state.data, error: state.error, reload };
}
