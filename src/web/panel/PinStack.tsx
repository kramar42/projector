import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { IconButton } from '../components/Button.tsx';
import { KeyHints } from '../components/KeyHint.tsx';
import { RecordMark } from '../components/CardBody.tsx';
import { NO_WRITES, usePanelWriter } from './usePanelWriter.ts';
import { NoteTiers } from './tiers.tsx';
import { SPINE_W } from './pins.ts';
import type { Meta, NoteDetail, QueryResponse } from '../types.ts';

/**
 * The pinned notes, in their two states.
 *
 * `PinDock` is the collapsed one: a row of vertical title spines glued to the
 * right edge — left of the panel when one is open — that costs `SPINE_W` per
 * pin and leaves the view usable. `PinStack` is the spread: the same pins as
 * full-height pages laid side by side over the view, each page carrying its
 * spine as its own left edge, sticking at either viewport edge instead of
 * scrolling away — so a spread wider than the window folds its ends down to
 * titles rather than losing them.
 *
 * **A page draws the note the way the panel does** — the same `NoteTiers`, so
 * the facet chips, the link kinds, the derived rows and the workshop cannot
 * come to look like a summary of a note instead of the note.
 *
 * **Exactly one page is actionable: the focused one.** The others are `inert`
 * and draw no key hints, which is the same sentence twice — a key reaches the
 * focused page, so a hint on any other would name a stroke that acts somewhere
 * else on screen. That is what keeps the cursor the only pointer with four notes
 * up: the focused page *is* `?note=`, so there is one surface a write can land
 * on, exactly as there is one panel (C10).
 *
 * The fold is CSS `position: sticky` with per-index offsets, not measurement:
 * page i may go no further left than `i` spines and no further right than the
 * `n-1-i` behind it, and everything the spread does — the fold, the stacking,
 * the "viewport shrinks by one spine per folded page" — falls out of those two
 * numbers. The one scripted motion is `reveal`, and it moves only when the page
 * it is asked for is not already whole on screen.
 */

/** A pinned note's title: the payload's when it is drawn, fetched when it is not. */
function useTitle(id: string, known: string | undefined): string {
  const [fetched, setFetched] = useState<string | null>(null);
  useEffect(() => {
    if (known) return;
    let gone = false;
    api.note(id).then(
      (d) => !gone && setFetched(d.note.title),
      // A pin whose note was deleted still needs a legible spine to unpin from.
      () => !gone && setFetched(id),
    );
    return () => {
      gone = true;
    };
  }, [id, known]);
  return known ?? fetched ?? '…';
}

export function PinDock({
  pins,
  notes,
  onOpen,
}: {
  pins: string[];
  notes: QueryResponse['notes'];
  /** A spine click opens that note — the same act as clicking its card. */
  onOpen: (id: string) => void;
}) {
  return (
    <div className="pindock" aria-label="Pinned notes">
      {pins.map((id) => (
        <DockSpine key={id} id={id} known={notes[id]?.title} onOpen={() => onOpen(id)} />
      ))}
    </div>
  );
}

function DockSpine({ id, known, onOpen }: { id: string; known: string | undefined; onOpen: () => void }) {
  const title = useTitle(id, known);
  return (
    <button
      className="pindock-spine"
      data-act="spine"
      style={{ width: SPINE_W }}
      title={`${title} — open it. " spreads every pin`}
      onClick={onOpen}
    >
      <span className="spinelabel">{title}</span>
    </button>
  );
}

