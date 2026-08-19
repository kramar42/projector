import { useCallback, useEffect, useRef, useState } from 'react';
import { Route, Switch, useLocation, useRoute, useSearch } from 'wouter';
import { api } from './api.ts';
import { BoardView } from './views/BoardView.tsx';
import { CanvasView } from './views/CanvasView.tsx';
import { CardPanel } from './views/CardPanel.tsx';
import type { Meta } from './types.ts';

function Sidebar({ meta }: { meta: Meta }) {
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
        <div className="navfoot-path" title={meta.dataDir}>
          {meta.dataDir.replace(/^.*\/(?=[^/]+\/[^/]+$)/, '…/')}
        </div>
      </div>
    </nav>
  );
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    api.meta().then(setMeta, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (isRoot && meta) {
      const first = meta.views.find((v) => v.kind === 'board');
      if (first) navigate(`/board/${first.name}`, { replace: true });
    }
  }, [isRoot, meta, navigate]);

  if (error) return <div className="boot-error">Cannot reach the cockpit server: {error}</div>;
  if (!meta) return <div className="boot">starting…</div>;

  return (
    <div className="shell">
      <Sidebar meta={meta} />
      <main className="main">
        <Switch>
          <Route path="/board/:name">
            {(params) => <BoardView name={params.name!} meta={meta} onOpen={setOpenCard} />}
          </Route>
          <Route path="/canvas/:name">
            {(params) => <CanvasView name={params.name!} meta={meta} onOpen={setOpenCard} />}
          </Route>
          <Route>
            <div className="pane-loading">pick a view</div>
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
  );
}
