import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { IconButton } from '../components/Button.tsx';
import { KeyHints } from '../components/KeyHint.tsx';
import { PinMark } from '../components/CardBody.tsx';
import { NO_WRITES, usePanelWriter } from './usePanelWriter.ts';
import { useWorkStarter } from './useWorkStarter.ts';
import { NoteTiers } from './tiers.tsx';
import { exposedPageWidths, isCompactPage, revealScroll, SPINE_W, stackPages } from './pins.ts';
import type { Meta, NoteDetail, QueryResponse } from '../types.ts';

/** The CSS aperture transition, and its deliberately half-way sibling cadence. */
const SPREAD_MS = 420;
const SPREAD_STAGGER_MS = SPREAD_MS / 2;

/**
 * The pinned notes, in their two drawn states.
 *
 * `PinDock` is the folded navigation beside an open panel: a row of vertical
 * title spines, each jumping to that pinned note. It is absent while the view
 * stands alone, where record marks already identify pins and the spines would
 * only cover the work. `PinStack` is the spread: the same pins as full-height
 * pages laid side by side over the view, each page carrying its spine as its
 * own left edge, sticking at either viewport edge instead of scrolling away —
 * so a spread wider than the window folds its ends down to titles rather than
 * losing them.
 *
 * **A page draws the note the way the panel does** — the same `NoteTiers`, so
 * the facet chips, the link kinds, the derived rows and the workshop cannot
 * come to look like a summary of a note instead of the note.
 *
 * **Exactly one page body is actionable: the focused one.** The other bodies are
 * `inert` and hide their key hints, which is the same sentence twice — a key
 * reaches the focused page, so a hint on any other would name a stroke that acts
 * somewhere else. Hidden hints retain their boxes so focus never reflows a page.
 * Page-level open and unpin controls remain controls on every
 * header; none writes note content. This keeps the cursor the only write target
 * even when `?note=` holds a separate trailing page for context (C10).
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
  openNote,
  notes,
  onOpen,
  underSpread = false,
}: {
  pins: string[];
  openNote: string;
  notes: QueryResponse['notes'];
  /** A spine click opens that note — the same act as clicking its card. */
  onOpen: (id: string) => void;
  /** Pre-mounted beneath a folding spread for a no-replacement handoff. */
  underSpread?: boolean;
}) {
  return (
    <div
      className={`pindock ${underSpread ? 'is-under-spread' : ''}`}
      aria-label="Pinned notes"
      aria-hidden={underSpread}
    >
      {pins.map((id) => (
        <DockSpine
          key={id}
          id={id}
          known={notes[id]?.title}
          isOpen={id === openNote}
          onOpen={() => onOpen(id)}
        />
      ))}
    </div>
  );
}

function DockSpine({
  id,
  known,
  isOpen,
  onOpen,
}: {
  id: string;
  known: string | undefined;
  isOpen: boolean;
  onOpen: () => void;
}) {
  const title = useTitle(id, known);
  return (
    <button
      className={`pindock-spine ${isOpen ? 'is-open' : ''}`}
      data-act="spine"
      style={{ width: SPINE_W }}
      title={`${title} — open it. " spreads every pin`}
      onClick={onOpen}
      aria-current={isOpen ? 'page' : undefined}
    >
      <span className="spinelabel">{title}</span>
    </button>
  );
}

