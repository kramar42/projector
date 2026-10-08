// bb-plugin-projector — the app half: projector's own web app, embedded.
//
// Nothing here redraws projector. Its server already serves each part of the app
// on its own (`?embed=view|sidebar|note`) and the parts coordinate through the
// page that holds them: each frame posts `{ projector: "query", search, sel,
// note }` up whenever its URL changes, and accepts `{ projector: "navigate", … }`
// down (projector's src/web/embed.ts, MANUAL §Embedding). This file is that
// page: it holds the frames and routes between them.
//
// - A Projector page in the sidebar: the shape in the middle, and the views
//   sidebar and the note panel as tabs beside it.
// - A "Projector note" tab beside any thread, showing the thread's note, or a
//   box to attach one.
// - A chip in the thread header naming the attached note.
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { definePluginApp, useBbNavigate, useRpc, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

// ----------------------------------------------------------------- frame routing

type Role = "view" | "sidebar" | "note";

interface Frame {
  role: Role;
  origin: string;
  window: Window;
}

/** Every mounted projector frame, so a message can be traced to its role. */
const frames = new Set<Frame>();
/** The last query and note routed, so an echo does not bounce between frames. */
const routed: { search: string | null; note: string | null } = { search: null, note: null };
let listening = false;

function post(frame: Frame, message: Record<string, unknown>) {
  frame.window.postMessage({ projector: "navigate", ...message }, frame.origin);
}

/** bb's navigation, as the most recently mounted frame saw it; a module listener has no hooks. */
let toThread: ((threadId: string) => void) | null = null;

function onFrameMessage(ev: MessageEvent) {
  const from = [...frames].find((f) => f.window === ev.source && f.origin === ev.origin);
  const d = ev.data as {
    projector?: unknown;
    search?: unknown;
    sel?: unknown;
    note?: unknown;
    kind?: unknown;
    ref?: unknown;
  } | null;
  if (!from) return;

  // A link offered up from a note (`bb:thr_…`): the reference's other end, in bb.
  // Every other kind stays projector's business, so it is ignored here.
  if (d?.projector === "open") {
    if (d.kind === "bb" && typeof d.ref === "string" && /^thr_[a-z0-9]+$/i.test(d.ref)) toThread?.(d.ref);
    return;
  }
  if (d?.projector !== "query") return;

  // A query moved in the sidebar or the shape: every other query-holding frame follows.
  if ((from.role === "sidebar" || from.role === "view") && typeof d.search === "string" && d.search !== routed.search) {
    routed.search = d.search;
    for (const f of frames) {
      if (f !== from && f.role !== "note") post(f, { search: d.search, sel: Array.isArray(d.sel) ? d.sel : [] });
    }
  }
  // A card opened in the shape: the note frame shows it (the shape never slides its own panel).
  const note = typeof d.note === "string" ? d.note : null;
  if (from.role === "view" && note !== routed.note) {
    routed.note = note;
    for (const f of frames) if (f.role === "note") post(f, { note });
  }
}

/** Register an iframe for routing while it is mounted. */
function useRoutedFrame(role: Role, src: string | null) {
  const ref = useRef<HTMLIFrameElement>(null);
  const navigate = useBbNavigate();
  useEffect(() => {
    toThread = (threadId) => navigate.toThread(threadId);
  }, [navigate]);
  useEffect(() => {
    const win = ref.current?.contentWindow;
    if (!win || !src) return;
    if (!listening) {
      window.addEventListener("message", onFrameMessage);
      listening = true;
    }
    const frame: Frame = { role, origin: new URL(src).origin, window: win };
    frames.add(frame);
    return () => {
      frames.delete(frame);
    };
  }, [role, src]);
  return ref;
}

// ---------------------------------------------------------------------- config

interface Config {
  url: string;
  vault: string;
}

/** The embed settings, or null while loading or unset (the caller says which). */
function useConfig(): { config: Config | null; loading: boolean } {
  const { values, isLoading } = useSettings();
  const url = typeof values?.projectorUrl === "string" ? values.projectorUrl.replace(/\/+$/, "") : "";
  const vault = typeof values?.vault === "string" ? values.vault : "";
  return { config: url && vault ? { url, vault } : null, loading: isLoading };
}

function frameSrc(config: Config, embed: Role, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ vault: config.vault, embed, ...extra });
  return `${config.url}/?${params}`;
}

function Unconfigured({ loading }: { loading: boolean }) {
  if (loading) return null;
  return (
    <div className="p-6 text-sm text-muted-foreground">
      Projector's web app is not configured. Start it, then run{" "}
      <code>bb plugin config projector set projectorUrl http://127.0.0.1:8092</code>.
    </div>
  );
}

