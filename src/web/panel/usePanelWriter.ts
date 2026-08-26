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
 * The only place in the browser that names an endpoint for one card.
 *
 * `api.bulk` is deliberately not in this switch. That is the whole of "the panel
 * writes one card" — the board's bulk bar keeps `POST /api/bulk` because it
 * genuinely has many cards and no single mtime, and the panel can no longer
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
  title(next: string): void;
  links(next: string[]): void;
  projectBlock(block: Record<string, unknown> | null): void;
  remove(): void;

  body(next: string): Promise<void>;
  frontmatter(yaml: string): Promise<{ warnings: string[] }>;

  status: WriteStatus;
  busy: string | null;
  banner: ReturnType<typeof bannerFor>;
  /** Clear a standing failure and refetch — the conflict banner's Reload. */
  dismiss(): void;
}

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
    if (at === null) throw new ApiError('the card is not loaded yet', 0);
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
    title: useCallback((title) => press({ kind: 'title', title }), [press]),
    links: useCallback((links) => press({ kind: 'links', links }), [press]),
    projectBlock: useCallback((block) => press({ kind: 'projectBlock', block }), [press]),
    remove: useCallback(() => press({ kind: 'delete' }), [press]),

    body: useCallback((body) => run({ kind: 'body', body }).then(() => {}), [run]),
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
