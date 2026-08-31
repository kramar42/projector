import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ApiError, api, onAttention } from './api.ts';
import { useLive } from './useLive.ts';
import { BoardView } from './views/BoardView.tsx';
import { CalendarView } from './views/CalendarView.tsx';
import { TableView } from './views/TableView.tsx';
import { whatIsUnsaved } from './panel/unsaved.ts';
/**
 * The two chunks worth splitting, and only these: the canvas carries React Flow
 * and dagre, the panel carries the markdown renderer — together well over half
 * the bundle, and neither is on screen at first paint unless the URL asks. The
 * board, table and calendar are this app's own code and stay in the shell;
 * splitting them would trade a flash of `loading…` for nothing.
 */
const CanvasView = lazy(() =>
  import('./views/CanvasView.tsx').then((m) => ({ default: m.CanvasView })),
);
const NotePanel = lazy(() =>
  import('./panel/NotePanel.tsx').then((m) => ({ default: m.NotePanel })),
);
// The pins ride in a lazy chunk for the panel's reason: a spread page renders
// markdown, and neither surface is on screen at first paint unless the URL asks.
const PinDock = lazy(() =>
  import('./panel/PinStack.tsx').then((m) => ({ default: m.PinDock })),
);
const PinStack = lazy(() =>
  import('./panel/PinStack.tsx').then((m) => ({ default: m.PinStack })),
);
import { DeclinedPanel } from './Declined.tsx';
import { EnrichmentProvider } from './enrichment.tsx';
import { VocabularyProvider } from './vocabulary.tsx';
import { TouchedProvider } from './touched.tsx';
import { PinnedProvider } from './pinned.tsx';
import { Sidebar } from './sidebar/Sidebar.tsx';
import { VaultPicker } from './VaultPicker.tsx';
import { Cheatsheet } from './Cheatsheet.tsx';
import { Palette } from './Palette.tsx';
import { asksOnlyForAVault, VAULT_PARAM, vaultOf } from './vault.ts';
import {
  NOTE_PARAM,
  DECLINED_PARAM,
  apiSearch,
  patchSearch,
  pinsOf,
  pinsPatch,
  selectionOf,
  selectionPatch,
  strippedOfStrays,
  type Patch,
} from './query.ts';
import { afterRemovingPage, PAGE_SCROLL, SPINE_W, stackPages } from './panel/pins.ts';
import { useSelection, type Selection } from './selection.ts';
import { focusSoon, useCursor, useDormantRing, type Cursor } from './cursor.ts';
import {
  drawn,
  firstSpot,
  gridOf,
  idAt,
  lastSpot,
  locate,
  steppedTo,
  type Grid,
  type Spot,
} from './views/motion.ts';
import {
  changeView,
  clearFilters,
  setFocus,
  setGroupBy,
  setShape,
  setShow,
  setSort,
  specToPatch,
} from '../view/intents.ts';
import { bind, inField, type Command, type Pending } from '../view/keys.ts';
import type { KeyboardLayout } from './cheatsheetKeys.ts';
import {
  emptyHistory,
  inverseOf,
  recorded,
  redone,
  undone,
  type FacetWrite,
  type History,
  type Step,
} from '../view/undo.ts';
import type { Edit, ViewSpec } from './types.ts';
import type { Meta, NoteDTO, QueryResponse } from './types.ts';

/**
 * How long a keynotice stays.
 *
 * Long enough to read a sentence and short enough that nobody reaches for the
 * mouse to clear it. It is not `FLUSH_MS`: that is how long a *changed region*
 * stays washed, and it is welded to the length of a write. These two have nothing
 * to keep in step, so sharing a constant would be a coincidence pretending to be
 * a rule.
 */
const NOTICE_MS = 4000;

/**
 * Hooks must still be called while the picker is open, but an unselected vault
 * must not let the server's single-vault fallback start reading one. The promise
 * is superseded as soon as `vault` changes and its result is never observed.
 */
const NO_VAULT_QUERY = new Promise<QueryResponse>(() => {});

/**
 * One route.
 *
 * P1 routed `/board/:name` and `/canvas/:name`, because a view was a place you
 * navigated to. A view is a query now (C9), so there is one page and the query
 * lives in the search string — which keeps `?note=` deep links working exactly
 * as before, and makes any view shareable without having to first save it.
 */
