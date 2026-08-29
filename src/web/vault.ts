/**
 * Which vault this browser is looking at.
 *
 * It lives in the page URL, is sent as a header on every request, and is chosen
 * by the user the way an Obsidian vault is: point at a folder. There is no
 * default and no assumed directory name — with nothing chosen, the app asks.
 *
 * This is deliberately not browser storage. A URL with a bad path must still be
 * recoverable by deleting `vault=`, and a link must say which library it opens.
 */

export const VAULT_PARAM = 'vault';

/** The vault named by a page search string, if any. */
export function vaultOf(search: string): string | null {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(VAULT_PARAM) || null;
}

/**
 * The URL is the current page's source of truth. Request helpers are kept free
 * of React, so they read it here rather than carrying a second vault state.
 */
export function currentVault(): string | null {
  return typeof window === 'undefined' ? null : vaultOf(window.location.search);
}

export interface VaultInfo {
  path: string;
  name: string;
  addedAt: number;
  lastOpenedAt?: number;
  exists: boolean;
  notes: number | null;
  /**
   * False when `notes` came from that vault's last index rather than a walk done
   * now — see `countedNotes` on the server. The list is drawn before anything is
   * open, so every vault but the one you are in is routinely this.
   */
  notesExact: boolean | null;
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
