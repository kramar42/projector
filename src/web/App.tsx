import { useCallback, useEffect, useRef, useState } from 'react';
import { Route, Switch, useLocation, useRoute, useSearch } from 'wouter';
import { api } from './api.ts';
import { BoardView } from './views/BoardView.tsx';
import { CanvasView } from './views/CanvasView.tsx';
import { CardPanel } from './views/CardPanel.tsx';
import { EnrichmentProvider } from './enrichment.tsx';
import { VaultPicker } from './VaultPicker.tsx';
import { VaultSwitcher } from './VaultSwitcher.tsx';
import { currentVault, setCurrentVault } from './vault.ts';
import { ApiError } from './api.ts';
import type { Meta } from './types.ts';

function Sidebar({
  meta,
  onSwitchVault,
  onAddVault,
}: {
  meta: Meta;
  onSwitchVault: (path: string) => void;
  onAddVault: () => void;
}) {
  const [location, navigate] = useLocation();
  const boards = meta.views.filter((v) => v.kind === 'board');
  const canvases = meta.views.filter((v) => v.kind === 'canvas');

  const item = (kind: string, name: string, title: string) => {
    const href = `/${kind}/${name}`;
    return (
      <button
        key={href}
        className={`navitem ${location === href ? 'is-active' : ''}`}
        onClick={() => navigate(href)}
      >
        {title}
      </button>
    );
  };

  return (
    <nav className="sidebar">
      <div className="brand">
        cockpit
        <span className="brand-sub">P2 · editing</span>
      </div>

      <div className="navgroup">
        <h2>Boards</h2>
        {boards.map((v) => item('board', v.name, v.title))}
      </div>

      <div className="navgroup">
        <h2>Canvases</h2>
        {canvases.map((v) => item('canvas', v.name, v.title))}
      </div>

      <div className="navfoot">
        <div>
          {meta.counts.cards} cards · {meta.counts.nodes} nodes
        </div>
        <div>
          {meta.counts.projects} projects · {meta.counts.edges} edges
        </div>
        <VaultSwitcher meta={meta} onSwitch={onSwitchVault} onAdd={onAddVault} />
      </div>
    </nav>
  );
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  // No vault chosen, or the server rejected the one we named: ask.
  const [gate, setGate] = useState<{ reason?: string } | null>(
    currentVault() ? null : { reason: undefined },
  );
  const [addingVault, setAddingVault] = useState(false);
  const [location, navigate] = useLocation();
  const search = useSearch();
  const [isRoot] = useRoute('/');

  // The open card lives in the URL, not in component state, so a card can be
  // bookmarked or pasted into Slack and reopened in its own view.
  const openCard = new URLSearchParams(search).get('card');

  // `onOpen` reaches React Flow through a memoised node array, so its identity
  // must never change: a new function per render re-seeds the store, node
  // measurement restarts, and fitView plus every edge stay permanently pending.
  // Reading the current location from a ref keeps the deps genuinely empty.
  const nav = useRef({ search, location, navigate });
  nav.current = { search, location, navigate };
  const setOpenCard = useCallback((id: string | null) => {
    const { search: s, location: loc, navigate: go } = nav.current;
    const params = new URLSearchParams(s);
    if (id) params.set('card', id);
    else params.delete('card');
    const q = params.toString();
    go(`${loc}${q ? `?${q}` : ''}`, { replace: !id });
  }, []);

  const loadMeta = useCallback(() => {
    api.meta().then(
      (m) => {
        setMeta(m);
        setError(null);
        setGate(null);
        // Adopt whatever the server actually served, so a fallback to the single
        // registered vault is remembered rather than re-derived every load.
        if (m.vault !== currentVault()) setCurrentVault(m.vault);
      },
      (e: ApiError) => {
        if (e.needsVault || e.status === 428) setGate({ reason: e.message });
        else setError(e.message);
      },
    );
  }, []);

  useEffect(() => {
    if (!gate) loadMeta();
  }, [gate, loadMeta]);

  const switchVault = useCallback(
    (path: string) => {
      setCurrentVault(path);
      setMeta(null);
      setGate(null);
      // The current route names a view in the *old* vault. Go back to the root so
      // the redirect below picks whichever board the new vault actually has.
      navigate('/', { replace: true });
      loadMeta();
    },
    [loadMeta, navigate],
  );

  useEffect(() => {
    if (isRoot && meta) {
      const first = meta.views.find((v) => v.kind === 'board');
      if (first) navigate(`/board/${first.name}`, { replace: true });
    }
  }, [isRoot, meta, navigate]);

  if (gate) {
    return (
      <VaultPicker
        reason={gate.reason}
        onOpened={switchVault}
        onCancel={meta ? () => setGate(null) : undefined}
      />
    );
  }
  if (addingVault) {
    return (
      <VaultPicker
        onOpened={(path) => {
          setAddingVault(false);
          switchVault(path);
        }}
        onCancel={() => setAddingVault(false)}
      />
    );
  }
  if (error) return <div className="boot-error">Cannot reach the cockpit server: {error}</div>;
  if (!meta) return <div className="boot">starting…</div>;

  return (
    <EnrichmentProvider>
    <div className="shell">
      <Sidebar meta={meta} onSwitchVault={switchVault} onAddVault={() => setAddingVault(true)} />
      <main className="main">
        <Switch>
          <Route path="/board/:name">
            {(params) => <BoardView name={params.name!} meta={meta} onOpen={setOpenCard} />}
          </Route>
          <Route path="/canvas/:name">
            {(params) => <CanvasView name={params.name!} meta={meta} onOpen={setOpenCard} />}
          </Route>
          <Route>
            {meta.views.length ? (
              <div className="pane-loading">pick a view</div>
            ) : (
              <div className="pane-loading">
                This vault has no views yet. Add a board to{' '}
                <code>views/board/</code> — see the spec for the format.
              </div>
            )}
          </Route>
        </Switch>
      </main>
      {openCard && (
        <CardPanel
          id={openCard}
          meta={meta}
          onClose={() => setOpenCard(null)}
          onOpen={setOpenCard}
        />
      )}
    </div>
    </EnrichmentProvider>
  );
}
