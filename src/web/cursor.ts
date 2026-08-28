import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Where the keyboard is.
 *
 * Called the *cursor* rather than the focus, because `focus` already means two
 * other things here: `spec.query.focus` is a traversal — pick a note and walk
 * edges from it — and `:focus-visible` is the browser's. Three meanings for one
 * word in one file is how a rename goes wrong six months later.
 *
 * It is **the only pointer**. `?note=` is described in `query.ts` as "where you
 * are looking, not what you are looking at", and that is this: with the panel
 * open it shows the cursor's note, so motion flips the panel down the list, and
 * following a reference simply moves the cursor. There is no second pointer to
 * keep in step, and so no rule about which of the two a write lands on.
 *
 * ## Why it is state and not a URL parameter
 *
 * `selection.ts` already settled the same question for the click anchor: it is
 * "the one piece of genuinely transient state — where the *last click* landed,
 * which no URL should carry". A cursor is that. A shared link that dropped you at
 * someone else's cursor position would be noise, and `?note=` already carries the
 * part that is worth sharing.
 *
 * ## Why it is an id and not an index
 *
 * An index is a fact about a result set, and the result set changes under you —
 * a filter, a regroup, a re-sort, an agent writing a note in another window. An
 * id survives all four, and `motion.ts` re-derives the position from it. When the
 * note genuinely leaves the view, `stepped` answers with the first drawn row
 * rather than nothing, so the failure mode is "the cursor goes home" instead of
 * "the arrow keys stopped working".
 */

/**
 * The trail, which is a jumplist and not a history.
 *
 * `j` and `k` do **not** record. Vim's jumplist works the same way and for the
 * same reason: if every step were a stop, walking down a column of forty would
 * bury the one place you actually want to get back to. What records is a *jump* —
 * following a reference out of the note you were reading, which is the only way
 * the cursor moves somewhere it cannot walk back from.
 *
 * That makes `H` mean exactly one thing: **the note I came from**. Which is the
 * whole of "follow a ref, change something on that note, and come back".
 */
export interface Cursor {
  id: string | null;
  /** Move without recording — motion keys, and a click. */
  step: (id: string | null) => void;
  /** Move and record where we were: following a reference. */
  jump: (id: string) => void;
  /** Walk the trail. `-1` is back. Returns where it landed, or `null` for nowhere. */
  travel: (delta: 1 | -1) => string | null;
}

export function useCursor(): Cursor {
  const [id, setId] = useState<string | null>(null);
  /**
   * Behind and ahead, as two stacks — the shape a back/forward pair always is.
   *
   * In a ref rather than in state because nothing renders from them: the trail is
   * consulted when `H` is pressed and is invisible the rest of the time, so
   * putting it in state would re-render the whole shell on every jump to change
   * nothing on screen.
   */
  const behind = useRef<string[]>([]);
  const ahead = useRef<string[]>([]);
  const at = useRef<string | null>(null);
  at.current = id;

  const step = useCallback((next: string | null) => setId(next), []);

  const jump = useCallback((next: string) => {
    const from = at.current;
    if (from === next) return;
    if (from) behind.current.push(from);
    // A new jump abandons the forward stack, exactly as a browser's does — the
    // alternative is a "forward" that leads somewhere you never went from here.
    ahead.current = [];
    // Capped, because this is a convenience and not a record. Fifty is far past
    // what anyone walks back through and far short of what would be worth
    // worrying about holding.
    if (behind.current.length > 50) behind.current.shift();
    setId(next);
  }, []);

  const travel = useCallback((delta: 1 | -1) => {
    const from = delta === -1 ? behind.current : ahead.current;
    const to = delta === -1 ? ahead.current : behind.current;
    const next = from.pop();
    if (next === undefined) return null;
    if (at.current) to.push(at.current);
    setId(next);
    // The id rather than a flag, because the caller has to mirror it into the
    // open panel and cannot read `id` back until the next render.
    return next;
  }, []);

  return { id, step, jump, travel };
}

/**
 * Put the browser's focus where the cursor is.
 *
 * Real DOM focus rather than a drawn ring plus `aria-activedescendant`, and the
 * three things it buys are the argument: `scrollIntoView` on an element that is
 * genuinely focused, a `:focus-visible` ring the app already defines once, and
 * `Enter` meaning activate without anything being bound. It is also what turns
 * the tile from a `div` with an `onClick` into something a screen reader can
 * reach, which was the first of NEXT.md's four markup items.
 *
 * **Focus is only taken from something that is not using it.** A cursor move with
 * the panel open would otherwise yank focus out of whatever control was being
 * used — the panel is non-modal, so both are live at once — and stealing focus
 * mid-edit is worse than a cursor you cannot see. The body, nothing, and another
 * card are the three cases where nobody is using it.
 *
 * ## Why a pointer gets the focus without the scroll
 *
 * The scroll is for motion keys, and only they need it: `l` can walk onto a card
 * that is on screen only in the sense that its coordinates are, which is what the
 * `scroll-padding` in `style.css` is measured for. **A pointer cannot do that.**
 * Whatever was clicked was visible, or there was nothing there to click.
 *
 * And the same click opens the panel, which is a cover — so the aim it hands
 * `scrollIntoView` is `scroll-padding-right: --panel-w` against a board that has
 * just grown a `--panel-w` spacer to scroll into. A card clicked under where the
 * panel lands was therefore hauled clear of it: `?view=home` at `scrollLeft: 0`,
 * click the card at `877…1151`, and the board is at `434` with the card at `443`
 * — the whole view sliding out from under the pointer that opened it. Nothing had
 * reflowed; the click had asked to be scrolled to.
 *
 * So the caller says a pointer did it, by calling the returned function before it
 * moves the cursor. It disarms itself on use and on the cursor leaving, so a
 * click on the card the cursor is *already* on cannot leave the next `k` back
 * onto it silently refusing to scroll.
 *
 * @returns Say that a pointer is what is about to move the cursor here.
 */
