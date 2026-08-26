import { useEffect, useState } from 'react';
import { vaultApi, type BrowseEntry, type Inspection, type VaultInfo } from './vault.ts';
import { plural } from './plural.ts';
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
  const [listing, setListing] = useState<{ path: string; entries: BrowseEntry[] } | null>(null);
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
          A vault is a folder of markdown. Point at notes you already keep, at a vault you have
          opened before, or at an empty folder to start one.
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
                    {v.exists ? `${v.notes ?? 0} notes` : 'folder is gone'}
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
              placeholder="/Users/you/notes  or  ~/vault"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !inspection) return;
                void open(inspection.path, !inspection.configured);
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
              {inspection.configured ? (
                <>
                  <b className="tone-good">A vault.</b> {plural(inspection.notes, 'card')}.{' '}
                  {inspection.registered ? 'Already in your list.' : ''}
                </>
              ) : inspection.isVault ? (
                <>
                  <b className="tone-good">A folder of markdown.</b> {plural(inspection.notes, 'card')}
                  . Opening it adds <code>.projector/</code> for the vocabulary and the views; your
                  files are not touched or moved.
                </>
              ) : inspection.exists && !inspection.empty ? (
                <>
                  <b className="tone-bad">Not a vault, and not empty.</b> Pick an empty folder, or one
                  that holds markdown.
                </>
              ) : (
                <>
                  <b className="tone-warn">
                    {inspection.exists ? 'Empty folder.' : 'Does not exist yet.'}
                  </b>{' '}
                  Opening it will create <code>.projector/</code>, with a starter vocabulary and
                  views.
                </>
              )}
            </div>
          )}

          <div className="vaultgate-actions">
            <Button
              tone="primary"
              disabled={busy || !inspection || (inspection.exists && !inspection.empty && !inspection.isVault)}
              onClick={() => inspection && void open(inspection.path, !inspection.configured)}
            >
              {busy
                ? 'opening…'
                : inspection?.configured
                  ? 'Open vault'
                  : inspection?.isVault
                    ? 'Open these notes'
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
                    className={`truncate browse-item ${e.configured ? "is-vault" : ""}`}
                    onClick={() => into(e.name)}
                    title={
                      e.configured ? 'a vault' : e.isVault ? 'holds markdown — can be opened' : ''
                    }
                  >
                    {e.configured ? '▣' : e.isVault ? '▫' : '›'} {e.name}
                  </button>
                ))
              ) : (
                <div className="emptystate picker-empty">no subfolders</div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
