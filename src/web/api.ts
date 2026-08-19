import type { BoardResponse, CanvasResponse, CardDetail, Meta } from './types.ts';

/**
 * A thin typed fetch. No client-side cache: the server owns the cache and
 * answers from localhost in under a millisecond, so a second staleness model
 * would only be something extra to reason about (§6.7).
 */
export class ApiError extends Error {
  status: number;
  conflict: boolean;
  mtime?: number;
  constructor(message: string, status: number, opts: { conflict?: boolean; mtime?: number } = {}) {
    super(message);
    this.status = status;
    this.conflict = opts.conflict ?? false;
    this.mtime = opts.mtime;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      conflict?: boolean;
      mtime?: number;
    };
    throw new ApiError(payload.error ?? `${res.status} ${res.statusText}`, res.status, payload);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const get = <T>(path: string) => req<T>('GET', path);

export interface PatchCard {
  title?: string;
  facets?: Record<string, string[]>;
  links?: string[];
  body?: string;
  kind?: 'card' | 'node';
  baseMtime?: number;
}

export const api = {
  meta: () => get<Meta>('/api/meta'),
  board: (name: string) => get<BoardResponse>(`/api/board/${encodeURIComponent(name)}`),
  canvas: (name: string) => get<CanvasResponse>(`/api/canvas/${encodeURIComponent(name)}`),
  card: (id: string) => get<CardDetail>(`/api/card/${encodeURIComponent(id)}`),

  patchCard: (id: string, patch: PatchCard) =>
    req<{ mtime: number }>('PATCH', `/api/card/${encodeURIComponent(id)}`, patch),

  createCard: (input: {
    title: string;
    kind?: 'card' | 'node';
    parent?: string;
    facets?: Record<string, string[]>;
  }) => req<{ id: string }>('POST', '/api/card', input),

  deleteCard: (id: string) =>
    req<{ removedEdges: number }>('DELETE', `/api/card/${encodeURIComponent(id)}`),

  setEdges: (id: string, edges: { type: string; to: string }[], baseMtime?: number) =>
    req<{ mtime: number }>('PUT', `/api/card/${encodeURIComponent(id)}/edges`, { edges, baseMtime }),

  bulk: (input: {
    ids: string[];
    op: 'facet' | 'parent' | 'delete';
    facet?: string;
    values?: string[];
    mode?: 'set' | 'add' | 'remove';
    parent?: string | null;
  }) => req<{ changed?: number; deleted?: number }>('POST', '/api/bulk', input),

  saveCanvas: (name: string, nodes: Record<string, { x?: number; y?: number; size?: string }>) =>
    req<{ ok: true }>('PATCH', `/api/canvas/${encodeURIComponent(name)}`, { nodes }),

  uploadAsset: async (id: string, file: File): Promise<{ path: string }> => {
    const res = await fetch(`/api/card/${encodeURIComponent(id)}/asset`, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: await file.arrayBuffer(),
    });
    if (!res.ok) {
      const p = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(p.error ?? 'upload failed', res.status);
    }
    return (await res.json()) as { path: string };
  },
};

/**
 * Subscribe to file changes. The server watches the data directory, so a card
 * edited by a Claude session in another window shows up here without a refresh —
 * which is the whole point of keeping markdown as the source of truth.
 */
export function onDataChange(fn: () => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('change', () => fn());
  return () => es.close();
}
