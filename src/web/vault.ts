/**
 * Which vault this browser is looking at.
 *
 * Held in localStorage, sent as a header on every request, and chosen by the user
 * the way an Obsidian vault is: point at a folder. There is no default and no
 * assumed directory name — with nothing chosen, the app asks.
 */

const KEY = 'projector.vault';

export function currentVault(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setCurrentVault(path: string | null): void {
  try {
    if (path) localStorage.setItem(KEY, path);
    else localStorage.removeItem(KEY);
  } catch {
    /* private browsing; the app still works for this session */
  }
}

export interface VaultInfo {
  path: string;
  name: string;
  addedAt: number;
  lastOpenedAt?: number;
  exists: boolean;
  notes: number | null;
}

export interface BrowseEntry {
  name: string;
  isVault: boolean;
  configured: boolean;
}

export interface Inspection {
  path: string;
  exists: boolean;
  isVault: boolean;
  /** It has a `.projector/` — opened before, rather than merely openable. */
  configured: boolean;
  notes: number;
  empty: boolean;
  suggestedName: string;
  registered: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const vaultApi = {
  list: () => fetch('/api/vaults').then((r) => json<{ vaults: VaultInfo[] }>(r)),

  browse: (path: string) =>
    fetch(`/api/vaults/browse?path=${encodeURIComponent(path)}`).then((r) =>
      json<{ path: string; entries: BrowseEntry[] }>(r),
    ),

  inspect: (path: string) =>
    fetch(`/api/vaults/inspect?path=${encodeURIComponent(path)}`).then((r) => json<Inspection>(r)),

  open: (path: string, opts: { name?: string; create?: boolean } = {}) =>
    fetch('/api/vaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...opts }),
    }).then((r) => json<{ vault: VaultInfo }>(r)),

  forget: (path: string) =>
    fetch('/api/vaults', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ forgotten: boolean }>(r)),
};