function ProjectorFrame({ role, src, title }: { role: Role; src: string; title: string }) {
  const ref = useRoutedFrame(role, src);
  return <iframe ref={ref} src={src} title={title} className="block h-full w-full border-0" />;
}

// ------------------------------------------------------------- Projector page

function ProjectorPage() {
  const { config, loading } = useConfig();
  if (!config) return <Unconfigured loading={loading} />;
  return (
    <div className="h-full min-h-[70vh]">
      <ProjectorFrame role="view" title="Projector" src={frameSrc(config, "view", { view: "actionable" })} />
    </div>
  );
}

function ViewsTab() {
  const { config, loading } = useConfig();
  if (!config) return <Unconfigured loading={loading} />;
  return <ProjectorFrame role="sidebar" title="Projector views" src={frameSrc(config, "sidebar")} />;
}

function NoteTab() {
  const { config, loading } = useConfig();
  if (!config) return <Unconfigured loading={loading} />;
  // Opens on whatever the shape last opened; later cards arrive as messages.
  const extra: Record<string, string> = routed.note ? { note: routed.note } : {};
  return <ProjectorFrame role="note" title="Projector note" src={frameSrc(config, "note", extra)} />;
}

// --------------------------------------------------------- the thread's note

/** Attachment changes made from this window, so the header chip and the tab agree. */
const attachmentListeners = new Set<() => void>();
const attachmentChanged = () => attachmentListeners.forEach((l) => l());

interface Attachment {
  noteId: string;
  title: string | null;
}

