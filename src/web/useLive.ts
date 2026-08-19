import { useCallback, useEffect, useRef, useState } from 'react';
import { onDataChange } from './api.ts';

/**
 * Fetch something, then refetch whenever a file under the data directory
 * changes. That covers our own writes and, more importantly, edits made by a
 * Claude session in another window — the app and an agent share one source of
 * truth, so the app has to notice (C3).
 */
export function useLive<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const gen = useRef(0);

  const reload = useCallback(() => {
    const mine = ++gen.current;
    loadRef
      .current()
      .then((d) => {
        // Ignore a response that a newer request has already superseded.
        if (mine === gen.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (mine === gen.current) setError(e.message);
      });
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => onDataChange(reload), [reload]);

  return { data, error, reload };
}