export function PinStack({
  pins,
  openNote,
  cursor,
  meta,
  onCursor,
  onOpen,
  onUnpin,
  onFocus,
  onUnsaved,
}: {
  pins: string[];
  openNote: string | null;
  cursor: string | null;
  meta: Meta;
  /** Focus moved to a page: the cursor and `?note=` go together, one pointer. */
  onCursor: (id: string) => void;
  /** Follow a reference out of a page. Modifiers decide how — see `followCard`. */
  onOpen: (id: string, mods?: { altKey?: boolean; shiftKey?: boolean }) => void;
  onUnpin: (id: string) => void;
  /** Reshape the view around a derived row — the shell owns the query. */
  onFocus: (id: string, via: string) => void;
  /** What the focused page would lose if it were folded — the panel's guard. */
  onUnsaved: (u: { body: boolean; frontmatter: boolean }) => void;
}) {
  // The open note is a page too — rightmost, unless it is itself a pin, in
  // which case it is already on screen at its pin's place and a second copy
  // would be the same note twice.
  const pages = openNote && !pins.includes(openNote) ? [...pins, openNote] : pins;
  const strip = useRef<HTMLDivElement | null>(null);

  /**
   * Bring page i into view — and **only** as far as it takes.
   *
   * A page is fully in view when neither edge is under a stuck neighbour: with
   * `S` the scroll offset, `L` the page's layout position and `C` the viewport,
   * its left edge clears the `i` spines before it while `S ≤ L − i·SPINE_W`, and
   * its right edge clears the `n−1−i` spines after it while
   * `S ≥ L + w + (n−1−i)·SPINE_W − C`. Any `S` between those two shows the whole
   * page, so a scroll is needed only when the current one is outside, and then
   * only to the nearer end of the range.
   *
   * Seating every focused page at the left edge instead — which is what this did
   * — meant `h` and `l` dragged the whole spread sideways on every step even when
   * the page they landed on was already fully readable, so the surface never sat
   * still while you walked it. When the range is empty, because the page is wider
   * than the room between the stuck spines, the left edge wins: a title and the
   * start of the prose beat the end of it.
   */
  const reveal = useCallback((i: number) => {
    const el = strip.current;
    const page = el?.children[i] as HTMLElement | undefined;
    if (!el || !page) return;
    const n = el.children.length;
    const w = page.offsetWidth;
    /*
     * `i × w`, not `offsetLeft`.
     *
     * Chrome reports a **sticky** element's `offsetLeft` at the position it is
     * currently stuck to rather than the one it was laid out at, so the far
     * pages measured as if they were already where they belong and every
     * comparison below came out true: nothing ever scrolled. Every page is the
     * same width by rule, so the layout position is the index times that width,
     * which is a fact the render already guarantees.
     */
    const layout = i * w;
    const most = layout - i * SPINE_W;
    const least = layout + w + (n - 1 - i) * SPINE_W - el.clientWidth;
    const at = el.scrollLeft;
    const to = at > most ? most : at < least ? Math.min(least, most) : at;
    if (to === at) return;
    el.scrollTo({ left: Math.max(0, Math.min(to, el.scrollWidth - el.clientWidth)), behavior: 'smooth' });
  }, []);

  // The focused page comes into view when it is not — `h`/`l` land somewhere
  // readable, and a page already on screen stays exactly where it is.
  const focused = cursor && pages.includes(cursor) ? cursor : openNote;
  useEffect(() => {
    if (focused) reveal(pages.indexOf(focused));
    // `pages` is derived from the same URL state a focus change re-renders on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, pages.length, reveal]);

  /**
   * Drag-to-pan, the way the board pans: grab a margin, a header or a spine and
   * pull. Prose, links and buttons are exempt so text stays selectable and a
   * click stays a click — the 4px threshold is what tells the two apart.
   */
  const pan = useRef<{ x: number; left: number; on: boolean } | null>(null);
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('a, button, p, pre, code, li, h2')) return;
    pan.current = { x: e.clientX, left: strip.current?.scrollLeft ?? 0, on: false };
  };
  const move = (e: React.PointerEvent) => {
    const p = pan.current;
    const el = strip.current;
    if (!p || !el) return;
    const dx = e.clientX - p.x;
    if (!p.on && Math.abs(dx) > 4) {
      p.on = true;
      el.classList.add('is-panning');
      el.setPointerCapture(e.pointerId);
    }
    if (p.on) el.scrollLeft = p.left - dx;
  };
  const up = (e: React.PointerEvent) => {
    const el = strip.current;
    if (pan.current?.on && el) {
      el.classList.remove('is-panning');
      el.releasePointerCapture(e.pointerId);
    }
    pan.current = null;
  };

  return (
    <div
      className="pinstack"
      ref={strip}
      role="region"
      aria-label="Pinned notes, spread"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {pages.map((id, i) => (
        <PinPage
          key={id}
          id={id}
          meta={meta}
          // The sticky pair that makes the fold: no further left than my elders'
          // spines, no further right than my juniors'.
          left={i * SPINE_W}
          right={(pages.length - 1 - i) * SPINE_W}
          isFocus={id === focused}
          isPinned={pins.includes(id)}
          onFocus={() => onCursor(id)}
          onSpine={() => reveal(i)}
          onOpen={onOpen}
          onUnpin={() => onUnpin(id)}
          onFocusRow={onFocus}
          onUnsaved={onUnsaved}
        />
      ))}
    </div>
  );
}

