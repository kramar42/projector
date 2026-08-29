import { useCallback, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  baseOf,
  bannerFor,
  busyLabel,
  classify,
  heldBase,
  idleStatus,
  labelFor,
  nextStatus,
  planWrite,
  type CardWrite,
  type FacetMode,
  type Plan,
  type WriteStatus,
} from './write.ts';

/**
 * The only place in the browser that names an endpoint for one note.
 *
 * `api.bulk` is deliberately not in this switch. That is the whole of "the panel
 * writes one note" — the board's bulk bar keeps `POST /api/bulk` because it
 * genuinely has many notes and no single mtime, and the panel can no longer
 * borrow it by accident.
 */
function dispatch(id: string, p: Plan): Promise<{ mtime?: number; warnings?: string[] }> {
  switch (p.call) {
    case 'patch':
      return api.patchNote(id, p.body);
    case 'frontmatter':
      return api.putFrontmatter(id, p.yaml, p.baseMtime);
    case 'delete':
      return api.deleteNote(id).then(() => ({}));
  }
}

/**
 * One door for everything the panel writes about one note.
 *
 * What a caller must know:
 *
 * - **Every write carries a base mtime**, stamped by `planWrite`. There is no
 *   unstamped path, and this is the only door in the panel through which a note is
 *   changed, so there is nothing left to make an unstamped one with. `useWorkStarter`
 *   is the sibling door and reaches `api` too — it carries no base because it
 *   changes no note, and that is stated there rather than being an exception here.
 * - **The base is read at call time**, through refs. This is not tidiness: the
 *   body editor builds its ⌘S handler once at mount and closes over whatever it
 *   was handed, so a handler frozen at mount and one built this render must be
 *   the same function reading the same numbers. They were not — ⌘S sent the
 *   mount-time mtime, so the second ⌘S of a session failed while the Save button
 *   beside it worked.
 * - **Except the two documents**, `body` and `frontmatter`, which carry
 *   `heldBase` — frozen while their editor is dirty, because the document on
 *   screen belongs to an older read. Both editors share one adopt rule, so both
 *   need the base that rule implies; `frontmatter` needs it more, since it
 *   replaces the whole block rather than one key.
 * - **`press*` members return `void` and never reject**; failure lands in
 *   `status`. `void` is not assignable to `Promise<void>`, so handing one to an
 *   editor's `onSave` does not compile.
 * - **`save*` members reject and note nothing.** Their controls report for
 *   themselves, and a panel banner offering a Reload that does nothing while the
 *   editor is dirty is a lie. One rule: a control that can report for itself does
 *   not also raise a banner.
 * - Every successful write reloads. `remove` calls `onGone` only if it succeeded.
 * - The panel is mounted with `key={id}`, so this hook never sees an id change
 *   and owns no reset logic.
 */
export interface NoteWriter {
  /**
   * `mode` defaults to `set`, which is right for a control that replaces an axis
   * — a date, a single-valued toggle, a parent. A control that toggles one value
   * of a multi-valued axis must say `add` or `remove`, because "the axis is now
   * exactly this" is a claim it cannot honestly make about a file it last read a
   * render ago.
   */
  facet(name: string, values: string[], mode?: FacetMode): void;
  /**
   * Judge a candidate: `intake` comes off, and `extends` with it.
   *
   * Two writes rather than one, because the browser may only ever send *one*
   * facet at a time — its copy of the map is as old as its last render, so the
   * whole-map form would revert whatever an agent changed on another axis. They
   * are chained through `run` rather than fired at `press` twice: `run` advances
   * the base mtime as each lands, so the second write is not a lost update
   * against the first.
   *
   * One status for the pair, because it is one act. A failure half way leaves the
   * note carrying `extends` and no `intake`, which is exactly the stale-fold-
   * control state this exists to prevent — so `intake` is cleared *last*, and a
   * candidate that fails mid-accept is still visibly a candidate.
   */
  accept(): void;
  title(next: string): void;
  links(next: string[]): void;
  projectBlock(block: Record<string, unknown> | null): void;
  remove(): void;

  body(next: string): Promise<void>;
  frontmatter(yaml: string): Promise<{ warnings: string[] }>;

  /**
   * A body checkbox, flipped. The same `body` write, through `press` instead.
   *
   * Not a second write path — `CardWrite` gains nothing and the wire call is the
   * one `body` already makes. What differs is who reports: the body *editor*
   * reports for itself, which is why `body` rejects and notes nothing, and a
   * checkbox has nowhere to put a failure. So this one raises the banner, by the
   * rule stated above rather than despite it.
   */
  task(next: string): void;

  status: WriteStatus;
  busy: string | null;
  banner: ReturnType<typeof bannerFor>;
  /** Clear a standing failure and refetch — the conflict banner's Reload. */
  dismiss(): void;
}