export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [location, navigate] = useLocation();
  const search = useSearch();
  const vault = vaultOf(search);
  // No vault chosen, or the server rejected the one we named: ask.
  const [gate, setGate] = useState<{ reason?: string } | null>(
    vault ? null : { reason: undefined },
  );
  const [addingVault, setAddingVault] = useState(false);
  // Spreading is presentation, not part of the reading workspace. Pins and the
  // open note survive a reload; the expensive multi-note surface does not make
  // itself the next cold start merely because it was open on exit.
  const [stackOpen, setStackOpen] = useState(false);
  // A slow response for the vault we just left must not re-install its metadata.
  const activeVault = useRef(vault);
  activeVault.current = vault;

  const openNote = new URLSearchParams(search).get(NOTE_PARAM);
  /** The URL-owned reading set. Its expanded presentation stays in memory. */
  const pins = useMemo(() => pinsOf(search), [search]);
  // A spread belongs to the vault it was opened in, not whichever vault is
  // selected next in the same mounted shell.
  useEffect(() => setStackOpen(false), [vault]);
  /**
   * The declined pile, opened over the view like the panel is.
   *
   * A search parameter rather than a route, for the reason the file above gives:
   * there is one route because a view is a query, and this is not a view — it is a
   * surface over whatever you were looking at.
   */
  const declinedOpen = new URLSearchParams(search).get(DECLINED_PARAM) === '1';

  /**
   * Open or close the declined surface without disturbing the view underneath.
   *
   * Rewriting the whole search string would drop the query you were looking at,
   * which is the difference between a surface *over* a view and a navigation away
   * from one.
   */
  const setDeclined = (open: boolean) => {
    const next = new URLSearchParams(search);
    if (open) next.set(DECLINED_PARAM, '1');
    else next.delete(DECLINED_PARAM);
    const q = next.toString();
    navigate(`${location}${q ? `?${q}` : ''}`);
  };
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
   * Selection is written like `?note=` and never like a query: `replace` always,
   * because a twelve-note selection is twelve clicks and the back button is for
   * views rather than for undoing a pick.
   */
  const commitSelection = useCallback((next: ReadonlySet<string>) => {
    const { search: s, location: loc, navigate: go } = nav.current;
    go(`${loc}${patchSearch(s, selectionPatch(next))}`, { replace: true });
  }, []);

  const selection = useSelection(selectedIds, commitSelection);

  const cursor = useCursor();
  // One ring is lit at a time (C12). The cursor keeps its place while the keyboard
  // is off in the rail or the panel, and stops claiming the keys — see `cursor.ts`.
  useDormantRing();
  /**
   * What a keyboard write has to say for itself.
   *
   * The three views each own a `problem` banner, and none of them is reachable
   * from here — a keystroke is dispatched by the shell, not by whichever shape
   * happens to be mounted. So the shell gets one, in the same `banner is-bad`
   * register, and it carries the neutral reports too: an undo that succeeded and
   * an undo that had nothing to put back are both things the reader asked for and
   * should be told about.
   */
  const [notice, setNotice] = useState<{ tone: 'bad' | 'info'; text: string } | null>(null);
  /**
   * The notice goes on its own, which the stylesheet had claimed for some time.
   *
   * `.keynotice`'s comment called it "transient, centred and self-dismissing" and
   * used that as the reason it writes no `scroll-padding` — but nothing ever
   * dismissed it. `showing what names this note on Part of` sat over the board
   * until it was clicked or Escape was pressed, which is a modal's behaviour on a
   * message that is already history by the time it is read.
   *
   * Keyed on the notice *object* rather than on its text, so the same message
   * arriving twice restarts the clock: every `notify` call builds a fresh object,
   * so identity is the "this is a new notice" signal without a sequence number.
   * Click and Escape still dismiss it early; the cleanup is what stops a dismissed
   * notice's timer clearing the next one.
   */
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * The column `n` asked to create a card in.
   *
   * The one binding whose target is not a note, so it is the one that cannot be
   * done from here alone: the inline field belongs to the column that draws it.
   * The shell names the column and the board opens it.
   */
  const [newIn, setNewIn] = useState<string | null>(null);
  /**
   * A pending `⌥j` / `⌥k`, handed to the board and cleared as it is taken.
   *
   * Null between presses rather than a running counter: the board clears it the
   * moment it acts, so the prop goes `null → delta → null` and two presses of one
   * key are two changes. A counter would be a second thing to keep in step for a
   * problem the round trip already solves.
   */
  const [nudge, setNudge] = useState<number | null>(null);
  /**
   * The undo stacks. A ref, because nothing renders from them — `u` consults them
   * and they are invisible the rest of the time.
   */
  const history = useRef<History>(emptyHistory());
  /**
   * What the open panel would lose if it closed now.
   *
   * A ref written by the panel, because the key chain is the one thing that
   * closes it and the chain is here. It was a second `window` listener living in
   * `NotePanel`, which is why the title editor had to `stopPropagation` on a key
   * it was already handling.
   */
  const panelUnsaved = useRef({ body: false, frontmatter: false });
  /**
   * The last values seen on every note, so an undo can put back what a note held
   * even after the write moved it out of the view. See `KeyState.valuesOf`.
   */
  const seenFacets = useRef(new Map<string, NoteDTO['facets']>());

  const setOpenNote = useCallback((id: string | null) => {
    const { search: s, location: loc, navigate: go } = nav.current;
    const params = new URLSearchParams(s);
    if (id) params.set(NOTE_PARAM, id);
    else params.delete(NOTE_PARAM);
    const q = params.toString();
    go(`${loc}${q ? `?${q}` : ''}`, { replace: !id });
  }, []);

  /**
   * Opening a note from a view: the cursor goes where the pointer did.
   *
   * `step` rather than `jump`, because clicking a card you can see is not a
   * detour — the trail is for the one move the cursor cannot walk back from,
   * which is following a reference out of the view. See `cursor.ts`.
   *
   * Both dependencies are identity-stable, which the canvas requires absolutely:
   * a new `onOpen` per render re-seeds React Flow's store and leaves fitView and
   * every edge permanently pending. `cursor.step` is a `useCallback` with no
   * deps for exactly this.
   */
  // Identity-stable, so the board's effect fires on the request rather than on
  // every render of the shell.
  const clearNewIn = useCallback(() => setNewIn(null), []);
  const clearNudge = useCallback(() => setNudge(null), []);

  const openCard = useCallback(
    (id: string | null, at?: Spot | null) => {
      if (id) cursor.jump(id, at);
      setOpenNote(id);
    },
    [cursor.jump, setOpenNote],
  );

  /**
   * Pins are written like the selection: `replace` always, because pinning is a
   * pick and the back button is for views. One URL write per gesture.
   */
  const setPins = useCallback((ids: string[]) => {
    const { search: s, location: loc, navigate: go } = nav.current;
    // A pins-only spread with no pins is no surface at all. Close it in the same
    // gesture rather than leaving the view inert under an empty overlay.
    if (!ids.length && !new URLSearchParams(s).get(NOTE_PARAM)) setStackOpen(false);
    go(`${loc}${patchSearch(s, pinsPatch(ids))}`, { replace: true });
  }, []);

  /**
   * Hold this note, or let it go — through the same URL writer, wherever the
   * control lives. The same act `'` performs, so a pointer and a key cannot
   * disagree about what pinning is.
   */
  const togglePin = useCallback(
    (id: string) => {
      const held = pinsOf(nav.current.search);
      setPins(held.includes(id) ? held.filter((p) => p !== id) : [...held, id]);
    },
    [setPins],
  );

  /**
   * Spread or fold the pins — and, folding, optionally land on a note.
   *
   * The mode itself is memory state. When folding also changes `?note=`, that
   * note still gets one URL write; the state update cannot race or restore an
   * older search string.
   */
  const setStack = useCallback((open: boolean, note?: string | null) => {
    setStackOpen(open);
    if (note === undefined) return;
    const { search: s, location: loc, navigate: go } = nav.current;
    go(`${loc}${patchSearch(s, { [NOTE_PARAM]: note })}`, { replace: true });
  }, []);

  /**
   * Opening a note from *inside* a note — a reference chip, a reflink, a spread
   * page. The modifiers are the three ways out of a note you are reading:
   *
   *   plain    the reference replaces what you are reading, and records —
   *            `H` is what returns you (the move the trail exists for)
   *   ⌥        the reference becomes a pin; what you are reading stays put
   *   ⇧        what you are reading becomes a pin, the reference takes its
   *            place — reading forward while the trail piles up on the right
   */
  const followCard = useCallback(
    (id: string, mods?: { altKey?: boolean; shiftKey?: boolean }) => {
      const held = pinsOf(nav.current.search);
      if (mods?.altKey) {
        if (!held.includes(id)) {
          const { search: s, location: loc, navigate: go } = nav.current;
          go(`${loc}${patchSearch(s, pinsPatch([...held, id]))}`, { replace: true });
        }
        return;
      }
      if (mods?.shiftKey) {
        const from = new URLSearchParams(nav.current.search).get(NOTE_PARAM);
        cursor.jump(id);
        const next = from && !held.includes(from) ? [...held, from] : held;
        const { search: s, location: loc, navigate: go } = nav.current;
        go(`${loc}${patchSearch(s, { ...pinsPatch(next), [NOTE_PARAM]: id })}`);
        return;
      }
      cursor.jump(id);
      setOpenNote(id);
    },
    [cursor.jump, setOpenNote],
  );

  /**
   * Interrupting, when a sweep found something that could not wait.
   *
   * Permission is asked on the first one rather than on load: a page that demands
   * notification rights before it has anything to say is the page everybody
   * denies. By the time this fires there is a specific thing to be told about, and
   * a refusal costs nothing — the note is on the board either way, which is what
   * makes this an enhancement rather than a delivery mechanism.
   *
   * Clicking one opens the note it names.
   */
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    return onAttention((notes) => {
      const raise = () => {
        for (const n of notes.slice(0, 3)) {
          const seen = new Notification(n.title, { body: 'Needs you now — from a sweep', tag: n.id });
          seen.onclick = () => {
            window.focus();
            setOpenNote(n.id);
          };
        }
      };
      if (Notification.permission === 'granted') raise();
      else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => p === 'granted' && raise());
    });
  }, [setOpenNote]);

  const loadMeta = useCallback(() => {
    if (!vault) return;
    const requested = vault;
    api.meta().then(
      (m) => {
        if (activeVault.current !== requested) return;
        setMeta(m);
        setError(null);
        setGate(null);
      },
      (e: ApiError) => {
        if (activeVault.current !== requested) return;
        if (e.needsVault || e.status === 428) setGate({ reason: e.message });
        else setError(e.message);
      },
    );
  }, [vault]);

  useEffect(() => {
    setMeta(null);
    if (!vault) {
      setGate({ reason: undefined });
      return;
    }
    setGate(null);
    loadMeta();
  }, [vault, loadMeta]);

  const switchVault = useCallback(
    (selector: string) => {
      // The query may name a view or a focus note from the *old* vault.
      navigate(`/${patchSearch('', { [VAULT_PARAM]: selector })}`, { replace: true });
    },
    [navigate],
  );

  // Full-path links from older builds remain valid, then become the portable,
  // human-readable spelling as soon as the server has resolved them.
  useEffect(() => {
    if (!meta || vault !== meta.vault || meta.vaultName === vault) return;
    navigate(`/${patchSearch(search, { [VAULT_PARAM]: meta.vaultName })}`, { replace: true });
  }, [meta, vault, search, navigate]);

  /**
   * Nothing asked for: open `home` if the vault has one, else the first saved
   * view, else the bare query. Rewritten into the URL so it is always
   * authoritative and an explicitly empty filter stays representable.
   *
   * "Nothing asked for" is *besides the vault*, and that is the whole of this.
   * The guard used to be `isRoot` — a path test, back when a view was a place —
   * and became `if (search)` when a view became a query. But choosing a vault is
   * itself a search parameter now, and it is written before any metadata exists
   * to have a home view in, so `search` was never empty by the time this could
   * run: every vault opened on an ungrouped ad-hoc board, including the shipped
   * tutorial, whose `home.yaml` says "Opened when nothing else is asked for" in
   * its first line.
   *
   * `patchSearch` rather than a fresh string for the same reason: the vault is a
   * parameter like any other and must survive being landed on.
   */
  useEffect(() => {
    if (!meta || !asksOnlyForAVault(search)) return;
    const home = meta.views.find((v) => v.name === 'home') ?? meta.views[0];
    if (home) navigate(`/${patchSearch(search, { view: home.name })}`, { replace: true });
  }, [meta, search, navigate]);

  /**
   * A link that opens a note puts the cursor on it, once.
   *
   * `?note=` is the shareable half of where you are, and the cursor is the
   * transient half — so a cold load of someone's link had `?note=` and a cursor
   * of `null`. Everything downstream reads as broken from that one gap: `jump`
   * pushes nothing when there is nowhere to push, so the *first* reference you
   * followed from a shared link recorded nothing and `H` did not come back. You
   * had to touch the board first to make the trail work at all.
   *
   * A `step` rather than a `jump`, deliberately: this is the starting point, not
   * a move away from one, and recording it would put a note on the trail that
   * nothing ever left. It runs once by construction — the cursor is only ever
   * `null` before something sets it, and `openCard(null)` closes the panel
   * without clearing it.
   */
  useEffect(() => {
    if (openNote && !cursor.id) cursor.step(openNote);
  }, [openNote, cursor.id, cursor.step]);

  const wire = apiSearch(search);
  /**
   * The query, and the two different things a change to it can mean.
   *
   * A new `wire` is a new question about the same vault, so the answer on screen
   * stays up until the new one lands — that is the whole of "no blink" (see
   * `useLive`). A new vault is a different library, and holding its predecessor's
   * board up for even a frame would be showing cards that are not there.
   */
  const { data, error: queryError, reload } = useLive<QueryResponse>(
    () => (vault ? api.query(wire) : NO_VAULT_QUERY),
    [wire],
    [vault],
  );

  const shape = data?.spec.shape ?? 'table';
  // Kept in a ref so `edit` can stay identity-stable; see `nav` above for why.
  editRef.current = data ? { spec: data.spec, savedSpec: data.savedSpec } : null;

  /**
   * Where the cursor can go: the payload's notes, in the order the shape draws
   * them.
   *
   * Built here rather than inside a view, because `App` already holds the payload
   * and `gridOf` is pure — so a view's only job is to *draw* the cursor it is
   * given, and neither of them has to hand an ordering back up the tree.
   */
  // The calendar's cells come from the URL's page and the vocabulary's date
  // axis, which is why this alone of the shapes needs more than the payload.
  const grid = useMemo(
    () => gridOf(data, { search, facets: meta?.facets ?? {} }),
    [data, search, meta],
  );
  /**
   * Which *placement* the cursor is at, for the views to draw.
   *
   * The cursor is an id and a note can be drawn several times, so an id alone
   * cannot say which copy on screen is the one the keyboard is on. `locate` has
   * always answered that for stepping; this hands the same answer to the drawing
   * so the two cannot disagree.
   */
  const cursorSpot: Spot | null = useMemo(
    // With the copy the cursor was last put on as a hint — see `locate`. It is
    // re-resolved here every render, so a hint the grid has outgrown costs
    // nothing but a fall back to the first placement.
    () => locate(grid, cursor.id, cursor.at),
    [grid, cursor.id, cursor.at],
  );

  // Remember every note the query has shown. Cheap — one entry per note in the
  // vault at worst — and it is the only record of what a note held once the query
  // stops returning it.
  useEffect(() => {
    if (!data) return;
    for (const [id, note] of Object.entries(data.notes)) seenFacets.current.set(id, note.facets);
  }, [data]);

  /**
   * Everything the key handler reads, in a ref.
   *
   * The listener registers once and never again — the same device `nav` above
   * uses, and for a sharper reason here: re-registering a `keydown` listener on
   * every render is how a keystroke arriving mid-teardown lands on nothing, which
   * `Popover` has a comment about already. A ref written during render is also
   * always current, which a dependency array is not.
   */
  /**
   * Send a step, record it, and say what happened.
   *
   * One place, so a write and its inverse are always applied by the same code —
   * an undo that took a different path to the server than the write it reverses
   * is an undo that can be wrong in ways the write never was.
   *
   * Sequential rather than concurrent: a `set` inverse can be several writes, and
   * the server gates each note on its mtime, so two requests touching one file in
   * flight together is a conflict this would be manufacturing for itself.
   */
  /**
   * Fold a write we just made into what we remember about those notes.
   *
   * Without this the memory is only as fresh as the last payload, and the case it
   * exists for is exactly the case where payloads stop coming: a note written out
   * of the view is never seen again, so the *second* write to it computed its
   * inverse from the values it had two writes ago. Undo put back the wrong thing —
   * `planning` where the note had been `on-hold`.
   */
  const remember = useCallback((w: FacetWrite) => {
    for (const id of w.ids) {
      const facets = { ...(seenFacets.current.get(id) ?? {}) };
      const held = facets[w.facet] ?? [];
      facets[w.facet] =
        w.mode === 'set'
          ? [...w.values]
          : w.mode === 'add'
            ? [...held, ...w.values.filter((v) => !held.includes(v))]
            : held.filter((v) => !w.values.includes(v));
      seenFacets.current.set(id, facets);
    }
  }, []);

  const applyStep = useCallback(
    async (writes: FacetWrite[], say: string) => {
      try {
        for (const w of writes) {
          await api.bulk({ ids: w.ids, op: 'facet', facet: w.facet, values: w.values, mode: w.mode });
          remember(w);
        }
        setNotice(null);
        reload();
        return true;
      } catch (err) {
        setNotice({ tone: 'bad', text: `${say}: ${(err as ApiError).message}` });
        return false;
      }
    },
    [reload, remember],
  );

  /** Do a step and put it on the stack. Nothing is recorded that did not land. */
  const doStep = useCallback(
    async (step: Step) => {
      if (await applyStep(step.forward, step.label)) history.current = recorded(history.current, step);
    },
    [applyStep],
  );

  const keys = useRef<KeyState | null>(null);
  /** Used only for Option letters, whose `key` is a macOS symbol rather than their label. */
  const keyLayout = useRef<KeyboardLayout | null>(null);
  useEffect(() => {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<KeyboardLayout> } }).keyboard;
    void keyboard?.getLayoutMap?.().then((map) => {
      keyLayout.current = map;
    }).catch(() => {});
  }, []);
  keys.current = {
    grid,
    cursor,
    cursorSpot,
    selection,
    openNote,
    setOpenNote,
    pins,
    setPins,
    stackOpen,
    setStack,
    panelUnsaved,
    facets: meta?.facets ?? {},
    notes: data?.notes ?? {},
    valuesOf: (id, facet) =>
      data?.notes[id]?.facets[facet] ?? seenFacets.current.get(id)?.[facet] ?? [],
    facetKeys: facetKeysOf(meta),
    groupedAxis: data?.spec.query.groupBy?.[0] ?? null,
    notify: setNotice,
    notice,
    newCardIn: setNewIn,
    nudgeCard: setNudge,
    follow: followCard,
    edit,
    spec: data?.spec ?? null,
    views: data?.views ?? meta?.views ?? [],
    land: (view) => patch(changeView(data?.spec ?? null, nav.current.search, view)),
    toggleRail: () => setSidebarCollapsed((c) => !c),
    helpOpen,
    setHelpOpen,
    paletteOpen,
    setPaletteOpen,
    setDeclined,
    doStep,
    history,
    applyStep,
  };

  useEffect(() => {
    /**
     * The half-typed sequence. A ref rather than state, because nothing renders
     * from it: `,` and `g` are invisible until the key that completes them, and
     * putting a prefix in state would re-render the shell twice per binding.
     */
    const pending = { at: null as Pending | null };
    const onKey = (e: KeyboardEvent) => {
      const s = keys.current;
      if (!s) return;
      const out = bind(pending.at, {
        key: e.key,
        code: e.code,
        layoutKey: keyLayout.current?.get(e.code),
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      }, {
        facetKeys: s.facetKeys,
        groupedAxis: s.groupedAxis,
        inField: inField(e.target as HTMLElement | null),
      });
      pending.at = out.pending;
      if (!out.handled) return;
      // Claimed keys are prevented even when they produced nothing — otherwise
      // the abandoned second key of a `gg` scrolls the page.
      e.preventDefault();
      if (out.command) run(out.command, s);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const content = useMemo(() => {
    if (queryError) return <div className="pane-error">{queryError}</div>;
    // First paint only. A change of query holds the previous payload, so nothing
    // that is already on screen ever passes back through here.
    if (!data || !meta) return <div className="pane-loading">loading…</div>;
    if (shape === 'graph')
      return (
        // The canvas is a lazy chunk; the fallback is the same line first paint
        // shows, so a slow fetch and a slow chunk read as one thing.
        <Suspense fallback={<div className="pane-loading">loading…</div>}>
          <CanvasView
            meta={meta}
            data={data}
            onOpen={openCard}
            selection={selection}
            reload={reload}
            wire={wire}
            onSaved={(name) => patch({ view: name })}
          />
        </Suspense>
      );
    if (shape === 'table')
      return (
        <TableView
          meta={meta}
          data={data}
          onOpen={openCard}
          selection={selection}
          cursor={cursor.id}
          cursorSpot={cursorSpot}
          onCursor={cursor.step}
          reload={reload}
        />
      );
    if (shape === 'calendar')
      return (
        <CalendarView
          meta={meta}
          data={data}
          onOpen={openCard}
          selection={selection}
          cursor={cursor.id}
          cursorSpot={cursorSpot}
          onCursor={cursor.step}
          newIn={newIn}
          onNewHandled={clearNewIn}
          nudge={nudge}
          onNudged={clearNudge}
          // The page anchor lives in `cal`, outside the wire — so the search
          // string is a dependency here where the other shapes need only `wire`:
          // turning a page re-renders without refetching. Grid settings are
          // spec params and arrive in `data.spec` as saved view config.
          search={search}
          patch={patch}
          reload={reload}
        />
      );
    return (
      <BoardView
        meta={meta}
        data={data}
        onOpen={openCard}
        selection={selection}
        cursor={cursor.id}
        cursorSpot={cursorSpot}
        onCursor={cursor.step}
        newIn={newIn}
        onNewHandled={clearNewIn}
        nudge={nudge}
        onNudged={clearNudge}
        reload={reload}
      />
    );
  }, [data, meta, queryError, shape, setOpenNote, openCard, cursor.id, cursor.step, selection, reload, patch, wire, search, nudge, clearNudge]);

  if (gate || !vault) {
    return (
      <VaultPicker
        reason={gate?.reason}
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
  if (!meta || (meta.vault !== vault && meta.vaultName !== vault)) {
    return <div className="boot">starting…</div>;
  }

  return (
    <EnrichmentProvider>
     <TouchedProvider>
      {/* Every surface that *draws* a facet value reads its hue from here, so a
          chip on a card face, a table cell, a canvas node and the bulk bar
          cannot disagree about what colour an axis is. */}
      {/* Every shape gets the same pin indicator and the same App-owned toggle
          route, without each view learning how `?pins=` is stored. */}
      <PinnedProvider pins={pins} onToggle={togglePin}>
      <VocabularyProvider facets={meta.facets}>
      {/*
        `panel-is-open` no longer reserves a track — the panel covers the view and
        declares how far it reaches, so the cursor still cannot hide under it while
        the view keeps its width. `.shell` carries the whole argument, and why
        reserving the width was the wrong half of it.
      */}
      <div
        className={`shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''} ${
          openNote && !stackOpen ? 'panel-is-open' : ''
        } ${openNote && pins.length && !stackOpen ? 'pins-are-docked' : ''}`}
        // The dock's reach, for `--covered-right`: `SPINE_W` per pin, measured
        // nowhere because it is a token — the same argument `.panel` makes.
        // It matters only beside an open panel; compact views carry their pins
        // on the notes' record marks and give none of the view to duplicate UI.
        style={{ ['--pins-w' as string]: `${pins.length * SPINE_W}px` }}
      >
        <Sidebar
          meta={meta}
          data={data}
          search={search}
          wire={wire}
          onShowDeclined={() => setDeclined(true)}
          pins={pins.length}
          onShowPins={() => {
            // Pins are a reading set, not a computed property of the notes. The
            // spread is their honest "only these" surface: no saved query or CLI
            // invocation acquires session state it cannot reproduce.
            const landing = cursor.id && pins.includes(cursor.id) ? cursor.id : pins[pins.length - 1];
            if (!landing) return;
            cursor.step(landing);
            setStack(true);
          }}
          patch={patch}
          edit={edit}
          onSwitchVault={switchVault}
          onAddVault={() => setAddingVault(true)}
          onOpenNote={openCard}
          collapsed={sidebarCollapsed}
          covered={stackOpen}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
        />
        <main className="main" inert={stackOpen}>
          {/*
            What the keyboard did, when it is worth saying.

            It floats over the content rather than sitting above it, for the
            reason the bulk bar does: a banner that takes height mid-rail makes
            the whole board jump, and this appears and vanishes several times a
            minute once the digits are in use. Click to dismiss — the only
            control it needs, since every message it carries is already history
            by the time it is read.
          */}
          {notice && (
            <div
              className={`keynotice banner is-${notice.tone}`}
              onClick={() => setNotice(null)}
              // `aria-live` rather than `role="status"`, which says the same
              // thing: the C4 guard reads the client for any word a vault
              // declares as a facet, and the seeded vocabulary has one called
              // `status`. A coincidence, but avoiding it costs nothing and the
              // guard is worth more than the shorter attribute.
              aria-live="polite"
            >
              {notice.text}
            </div>
          )}
          {content}
        </main>
        {helpOpen && <Cheatsheet meta={meta} onClose={() => setHelpOpen(false)} />}
        {paletteOpen && (
          <Palette
            meta={meta}
            onClose={() => setPaletteOpen(false)}
            /* Straight into the same dispatcher a key reaches, so a command
               cannot behave one way from the keyboard and another from here. */
            onRun={(command) => keys.current && run(command, keys.current)}
          />
        )}
        {declinedOpen && (
          <DeclinedPanel
            onClose={() => setDeclined(false)}
            // The footer's count comes from `meta`, so bringing one back has to
            // reload it — otherwise the sidebar keeps claiming a number the open
            // panel is visibly contradicting.
            onRestored={loadMeta}
          />
        )}
        {openNote && pins.length > 0 && !stackOpen && (
          // Folded pins become navigation only while a note is open: title
          // spines at the panel's left edge, each opening that pinned note.
          <Suspense fallback={null}>
            <PinDock pins={pins} openNote={openNote} notes={data?.notes ?? {}} onOpen={openCard} />
          </Suspense>
        )}
        {stackOpen && (pins.length > 0 || openNote) && (
          <Suspense fallback={null}>
            <PinStack
              pins={pins}
              openNote={openNote}
              cursor={cursor.id}
              meta={meta}
              // One actionable pointer: focus is the cursor. `?note=` is a
              // separate trailing slot on this surface and moves only when the
              // reader explicitly opens something.
              onCursor={cursor.step}
              onOpen={followCard}
              onUnpin={(id) => {
                if (cursor.id === id && openNote !== id) {
                  cursor.step(afterRemovingPage(stackPages(pins, openNote), id));
                }
                setPins(pins.filter((p) => p !== id));
              }}
              onDelete={(id) => {
                const pages = stackPages(pins, openNote);
                const remaining = pins.filter((p) => p !== id);
                if (cursor.id === id) cursor.step(afterRemovingPage(pages, id));
                if (!remaining.length) setStackOpen(false);
                // One URL write: deleting an opened pin removes both its
                // membership and its trailing slot without either update racing
                // the other through a stale search string.
                const { search: s, location: loc, navigate: go } = nav.current;
                go(`${loc}${patchSearch(s, { ...pinsPatch(remaining), [NOTE_PARAM]: null })}`, {
                  replace: true,
                });
              }}
              onMakeOpen={(id) => {
                cursor.step(id);
                setOpenNote(id);
              }}
              // The same reshape the panel's derived rows make, so a bullseye
              // means one thing wherever it is drawn.
              onFocus={(id, via) => edit((spec) => setFocus(spec, { id, via, dir: 'in' }))}
              onUnsaved={(u) => {
                panelUnsaved.current = u;
              }}
            />
          </Suspense>
        )}
        {openNote && !stackOpen && (
          // A lazy chunk with no visible fallback: the panel slides in beside a
          // board that is already drawn, and an empty aside for one network
          // round-trip reads better than a flash of text inside it.
          <Suspense fallback={null}>
          <NotePanel
            // Not keyed here any more — `NotePanel` keys the frame on the note it
            // is *showing*, one level in, so the fetch outlives the reset and
            // walking `j` down a list turns the page instead of blinking.
            id={openNote}
            meta={meta}
            onClose={() => setOpenNote(null)}
            onOpen={followCard}
            /*
             * The same reshape `gotoInverse` performs, from the row rather than
             * from a keystroke — one `setFocus` call in both places, so the
             * button and `g⇧⟨key⟩` cannot come to mean different things.
             *
             * No notification here, and that is the difference between the two.
             * The keystroke announces itself because nothing on screen says a
             * key was pressed; a click on a bullseye in the row it reshapes has
             * already been seen. The rail's Focus row is the state either way,
             * with its ✕ to undo.
             */
            onFocus={(id, via) => edit((spec) => setFocus(spec, { id, via, dir: 'in' }))}
            onUnsaved={(u) => {
              panelUnsaved.current = u;
            }}
          />
          </Suspense>
        )}
      </div>
      </VocabularyProvider>
      </PinnedProvider>
     </TouchedProvider>
    </EnrichmentProvider>
  );
}

/**
 * What a keystroke acts on.
 *
 * Assembled during render and read from a ref, so the listener can register once
 * and still see the current payload — see `keys` above for why that matters.
 */
interface KeyState {
  grid: Grid;
  cursor: Cursor;
  /** Which copy the cursor is on, resolved — what a step is measured from. */
  cursorSpot: Spot | null;
  selection: Selection;
  openNote: string | null;
  setOpenNote: (id: string | null) => void;
  /** The pinned notes, in pin order, and whether they are spread. */
  pins: string[];
  setPins: (ids: string[]) => void;
  stackOpen: boolean;
  /** Fold or spread — and, folding, optionally land on a note. */
  setStack: (open: boolean, note?: string | null) => void;
  panelUnsaved: { current: { body: boolean; frontmatter: boolean } };
  /** The vocabulary, for the declared value a digit names and its cardinality. */
  facets: Meta['facets'];
  /** The drawn notes. */
  notes: QueryResponse['notes'];
  /**
   * What an axis held before a write, for a note that may no longer be drawn.
   *
   * The payload is not enough on its own: a write that moves a note out of the
   * view removes it from `notes`, and an undo computed from an empty value list
   * would *clear* the axis rather than put back what was there. So the last
   * values seen for every note are kept, and this asks the payload first and the
   * memory second.
   */
  valuesOf: (id: string, facet: string) => readonly string[];
  /** `key:` → facet name. The only place in the client a facet is named (C4). */
  facetKeys: Record<string, string>;
  groupedAxis: string | null;
  notify: (n: { tone: 'bad' | 'info'; text: string } | null) => void;
  notice: { tone: 'bad' | 'info'; text: string } | null;
  /** Ask the board to open its inline creator in one column. */
  newCardIn: (column: string) => void;
  /** Ask the board to move the cursor's card within its column's stored order. */
  nudgeCard: (delta: number) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Open or close the declined surface. See `setDeclined` for why it is a URL edit. */
  setDeclined: (open: boolean) => void;
  /** Go to a note and record it on the trail — what `H` comes back from. */
  follow: (id: string) => void;
  /** Edit the view itself, for the traversal `g⇧⟨key⟩` sets and the rail leader. */
  edit: Edit;
  /** The resolved view, for the rail rows that toggle rather than replace. */
  spec: ViewSpec | null;
  /** Saved views in rail order, which is what `⌥1`–`⌥9` count along. */
  views: { name: string }[];
  land: (view: string) => void;
  toggleRail: () => void;
  doStep: (step: Step) => void;
  applyStep: (writes: FacetWrite[], say: string) => Promise<boolean>;
  history: { current: History };
}

/**
 * What a write lands on: the selection if there is one, otherwise the cursor's
 * note.
 *
 * The same rule a drag already follows — "dragging a card that is not part of the
 * selection moves just that card" — so the pointer and the keyboard cannot
 * disagree about what a gesture applies to. The panel being open changes nothing,
 * because the panel *is* the cursor's note.
 */
function targets(s: KeyState): string[] {
  // A selection is narrowed to what is drawn, which is the bulk bar's rule: "3
  // selected" has to mean three you can see.
  const picked = [...s.selection.ids].filter((id) => s.notes[id]);
  if (picked.length) return picked;
  /**
   * The cursor is **not** narrowed, and that is the fix for a silent bug.
   *
   * It used to be, by analogy with the selection, and the analogy is wrong: a
   * selection is a set you built out of what was on screen, while the cursor is a
   * single note you are looking at — and it routinely sits on a note the query
   * does not return. Two ordinary things put it there. Writing a value the view
   * filters out (`home` keeps `planning, active`, so setting anything else drops
   * the note), and following a reference with `g` to a note outside the view.
   *
   * In both cases the panel stays open on the note, the reader keeps typing at
   * it, and every write after the first was discarded without a word.
   */
  return s.cursor.id ? [s.cursor.id] : [];
}

/** The vault's declared keyboard addresses, inverted for lookup. */
function facetKeysOf(meta: Meta | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(meta?.facets ?? {})) {
    if (def.key) out[def.key] = name;
  }
  return out;
}

/**
 * The chips in the note that lead somewhere, in the order they are drawn.
 *
 * A DOM query rather than a data lookup, and deliberately: these are *native
 * buttons and anchors already*, so walking them means moving real focus, and
 * `⏎` follows one without anything being bound to it. Building a parallel list
 * from the payload would mean a second cursor, a second highlight, and a second
 * chance for the two to disagree about what is on screen — the note's inbound
 * rows are capped at three with an `n more`, and the data has no idea.
 *
 * `data-nav` rather than the styling class, so a chip can be restyled without
 * silently leaving the keyboard behind.
 */
/**
 * Is this axis's other end observably empty?
 *
 * The panel draws a derived row whenever the axis names an `inverse:` *and*
 * something points along it. So with the panel open on this note the two are
 * jointly observable, and a declared inverse with no row drawn means the count is
 * zero — without asking the server a question it has already answered on screen.
 *
 * Every clause is load-bearing, which is why this is a function rather than a
 * condition written twice. No `inverse` means no row is ever drawn, so its absence
 * says nothing; no panel means there is no row to read; and either way the honest
 * move is to walk the relation rather than to claim it is empty.
 *
 * Shared by `gotoInverse` and `focusInverse` so the two cannot come to disagree
 * about what "nothing there" means — they already share the reshape.
 */
function emptyOtherEnd(
  s: { facets: Meta['facets']; openNote: string | null; stackOpen: boolean },
  id: string,
  facet: string,
): boolean {
  // In the spread the focused page is the rendered note, whether or not a
  // different page occupies the trailing open slot.
  if (!s.stackOpen && s.openNote !== id) return false;
  if (!s.facets[facet]?.inverse) return false;
  return rowChips(facet, true).length === 0;
}

/**
 * The one note the keyboard may enter.
 *
 * The panel and the spread have the same tiers. In the latter, the cursor is
 * the one writable page, so resolving the root from its focus class keeps a
 * region command on the page it highlights instead of folding the spread and
 * promoting that page into the unrelated `?note=` role.
 */
function noteRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.pinstack .pinpage.is-focus') ??
    document.querySelector<HTMLElement>('.panel')
  );
}

function navChips(within?: Element | null): HTMLElement[] {
  const root = within ?? noteRoot();
  return root ? [...root.querySelectorAll<HTMLElement>('[data-nav]')] : [];
}

/**
 * The chips of one axis row, and none when that row is not drawn.
 *
 * `navChips` widens an absent argument to the whole panel, which is right for its
 * other caller and wrong for every question of the form *does this axis have a
 * drawn list*: `navChips(axisRow(f, true))` on a note with no derived row returned
 * every `[data-nav]` in the panel, so `g⇧⟨key⟩` landed on the first link instead
 * of falling through to the traversal, and `focusInverse`'s empty-set guard could
 * not fire at all while the panel held a single link.
 *
 * `??` is what made it silent — an absent row and a row with no chips are the same
 * value, and only one of them means "no list here".
 */
function rowChips(facet: string, inverse: boolean): HTMLElement[] {
  const row = axisRow(facet, inverse);
  return row ? navChips(row) : [];
}

/**
 * A control the leader landed on, driven from the keyboard.
 *
 * A `<select>` cannot be opened programmatically — no browser allows it — so
 * "pick from this list" has to mean stepping its value rather than dropping it
 * down. React tracks a control's value behind the DOM's back, so the native
 * setter is used and a `change` is dispatched after it; assigning `.value`
 * directly is the version of this that appears to work and then silently stops
 * at the second press.
 */
function stepSelect(el: HTMLSelectElement, delta: number): void {
  const next = el.selectedIndex + (delta > 0 ? 1 : -1);
  if (next < 0 || next >= el.options.length) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(el, el.options[next]!.value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * The chip list an element belongs to, or `null`.
 *
 * A row of the panel's facet grid, or the links block — the two places a note
 * points somewhere else. Scoped to a *row* rather than to the whole panel, so
 * `j` walks the three children under `Children` and stops, instead of running on
 * into whatever axis happens to be drawn beneath it.
 */
function listOf(el: Element | null): Element | null {
  if (!el || !(el instanceof HTMLElement) || !el.dataset.nav) return null;
  return el.closest('[data-navlist]');
}

/** The row a `g⟨key⟩` addresses: one axis, forward or inverted. */
function axisRow(facet: string, inverse: boolean): Element | null {
  const rows = noteRoot()?.querySelectorAll(`[data-axis="${CSS.escape(facet)}"]`) ?? [];
  return [...rows].find((r) => r.hasAttribute('data-inverse') === inverse) ?? null;
}

/**
 * The commands whose controls exist only in the panel frame. `NoteTiers` is
 * mounted in the focused spread page too, so its region and axis commands stay
 * in the spread and use the focused page's real writer.
 */
const NEEDS_PANEL = new Set<Command['kind']>([
  'work', 'judge', 'remove', 'rename', 'toggleProject', 'enrich',
]);

/**
 * Doing what a keystroke meant.
 *
 * Deliberately the *only* impure half: `bind` decided what the key was and
 * `motion.ts` decided where it goes, both without a DOM, so what is left here is
 * the calls. A branch that grows a decision belongs back in one of those two.
 */
function run(command: Command, s: KeyState): void {
  /**
   * A command that needs the editing panel folds the spread first.
   *
   * One state transition and at most one URL write. `s` is re-shadowed so the
   * case below sees the panel as already open and does not write the landing
   * note a second time from a stale search string.
   */
  if (s.stackOpen && NEEDS_PANEL.has(command.kind)) {
    const on = s.cursor.id ?? s.openNote;
    s.setStack(false, on);
    s = { ...s, stackOpen: false, openNote: on };
  }

  const { grid, cursor, selection, openNote, setOpenNote } = s;

  /**
   * Move the cursor, and take the open panel with it.
   *
   * This is the whole of "flat and non-modal": there is one pointer, so a panel
   * that is open is showing wherever the cursor is, and `j` flips down the list
   * without anything having to be kept in step. `useLive` holds the outgoing
   * payload until the next one lands, so it reads as a page turn rather than a
   * blink.
   *
   * It moves in **placements** rather than ids, because a step has to say *which
   * copy* it reached: a note drawn twice would otherwise resolve back to its
   * first copy on the next render, so walking into the second one undid itself.
   */
  const goToSpot = (spot: Spot | null) => {
    const next = idAt(grid, spot);
    if (!next) return;
    cursor.step(next, spot);
    if (openNote) setOpenNote(next);
  };

  switch (command.kind) {
    case 'setShape':
      // `,s` intentionally parks on the selector so `j`/`k` can browse it.
      // Its completed forms — `,s t/b/c/g` — are answers, though: leaving the
      // select focused after one would make the next plain key mutate a control
      // the reader has already left.
      document.querySelector<HTMLSelectElement>('[data-rail="shape"]')?.blur();
      return s.edit((spec) => setShape(spec, command.shape));

    case 'move': {
      /**
       * The spread re-reads the motion keys the way a navlist does, and for the
       * same reason: what is in front of you is not the view. `h`/`l` walk the
       * pages while the trailing `?note=` stays put, and `j`/`k` scroll the
       * focused page. The cursor remains the one write target; the open slot is
       * context, not a second pointer.
       */
      if (s.stackOpen) {
        const pages = stackPages(s.pins, s.openNote);
        if (!pages.length) return;
        if (command.along === 'row') {
          const at = cursor.id ?? openNote ?? pages[0]!;
          document
            .querySelector(`.pinstack [data-page="${CSS.escape(at)}"] .pinpage-scroll`)
            ?.scrollBy({ top: command.delta * PAGE_SCROLL });
          return;
        }
        const at = pages.indexOf(cursor.id ?? openNote ?? '');
        const to = at === -1 ? 0 : Math.min(pages.length - 1, Math.max(0, at + command.delta));
        const next = pages[to]!;
        if (next !== cursor.id) cursor.step(next);
        return;
      }
      // Brackets name the third visible dimension. On a board or canvas that is
      // a lane; on a calendar it is the next or previous page of time.
      if (command.along === 'lane' && s.spec?.shape === 'calendar') {
        return run({ kind: 'calendarPage', page: command.delta < 0 ? 'previous' : 'next' }, s);
      }
      /**
       * `j` means "the next one" — of whatever you are currently in.
       *
       * Deciding that here rather than in `bind` is the one place a DOM fact
       * genuinely belongs in the impure half: the question is "where is focus",
       * which no pure function can answer. `bind` still says only "down".
       */
      const at = document.activeElement;
      const list = listOf(at);
      if (list) {
        /**
         * Which key walks a list, and which steps to the next one, follows how the
         * list is *drawn*.
         *
         * A facet's values are chips laid across the row, and the axes stack down
         * the panel — so `h`/`l` walk the values and `j`/`k` change axis. A link
         * list and an inbound list are full-width rows stacked downward, so there
         * `j`/`k` walk and `h`/`l` step between lists. One rule, read off the
         * layout, rather than a convention the reader has to hold per surface.
         *
         * It is also what the board already says with the same two keys: `j` goes
         * down what is stacked and `l` goes across what is laid out.
         */
        const flow = (list as HTMLElement).dataset.navFlow ?? 'column';
        const walks = flow === 'row' ? 'column' : 'row';
        if (command.along === walks) return run({ kind: 'listMove', delta: command.delta }, s);
        /**
         * The next list that has something to land on.
         *
         * Skipping rather than stopping: a row can draw nothing walkable — an axis
         * with no declared values and no new-value field, or one whose only
         * control is a field the walk deliberately leaves out — and halting in
         * front of it reads as the keyboard breaking rather than as an empty row.
         * The board does the same thing with an empty column.
         */
        const lists = [...(noteRoot()?.querySelectorAll<HTMLElement>('[data-navlist]') ?? [])];
        const step = command.delta > 0 ? 1 : -1;
        for (let i = lists.indexOf(list as HTMLElement) + step; i >= 0 && i < lists.length; i += step) {
          const landing = lists[i]!.querySelector<HTMLElement>('[data-nav]');
          if (landing) return landing.focus();
        }
        return;
      }
      // A rail select is a list too, just one the browser insists on drawing.
      if (command.along === 'row' && at instanceof HTMLSelectElement && at.dataset.rail) {
        return stepSelect(at, command.delta);
      }
      return goToSpot(steppedTo(grid, s.cursorSpot, command.along, command.delta));
    }

    /**
     * A step within a list, which is not always a step onto something.
     *
     * The panel caps a link list and an inbound list at three and the filter rail
     * caps a facet at eight, so "the next one" is routinely behind an `n more` —
     * and a walk that treated that button as scenery either stopped dead (the
     * links, where the remainder is at the end) or *skipped the rest of the axis*
     * (the rail, where the remainder sits between the eighth value and the next
     * heading). Both were the walk obeying a rendering decision.
     *
     * So a remainder is a step like any other, and taking it opens the list and
     * carries on into what appears. Forward only: a list growing underneath you
     * on the way back up is not the same gesture, so going the other way steps
     * over it to the previous real item.
     */
    case 'listMove': {
      const list = listOf(document.activeElement);
      if (!list) return;
      const current = document.activeElement as HTMLElement;
      const steps = [...list.querySelectorAll<HTMLElement>('[data-nav], [data-nav-more]')];
      const at = steps.indexOf(current);
      if (at === -1) return;

      if (command.delta < 0) {
        for (let i = at - 1; i >= 0; i--) {
          if (steps[i]!.dataset.navMore === undefined) return steps[i]!.focus();
        }
        // The top. It stops rather than wrapping: a list that cycles forever
        // gives no signal you have seen all of it.
        return;
      }

      const next = steps[at + 1];
      if (!next) return;
      if (next.dataset.navMore === undefined) return next.focus();

      /**
       * Open it, then land on the first of the items that were hidden.
       *
       * The `grown` test is load-bearing and was missing: `focusSoon` tries
       * immediately, and immediately is *before* React has re-rendered — so "the
       * item after the one I am on" still resolves to whatever followed the
       * truncated list. At the end of a link list that is nothing, and the retry
       * did the right thing by accident. Mid-rail it is the next axis's heading,
       * which is a perfectly real element, so it focused that and never retried:
       * the list expanded and the cursor jumped straight over the eight values it
       * had just revealed.
       */
      const before = list.querySelectorAll('[data-nav]').length;
      next.click();
      focusSoon(() => {
        const items = [...list.querySelectorAll<HTMLElement>('[data-nav]')];
        if (items.length <= before) return null;
        const i = items.indexOf(current);
        return i >= 0 ? items[i + 1] : null;
      });
      return;
    }

    /**
     * Follow one axis out of this note.
     *
     * The single-value case is the common one and is answered from the payload,
     * so it works with the panel shut: one note, go there. It is a `jump`, which
     * is what puts it on the trail and makes `H` mean something at last.
     *
     * Several values is where the chips earn their place — there is a choice to
     * make and the panel is already drawing it, so focus lands on the first and
     * `j`/`k` walk the rest.
     */
    case 'gotoRef': {
      const def = s.facets[command.facet];
      /**
       * The open panel is asked first, because it is the only thing here that
       * actually knows.
       *
       * It draws from the note's own detail; the query payload is a different
       * question and routinely does not contain this note at all — you have just
       * written it out of the view, or followed a reference into one. Reading the
       * payload alone is what made `g r` report "nothing on Project" while the
       * project sat on screen three rows below the cursor.
       *
       * Clicking the chip rather than extracting an id from it: the chip already
       * knows which note it is and already goes there through the trail.
       */
      const chips = rowChips(command.facet, false);
      if (chips.length === 1) return chips[0]!.click();
      if (chips.length > 1) return chips[0]!.focus();

      // No panel — so no chips to read. What the query knows, and failing that
      // what it knew when it last drew this note.
      const id = cursor.id;
      const held = id ? s.valuesOf(id, command.facet) : [];
      if (!held.length) {
        return s.notify({ tone: 'info', text: `nothing on ${def?.label ?? command.facet}` });
      }
      if (held.length === 1) return s.follow(held[0]!);
      // Several, and nothing drawn to choose between them. Opening the note is
      // the honest half-step: the choice is on screen and one more `g` makes it.
      if (id) s.setOpenNote(id);
      return s.notify({ tone: 'info', text: `${def?.label ?? command.facet} names ${held.length}` });
    }

    /**
     * The other end of the axis.
     *
     * A **view focus** rather than a jump, because the counts are different in
     * kind: forward is one container, backward is a project's twenty children. The
     * traversal already exists and answers it exactly — `focus` walks a reference
     * facet — so this reshapes the query, `j`/`k` walk the result as ordinary
     * cards, and the rail's Focus row shows what happened with a ✕ to undo it.
     *
     * The alternative was a chip list, and it is worse twice: the panel caps an
     * inbound list at three, and a list you page through cannot be filtered,
     * sorted or grouped.
     */
    case 'gotoInverse': {
      const id = cursor.id;
      if (!id) return;
      const def = s.facets[command.facet];
      /**
       * The panel draws this axis's other end, so walk it.
       *
       * Reshaping the view is the right answer for a project with twenty children
       * and the wrong one when the three you want are already on screen under
       * `Children` — and the panel only draws the row when there is something in
       * it, which is the same question the traversal would be asked. So the row
       * wins when it exists, and the traversal is what happens when there is no
       * panel to read.
       */
      const chips = rowChips(command.facet, true);
      if (chips.length) return chips[0]!.focus();
      /*
       * Nothing to walk to, said without walking anywhere.
       *
       * The panel draws a derived row whenever the axis names an inverse *and*
       * something points along it, so with the panel open on this note those two
       * conditions are jointly observable: a declared `inverse` and no row means
       * the count is zero. Focusing on that reshaped the whole view to show one
       * note and `no notes match`, which is a worse answer than a sentence.
       *
       * Both halves of the guard are load-bearing. Without `inverse` no row is
       * ever drawn, so its absence says nothing and the traversal is the only way
       * to see the other end — that is the case this fallback was written for.
       * And without the panel there is no row to read, so nothing has been
       * observed and the traversal is again the honest move.
       */
      if (emptyOtherEnd(s, id, command.facet)) {
        return s.notify({ tone: 'info', text: `nothing names this note on ${def!.inverse}` });
      }
      s.edit((spec) => setFocus(spec, { id, via: command.facet, dir: 'in' }));
      return s.notify({
        tone: 'info',
        text: `showing what names this note on ${def?.label ?? command.facet}`,
      });
    }

    /**
     * The same reshape, unconditionally — bare `⇧⟨axis key⟩`.
     *
     * `gotoInverse` prefers the drawn row, which is why this exists: the row is
     * capped at three, so the lists worth turning into a query were exactly the
     * ones its preference kept the keyboard away from. One keystroke, and the same
     * `setFocus` call the row's bullseye makes — three routes to this act now, and
     * one line of code performing it.
     *
     * It keeps the empty-set guard rather than dropping it for being terse. A
     * shortcut that reshapes the view to show one note and `no notes match` is not
     * faster than one that says nothing is there; it is the same wrong answer
     * sooner.
     */
    case 'focusInverse': {
      const id = cursor.id;
      if (!id) return;
      const def = s.facets[command.facet];
      if (emptyOtherEnd(s, id, command.facet)) {
        return s.notify({ tone: 'info', text: `nothing names this note on ${def!.inverse}` });
      }
      s.edit((spec) => setFocus(spec, { id, via: command.facet, dir: 'in' }));
      return s.notify({
        tone: 'info',
        text: `showing what names this note on ${def?.label ?? command.facet}`,
      });
    }

    /**
     * The rail, in two keystrokes.
     *
     * Two kinds of row, and the difference is whether there is anything to choose.
     * `clear` and `collapse` are *acts* — there is one thing they do, so the
     * leader does it rather than parking focus on a button you then have to press.
     * The rest are choices, so the leader focuses the control and the vault's own
     * `key:` lets you skip even that: `,g` then an axis key groups by it outright,
     * with focusing the select as the fallback for an axis that declares no
     * letter.
     */
    case 'rail': {
      const { control, facet } = command;
      if (control === 'clear') return s.edit(clearFilters);
      /**
       * The direction alone, without touching what is sorted by.
       *
       * `,o` then the same axis twice also flips it, but only while you are
       * choosing an axis — this is the arrow beside the select, which is a
       * separate control because "sort by this" and "the other way round" are
       * separate questions.
       */
      if (control === 'sortDir') {
        const [by = '', dir = 'asc'] = (s.spec?.query.sort?.[0] ?? '').split(':');
        if (!by) return s.notify({ tone: 'info', text: 'nothing is sorted' });
        return s.edit((spec) => setSort(spec, by, dir === 'asc' ? 'desc' : 'asc'));
      }
      if (control === 'collapse') return s.toggleRail();
      /**
       * Write the overrides into the view they override.
       *
       * Aimed at the ✓ rather than reimplemented, for the reason `work` and
       * `judge` are: the button knows whether there is anything to write — it is
       * drawn only when there is — so the key inherits that rather than
       * re-deriving it and being able to disagree.
       */
      if (control === 'save') {
        const button = document.querySelector<HTMLButtonElement>('[data-rail="save"]');
        if (!button) {
          return s.notify({ tone: 'info', text: 'this view has no unsaved changes' });
        }
        button.click();
        return;
      }
      /**
       * The filter rail has no single control to focus — it *is* the list — so
       * the leader steps into it rather than onto it. An axis you have already
       * opened is where you want to be, so focus lands on the first *value* if
       * there is one and on the first axis head otherwise.
       */
      if (control === 'filter') {
        const rail = document.querySelector('[data-navlist="filter"]');
        const items = navChips(rail);
        const target = items.find((i) => i.dataset.nav === 'value') ?? items[0];
        target?.focus();
        return;
      }
      if (facet) {
        if (control === 'group') return s.edit((spec) => setGroupBy(spec, 0, facet));
        if (control === 'thenBy') return s.edit((spec) => setGroupBy(spec, 1, facet));
        if (control === 'sort') {
          // Same axis again flips the direction, which is what the ↕ button beside
          // the select does — a second `,o p` should not be a no-op.
          const [key = '', dir = 'asc'] = (s.spec?.query.sort?.[0] ?? '').split(':');
          return s.edit((spec) =>
            setSort(spec, facet, key === facet && dir === 'asc' ? 'desc' : 'asc'),
          );
        }
        if (control === 'show') {
          const shown = s.spec?.show ?? [];
          return s.edit((spec) =>
            setShow(spec, shown.includes(facet) ? shown.filter((f) => f !== facet) : [...shown, facet]),
          );
        }
      }
      const el = document.querySelector<HTMLElement>(`[data-rail="${control}"]`);
      if (!el) return;
      el.focus();
      /**
       * A popover opens, rather than waiting to be pressed.
       *
       * The leader's whole job is to get you to the choice, and a focused button
       * you then have to press Space on is the step it was supposed to remove —
       * which is exactly what a select does *not* need, since its list is already
       * the thing under the cursor. So the two controls diverge here and agree
       * everywhere after: `j`/`k` walk whichever list is now in front of you.
       *
       * Clicking rather than reaching for the state: `PopoverButton` owns its own
       * `open`, and prising that out to be driven from here would mean a ref for
       * every popover in the app to save one synthetic event.
       */
      /**
       * `aria-expanded` is the test, and it does two jobs.
       *
       * It tells a popover button from a plain one — `,w` lands on a pill that
       * opens a note when a focus is already set, and clicking that would go
       * somewhere rather than offer a choice. And it makes the leader
       * *idempotent*: pressing `,v` twice should not close the list it just
       * opened, which is what a bare `click()` did.
       */
      if (!el.hasAttribute('aria-expanded')) return;
      if (el.getAttribute('aria-expanded') === 'false') el.click();
      // Focusing happens whether or not the click did, so the leader means "get
      // me into this list" rather than "toggle this list".
      focusSoon(() => document.querySelector<HTMLElement>('.popover [data-nav]'));
      return;
    }

    /**
     * The nth saved view.
     *
     * Counted along the rail's own order, which is the order the popover lists
     * them in — so the number is something you can read off the screen rather
     * than memorise. A `key:` in the view file is the follow-up that would make
     * it stable as views are added; until then the popover is the reference.
     */
    case 'view': {
      const view = s.views[command.ordinal - 1];
      if (!view) return s.notify({ tone: 'info', text: `no ${command.ordinal}th saved view` });
      return s.land(view.name);
    }

    /**
     * A region of the open note.
     *
     * Everything here needs a rendered note. A shut panel opens for it; a spread
     * already has its one writable, focused page on screen, so it stays put.
     * `focusSoon` covers the panel's load gap.
     */
    case 'gotoRegion': {
      if (!s.stackOpen && !openNote && cursor.id) s.setOpenNote(cursor.id);

      if (command.region === 'links' || command.region === 'facets') {
        const within = command.region === 'links' ? '[data-navlist="links"]' : '.panel-tier .facetgrid';
        return focusSoon(() => noteRoot()?.querySelector<HTMLElement>(`${within} [data-nav]`) ?? null, 8);
      }

      /**
       * The facets door, opened and stepped into.
       *
       * The same two moves the rail leader makes on a popover, for the same
       * reason: reaching a list of choices and then having to press one more key
       * to be *in* it is the step the shortcut was supposed to remove.
       */
      if (command.region === 'addFacet') {
        return focusSoon(() => {
          const door = noteRoot()?.querySelector<HTMLElement>('[data-nav="add"]');
          if (!door) return null;
          if (door.getAttribute('aria-expanded') === 'false') {
            door.click();
            return null;
          }
          return document.querySelector<HTMLElement>('.popover [data-nav]');
        }, 10);
      }

      /**
       * The two document regions open their editor first.
       *
       * "Go to the body" can only mean *edit* it: reading needs no cursor, and the
       * body is a rendered block until the toggle is pressed. The toggle is a
       * real button already, so this presses it rather than reaching into the
       * block's state — and it presses it only when it is off, so a second `gc`
       * puts the cursor back in the editor instead of closing it and asking
       * whether you meant to discard.
       */
      const section = `[data-section="${command.region}"]`;
      return focusSoon(() => {
        const host = noteRoot()?.querySelector<HTMLElement>(section);
        if (!host) return null;
        const toggle = host.querySelector<HTMLElement>('.section-do button');
        if (toggle?.getAttribute('aria-pressed') === 'false') {
          toggle.click();
          return null;
        }
        return host.querySelector<HTMLElement>('.cm-content');
      }, 10);
    }

    /**
     * Start work on the note under the cursor.
     *
     * Presses the panel's own button rather than calling the endpoint, and that is
     * the decision rather than a shortcut: the button owns the plan-confirm-launch
     * sequence and the banner that reports it, so a keystroke that called the API
     * itself would be a second path to the same act — one that could skip the
     * confirm, and one more place to keep the wording of a refusal.
     *
     * The panel is opened when it is shut, on `gotoRegion`'s reasoning: everything
     * this can say afterwards is said in the panel's head, so a launch reported to
     * a surface that is not on screen is a launch reported nowhere. `focusSoon`
     * covers the load.
     *
     * `orElse` matters here more than anywhere else it is used. Every other search
     * in this file fails when a row is absent; this one fails when the *cursor* is
     * — press `!` on an empty board and there is nothing to work on, which has to
     * say so rather than look broken.
     */
    /**
     * Judge a candidate — one verb, and the card decides which act it is.
     *
     * Aims at a button rather than doing the work here, exactly as `work` does
     * and for the same reason: one path from the gesture to the act, so a
     * confirm cannot be skipped by arriving from the keyboard. Which button is
     * the whole of the decision, and the panel has already made it — it draws
     * `fold` on a candidate carrying `extends` and `accept` on one that does
     * not, so reading the DOM is reading the card's own state rather than
     * re-deriving it from a copy of the note that may be a render old.
     */
    case 'judge': {
      const on = openNote ?? cursor.id;
      if (!on) return s.notify({ tone: 'info', text: 'no note under the cursor' });
      if (!openNote) setOpenNote(on);
      return focusSoon(
        () => {
          const button =
            document.querySelector<HTMLButtonElement>('.panel [data-act="fold"]') ??
            document.querySelector<HTMLButtonElement>('.panel [data-act="accept"]');
          if (!button) {
            s.notify({ tone: 'info', text: 'this note is not waiting to be judged' });
            // Returned so `focusSoon` stops: the absence is the answer, not a
            // panel that has not opened yet.
            return null;
          }
          button.click();
          // And returned on the way out for the same reason `remove` does it: a
          // `find` that answers with nothing is retried, and the fold dialog this
          // opens would be opened again 16ms later.
          return button;
        },
        10,
        () => s.notify({ tone: 'info', text: 'the note did not open, so nothing was judged' }),
      );
    }

    /**
     * Delete, through the confirm belonging to whichever control means it.
     *
     * The one command that destroys something, so it is the one that most needs
     * the aim-at-the-button rule: the confirm names what goes and says the files
     * are in git, and a keyboard path that wrote directly would be a second way
     * to delete with no second confirm to match.
     *
     * **Which button is a DOM question, not a derived one.** The bulk bar is
     * drawn exactly when there is a selection to act on, and it is drawn from the
     * *narrowed* selection — the ids it will actually send — so asking whether it
     * is on screen asks the thing that knows. Deriving the set here would put one
     * count in the confirm and another in the request, and on the canvas it
     * cannot be derived at all: `gridOf` is empty there.
     *
     * This is the same rule `targets` states for every other write — the
     * selection if there is one, otherwise the cursor's note — and it is the half
     * of it that `⌫` was missing. It went to the panel unconditionally, so eleven
     * selected notes and one keystroke deleted the one under the cursor and left
     * ten selected.
     */
    case 'remove': {
      const bulk = document.querySelector<HTMLButtonElement>('.bulkbar [data-act="delete"]');
      if (bulk) return bulk.click();

      const on = openNote ?? cursor.id;
      if (!on) return s.notify({ tone: 'info', text: 'no note under the cursor' });
      if (!openNote) setOpenNote(on);
      return focusSoon(
        () => {
          const button = document.querySelector<HTMLButtonElement>('.panel [data-act="delete"]');
          if (!button) return null;
          button.click();
          /**
           * Returned so `focusSoon` **stops**, which is the whole of a second bug.
           * It retries whenever `find` answers with nothing, and `confirm()` blocks
           * the timer rather than cancelling it — so the retry fired 16ms after the
           * dialog was answered, found the same button still mounted, and clicked
           * it again. One keystroke, two dialogs; cancelling the first asked
           * another ten times.
           */
          return button;
        },
        10,
        () => s.notify({ tone: 'info', text: 'the note did not open, so nothing was deleted' }),
      );
    }

    case 'declined':
      /*
       * Opened, and that is all this does.
       *
       * The landing used to be here — `,d` opened the surface and then aimed focus
       * at its first row — which quietly made the keyboard a property of the key
       * you arrived by: opened from the footer's count instead, the pile had no
       * keyboard at all. `DeclinedPanel` claims focus on arrival for every entry
       * path, so the dispatcher no longer has an opinion about where it goes.
       */
      return s.setDeclined(true);

    /**
     * The four acts the palette exists for.
     *
     * One shape, because they are one kind of thing: a control the panel or the
     * rail already draws, with no key of its own. Aimed rather than
     * reimplemented, so the button stays the only thing that decides whether the
     * act applies — and so a confirm, where there is one, cannot be skipped.
     */
    case 'rename':
    case 'toggleProject':
    case 'enrich':
    case 'switchVault': {
      if (command.kind === 'switchVault') {
        const row = document.querySelector<HTMLButtonElement>('[data-rail="vault"]');
        if (!row) return s.notify({ tone: 'info', text: 'no vault picker here' });
        return row.click();
      }
      const act = { rename: 'rename', toggleProject: 'project', enrich: 'enrich' }[command.kind];
      const on = openNote ?? cursor.id;
      if (!on) return s.notify({ tone: 'info', text: 'no note under the cursor' });
      if (!openNote) setOpenNote(on);
      return focusSoon(
        () => {
          const button = document.querySelector<HTMLElement>(`.panel [data-act="${act}"]`);
          if (!button) {
            s.notify({ tone: 'info', text: `this note has no ${act} control` });
            return null;
          }
          button.click();
          return button;
        },
        10,
        () => s.notify({ tone: 'info', text: 'the note did not open' }),
      );
    }

    /**
     * Step into a floating bar.
     *
     * Both are drawn only when they apply — the bulk bar with a selection, the
     * toolbar on a canvas — so an absent list is the answer rather than a
     * failure, and saying which is missing is more use than saying nothing
     * happened.
     */
    case 'reachList': {
      const list = document.querySelector(`[data-navlist="${command.list}"]`);
      const first = list?.querySelector<HTMLElement>('[data-nav]');
      if (!first) {
        return s.notify({
          tone: 'info',
          text:
            command.list === 'bulk'
              ? 'the bulk bar appears once cards are selected — x picks one'
              : 'the toolbar is a graph',
        });
      }
      return first.focus();
    }

    case 'work': {
      const on = openNote ?? cursor.id;
      if (!on) return s.notify({ tone: 'info', text: 'no note under the cursor' });
      if (!openNote) setOpenNote(on);
      return focusSoon(
        () => {
          const button = document.querySelector<HTMLButtonElement>('.panel [data-act="work"]');
          if (!button) return null;
          button.click();
          // Returned so `focusSoon` **stops**, which is the load-bearing part: it
          // retries while the search comes back empty, and a retry here would be a
          // second launch. The `focus()` it then does is incidental and does not
          // stick — the control goes `disabled` while the plan is in flight, and a
          // disabled element cannot hold focus. That is also a third guard against
          // a double launch, after the hook's own and the confirm: `.click()` on a
          // disabled button does nothing, so a second `!` mid-flight is inert.
          return button;
        },
        10,
        () => s.notify({ tone: 'info', text: 'the note did not open, so nothing was started' }),
      );
    }

    case 'moveTo': {
      // `gg`/`G` on the spread are its ends, for the reason `move` gives — and
      // they stay steps there: the pages are all on screen, so an end of the
      // spread is somewhere you can see, not somewhere you jumped to.
      if (s.stackOpen) {
        const pages = stackPages(s.pins, s.openNote);
        const next = command.end === 'first' ? pages[0] : pages[pages.length - 1];
        if (next && next !== cursor.id) cursor.step(next);
        return;
      }
      /**
       * Off the spread they record, which is vim's own line: `gg` and `G` set the
       * jumplist mark and `j`/`k` do not, because an end of a list is exactly the
       * place you go without meaning to stay.
       */
      const spot = command.end === 'first' ? firstSpot(grid) : lastSpot(grid);
      const next = idAt(grid, spot);
      if (!next) return;
      cursor.jump(next, spot);
      if (openNote) setOpenNote(next);
      return;
    }

    case 'trail': {
      // `travel` reports where it landed rather than whether it moved, because
      // the panel has to be told and `cursor.id` is a render behind.
      const next = cursor.travel(command.delta);
      if (next && openNote) setOpenNote(next);
      return;
    }

    case 'take':
    case 'open': {
      /**
       * Inside a chip list, `⏎` follows the chip.
       *
       * It has to be said explicitly because the stroke was already claimed and
       * `preventDefault`ed by the time we get here — so the browser's own "Enter
       * activates a button" never runs. `.click()` on an anchor follows its href,
       * which is what a link chip wants.
       */
      const focused = document.activeElement as HTMLElement | null;
      if (listOf(focused)) {
        focused!.click();
        // A nav item that opens a panel is a step *into* it, not a destination —
        // the same rule the rail leader follows, and the reason `aria-expanded`
        // is the test there too.
        if (focused!.hasAttribute('aria-expanded')) {
          focusSoon(() => document.querySelector<HTMLElement>('.popover [data-nav]'));
        }
        return;
      }
      // The spread distinguishes its two verbs. `o` promotes the focused page
      // into the trailing open slot and stays here; Enter takes the focused page
      // into the ordinary panel. Outside the spread both still open a note.
      if (s.stackOpen) {
        const on = cursor.id ?? openNote;
        if (!on) return;
        if (command.kind === 'open') setOpenNote(on);
        else s.setStack(false, on);
        return;
      }
      const spot = s.cursorSpot ?? firstSpot(grid);
      const id = cursor.id ?? idAt(grid, spot);
      if (!id) return;
      cursor.step(id, spot);
      setOpenNote(id);
      return;
    }

    /**
     * Escape, until the chain lands.
     *
     * `NotePanel` keeps its own listener because closing runs an unsaved-changes
     * prompt, so this stands aside while the panel is open — which is exactly
     * what the effect this replaced did, for the same stated reason: one
     * keystroke should mean one thing.
     */
    case 'escape':
      // The first link of the chain that stage 7 finishes: the sheet is the
      // topmost thing on screen, so it is the first thing Escape takes off it.
      if (s.helpOpen) return s.setHelpOpen(false);
      // Then the palette, which sits at the same depth and is opened the same way.
      if (s.paletteOpen) return s.setPaletteOpen(false);
      /**
       * Then whatever control focus is *in*, as distinct from what is on screen.
       *
       * A chip list and a rail control are the same case: the reader stepped into
       * something, and Escape steps out. The rail half was missing, and it was the
       * worse of the two — after `,s` the shape select kept focus, so `j` and `k`
       * went on changing the shape and there was no way back to the cards at all
       * short of clicking one.
       */
      const inControl = listOf(document.activeElement) ||
        (document.activeElement as HTMLElement | null)?.closest?.('[data-rail]');
      if (inControl) {
        const card = cursor.id
          ? document.querySelector<HTMLElement>(`[data-card="${CSS.escape(cursor.id)}"]`)
          : null;
        if (card) card.focus();
        else (document.activeElement as HTMLElement).blur();
        return;
      }
      if (s.notice) return s.notify(null);
      /**
       * Then the panel, with the prompt that used to live inside it.
       *
       * Ordered above the selection because it is what is in front of you: a
       * note open over a board of twelve selected cards should close before the
       * twelve are let go, and one keystroke should undo one thing.
       */
      if (openNote) {
        const u = s.panelUnsaved.current;
        if ((u.body || u.frontmatter) && !confirm(`${whatIsUnsaved(u)} unsaved changes. Close anyway?`)) {
          return;
        }
        // With no pins, the open slot is the spread's final page. Closing that
        // page must also uncover the view; an empty spread must not leave the
        // board and rail inert with nothing painted over them.
        if (s.stackOpen && !s.pins.length) return s.setStack(false, null);
        return setOpenNote(null);
      }
      /**
       * Then the spread — deliberately *after* the note, so Escape keeps its
       * one unconditional meaning: close the open note. Folding never touches
       * the pins themselves; only `'` and a page's ✕ unpin, so no chain of
       * Escapes can cost you the set you built.
       */
      if (s.stackOpen) return s.setStack(false);
      if (selection.ids.size) selection.clear();
      return;

    case 'help':
      return s.setHelpOpen(!s.helpOpen);

    /**
     * Every act by name, for the four that have no key.
     *
     * A toggle like `?` beside it, and for the same reason: the key that opens it
     * is the key that shuts it, so there is no state to get stuck in.
     */
    case 'palette':
      return s.setPaletteOpen(!s.paletteOpen);

    case 'clearSelection':
      if (!selection.ids.size) return s.notify({ tone: 'info', text: 'nothing is selected' });
      selection.clear();
      return;

    case 'calendarPage': {
      const button = document.querySelector<HTMLButtonElement>(`[data-act="calendar.${command.page}"]`);
      if (!button) return s.notify({ tone: 'info', text: 'calendar paging is available in a calendar' });
      button.click();
      return;
    }

    case 'canvasAction': {
      const target = command.action === 'newNote' ? 'canvas.note' : 'canvas.save';
      const button = document.querySelector<HTMLButtonElement>(`[data-act="${target}"]`);
      if (!button) {
        return s.notify({
          tone: 'info',
          text: command.action === 'newNote' ? 'new graph notes are available on a graph' : 'there is no graph layout to save',
        });
      }
      button.click();
      return;
    }

    case 'saveAsView':
    case 'blankView': {
      const view = document.querySelector<HTMLElement>('[data-rail="view"]');
      if (!view) return s.notify({ tone: 'info', text: 'saved views are unavailable here' });
      if (view.getAttribute('aria-expanded') === 'false') view.click();
      const act = command.kind === 'saveAsView' ? 'view.save-as' : 'view.blank';
      return focusSoon(() => {
        const button = document.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
        if (!button) return null;
        button.click();
        return button;
      });
    }

    case 'revertView': {
      const button = document.querySelector<HTMLButtonElement>('[data-act="view.revert"]');
      if (!button) return s.notify({ tone: 'info', text: 'this view has no changes to revert' });
      button.click();
      return;
    }

    /**
     * The rail, reached by attribute.
     *
     * A `querySelector` from the dispatcher rather than a ref threaded through
     * `Sidebar` into `SearchBox`: the dispatcher is already this file's impure
     * half, and the alternative is three props for one keystroke. It is also the
     * shape the rail leader wants — eight more controls, eight more attributes,
     * and no new mechanism.
     */
    case 'search': {
      const field = document.querySelector<HTMLElement>('[data-rail="search"]');
      field?.focus();
      return;
    }

    case 'select': {
      const rows = drawn(grid);
      if (command.how === 'all') return selection.replace(new Set(rows));
      const id = cursor.id;
      if (!id) return;
      if (command.how === 'toggle') return selection.toggle(id, true, rows.indexOf(id));
      /**
       * Extending moves the cursor and takes the row with it, which is what makes
       * `x J J J` read as one gesture. The anchor is whatever `x` last set, so a
       * run grows from where you started rather than from where you are.
       */
      const spot = steppedTo(grid, s.cursorSpot, 'row', command.delta);
      const next = idAt(grid, spot);
      if (!next) return;
      selection.extend(rows, rows.indexOf(next));
      return goToSpot(spot);
    }

    /**
     * Pin the cursor's note, or unpin it. No panel required — the same reach
     * `s ⟨digit⟩` already has — and the notice is what says it landed, since a
     * spine appearing at the right edge is easy to miss mid-scan.
     */
    case 'pin': {
      const id = cursor.id ?? openNote;
      if (!id) return s.notify({ tone: 'info', text: 'no note under the cursor' });
      const held = s.pins.includes(id);
      s.setPins(held ? s.pins.filter((p) => p !== id) : [...s.pins, id]);
      const title = s.notes[id]?.title ?? 'this note';
      return s.notify({
        tone: 'info',
        text: held ? `unpinned ${title}` : `pinned ${title} — " spreads the pins`,
      });
    }

    /**
     * The previous / next pinned note, opened — the folded dock's one keyboard
     * address, and the reason it exists: a spine could be clicked and nothing
     * reached one without a mouse.
     *
     * It does exactly what a spine click does (`openCard`), because it is the
     * same act. In the spread it is `h`/`l`: the pages there *are* the pins,
     * already walked by the motion keys, and a second walker over one row would
     * be two names for one motion rather than a second way in.
     */
    case 'pinStep': {
      if (s.stackOpen) return run({ kind: 'move', along: 'column', delta: command.delta }, s);
      if (!s.pins.length) {
        return s.notify({ tone: 'info', text: "nothing is pinned — ' pins the note under the cursor" });
      }
      const at = s.pins.indexOf(openNote ?? '');
      // Off the ring — no panel open, or reading something unpinned — so a step
      // enters from the end it came from rather than resuming where it left off.
      const to =
        at === -1
          ? command.delta > 0
            ? 0
            : s.pins.length - 1
          : (at + command.delta + s.pins.length) % s.pins.length;
      const next = s.pins[to]!;
      // A jump, like the spine click it mirrors: the folded dock shows one note,
      // so stepping the ring moves you somewhere you could not see.
      cursor.jump(next);
      setOpenNote(next);
      return;
    }

    /**
     * Spread the pins, or fold them. Spreading unmounts the panel — the spread
     * is read-only (C10) — so unsaved text gets the same question Escape asks
     * before the surface holding it goes.
     */
    case 'stack': {
      if (s.stackOpen) return s.setStack(false);
      if (!s.pins.length && !openNote) {
        return s.notify({ tone: 'info', text: "nothing is pinned — ' pins the note under the cursor" });
      }
      const u = s.panelUnsaved.current;
      if ((u.body || u.frontmatter) && !confirm(`${whatIsUnsaved(u)} unsaved changes. Spread anyway?`)) {
        return;
      }
      const landing = openNote ?? (cursor.id && s.pins.includes(cursor.id) ? cursor.id : s.pins[s.pins.length - 1]);
      if (landing) cursor.step(landing);
      return s.setStack(true);
    }

    /**
     * The nth declared value of an axis — the map's one-keystroke write.
     *
     * **Declared** order rather than the column order on screen, which is the
     * decision that makes a digit mean the same thing everywhere. The two agree
     * in the ordinary case, because a board keeps an empty declared column; where
     * they part — a filtered-out column, a value the vocabulary does not declare —
     * the stable answer is the vocabulary's, so `2` is the same write whatever the
     * current filter happens to be hiding.
     *
     * The mode is the panel's rule, which is the rule this app has always
     * followed: **the type picks the control and the cardinality picks the verb.**
     * One slot can only be replaced, so a single-valued axis is `set`; an axis
     * that holds several is `add`, exactly as `FacetEditor.take` does for a value
     * that is not on the note yet. It is deliberately never `remove` — a digit
     * cannot destroy, and `0` is the gesture that clears.
     */
    case 'setAxisValue': {
      const def = s.facets[command.facet];
      if (!def) return;
      const ids = targets(s);
      if (!ids.length) return;

      const clearing = command.ordinal === 0;
      const value = clearing ? null : def.values[command.ordinal - 1];
      if (!clearing && !value) {
        return s.notify({
          tone: 'info',
          text: `${def.label} has no ${command.ordinal}${ordinalSuffix(command.ordinal)} value`,
        });
      }

      const write: FacetWrite = {
        ids,
        facet: command.facet,
        values: value ? [value] : [],
        mode: clearing || def.single ? 'set' : 'add',
      };
      const back = inverseOf(write, (id) => s.valuesOf(id, command.facet));
      return s.doStep({
        forward: [write],
        back,
        label: clearing
          ? `cleared ${def.label}`
          : `set ${def.label} to ${value} on ${ids.length === 1 ? 'a note' : `${ids.length} notes`}`,
      });
    }

    /**
     * A new card, in the column the cursor is in.
     *
     * The only binding whose target is not a note, and the reason it waited: the
     * field it opens belongs to `Column`, so the shell can name a column and
     * nothing else. A card created there inherits that column's value for the
     * grouped axis — which is the board's own rule, and the one write outside the
     * panel that is not a gesture.
     *
     * A board or a calendar — the two shapes with an inline creator, and the
     * grid already says which by having columns. On a calendar the column is a
     * day, so the card is born with that date. A table and a canvas draw no
     * inline creator, and inventing a prompt for them would be a second way to
     * make a card that looks nothing like the first.
     */
    case 'newCard': {
      // The shape, not the grid: a table has columns to walk and no creator to
      // open, so `n` there used to park a request nothing would ever consume.
      const shape = s.spec?.shape;
      if ((shape !== 'board' && shape !== 'calendar') || !grid.columns.length) {
        return s.notify({ tone: 'info', text: 'new cards are made on a board or a calendar' });
      }
      const spot = locate(grid, cursor.id);
      const column = grid.columns[spot ? spot[1] : 0];
      if (column === undefined) return;
      return s.newCardIn(column);
    }

    /**
     * `⌥j` / `⌥k` — the drag within a column, keyed.
     *
     * The board owns the act, for the reason `newCard` does: the shell knows a
     * key was pressed and the board knows what a column is. Refused here only
     * where the shell can already tell it is meaningless — a shape with no
     * columns — so the board never has to explain a key that could not apply.
     */
    case 'reorder': {
      if (!grid.columns.length) {
        return s.notify({ tone: 'info', text: 'card order is a board' });
      }
      return s.nudgeCard(command.delta);
    }

    /**
     * One axis's own row, which is what `⟨key⟩` means on its own.
     *
     * The fallback of the axis prefix: `p3` writes the third value and `pp` — or
     * `p` and anything that is not a digit — goes to the row so you can see them.
     * It was the one command `bind` emitted that nothing acted on, which made the
     * prefix's own rule ("never leaves you with nothing") false for exactly the
     * case it was written about.
     *
     * The same reach `gf` makes, narrowed to one axis. A note that carries nothing
     * on it draws no row, so this says so rather than opening a note to nothing.
     */
    case 'openAxisControl': {
      if (!s.stackOpen && !openNote && cursor.id) s.setOpenNote(cursor.id);
      const def = s.facets[command.facet];
      return focusSoon(
        () => axisRow(command.facet, false)?.querySelector<HTMLElement>('[data-nav]'),
        8,
        // The note draws no row for this axis, which is what "carries nothing on
        // it" looks like in the DOM. Say so, and say where the door is.
        () =>
          s.notify({
            tone: 'info',
            text: `nothing on ${def?.label ?? command.facet} — g⇧F adds an axis`,
          }),
      );
    }

    case 'undo':
    case 'redo': {
      const move = command.kind === 'undo' ? undone(s.history.current) : redone(s.history.current);
      if (!move) {
        return s.notify({ tone: 'info', text: `nothing to ${command.kind}` });
      }
      const writes = command.kind === 'undo' ? move.step.back : move.step.forward;
      if (!writes.length) {
        // Recorded but not reversible. Saying so beats silently undoing the step
        // *before* it, which the reader has long since stopped thinking about.
        return s.notify({ tone: 'info', text: `${move.step.label} cannot be undone` });
      }
      // The stacks move whether or not the request lands: a failed undo leaves
      // the vault as it was, which is where the stack already says it is.
      s.history.current = move.history;
      void s.applyStep(writes, command.kind).then((ok) => {
        if (ok) s.notify({ tone: 'info', text: `${command.kind}: ${move.step.label}` });
      });
      return;
    }
  }
}

/** `1st`, `2nd`, `3rd`, `4th` — for a message a reader reads once and dismisses. */
function ordinalSuffix(n: number): string {
  return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
}
