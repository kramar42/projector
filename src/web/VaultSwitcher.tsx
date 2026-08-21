import { useEffect, useState } from 'react';
import { vaultApi, type VaultInfo } from './vault.ts';
import { PopoverButton } from './components/Popover.tsx';
import type { Meta } from './types.ts';
import { IconButton } from './components/Button.tsx';

/**
 * The vault this window is looking at, and a way to change it.
 *
 * The menu is portalled: this sits at the top of a rail with its own overflow, so
 * a panel positioned inside the sidebar was being clipped at the rail's edge.
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
  return (
    <PopoverButton
      className="vaultbtn"
      panelClassName="vaultmenu"
      minWidth={280}
      title={meta.vault}
      label={
        <>
          <span className="vaultbtn-mark">▣</span>
          <span className="vaultbtn-name">{meta.vaultName}</span>
        </>
      }
      render={(close) => <VaultMenu meta={meta} onSwitch={onSwitch} onAdd={onAdd} close={close} />}
    />
  );
}

function VaultMenu({
  meta,
  onSwitch,
  onAdd,
  close,
}: {
  meta: Meta;
  onSwitch: (path: string) => void;
  onAdd: () => void;
  close: () => void;
}) {
  const [vaults, setVaults] = useState<VaultInfo[]>([]);

  useEffect(() => {
    vaultApi.list().then(
      (r) => setVaults(r.vaults),
      () => setVaults([]),
    );
  }, []);

  const forget = async (path: string) => {
    if (path === meta.vault) return; // never forget the one you are looking at
    await vaultApi.forget(path).catch(() => undefined);
    const r = await vaultApi.list().catch(() => ({ vaults: [] as VaultInfo[] }));
    setVaults(r.vaults);
  };

  return (
    <>
      <div className="pop-head">Vaults</div>
      {vaults.map((v) => (
        <div key={v.path} className="pop-row">
          <button
            className={`pop-pick ${v.path === meta.vault ? 'is-current' : ''} ${v.exists ? '' : 'is-missing'}`}
            disabled={!v.exists}
            onClick={() => {
              close();
              if (v.path !== meta.vault) onSwitch(v.path);
            }}
            title={v.path}
          >
            <span className="pop-pick-name">{v.name}</span>
            <span className="pop-count">{v.exists ? `${v.cards ?? 0}` : 'missing'}</span>
          </button>
          {v.path !== meta.vault && (
            <IconButton
              glyph="close"
              title="stop tracking this vault (the folder is untouched)"
              onClick={() => void forget(v.path)}
            />
          )}
        </div>
      ))}
      <button
        className="pop-action"
        onClick={() => {
          close();
          onAdd();
        }}
      >
        + Open another folder…
      </button>
      <div className="pop-foot">{meta.vault}</div>
    </>
  );
}