/**
 * A writer that writes nothing, for a surface that may not.
 *
 * The spread draws every pinned note with the panel's own blocks, and those
 * blocks are editing controls — so a page that is not the focused one needs a
 * writer of the right shape that reaches no route. `inert` already makes the
 * subtree unclickable, and that is the *visible* half of the rule; this is the
 * half that holds when something reaches a control anyway, which a synthetic
 * click demonstrably does. Two guards for one invariant, because the invariant
 * is that exactly one surface can write (C10) and a UI-level guard is not one
 * a reader can check.
 *
 * Frozen, and shared: it holds no state, so one instance serves every page and
 * a new object per render would re-run the effects the blocks hang off it.
 */
export const NO_WRITES: NoteWriter = Object.freeze({
  facet: () => {},
  accept: () => {},
  title: () => {},
  links: () => {},
  projectBlock: () => {},
  remove: () => {},
  body: async () => {},
  frontmatter: async () => ({ warnings: [] }),
  task: () => {},
  status: idleStatus(),
  busy: null,
  banner: null,
  dismiss: () => {},
});

export function usePanelWriter(o: {
  id: string;
  /** The freshest completed read's mtime; null until the first load lands. */
  mtime: number | null;
  reload: () => void;
  /**
   * Which documents hold unsaved text. Each freezes its own base — a dirty
   * frontmatter pane says nothing about the body's document and must not pin it.
   */
  held: { body: boolean; frontmatter: boolean };
  onGone: () => void;
}): NoteWriter {
  const [status, setStatus] = useState(idleStatus);
  const read = useRef(o.mtime);
  const wrote = useRef<number | null>(null);
  const held = useRef<{ body: number | null; frontmatter: number | null }>({
    body: null,
    frontmatter: null,
  });
  const live = useRef(o);
  const seq = useRef(0);

  // Assigned during render, exactly as `useLive` assigns its `loadRef`. `heldBase`
  // is idempotent, so a StrictMode double render changes nothing.
  read.current = o.mtime;
  const fresh = baseOf(o.mtime, wrote.current);
  held.current = {
    body: heldBase(held.current.body, fresh, o.held.body, wrote.current),
    frontmatter: heldBase(held.current.frontmatter, fresh, o.held.frontmatter, wrote.current),
  };
  live.current = o;

  const run = useCallback(async (w: CardWrite): Promise<{ warnings?: string[] }> => {
    const doc = w.kind === 'body' || w.kind === 'frontmatter' ? w.kind : null;
    const at = doc ? held.current[doc] : baseOf(read.current, wrote.current);
    if (at === null) throw new ApiError('the note is not loaded yet', 0);
    const res = await dispatch(live.current.id, planWrite(w, at));
    if (typeof res.mtime === 'number') {
      wrote.current = res.mtime;
      // That editor is about to go clean on this text, so its base advances too.
      if (doc) held.current[doc] = res.mtime;
    }
    live.current.reload();
    return res;
  }, []);

  /** Fire and report. Never rejects — the panel's banner is the whole report. */
  const press = useCallback(
    (w: CardWrite) => {
      const n = ++seq.current;
      setStatus((s) => nextStatus(s, { t: 'start', seq: n, label: labelFor(w) }));
      run(w).then(
        () => {
          setStatus((s) => nextStatus(s, { t: 'settled', seq: n, failure: null }));
          if (w.kind === 'delete') live.current.onGone();
        },
        (err: unknown) =>
          setStatus((s) => nextStatus(s, { t: 'settled', seq: n, failure: classify(err) })),
      );
    },
    [run],
  );

  return {
    facet: useCallback(
      (name, values, mode: FacetMode = 'set') => press({ kind: 'facet', name, values, mode }),
      [press],
    ),
    accept: useCallback(() => {
      const n = ++seq.current;
      setStatus((s) => nextStatus(s, { t: 'start', seq: n, label: 'accepting' }));
      run({ kind: 'facet', name: 'extends', values: [], mode: 'set' })
        .then(() => run({ kind: 'facet', name: 'intake', values: [], mode: 'set' }))
        .then(
          () => setStatus((s) => nextStatus(s, { t: 'settled', seq: n, failure: null })),
          (err: unknown) =>
            setStatus((s) => nextStatus(s, { t: 'settled', seq: n, failure: classify(err) })),
        );
    }, [run]),
    title: useCallback((title) => press({ kind: 'title', title }), [press]),
    links: useCallback((links) => press({ kind: 'links', links }), [press]),
    projectBlock: useCallback((block) => press({ kind: 'projectBlock', block }), [press]),
    remove: useCallback(() => press({ kind: 'delete' }), [press]),

    body: useCallback((body) => run({ kind: 'body', body }).then(() => {}), [run]),
    task: useCallback((body) => press({ kind: 'body', body }), [press]),
    frontmatter: useCallback(
      (yaml) => run({ kind: 'frontmatter', yaml }).then((r) => ({ warnings: r.warnings ?? [] })),
      [run],
    ),

    status,
    busy: busyLabel(status),
    banner: bannerFor(status),
    dismiss: useCallback(() => {
      setStatus((s) => nextStatus(s, { t: 'dismiss' }));
      live.current.reload();
    }, []),
  };
}
