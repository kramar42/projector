import type { DragMode } from '../view/dropOutcome.ts';
import { currentVault } from './vault.ts';
import type { NoteDetail, Meta, QueryResponse, Resolved } from './types.ts';
import { foreignOf } from './changed.ts';
export { FLUSH_MS } from './changed.ts';

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
  /** `null` removes the block, so the note stops being a project. */
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

/**
 * Which notes *this tab* just wrote, and when.
 *
 * The change stream cannot tell us apart from anyone else — the file moved, and a
 * watcher sees a path. But this module is the only way this tab writes anything, so
 * it is the one place that knows. Stamping here and filtering on the way back in is
 * what makes "changed outside this app" mean it.
 *
 * The rule itself is in `changed.ts`, with no clock and no module state, because it
 * is the whole of this feature's correctness and everything around it needs a
 * browser to run. This holds the state; that decides.
 */
const selfWrites = new Map<string, number>();

function stampSelfWrite(ids: string | string[]): void {
  const now = Date.now();
  for (const id of Array.isArray(ids) ? ids : [ids]) selfWrites.set(id, now);
}

/** Of these changed notes, which were not changed by this tab. */
export function foreignIds(ids: readonly string[]): string[] {
  return foreignOf(ids, selfWrites, Date.now());
}

export const api = {
  meta: () => get<Meta>('/api/meta'),
  /**
   * The one read endpoint. `search` is the query half of the page URL, passed
   * through verbatim — the server merges a named `view=` with the overrides, so
   * a saved view and an ad-hoc query are the same request.
   */
  query: (search: string) => get<QueryResponse>(`/api/query${search}`),
  note: (id: string) => get<NoteDetail>(`/api/note/${encodeURIComponent(id)}`),

  patchNote: (id: string, patch: PatchCard) => (
    stampSelfWrite(id),
    req<{ mtime: number }>('PATCH', `/api/note/${encodeURIComponent(id)}`, patch)
  ),

  createNote: (input: {
    title: string;
    parent?: string;
    facets?: Record<string, string[]>;
  }) => req<{ id: string }>('POST', '/api/note', input),

  deleteNote: (id: string) => (
    stampSelfWrite(id),
    req<{ removedEdges: number }>('DELETE', `/api/note/${encodeURIComponent(id)}`)
  ),

  bulk: (input: {
    ids: string[];
    op: 'facet' | 'move' | 'delete' | 'merge';
    facet?: string;
    values?: string[];
    /** `move` only: one entry per grouping axis the drag crossed. */
    moves?: { facet: string; from: string; to: string }[];
    dragMode?: DragMode;
    mode?: 'set' | 'add' | 'remove';
    parent?: string | null;
    /**
     * `merge` only: the note that survives and absorbs the others.
     *
     * The composed body is deliberately *not* here. The server reads the notes and
     * composes inside the write, so a merge cannot carry prose as old as this
     * client's last render — the same reason `facet` above sends a delta rather
     * than a map. See `mergeNotes`.
     */
    into?: string;
  }) => (
    // The survivor is written too, so it is stamped too: without it, a merge run
    // with the survivor's panel open reports itself as somebody else's edit.
    stampSelfWrite(input.into ? [...input.ids, input.into] : input.ids),
    req<{ changed?: number; deleted?: number; merged?: number; repointed?: number }>(
      'POST',
      '/api/bulk',
      input,
    )
  ),

  enrich: (refs: string[], force = false) =>
    req<{ items: Resolved[] }>('POST', '/api/enrich', { refs, force }),

  clearEnrichment: (refs?: string[]) =>
    req<{ cleared: number }>('POST', '/api/enrich/clear', { refs }),

  putFrontmatter: (id: string, yaml: string, baseMtime?: number) => (
    stampSelfWrite(id),
    req<{ mtime: number; warnings: string[] }>(
      'PUT',
      `/api/note/${encodeURIComponent(id)}/frontmatter`,
      { yaml, baseMtime },
    )
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
   * `search` is the page's own query string, so the file notes what was on
   * screen rather than a second interpretation of it.
   */
  saveView: (name: string, search: string, title?: string) =>
    req<{ name: string }>('PUT', `/api/view/${encodeURIComponent(name)}${search}`, { title }),

  deleteView: (name: string) => req<{ ok: true }>('DELETE', `/api/view/${encodeURIComponent(name)}`),

  uploadAsset: async (id: string, file: File): Promise<{ path: string }> => {
    const res = await fetch(`/api/note/${encodeURIComponent(id)}/asset`, {
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
export function onDataChange(
  /**
   * `ids` is which notes moved, when the server could say — the watcher can, a
   * route cannot be bothered to (see its `bump`). Empty means "something changed
   * and it is not attributable", which is a reload and nothing more.
   */
  fn: (ids: string[]) => void,
  event: 'change' | 'enriched' = 'change',
): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener(event, (e) => {
    // Events carry the vault they came from: a change in another vault is none
    // of this tab's business.
    let ids: string[] = [];
    try {
      const data = JSON.parse((e as MessageEvent<string>).data) as {
        vault?: string;
        ids?: string[];
      };
      const mine = currentVault();
      if (data.vault && mine && data.vault !== mine) return;
      ids = data.ids ?? [];
    } catch {
      /* older payload shape; fall through and refresh */
    }
    fn(ids);
  });
  return () => es.close();
}