export function useCursorFocus(
  ref: { current: HTMLElement | null },
  isCursor: boolean,
): () => void {
  const pointed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!isCursor || !el) {
      pointed.current = false;
      return;
    }
    const byPointer = pointed.current;
    pointed.current = false;
    // `nearest`, so a cursor already on screen does not scroll the column under
    // it. A board scrolls in both directions and a table in one.
    if (!byPointer) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const active = document.activeElement as HTMLElement | null;
    const idle = !active || active === document.body || active.hasAttribute('data-card');
    if (idle) el.focus({ preventScroll: true });
    // The ref is stable for the life of the element; `isCursor` is the question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCursor]);

  return useCallback(() => {
    pointed.current = true;
  }, []);
}

/**
 * Declare how far something floating over a surface reaches into it.
 *
 * `useCursorFocus` leans on `scrollIntoView`, which calls an element in view when
 * it is inside the scrollport — and a scrollport is a box, not a picture. A sticky
 * table head or a floating bulk bar is painted over that box without displacing it,
 * so `nearest` sees nothing wrong and leaves the cursor's card half under it. CSS
 * has the lever for exactly this in `scroll-padding`; what it does not have is the
 * number, because the number is a measurement.
 *
 * So the cover measures itself. What it writes is its **reach** — from the host's
 * edge to its own far side — rather than its height, so the 16px the bulk bar sits
 * above the bottom is counted without being written down a second time here.
 *
 * It lands on the host rather than on a scroller because a custom property
 * inherits: one write on `.board-wrap` serves `.board-scroll` and every
 * `.column-body` inside it, and neither has to know what is floating over it.
 *
 * Removed on unmount, which is what makes the clearance last exactly as long as the
 * thing that needs it — the bar goes and the padding goes with it, rather than a
 * board keeping a 56px dead zone for a selection that no longer exists.
 *
 * A **layout** effect, and that is the load-bearing part rather than a preference.
 * `useCursorFocus` is a passive effect on a card, which is a *child* of the surface
 * measured here — and passive effects run child before parent, so on the commit that
 * mounts a table with the cursor already somewhere, the scroll would happen before
 * the padding existed and land the row under the head after all. Every layout effect
 * runs before any passive one, which is the ordering this needs.
 */
export function useEdgeInset(
  cover: { current: HTMLElement | null },
  side: 'top' | 'bottom',
  /**
   * Where to write it. Defaults to the cover's parent, which is what a thing
   * floating over a surface is a child of — so the bulk bar names nothing and the
   * table head, whose parent is the `<table>` and not the scroller, names the wrap.
   */
  host?: { current: HTMLElement | null },
): void {
  useLayoutEffect(() => {
    const el = cover.current;
    const on = host?.current ?? el?.parentElement;
    if (!el || !on) return;
    const prop = side === 'top' ? '--covered-top' : '--covered-bottom';
    const write = (): void => {
      const c = el.getBoundingClientRect();
      const h = on.getBoundingClientRect();
      const reach = side === 'top' ? c.bottom - h.top : h.bottom - c.top;
      // Never negative: a cover that has scrolled clear of the edge covers nothing,
      // and a negative padding would pull the aim past the edge instead.
      on.style.setProperty(prop, `${Math.max(0, Math.round(reach))}px`);
    };
    write();
    // Both boxes. The cover's size is what it takes — a bulk bar wraps to two rows
    // once a facet has enough values — and the host's edge is where it is taken
    // from, which a resized window moves without touching the cover.
    const observer = new ResizeObserver(write);
    observer.observe(el);
    observer.observe(on);
    return () => {
      observer.disconnect();
      on.style.removeProperty(prop);
    };
    // The refs are stable for the life of their elements, and a cover does not
    // change which edge it sits on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);
}

/**
 * Focus the first match, once it exists.
 *
 * A popover is a portal behind a state change and a revealed facet row is a
 * re-render, so neither is in the document at the moment the thing that creates
 * it is clicked. `requestAnimationFrame` is the obvious way to wait and the wrong
 * one: a frame is only promised to a tab that is *painting*, so in a background
 * window the callback simply never runs and the key silently does nothing.
 *
 * Try immediately — React flushes a discrete event synchronously, so this is
 * usually the attempt that wins — then on the macrotask queue, which runs whether
 * or not anything is being painted. It gives up rather than leaving a timer
 * looking for an element that is never coming.
 */
export function focusSoon(
  find: () => HTMLElement | null | undefined,
  tries = 3,
  /**
   * What to do when it never turns up.
   *
   * A search that can fail has to be able to say so, or the key it belongs to is
   * a silent no-op — which is exactly what `pp` was on an axis the note carries
   * nothing for: the row never appeared, the retries ran out, and nothing on
   * screen changed or explained why.
   */
  orElse?: () => void,
): void {
  const el = find();
  if (el) return el.focus();
  if (tries > 0) setTimeout(() => focusSoon(find, tries - 1, orElse), 16);
  else orElse?.();
}
