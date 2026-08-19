import type { BoardResponse, CanvasResponse, CardDetail, Meta } from './types.ts';

/**
 * A thin typed fetch. No client-side cache: the server owns the cache and
 * answers from localhost in under a millisecond, so a second staleness model
 * would only be something extra to reason about (§6.7).
 */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  meta: () => get<Meta>('/api/meta'),
  board: (name: string) => get<BoardResponse>(`/api/board/${encodeURIComponent(name)}`),
  canvas: (name: string) => get<CanvasResponse>(`/api/canvas/${encodeURIComponent(name)}`),
  card: (id: string) => get<CardDetail>(`/api/card/${encodeURIComponent(id)}`),
};