function PinPage({
  id,
  meta,
  left,
  right,
  isFocus,
  isPinned,
  onFocus,
  onSpine,
  onOpen,
  onUnpin,
  onFocusRow,
  onUnsaved,
}: {
  id: string;
  meta: Meta;
  left: number;
  right: number;
  isFocus: boolean;
  isPinned: boolean;
  onFocus: () => void;
  onSpine: () => void;
  onOpen: (id: string, mods?: { altKey?: boolean; shiftKey?: boolean }) => void;
  onUnpin: () => void;
  onFocusRow: (id: string, via: string) => void;
  onUnsaved: (u: { body: boolean; frontmatter: boolean }) => void;
}) {
  const { data, error, reload } = useLive<NoteDetail>(() => api.note(id), [id]);
  const card = data?.note;
  const title = card?.title ?? id;

  /**
   * A page holds its own unsaved flags, and only the focused one reports them.
   *
   * The two are the same fact the panel tracks, for the same two consumers —
   * see `NoteCard` — and they are per page because the editors are: a page that
   * is not focused is `inert`, so its documents cannot be dirty, and one that
   * loses focus while dirty is exactly the case the report exists to catch.
   */
  const [unsaved, setUnsaved] = useState({ body: false, frontmatter: false });
  useEffect(() => {
    if (!isFocus) return;
    onUnsaved(unsaved);
    return () => onUnsaved({ body: false, frontmatter: false });
  }, [isFocus, unsaved, onUnsaved]);

  const writer = usePanelWriter({
    id,
    mtime: data?.mtime ?? null,
    reload,
    held: unsaved,
    // The note went: let the pin go with it rather than leaving a spine that
    // opens nothing. An unpinned live page simply stops being drawn.
    onGone: onUnpin,
  });
  /**
   * Only the focused page is handed the real one — see `NO_WRITES`. The hook is
   * called either way because it is a hook, and because the page it belongs to
   * becomes the focused one the moment `h` or `l` lands on it.
   */
  const write = isFocus ? writer : NO_WRITES;

  return (
    <section
      className={`pinpage ${isFocus ? 'is-focus' : ''}`}
      data-page={id}
      style={{ left, right }}
      aria-label={title}
      onPointerDown={onFocus}
    >
      <button
        className="pinpage-spine"
        data-act="spine"
        style={{ width: SPINE_W }}
        title={`${title} — slide it fully into view`}
        onClick={onSpine}
      >
        <span className="spinelabel">{title}</span>
      </button>
      <div className="pinpage-content">
        <header className="pinpage-head">
          {card && <RecordMark card={card} pinned={isPinned} />}
          <h2 className="pinpage-title">{title}</h2>
          {write.busy && <span className="panel-busy">{write.busy}…</span>}
          {isPinned && (
            <IconButton
              glyph="close"
              size="small"
              data-act="unpin"
              aria-label={`Unpin ${title}`}
              title={`Unpin "${title}" (')`}
              onClick={onUnpin}
            />
          )}
        </header>
        {write.banner && <div className={`banner is-${write.banner.tone}`}>{write.banner.message}</div>}
        {/*
          Only the focused page is actionable, and `inert` is the whole of it:
          nothing inside takes focus, a click reaches nothing, and the subtree
          leaves the tab order — which is the same "one surface a write can land
          on" the panel gets by being the only one mounted. Hints go with it,
          since a key drawn beside a row it cannot reach is naming the focused
          page's row instead.
        */}
        <div className="pinpage-scroll" inert={!isFocus}>
          {error && <div className="pane-error">{error}</div>}
          {!data && !error && <div className="pane-loading">loading…</div>}
          {data && card && (
            <KeyHints on={isFocus}>
              <NoteTiers
                id={id}
                meta={meta}
                data={data}
                write={write}
                // No wash on a page. The flush answers "this moved without you"
                // about the surface you are working on, and four of them lighting
                // up at once is a light show rather than a signal.
                lit={() => false}
                onOpen={onOpen}
                onFocus={onFocusRow}
                onBodyDirty={(d) => setUnsaved((u) => (u.body === d ? u : { ...u, body: d }))}
                onFrontmatterDirty={(d) =>
                  setUnsaved((u) => (u.frontmatter === d ? u : { ...u, frontmatter: d }))
                }
              />
            </KeyHints>
          )}
        </div>
      </div>
    </section>
  );
}
