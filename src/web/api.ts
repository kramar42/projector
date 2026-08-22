import type { DragMode } from '../view/dropOutcome.ts';
import { currentVault } from './vault.ts';
import type { CardDetail, Meta, QueryResponse, Resolved } from './types.ts';

/**
 * A thin typed fetch. No client-side cache: the server owns the cache and
 * answers from localhost in under a millisecond, so a second staleness model
 * would only be something extra to reason about (see “Libraries” in the README).
 */
export class ApiError extends Error {
  status: number;
  conflict: boolean;
  /** The server could not tell which vault this was about; the UI must ask. */
  needsVault: boolean;
  mtime?: number;
  constructor(
    message: string,
    status: number,
    opts: { conflict?: boolean; mtime?: number; needsVault?: boolean } = {},
  ) {
    super(message);
    this.status = status;
    this.conflict = opts.conflict ?? false;
    this.needsVault = opts.needsVault ?? false;
    this.mtime = opts.mtime;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Every request names its vault. The server refuses one it has not been asked
  // to open, so this is a reference to a chosen folder, not an arbitrary path.
  const vault = currentVault();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (vault) headers['X-Projector-Vault'] = vault;

  const res = await fetch(path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      conflict?: boolean;
      mtime?: number;
      needsVault?: boolean;
    };
    throw new ApiError(payload.error ?? `${res.status} ${res.statusText}`, res.status, payload);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const get = <T>(path: string) => req<T>('GET', path);

export interface PatchCard {
  title?: string;
  links?: string[];
  body?: string;
  /** `null` removes the block, so the record stops being a project. */
  project?: Record<string, unknown> | null;
  /**
   * ONE facet, applied server-side to what is on disk.
   *
   * The whole-map form still exists on `PatchCardInput`, because `pj set` needs
   * it — it rebuilds the map from a fresh read of the file it is about to write,
   * and expresses every removal by omitting a key. The browser cannot do that
   * honestly: its copy is as old as its last render, so sending it back reverts
   * whatever an agent changed on another axis. So the browser cannot say it.
   */
  facet?: { name: string; values: string[]; mode: 'set' | 'add' | 'remove' };
  /**
   * Required here, optional on the server.
   *
   * The server has callers that legitimately have no single mtime to offer — the
   * board's bulk bar writes many cards at once. The panel writes exactly one, so
   * a write without a base is a lost update, and making the field required is
   * what turns "someone remembered" into "it compiles".
   */
  baseMtime: number;
}

export const api = {
  meta: () => get<Meta>('/api/meta'),
  /**
   * The one read endpoint. `search` is the query half of the page URL, passed
   * through verbatim — the server merges a named `view=` with the overrides, so
   * a saved view and an ad-hoc query are the same request.
   */
  query: (search: string) => get<QueryResponse>(`/api/query${search}`),
  card: (id: string) => get<CardDetail>(`/api/card/${encodeURIComponent(id)}`),

  patchCard: (id: string, patch: PatchCard) =>
    req<{ mtime: number }>('PATCH', `/api/card/${encodeURIComponent(id)}`, patch),

  createCard: (input: {
    title: string;
    parent?: string;
    facets?: Record<string, string[]>;
  }) => req<{ id: string }>('POST', '/api/card', input),

  deleteCard: (id: string) =>
    req<{ removedEdges: number }>('DELETE', `/api/card/${encodeURIComponent(id)}`),

  bulk: (input: {
    ids: string[];
    op: 'facet' | 'move' | 'parent' | 'delete';
    facet?: string;
    values?: string[];
    /** `move` only: one entry per grouping axis the drag crossed. */
    moves?: { facet: string; from: string; to: string }[];
    dragMode?: DragMode;
    mode?: 'set' | 'add' | 'remove';
    parent?: string | null;
  }) => req<{ changed?: number; deleted?: number }>('POST', '/api/bulk', input),

  enrich: (refs: string[], force = false) =>
    req<{ items: Resolved[] }>('POST', '/api/enrich', { refs, force }),

  clearEnrichment: (refs?: string[]) =>
    req<{ cleared: number }>('POST', '/api/enrich/clear', { refs }),

  putFrontmatter: (id: string, yaml: string, baseMtime?: number) =>
    req<{ mtime: number; warnings: string[] }>(
      'PUT',
      `/api/card/${encodeURIComponent(id)}/frontmatter`,
      { yaml, baseMtime },
    ),

  /**
   * Arrangement for a saved view. Merged server-side, never replaced: the client
   * sends only what it currently renders, and that is a filtered subset.
   */
  saveArrangement: (
    name: string,
    arrangement: { nodes?: Record<string, { x?: number; y?: number }>; order?: Record<string, string[]> },
  ) => req<{ ok: true }>('PATCH', `/api/view/${encodeURIComponent(name)}/arrangement`, arrangement),

  /**
   * *Save current as…*, and updating a saved view — the same call either way.
   * `search` is the page's own query string, so the file records what was on
   * screen rather than a second interpretation of it.
   */
  saveView: (name: string, search: string, title?: string) =>
    req<{ name: string }>('PUT', `/api/view/${encodeURIComponent(name)}${search}`, { title }),

  deleteView: (name: string) => req<{ ok: true }>('DELETE', `/api/view/${encodeURIComponent(name)}`),

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
 * Subscribe to server events.
 *
 * `change` means a file under the data directory changed — a card edited by a
 * Claude session in another window shows up without a refresh, which is the whole
 * point of keeping markdown as the source of truth. `enriched` means a background
 * enrichment fetch landed, and is deliberately separate so a chip resolving does
 * not make a board rebuild itself.
 */
export function onDataChange(fn: () => void, event: 'change' | 'enriched' = 'change'): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener(event, (e) => {
    // Events carry the vault they came from: a change in another vault is none
    // of this tab's business.
    try {
      const { vault } = JSON.parse((e as MessageEvent<string>).data) as { vault?: string };
      const mine = currentVault();
      if (vault && mine && vault !== mine) return;
    } catch {
      /* older payload shape; fall through and refresh */
    }
    fn();
  });
  return () => es.close();
}
