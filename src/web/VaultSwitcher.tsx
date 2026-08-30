import { useEffect, useState } from 'react';
import { vaultApi, type VaultInfo } from './vault.ts';
import { PopoverButton } from './components/Popover.tsx';
import type { Meta } from './types.ts';
import { IconButton } from './components/Button.tsx';

/**
 * The vault this window is looking at, and a way to change it.
 *
 * The button draws the name alone. It used to prefix it with `▣`, which is the
 * Note Mark vocabulary's project glyph worn by a thing that is not a note —
 * a pun that only worked while nothing in the rail said what the control was.
 * The row's `Vault` label says it now, and the glyph means one thing again.
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
      rail="vault"
      className="vaultbtn"
      minWidth={280}
      title={meta.vault}
      label={meta.vaultName}
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
  /**
   * What went wrong, if anything did.
   *
   * Both calls below used to swallow their rejection — `.catch(() => undefined)`
   * and `.catch(() => ({ vaults: [] }))` — so forgetting a vault and failing to
   * forget it looked identical, and a failed list rendered as *no vaults*, which
   * is a real state this menu can otherwise show. Silence is the worst of the
   * registers this app uses for a refused write, and the vault gate on the same
   * surface already renders one as a banner.
   */
  const [problem, setProblem] = useState<string | null>(null);

  const load = () =>
    vaultApi.list().then(
      (r) => {
        setVaults(r.vaults);
        setProblem(null);
      },
      (e: Error) => setProblem(e.message),
    );

  useEffect(() => {
    void load();
  }, []);

  const forget = async (path: string) => {
    if (path === meta.vault) return; // never forget the one you are looking at
    try {
      await vaultApi.forget(path);
    } catch (e) {
      setProblem((e as Error).message);
      return; // the list is unchanged, so there is nothing to re-read
    }
    await load();
  };

  return (
    <>
      <div className="pop-head">Vaults</div>
      {problem && <div className="banner is-bad">{problem}</div>}
      {vaults.map((v) => (
        <div key={v.path} className="pop-row">
          <button
            className={`pop-pick ${v.path === meta.vault ? 'is-current' : ''} ${v.exists ? '' : 'is-missing'}`}
            disabled={!v.exists}
            onClick={() => {
              close();
              if (v.path !== meta.vault) onSwitch(v.name);
            }}
            title={v.path}
          >
            <span className="truncate pop-pick-name">{v.name}</span>
            {/* Same tilde as the gate and `pj vaults`, one mark for one fact. */}
            <span
              className="pop-annotation"
              {...(v.exists && v.notesExact === false
                ? { title: 'as of this vault’s last index' }
                : {})}
            >
              {v.exists ? `${v.notesExact === false ? '~' : ''}${v.notes ?? 0}` : 'missing'}
            </span>
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
