import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ApiError, api } from './api.ts';
import { useLive } from './useLive.ts';
import { BoardView } from './views/BoardView.tsx';
import { CanvasView } from './views/CanvasView.tsx';
import { TableView } from './views/TableView.tsx';
import { CardPanel } from './panel/CardPanel.tsx';
import { EnrichmentProvider } from './enrichment.tsx';
import { VocabularyProvider } from './vocabulary.tsx';
import { Sidebar } from './sidebar/Sidebar.tsx';
import { VaultPicker } from './VaultPicker.tsx';
import { currentVault, setCurrentVault } from './vault.ts';
import {
  CARD_PARAM,
  apiSearch,
  patchSearch,
  selectionOf,
  selectionPatch,
  strippedOfStrays,
  type Patch,
} from './query.ts';
import { useSelection } from './selection.ts';
import { specToPatch } from '../view/intents.ts';
import type { ViewSpec } from './types.ts';
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // No vault chosen, or the server rejected the one we named: ask.
  const [gate, setGate] = useState<{ reason?: string } | null>(
    currentVault() ? null : { reason: undefined },
  );
  const [addingVault, setAddingVault] = useState(false);
  const [location, navigate] = useLocation();
  const search = useSearch();

  const openCard = new URLSearchParams(search).get(CARD_PARAM);
  // Memoised on the search string, so the set's identity only changes when the
  // selection does — a canvas effect keys off it.
  const selectedIds = useMemo(() => selectionOf(search), [search]);

  // `onOpen` reaches React Flow through a memoised node array, so its identity
  // must never change: a new function per render re-seeds the store, node
  // measurement restarts, and fitView plus every edge stay permanently pending.
  // Reading the current location from a ref keeps the deps genuinely empty.
  const nav = useRef({ search, location, navigate });
  nav.current = { search, location, navigate };

  /**
   * The URL is the view, so a key nothing reads is not part of it.
   *
   * Every control writes through `patchSearch`, which preserves what it does not
   * recognise — so a parameter that is deleted from the code keeps riding along in
   * any URL that was bookmarked or left open while it existed, and there is
   * nothing that would ever take it out. `?filterstyle=` outlived the three filter
   * treatments it switched between by exactly that route.
   *
   * `replace`, because this is a normalisation and not a navigation: a fossil in
   * the address bar should not become a place the back button can return to.
   */
  useEffect(() => {
    const cleaned = strippedOfStrays(search);
    if (cleaned === null) return;
    const { location: loc, navigate: go } = nav.current;
    go(`${loc}${cleaned}`, { replace: true });
  }, [search]);

  /**
   * Every sidebar control funnels through here. `replace` for anything you drag
   * or type — otherwise a filter session leaves fifty entries in the history and
   * the back button becomes useless.
   */
  const patch = useCallback((p: Patch, replace = false) => {
    const { search: s, location: loc, navigate: go } = nav.current;
    go(`${loc}${patchSearch(s, p)}`, { replace });
  }, []);

  /**
   * Editing the view itself.
   *
   * A control says what it wants of the spec; this turns the result back into the
   * overrides the URL carries. The spec it edits is the *resolved* one — saved
   * view merged under the query string — and the diff is taken against the saved
   * view, which is the only way "unselect this value" and "clear these filters"
   * can mean anything on a view whose defaults live in a file.
   */
  const editRef = useRef<{ spec: ViewSpec; savedSpec: ViewSpec | null } | null>(null);
  const edit = useCallback(
    (fn: (spec: ViewSpec) => ViewSpec, replace = false) => {
      const cur = editRef.current;
      if (!cur) return;
      // The current search is the third side of the diff: an override that lives
      // only in the URL is invisible to both specs, and so was never cleared.
      patch(specToPatch(fn(cur.spec), cur.savedSpec, nav.current.search), replace);
    },
    [patch],
  );

  /**
   * Selection is written like `?card=` and never like a query: `replace` always,
   * because a twelve-card selection is twelve clicks and the back button is for
   * views rather than for undoing a pick.
   */
  const commitSelection = useCallback((next: ReadonlySet<string>) => {
    const { search: s, location: loc, navigate: go } = nav.current;
    go(`${loc}${patchSearch(s, selectionPatch(next))}`, { replace: true });
  }, []);

  const selection = useSelection(selectedIds, commitSelection);

  /**
   * Escape clears the selection — the counterpart to the bulk bar's button, and
   * the only way out that does not involve aiming at anything.
   *
   * Not while the panel is open: `CardPanel` listens for the same key on the same
   * window to close itself, and one keystroke should mean one thing. Not while
   * something is being typed into either, where Escape belongs to the field.
   */
  useEffect(() => {
    if (!selectedIds.size || openCard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      commitSelection(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, openCard, commitSelection]);

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
  // Kept in a ref so `edit` can stay identity-stable; see `nav` above for why.
  editRef.current = data ? { spec: data.spec, savedSpec: data.savedSpec } : null;
  const content = useMemo(() => {
    if (queryError) return <div className="pane-error">{queryError}</div>;
    if (!data || !meta) return <div className="pane-loading">loading…</div>;
    if (shape === 'canvas')
      return (
        <CanvasView
          meta={meta}
          data={data}
          onOpen={setOpenCard}
          selection={selection}
          reload={reload}
          wire={wire}
          onSaved={(name) => patch({ view: name })}
        />
      );
    if (shape === 'table')
      return <TableView data={data} onOpen={setOpenCard} selection={selection} reload={reload} />;
    return <BoardView data={data} onOpen={setOpenCard} selection={selection} reload={reload} />;
  }, [data, meta, queryError, shape, setOpenCard, selection, reload, patch, wire]);

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
  if (error) return <div className="boot-error">Cannot reach the projector server: {error}</div>;
  if (!meta) return <div className="boot">starting…</div>;

  return (
    <EnrichmentProvider>
      {/* Every surface that *draws* a facet value reads its hue from here, so a
          chip on a card face, a table cell, a canvas node and the bulk bar
          cannot disagree about what colour an axis is. */}
      <VocabularyProvider facets={meta.facets}>
      <div className={`shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
        <Sidebar
          meta={meta}
          data={data}
          search={search}
          wire={wire}
          patch={patch}
          edit={edit}
          onSwitchVault={switchVault}
          onAddVault={() => setAddingVault(true)}
          onOpenCard={setOpenCard}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
        />
        <main className="main">{content}</main>
        {openCard && (
          <CardPanel
            // Keyed on the card, so switching records remounts the panel and
            // every block in it. That is the reset: there is no list of state to
            // keep in step, and so no list that can fall behind.
            key={openCard}
            id={openCard}
            meta={meta}
            onClose={() => setOpenCard(null)}
            onOpen={setOpenCard}
          />
        )}
      </div>
      </VocabularyProvider>
    </EnrichmentProvider>
  );
}
