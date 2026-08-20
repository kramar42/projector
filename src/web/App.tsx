import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ApiError, api } from './api.ts';
import { useLive } from './useLive.ts';
import { BoardView } from './views/BoardView.tsx';
import { CanvasView } from './views/CanvasView.tsx';
import { TableView } from './views/TableView.tsx';
import { CardPanel } from './views/CardPanel.tsx';
import { EnrichmentProvider } from './enrichment.tsx';
import { Sidebar } from './sidebar/Sidebar.tsx';
import { VaultPicker } from './VaultPicker.tsx';
import { currentVault, setCurrentVault } from './vault.ts';
import { CARD_PARAM, apiSearch, patchSearch, type Patch } from './query.ts';
import type { Meta, QueryResponse } from './types.ts';

/**
 * One route.
 *
 * P1 routed `/board/:name` and `/canvas/:name`, because a view was a place you
 * navigated to. A view is a query now (C9), so there is one page and the query
 * lives in the search string — which keeps `?card=` deep links working exactly
 * as before, and makes any view shareable without having to first save it.
 */
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

  const openCard = new URLSearchParams(search).get(CARD_PARAM);

  // `onOpen` reaches React Flow through a memoised node array, so its identity
  // must never change: a new function per render re-seeds the store, node
  // measurement restarts, and fitView plus every edge stay permanently pending.
  // Reading the current location from a ref keeps the deps genuinely empty.
  const nav = useRef({ search, location, navigate });
  nav.current = { search, location, navigate };

  /**
   * Every sidebar control funnels through here. `replace` for anything you drag
   * or type — otherwise a filter session leaves fifty entries in the history and
   * the back button becomes useless.
   */
  const patch = useCallback((p: Patch, replace = false) => {
    const { search: s, location: loc, navigate: go } = nav.current;
    go(`${loc}${patchSearch(s, p)}`, { replace });
  }, []);

  const setOpenCard = useCallback((id: string | null) => {
    const { search: s, location: loc, navigate: go } = nav.current;
    const params = new URLSearchParams(s);
    if (id) params.set(CARD_PARAM, id);
    else params.delete(CARD_PARAM);
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
      // The query may name a view or a focus record from the *old* vault.
      navigate('/', { replace: true });
      loadMeta();
    },
    [loadMeta, navigate],
  );

  // Nothing asked for: open `home` if the vault has one, else the first saved
  // view, else the bare query. Rewritten into the URL so it is always
  // authoritative and an explicitly empty filter stays representable.
  useEffect(() => {
    if (!meta || search) return;
    const home = meta.views.find((v) => v.name === 'home') ?? meta.views[0];
    if (home) navigate(`/?view=${encodeURIComponent(home.name)}`, { replace: true });
  }, [meta, search, navigate]);

  const wire = apiSearch(search);
  const { data, error: queryError, reload } = useLive<QueryResponse>(
    () => api.query(wire),
    [wire, meta?.vault],
  );

  const shape = data?.spec.shape ?? 'board';
  const content = useMemo(() => {
    if (queryError) return <div className="pane-error">{queryError}</div>;
    if (!data) return <div className="pane-loading">loading…</div>;
    if (shape === 'canvas')
      return (
        <CanvasView
          data={data}
          onOpen={setOpenCard}
          reload={reload}
          patch={patch}
          wire={wire}
          onSaved={(name) => patch({ view: name })}
        />
      );
    if (shape === 'table') return <TableView data={data} onOpen={setOpenCard} />;
    return <BoardView data={data} onOpen={setOpenCard} reload={reload} patch={patch} />;
  }, [data, queryError, shape, setOpenCard, reload, patch, wire]);

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
        <Sidebar
          meta={meta}
          data={data}
          search={search}
          wire={wire}
          patch={patch}
          onSwitchVault={switchVault}
          onAddVault={() => setAddingVault(true)}
          onOpenCard={setOpenCard}
        />
        <main className="main">{content}</main>
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