function useAttachment(threadId: string): { attachment: Attachment | null; loaded: boolean } {
  const sdk = useSdk();
  const [state, setState] = useState<{ attachment: Attachment | null; loaded: boolean }>({ attachment: null, loaded: false });
  const load = useCallback(() => {
    sdk.threads.getPluginMetadata({ threadId }).then(
      (meta: Record<string, unknown>) => {
        const noteId = typeof meta.noteId === "string" ? meta.noteId : null;
        const title = typeof meta.title === "string" ? meta.title : null;
        setState({ attachment: noteId ? { noteId, title } : null, loaded: true });
      },
      () => setState({ attachment: null, loaded: true }),
    );
  }, [sdk, threadId]);
  useEffect(() => {
    load();
    attachmentListeners.add(load);
    return () => {
      attachmentListeners.delete(load);
    };
  }, [load]);
  return state;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Hit {
  id: string;
  title: string;
}

/**
 * Find a note by typing: `pj search` on every pause, results under the box,
 * arrows to move, Enter or a click to pick. Each keystroke supersedes the
 * search before it, so a slow answer never overwrites a newer one.
 */
function NotePicker({ onPick, busy }: { onPick: (hit: Hit) => void; busy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    const mine = ++seq.current;
    if (!query) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      rpc.call("search", { q: query }).then(
        ({ results }: { results: Hit[] }) => {
          if (mine !== seq.current) return;
          setHits(results);
          setActive(0);
          setSearching(false);
          setError(null);
        },
        (err: unknown) => {
          if (mine !== seq.current) return;
          setSearching(false);
          setError(errorText(err));
        },
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [q, rpc]);

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "ArrowDown" && hits.length) {
      ev.preventDefault();
      setActive((i) => (i + 1) % hits.length);
    } else if (ev.key === "ArrowUp" && hits.length) {
      ev.preventDefault();
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (ev.key === "Enter" && hits[active] && !busy) {
      ev.preventDefault();
      onPick(hits[active]!);
    }
  };

  return (
    <div className="flex flex-col gap-1 text-sm">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find a note…"
        aria-label="Find a note"
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls="projector-note-hits"
        aria-activedescendant={hits[active] ? `projector-hit-${active}` : undefined}
        className="rounded-md bg-muted px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-ring"
      />
      <ul id="projector-note-hits" role="listbox" className="flex flex-col">
        {hits.map((hit, i) => (
          <li
            key={hit.id}
            id={`projector-hit-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              if (!busy) onPick(hit);
            }}
            className={`cursor-pointer rounded-md px-2.5 py-1.5 ${i === active ? "bg-accent text-foreground" : ""}`}
          >
            <div className="truncate">{hit.title}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{hit.id}</div>
          </li>
        ))}
      </ul>
      {searching && !hits.length ? <p className="px-2.5 text-xs text-muted-foreground">Searching…</p> : null}
      {!searching && q.trim() && !hits.length && !error ? (
        <p className="px-2.5 text-xs text-muted-foreground">No notes match.</p>
      ) : null}
      {error ? <p className="px-2.5 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Which note a tab shows, kept per tab so a reload reopens the same note. */
const tabKey = (tab: string) => `projector:note-tab:${tab}`;
function useTabNote(tab: string | null): [string | null, (noteId: string | null) => void] {
  const [noteId, setNoteId] = useState<string | null>(() => (tab ? localStorage.getItem(tabKey(tab)) : null));
  const set = useCallback(
    (next: string | null) => {
      if (tab) {
        if (next) localStorage.setItem(tabKey(tab), next);
        else localStorage.removeItem(tabKey(tab));
      }
      setNoteId(next);
    },
    [tab],
  );
  return [noteId, set];
}

/** The tab the header chip opens: always the thread's own note. */
const ATTACHED_TAB = "attached";

function tabOf(params: unknown): string | null {
  const tab = (params as { tab?: unknown } | null)?.tab;
  return typeof tab === "string" ? tab : null;
}

/** What a note tab is called before it shows a note. */
const DEFAULT_TAB_TITLE = "Projector note";

/** Note titles this window already knows, from picks, attachments and `title` calls. */
const knownTitles = new Map<string, string>();

/**
 * The tab label for a note: its title, else its id (a note with no title), or
 * null while the title is still being asked for.
 */
function useNoteLabel(noteId: string | null, attachment: Attachment | null): string | null {
  const rpc = useRpc<typeof rpcContract>();
  const fromAttachment = noteId !== null && attachment?.noteId === noteId ? attachment.title : null;
  const [fetched, setFetched] = useState<{ noteId: string; label: string } | null>(null);
  useEffect(() => {
    if (!noteId || fromAttachment || knownTitles.has(noteId)) return;
    let live = true;
    rpc.call("title", { noteId }).then(
      ({ title }: { title: string | null }) => {
        if (title) knownTitles.set(noteId, title);
        if (live) setFetched({ noteId, label: title ?? noteId });
      },
      // A note that cannot be read still needs a name; its id is one.
      () => live && setFetched({ noteId, label: noteId }),
    );
    return () => {
      live = false;
    };
  }, [noteId, fromAttachment, rpc]);
  if (!noteId) return DEFAULT_TAB_TITLE;
  return fromAttachment ?? knownTitles.get(noteId) ?? (fetched?.noteId === noteId ? fetched.label : null);
}

/** The label bb was last given for a tab, so a reload does not re-open every tab. */
const titleKey = (threadId: string, tab: string) => `projector:note-tab-title:${threadId}:${tab}`;
const rememberTitle = (threadId: string, tab: string, title: string) => localStorage.setItem(titleKey(threadId, tab), title);

/**
 * Name the tab after its note. bb has no rename: re-opening the action with the
 * tab's own params focuses that tab and refreshes its title (the pill keeps the
 * plugin's icon and ellipsizes the label itself). Focus is why this waits until
 * the tab is on screen, so a hidden tab never pulls the user away, and why it
 * fires only when the label differs from the last one given.
 */
function useTabTitle(threadId: string, tab: string | null, title: string | null, ref: RefObject<HTMLDivElement | null>) {
  const navigate = useBbNavigate();
  useEffect(() => {
    const el = ref.current;
    if (tab === null || title === null || !el) return;
    const key = titleKey(threadId, tab);
    const current = () => localStorage.getItem(key) ?? DEFAULT_TAB_TITLE;
    if (current() === title) return;
    const retitle = () => {
      if (!el.getClientRects().length) return false;
      if (current() !== title) {
        rememberTitle(threadId, tab, title);
        navigate.openThreadPanel({ actionId: "note", title, params: { tab } });
      }
      return true;
    };
    if (retitle()) return;
    // A hidden tab has no boxes; it gets them back (a resize) when shown.
    const watch = new ResizeObserver(() => {
      if (retitle()) watch.disconnect();
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [threadId, tab, title, navigate, ref]);
}

/**
 * One "Projector note" tab. Every activation opens a new one (see `run`), so a
 * thread can hold several notes side by side; a tab shows the note picked in
 * it, and the chip's tab shows the note the thread is attached to.
 */
function ThreadNotePanel({ threadId, params }: { threadId: string; params: unknown }) {
  const { config, loading } = useConfig();
  const { attachment, loaded } = useAttachment(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const tab = tabOf(params);
  const [picked, setPicked] = useTabNote(tab === ATTACHED_TAB ? null : tab);
  const [attachOnPick, setAttachOnPick] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // The chip's tab, and a legacy tab with no params, follow the attachment.
  const followsAttachment = tab === ATTACHED_TAB || tab === null;
  const noteId = !loaded ? null : followsAttachment ? (attachment?.noteId ?? null) : picked;
  const isAttached = noteId !== null && attachment?.noteId === noteId;
  const label = useNoteLabel(noteId, attachment);
  useTabTitle(threadId, tab, loaded && config ? label : null, root);

  if (!loaded) return null;
  if (!config) return <Unconfigured loading={loading} />;

  const run = (call: Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    call.then(
      () => {
        setBusy(false);
        after?.();
        attachmentChanged();
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorText(err));
      },
    );
  };

  const pick = (hit: Hit) => {
    // Attaching re-points the thread; a tab of its own just shows the note.
    const showHere = () => {
      if (!followsAttachment) setPicked(hit.id);
    };
    if (hit.title) knownTitles.set(hit.id, hit.title);
    if (attachOnPick || followsAttachment) {
      run(rpc.call("attach", { threadId, noteId: hit.id, record: false }), showHere);
    } else showHere();
  };

  if (!noteId) {
    return (
      <div ref={root} className="flex flex-col gap-3 p-3">
        <NotePicker onPick={pick} busy={busy} />
        {followsAttachment ? null : (
          <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={attachOnPick} onChange={(e) => setAttachOnPick(e.target.checked)} />
            Attach to this thread (it starts each session knowing the note)
          </label>
        )}
        {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div ref={root} className="flex h-full flex-col">
      {/* A quieter step, not a ruled strip: the note's own header is the heading. */}
      <div className="flex items-center gap-3 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
        <span className="truncate font-mono">{noteId}</span>
        <span className="ml-auto flex shrink-0 gap-3">
          {isAttached ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(rpc.call("detach", { threadId, record: false }))}
              className="hover:text-foreground"
            >
              Detach
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(rpc.call("attach", { threadId, noteId, record: false }))}
              className="hover:text-foreground"
            >
              Attach to thread
            </button>
          )}
          {followsAttachment ? null : (
            <button type="button" onClick={() => setPicked(null)} className="hover:text-foreground">
              Change
            </button>
          )}
        </span>
      </div>
      {error ? <p className="px-3 py-1 text-xs text-destructive">{error}</p> : null}
      <div className="min-h-0 flex-1">
        <ProjectorFrame role="note" title={noteId} src={frameSrc(config, "note", { note: noteId })} />
      </div>
    </div>
  );
}

function NoteChip({ threadId }: { threadId: string }) {
  const { attachment, loaded } = useAttachment(threadId);
  const navigate = useBbNavigate();
  if (!loaded) return null;
  const open = () => {
    // The same label the tab would give itself, so opening it does not retitle it again.
    const title = attachment ? (attachment.title ?? attachment.noteId) : DEFAULT_TAB_TITLE;
    if (navigate.openThreadPanel({ actionId: "note", title, params: { tab: ATTACHED_TAB } })) {
      rememberTitle(threadId, ATTACHED_TAB, title);
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      title={attachment ? `Projector note: ${attachment.title ?? attachment.noteId}` : "Attach a projector note"}
      aria-label={attachment ? `Open projector note ${attachment.noteId}` : "Attach a projector note"}
      className="h-7 max-w-48 truncate rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {attachment ? `◆ ${attachment.noteId}` : "◇ note"}
    </button>
  );
}

// -------------------------------------------------------------------- register

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "projector",
    title: "Projector",
    icon: "ListTodo",
    path: "projector",
    component: ProjectorPage,
    fixedTabs: [
      { panelId: "projector", id: "note", title: "Note", icon: "FileText", component: NoteTab, layout: "flush" },
      { panelId: "projector", id: "views", title: "Views", icon: "PanelLeft", component: ViewsTab, layout: "flush" },
    ],
  });
  app.slots.threadPanelAction({
    id: "note",
    title: "Projector note",
    layout: "flush",
    component: ThreadNotePanel,
    // bb focuses an existing tab when the params match, so each activation gets
    // its own: that is what lets a thread hold a second (third…) note tab.
    run: ({ openPanel }) => {
      // It starts as "Projector note" and takes the note's title once it has one (useTabTitle).
      openPanel({ title: DEFAULT_TAB_TITLE, params: { tab: crypto.randomUUID() } });
    },
  });
  app.slots.experimental_threadHeaderAction({
    id: "note",
    title: "Projector note",
    component: NoteChip,
  });
});
