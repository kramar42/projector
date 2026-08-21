import { useEffect, useState } from 'react';
import { vaultApi, type Inspection, type VaultInfo } from './vault.ts';
import { Button } from './components/Button.tsx';

/**
 * Choose a folder to open as a vault.
 *
 * Shown on first run and whenever the server says no usable vault was named. A
 * browser cannot open a native folder dialog for an arbitrary path, so this is a
 * path field with a directory browser beside it — and it says what will happen
 * before it happens: open an existing vault, or set one up here.
 */
export function VaultPicker({
  onOpened,
  onCancel,
  reason,
}: {
  onOpened: (path: string) => void;
  onCancel?: () => void;
  reason?: string;
}) {
  const [known, setKnown] = useState<VaultInfo[]>([]);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [listing, setListing] = useState<{ path: string; entries: { name: string; isVault: boolean }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    vaultApi.list().then((r) => setKnown(r.vaults), () => setKnown([]));
    vaultApi.browse('').then(setListing, () => setListing(null));
  }, []);

  // Say what opening this path would do, as it is typed.
  useEffect(() => {
    if (!path.trim()) {
      setInspection(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      vaultApi.inspect(path).then(
        (i) => {
          if (!live) return;
          setInspection(i);
          setName((n) => n || i.suggestedName);
        },
        () => live && setInspection(null),
      );
    }, 220);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path]);

  const open = async (target: string, create = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await vaultApi.open(target, { name: name.trim() || undefined, create });
      onOpened(res.vault.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const into = (dir: string) => {
    const next = listing ? `${listing.path.replace(/\/$/, '')}/${dir}` : dir;
    setPath(next);
    vaultApi.browse(next).then(setListing, () => setListing(null));
  };

  const up = () => {
    const base = (listing?.path ?? path).replace(/\/[^/]+\/?$/, '') || '/';
    setPath(base);
    vaultApi.browse(base).then(setListing, () => setListing(null));
  };

  return (
    <div className="vaultgate">
      <div className="vaultgate-card">
        <h1>Open a vault</h1>
        <p className="vaultgate-lede">
          A vault is a folder holding <code>cards/</code>, <code>facets.yaml</code> and{' '}
          <code>views/</code>. Point at one you already have, or at an empty folder to set one up.
        </p>
        {reason && <div className="banner is-conflict">{reason}</div>}
        {error && <div className="banner is-bad">{error}</div>}

        {known.length > 0 && (
          <section className="vaultgate-section">
            <h2>Recent</h2>
            <div className="vaultlist">
              {known.map((v) => (
                <button
                  key={v.path}
                  className={`vaultrow ${v.exists ? '' : 'is-missing'}`}
                  disabled={!v.exists || busy}
                  onClick={() => void open(v.path)}
                >
                  <span className="vaultrow-name">{v.name}</span>
                  <span className="vaultrow-meta">
                    {v.exists ? `${v.cards ?? 0} cards` : 'folder is gone'}
                  </span>
                  <span className="vaultrow-path">{v.path}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="vaultgate-section">
          <h2>{known.length ? 'Or open another folder' : 'Choose a folder'}</h2>
          <div className="vaultgate-row">
            <input
              autoFocus
              value={path}
              placeholder="/Users/you/notes/cards-vault  or  ~/vault"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !inspection) return;
                void open(inspection.path, !inspection.isVault);
              }}
            />
            <input
              className="vaultgate-name"
              value={name}
              placeholder="name"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {inspection && (
            <div className="vaultgate-verdict">
              {inspection.isVault ? (
                <>
                  <b className="tone-good">A vault.</b> {inspection.cards} card(s).{' '}
                  {inspection.registered ? 'Already in your list.' : ''}
                </>
              ) : inspection.exists && !inspection.empty ? (
                <>
                  <b className="tone-bad">Not a vault, and not empty.</b> Pick an empty folder, or one
                  that already holds <code>cards/</code>.
                </>
              ) : (
                <>
                  <b className="tone-warn">
                    {inspection.exists ? 'Empty folder.' : 'Does not exist yet.'}
                  </b>{' '}
                  Opening it will create <code>cards/</code>, <code>facets.yaml</code> and{' '}
                  <code>views/</code>.
                </>
              )}
            </div>
          )}

          <div className="vaultgate-actions">
            <Button
              tone="primary"
              disabled={busy || !inspection || (inspection.exists && !inspection.empty && !inspection.isVault)}
              onClick={() => inspection && void open(inspection.path, !inspection.isVault)}
            >
              {busy
                ? 'opening…'
                : inspection?.isVault
                  ? 'Open vault'
                  : 'Create vault here'}
            </Button>
            {onCancel && (
              <Button onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            )}
          </div>
        </section>

        {listing && (
          <section className="vaultgate-section">
            <h2>Browse</h2>
            <div className="browse-path">
              <Button size="tiny" onClick={up}>↑ up</Button>
              <code>{listing.path}</code>
            </div>
            <div className="browse-list">
              {listing.entries.length ? (
                listing.entries.map((e) => (
                  <button
                    key={e.name}
                    className={`browse-item ${e.isVault ? 'is-vault' : ''}`}
                    onClick={() => into(e.name)}
                    title={e.isVault ? 'looks like a vault' : ''}
                  >
                    {e.isVault ? '▣' : '›'} {e.name}
                  </button>
                ))
              ) : (
                <div className="picker-empty">no subfolders</div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