export function PinStack({
  pins,
  openNote,
  notes,
  cursor,
  meta,
  onCursor,
  onOpen,
  onUnpin,
  onDelete,
  onMakeOpen,
  onFocus,
  onUnsaved,
  closing = false,
  onClosed,
  active = true,
  children,
}: {
  pins: string[];
  openNote: string | null;
  /** Query titles keep folded spines legible while their full notes load. */
  notes: QueryResponse['notes'];
  cursor: string | null;
  meta: Meta;
  /** Focus moved to a page. The open slot, if present, stays where it is. */
  onCursor: (id: string) => void;
  /** Follow a reference out of a page. Modifiers decide how — see `followCard`. */
  onOpen: (id: string, mods?: { altKey?: boolean; shiftKey?: boolean }) => void;
  onUnpin: (id: string) => void;
  /** The trailing open note was deleted: remove its slot and any pin together. */
  onDelete: (id: string) => void;
  /** Promote a pin into the trailing open slot without folding the spread. */
  onMakeOpen: (id: string) => void;
  /** Reshape the view around a derived row — the shell owns the query. */
  onFocus: (id: string, via: string) => void;
  /** What the focused page would lose if it were folded — the panel's guard. */
  onUnsaved: (u: { body: boolean; frontmatter: boolean }) => void;
  /** Folding is the same physical aperture sequence, in reverse. */
  closing?: boolean;
  /** The final narrow aperture has met the compact dock. */
  onClosed?: () => void;
  /** Stay mounted with the open panel while the spread itself is folded away. */
  active?: boolean;
  /** The existing open panel is the physical trailing page, never a redraw. */
  children?: ReactNode;
}) {
  // The open note is a role, not a second membership. If it is pinned too it
  // temporarily leaves the pin run and occupies the trailing slot; closing or
  // replacing it restores its original pin position without another state key.
  const allPages = useMemo(() => stackPages(pins, openNote), [pins, openNote]);
  /*
   * The open note stays mounted as the strip's trailing panel while pins unfold
   * beside it. It remains in `allPages` for keyboard order, but not in `pages`:
   * the panel is its actual page, not a second copy to keep in sync.
   */
  const pages = useMemo(() => allPages.filter((id) => id !== openNote), [allPages, openNote]);
  const strip = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const [opening, setOpening] = useState(true);
  /*
   * The opening state is geometry, not a mask over the final drawing. Starting
   * with all pages at one spine width puts the same row at the same right edge
   * as the dock. Each page then receives its real width, right to left. The
   * flex run grows into its final sticky layout, so every intermediate frame is
   * a valid (if narrow) version of the surface rather than a card teleported
   * behind a clip path.
   */
  const [unfoldingAt, setUnfoldingAt] = useState<number | null>(null);
  const [foldingAt, setFoldingAt] = useState<number | null>(null);
  // Every pin finishes as the same full-width sticky page that horizontal
  // panning uses. The entry sequence alone narrows apertures; it must not leave
  // a second, non-scrollable "some cards are really spines" layout behind.
  const expandedCount = pages.length;
  const firstExpanded = 0;
  // A command can reverse the hand while the right-to-left cascade is still
  // running. Fold the aperture that is actually moving (and then its already
  // opened neighbours), never an older planned page that is still a spine.
  const firstFolding =
    opening && unfoldingAt !== null ? Math.max(firstExpanded, unfoldingAt) : firstExpanded;
  // Dimming is one continuous context change, so it lasts no less or more than
  // the aperture cascade it accompanies, never longer just because pins exist.
  const spreadDuration = SPREAD_MS + Math.max(0, expandedCount - 1) * SPREAD_STAGGER_MS;
  const foldDuration = SPREAD_MS + Math.max(0, pages.length - 1 - firstFolding) * SPREAD_STAGGER_MS;
  // This transient class keeps the aperture transition installed on the exact
  // frame a folding stack is asked to spread again. Without it, removing the
  // closing class drops the transition declaration before the width can turn
  // around, which is the source of the visible jump on a rapid second press.
  const resuming = !closing && !opening && foldingAt !== null;

  // A spine is honest while a page is loading. Once every page has its note,
  // the already-visible spines become those pages in reading order — no page
  // ever unfolds to a `loading…` body and then changes underneath the reader.
  useEffect(() => {
    if (!active) return;
    setLoaded(new Set());
    setOpening(true);
    setUnfoldingAt(null);
  }, [active, pages.join(',')]);
  const ready = active && pages.every((id) => loaded.has(id));

  useEffect(() => {
    if (!active || !ready || closing || !opening) return;
    if (!pages.length) {
      setOpening(false);
      return;
    }
    if (!expandedCount) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setUnfoldingAt(-1);
      setOpening(false);
      return;
    }

    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const unfold = (at: number) => {
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        setUnfoldingAt(at);
        timer = setTimeout(() => {
          if (cancelled) return;
          if (at === firstExpanded) {
            // The final frame is the actual scrollable spread: every aperture
            // is whole and the strip is seated at its right-hand end, where the
            // pages nearest the anchored open note are visible first.
            setUnfoldingAt(firstExpanded - 1);
            // Let the ResizeObserver read the final real width before normal
            // fold paint is allowed back in. Without these two frames a stale
            // compact bit could briefly hide a body that has already expanded.
            frame = requestAnimationFrame(() => {
              frame = requestAnimationFrame(() => {
                const el = strip.current;
                if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
                setOpening(false);
              });
            });
            return;
          }
          unfold(at - 1);
        }, at === firstExpanded ? SPREAD_MS : SPREAD_STAGGER_MS);
      });
    };
    unfold(pages.length - 1);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [active, closing, expandedCount, firstExpanded, opening, ready, pages.length]);

  // Keep the right edge—the open note's edge—fixed while entry widths grow.
  // Once all pages have their real width, this is precisely the ordinary
  // rightmost horizontal-scroll position, not a presentation-only substitute.
  useLayoutEffect(() => {
    if (!active || !opening || unfoldingAt === null) return;
    const el = strip.current;
    if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
  }, [active, opening, unfoldingAt]);

  /*
   * Fold through the same apertures in the opposite order. The stack remains
   * mounted until the last one reaches spine width; only then can the dock take
   * over without replacing a wide card with a different element mid-frame.
   */
  useEffect(() => {
    if (!closing) {
      setFoldingAt(null);
      return;
    }
    if (!active) return;
    if (!pages.length || !expandedCount || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClosed?.();
      return;
    }

    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const fold = (at: number) => {
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        setFoldingAt(at);
        timer = setTimeout(() => {
          if (cancelled) return;
          if (at === pages.length - 1) {
            onClosed?.();
            return;
          }
          fold(at + 1);
        }, at === pages.length - 1 ? SPREAD_MS : SPREAD_STAGGER_MS);
      });
    };
    fold(firstFolding);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [active, closing, expandedCount, firstFolding, onClosed, pages.length]);
  const onLoaded = useCallback((id: string) => {
    setLoaded((current) => (current.has(id) ? current : new Set([...current, id])));
  }, []);

  /**
   * Bring page i into view — and **only** as far as it takes.
   *
   * A page is fully in view when neither edge is under a stuck neighbour. The
   * elders at the left have folded to spines, but the first younger page at the
   * right has not: until normal flow reaches the focused page's edge it is a
   * whole sticky page, with only the younger pages behind *it* reduced to
   * spines. `revealScroll` keeps that painted geometry in one tested equation.
   *
   * Seating every focused page at the left edge instead — which is what this did
   * — meant `h` and `l` dragged the whole spread sideways on every step even when
   * the page they landed on was already fully readable, so the surface never sat
   * still while you walked it. When the range is empty, because the page is wider
   * than the room between the stuck spines, the left edge wins: a title and the
   * start of the prose beat the end of it.
   */
  const reveal = useCallback((i: number, behavior: ScrollBehavior = 'auto') => {
    const el = strip.current;
    const page = el?.querySelectorAll<HTMLElement>(':scope > .pinpage')[i];
    if (!el || !page) return;
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
    const at = el.scrollLeft;
    const to = revealScroll(
      i,
      pages.length,
      w,
      el.clientWidth,
      at,
      el.scrollWidth - el.clientWidth,
    );
    if (to === at) return;
    el.scrollTo({ left: to, behavior });
  }, [pages.length]);

  // The focused page comes into view before it is painted — `h`/`l` can repeat
  // faster than a smooth scroll, and the cursor must never outrun the note it
  // identifies. A spine click below keeps the glide because it is the motion.
  const focused = cursor && allPages.includes(cursor)
    ? cursor
    : openNote && allPages.includes(openNote)
      ? openNote
      : allPages[allPages.length - 1] ?? null;
  useLayoutEffect(() => {
    if (!active || !focused) return;
    // A deep link or a pins-only spread may arrive without a cursor on one of
    // its pages. Normalise the one pointer before paint as well as the scroll.
    if (cursor !== focused) onCursor(focused);
    const at = pages.indexOf(focused);
    if (at !== -1) reveal(at);
    // `pages` is derived from the same URL state a focus change re-renders on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focused, pages.length, reveal]);

  /**
   * A card never changes width; only its presentation follows the width not
   * covered by a younger sticky page. Content keeps the whole page until only
   * two spine widths remain, then it gives way to the vertical title. CSS
   * crossfades the two layers without moving either one.
   */
  useLayoutEffect(() => {
    const el = strip.current;
    if (!active || !el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const viewport = el.getBoundingClientRect();
      const rects = [...el.querySelectorAll<HTMLElement>(':scope > .pinpage')].map((page) =>
        page.getBoundingClientRect(),
      );
      const widths = exposedPageWidths(rects, viewport);
      const next = new Set(pages.filter((_, i) => isCompactPage(widths[i] ?? 0)));
      setCompact((current) => {
        if (current.size === next.size && [...current].every((id) => next.has(id))) return current;
        return next;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    // Opening changes a page's actual width. Observe those same pages, not
    // just the viewport, so the normal fold state is already correct at the
    // moment the expansion settles — there is no final content handoff.
    [...el.querySelectorAll<HTMLElement>(':scope > .pinpage')].forEach((page) => resize.observe(page));
    return () => {
      el.removeEventListener('scroll', schedule);
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active, pages]);

  /**
   * Drag-to-pan, the way the board pans: grab a margin, a header or a spine and
   * pull. Prose, links and buttons are exempt so text stays selectable and a
   * click stays a click — the 4px threshold is what tells the two apart.
   */
  const pan = useRef<{ x: number; left: number; on: boolean } | null>(null);
  const down = (e: React.PointerEvent) => {
    if (!active || e.button !== 0) return;
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
      className={`pinstack ${active ? '' : 'is-inactive'} ${openNote ? 'is-anchored' : ''} ${opening || resuming ? 'is-opening' : ''} ${
        opening && ready && expandedCount > 0 && unfoldingAt !== null ? 'is-spreading' : ''
      } ${closing ? 'is-closing' : ''} ${resuming ? 'is-resuming' : ''}`}
      ref={strip}
      style={{
        ['--spine-w' as string]: `${SPINE_W}px`,
        ['--pinspread-dim-ms' as string]: `${closing ? foldDuration : spreadDuration}ms`,
      }}
      role="region"
      aria-label="Pinned notes, spread"
      inert={closing}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {active && pages.map((id, i) => (
        <PinPage
          key={id}
          id={id}
          known={notes[id]?.title}
          meta={meta}
          // The sticky pair that makes the fold: no further left than my elders'
          // spines, no further right than my juniors'.
          left={i * SPINE_W}
          // The trailing panel has a real flex width, so it needs no synthetic
          // spine reservation here. Its own sticky geometry takes the right
          // edge; the pins retain exactly the offsets horizontal panning uses.
          right={(pages.length - 1 - i) * SPINE_W}
          entry={
            !ready || !expandedCount || unfoldingAt === null || i < firstExpanded
              ? 'folded'
              : i === unfoldingAt
                ? 'unfolding'
                : 'unfolded'
          }
          exit={
            !closing || foldingAt === null
              ? 'open'
              : i < foldingAt
                ? 'folded'
                : i === foldingAt
                  ? 'folding'
                  : 'open'
          }
          keptFolded={false}
          isFocus={id === focused}
          isPinned={pins.includes(id)}
          isOpen={id === openNote}
          isCompact={(!closing && opening) || compact.has(id)}
          onLoaded={() => onLoaded(id)}
          onFocus={() => onCursor(id)}
          onSpine={() => {
            onCursor(id);
            reveal(i, 'smooth');
          }}
          onMakeOpen={() => onMakeOpen(id)}
          onOpen={onOpen}
          onUnpin={() => onUnpin(id)}
          onDelete={() => onDelete(id)}
          onFocusRow={onFocus}
          onUnsaved={onUnsaved}
        />
      ))}
      {children}
    </div>
  );
}

function PinPage({
  id,
  known,
  meta,
  left,
  right,
  entry,
  exit,
  keptFolded,
  isFocus,
  isPinned,
  isOpen,
  isCompact,
  onLoaded,
  onFocus,
  onSpine,
  onMakeOpen,
  onOpen,
  onUnpin,
  onDelete,
  onFocusRow,
  onUnsaved,
}: {
  id: string;
  known: string | undefined;
  meta: Meta;
  left: number;
  right: number;
  /** A real page grows from the dock spine into this same final page. */
  entry: 'folded' | 'unfolding' | 'unfolded';
  /** The same page contracts back into the dock spine. */
  exit: 'open' | 'folding' | 'folded';
  /** This older pin remains in the left-edge spine run at rest. */
  keptFolded: boolean;
  isFocus: boolean;
  isPinned: boolean;
  isOpen: boolean;
  isCompact: boolean;
  /** The parent waits for complete pages before the spines unfold. */
  onLoaded: () => void;
  onFocus: () => void;
  onSpine: () => void;
  onMakeOpen: () => void;
  onOpen: (id: string, mods?: { altKey?: boolean; shiftKey?: boolean }) => void;
  onUnpin: () => void;
  onDelete: () => void;
  onFocusRow: (id: string, via: string) => void;
  onUnsaved: (u: { body: boolean; frontmatter: boolean }) => void;
}) {
  const { data, error, reload } = useLive<NoteDetail>(() => api.note(id), [id]);
  const card = data?.note;
  const title = card?.title ?? known ?? id;
  useEffect(() => {
    if (data || error) onLoaded();
  }, [data, error, onLoaded]);

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
    onGone: isOpen ? onDelete : onUnpin,
  });
  const work = useWorkStarter({ id, title });
  // Pinned already, so the mark's toggle can only be letting it go — which is
  // the same call the live-page `onGone` makes when the note itself disappears.
  const onTogglePin = onUnpin;
  /**
   * Only the focused page is handed the real one — see `NO_WRITES`. The hook is
   * called either way because it is a hook, and because the page it belongs to
   * becomes the focused one the moment `h` or `l` lands on it.
   */
  const write = isFocus && !isCompact ? writer : NO_WRITES;
  const isEntryFolded = entry === 'folded';
  const isUnfolding = entry === 'unfolding';
  const isFolded = keptFolded || isEntryFolded || isCompact;
  const isExitFolding = exit === 'folding';
  const isExitFolded = exit === 'folded';

  return (
    <section
      className={`pinpage ${isFocus ? 'is-focus' : ''} ${isFolded ? 'is-compact' : ''} ${
        isEntryFolded ? 'is-entry-folded' : ''
      } ${keptFolded ? 'is-kept-folded' : ''} ${isUnfolding ? 'is-unfolding' : ''} ${isExitFolding ? 'is-exit-folding' : ''} ${
        isExitFolded ? 'is-exit-folded' : ''
      }`}
      data-page={id}
      style={{ left, right }}
      aria-label={isOpen ? `Open note: ${title}` : title}
      onPointerDown={onFocus}
    >
      <button
        className="pinpage-spine"
        data-act="spine"
        style={{ width: SPINE_W }}
        title={`${title} — slide it fully into view`}
        onClick={onSpine}
        disabled={!isFolded}
        aria-hidden={!isFolded}
        tabIndex={isFolded ? 0 : -1}
      >
        <span className="spinelabel">{title}</span>
      </button>
      {/*
        `inert` rather than `aria-hidden`, which is what this was: a folded page
        is a spine, and its head kept a Delete button that a Tab could still
        reach and press on a note nobody could see. `inert` says the one thing
        meant by both — not here — and says it to the pointer, the tab order and
        the accessibility tree at once.
      */}
      <div className="pinpage-content" inert={isFolded || isUnfolding}>
        <header className="pinpage-head">
          {/* The mark is the pin control here too, so a page carries the fact
              and its reversal in one place — which is what let the trailing
              `unpin` button go: it was the same act drawn twice on one head. */}
          {card && (
            <PinMark card={card} title={title} pinned={isPinned} onToggle={onTogglePin} />
          )}
          <h2 className="pinpage-title">{title}</h2>
          {(writer.busy ?? work.busy) && <span className="panel-busy">{writer.busy ?? work.busy}…</span>}
          {/*
            The same corner the panel draws, in the same order and the same
            group — see `.panel-acts` in `NotePanel`. The open slot *is* the
            panel's note by another name, so the two heads answering differently
            was the inconsistency this pass exists to remove: what you can do to
            the note you are reading may not depend on which surface is drawing
            it. Every other page gets the pair that acts on its *pinned-ness*
            instead: send it to the slot, or let it go.
          */}
          <div className="panel-acts">
            {isOpen ? (
              <>
                <IconButton
                  glyph="start"
                  size="normal"
                  extra="panel-x"
                  data-act="work"
                  disabled={!!work.busy}
                  aria-label={`Start work on ${title}`}
                  title={`Start work on "${title}" — a worktree workspace and a Claude session (!)`}
                  onClick={work.start}
                />
                <IconButton
                  glyph="trash"
                  tone="danger"
                  size="normal"
                  extra="panel-x"
                  data-act="delete"
                  aria-label={`Delete ${title}`}
                  title={`Delete "${title}" — the file is in git, so it can be recovered (⌫)`}
                  onClick={() => {
                    if (!confirm(`Delete "${title}"?\n\nThe file is in git, so this is recoverable.`)) return;
                    writer.remove();
                  }}
                />
              </>
            ) : (
              <IconButton
                glyph="open"
                size="normal"
                extra="panel-x"
                data-act="open"
                title={`Open "${title}" at the right (o)`}
                aria-label={`Open ${title} at the right`}
                onClick={onMakeOpen}
              />
            )}
          </div>
        </header>
        {(writer.banner ?? work.banner) && (
          <div className={`banner is-${(writer.banner ?? work.banner)!.tone}`}>
            {(writer.banner ?? work.banner)!.message}
          </div>
        )}
        {/*
          Only the focused page is actionable, and `inert` is the whole of it:
          nothing inside takes focus, a click reaches nothing, and the subtree
          leaves the tab order — which is the same "one surface a write can land
          on" the panel gets by being the only one mounted. Hints become invisible
          with it, but keep their boxes so moving focus does not move the labels.
        */}
        <div className="pinpage-scroll" inert={!isFocus || isCompact}>
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
