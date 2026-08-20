import { useEffect, useRef, useState } from 'react';
import { vaultApi, type VaultInfo } from './vault.ts';
import type { Meta } from './types.ts';

/**
 * The vault this window is looking at, and a way to change it.
 *
 * Replaces what used to be a static path label: the app is no longer pointed at
 * one configured directory, so the footer names the open vault and lets another
 * be opened or added.
 */
export function VaultSwitcher({
  meta,
  onSwitch,
  onAdd,
}: {
  meta: Meta;
  onSwitch: (path: string) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    vaultApi.list().then((r) => setVaults(r.vaults), () => setVaults([]));
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const forget = async (path: string) => {
    if (path === meta.vault) return; // never forget the one you are looking at
    await vaultApi.forget(path).catch(() => undefined);
    const r = await vaultApi.list().catch(() => ({ vaults: [] as VaultInfo[] }));
    setVaults(r.vaults);
  };

  return (
    <div className="vaultswitch" ref={box}>
      <button
        className="vaultswitch-current"
        onClick={() => setOpen((v) => !v)}
        title={meta.vault}
      >
        <span className="vaultswitch-mark">▣</span>
        <span className="vaultswitch-name">{meta.vaultName}</span>
        <span className="vaultswitch-caret">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="vaultswitch-menu">
          <div className="vaultswitch-head">Vaults</div>
          {vaults.map((v) => (
            <div key={v.path} className="vaultswitch-row">
              <button
                className={`vaultswitch-pick ${v.path === meta.vault ? 'is-current' : ''} ${
                  v.exists ? '' : 'is-missing'
                }`}
                disabled={!v.exists}
                onClick={() => {
                  setOpen(false);
                  if (v.path !== meta.vault) onSwitch(v.path);
                }}
                title={v.path}
              >
                <span className="vaultswitch-name">{v.name}</span>
                <span className="vaultswitch-count">
                  {v.exists ? `${v.cards ?? 0}` : 'missing'}
                </span>
              </button>
              {v.path !== meta.vault && (
                <button
                  className="btn ghost tiny"
                  title="stop tracking this vault (the folder is untouched)"
                  onClick={() => void forget(v.path)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            className="vaultswitch-add"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            + Open another folder…
          </button>
          <div className="vaultswitch-path">{meta.vault}</div>
        </div>
      )}
    </div>
  );
}
