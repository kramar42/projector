import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { inField } from '../view/keys.ts';
import { back, emptyTrail, forward, jumped, type Trail } from '../view/trail.ts';
import type { Spot } from './views/motion.ts';

/**
 * Where the keyboard is.
 *
 * Called the *cursor* rather than the focus, because `focus` already means two
 * other things here: `spec.query.focus` is a traversal — pick a note and walk
 * edges from it — and `:focus-visible` is the browser's. Three meanings for one
 * word in one file is how a rename goes wrong six months later.
 *
 * It is **the only actionable pointer**. With the ordinary panel open, `?note=`
 * shows the cursor's note, so motion flips the panel down the list and following
 * a reference simply moves the cursor. The spread is the deliberate exception
 * in *placement*, not in action: `?note=` becomes a stable trailing page while
 * the cursor walks every page, and writes still land on the cursor alone. The
 * open slot is context, never a second target.
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
 *
 * ## And why it carries a placement anyway
 *
 * One note can be drawn several times, so the id names *which note* and not
 * *which copy*. `at` is that second half — and it is subordinate rather than
 * equal: `locate` honours it only while the cell it names still holds the id,
 * and falls back to the first placement otherwise. So everything the paragraph
 * above claims still holds — the id is what survives a regroup — and the copy
 * you clicked is reachable, which it was not while `locate` always answered
 * with the first one.
 */

/**
 * The trail, which is a jumplist and not a history.
 *
 * `j` and `k` do **not** record. Vim's jumplist works the same way and for the
 * same reason: if every step were a stop, walking down a column of forty would
 * bury the one place you actually want to get back to.
 *
 * What records is a **jump**: a move to a note the cursor did not *step* to.
 * Following a reference, clicking a card, clicking a pinned spine, `g [` / `g ]`,
 * `gg` / `G`, opening one from the rail. What does not is one step along an
 * ordering you can see — `j k h l`, the lane keys, and walking the spread, where
 * every pinned note is already on screen and there is nothing to come back from.
 *
 * That line was drawn too narrowly for a long time: only `followCard` recorded,
 * so `H` did nothing at all for a reader who navigates by clicking, which is most
 * of them. Widening it is what makes `H` mean the thing it always claimed —
 * **the note I came from** — rather than only ever meaning "the ref I followed".
 *
 * The cap stays at fifty because steps are excluded. A cap sized for recording
 * every step would have to be small, and a small cap is flushed by one screenful
 * of `j` — emptying the trail exactly when you have been reading around the note
 * you want back.
 */
export interface Cursor {
  id: string | null;
  /**
   * Which drawn copy the keyboard is on, when something knew — a click, or a
   * step that computed one. A hint for `locate`, re-checked every render.
   */
  at: Spot | null;
  /** Move without recording — one step along an ordering you can see. */
  step: (id: string | null, at?: Spot | null) => void;
  /**
   * Move and record where we were: anything that is not such a step.
   *
   * Takes a placement for the same reason `step` does — a click knows which drawn
   * copy it landed on, and a jump that threw that away sent the cursor to the
   * first copy of a note drawn twice.
   */
  jump: (id: string, at?: Spot | null) => void;
  /** Walk the trail. `-1` is back. Returns where it landed, or `null` for nowhere. */
  travel: (delta: 1 | -1) => string | null;
}

export function useCursor(): Cursor {
  /**
   * The note and the copy of it, in one state — they change together on every
   * move, and two `useState`s would render the cursor at a placement belonging
   * to the note it was on a moment ago.
   */
  const [pos, setPos] = useState<{ id: string | null; at: Spot | null }>({ id: null, at: null });
  const id = pos.id;
  /**
   * The two stacks, in a ref because nothing renders from them: the trail is
   * consulted when `H` is pressed and is invisible the rest of the time, so
   * putting it in state would re-render the whole shell on every jump to change
   * nothing on screen.
   *
   * The arithmetic is `view/trail.ts`, beside `undo.ts` and for its reason: it is
   * pure, it is the part that goes subtly wrong, and inside this hook there was
   * no way to assert any of it.
   */
  const trail = useRef<Trail>(emptyTrail());
  const on = useRef<string | null>(null);
  on.current = id;

  const step = useCallback(
    (next: string | null, spot: Spot | null = null) => setPos({ id: next, at: spot }),
    [],
  );

  const jump = useCallback((next: string, spot: Spot | null = null) => {
    if (on.current === next) return;
    trail.current = jumped(trail.current, on.current, next);
    // `null` unless the caller genuinely knew: a followed reference may not be
    // drawn at all, and a guessed placement is a hint `locate` throws away on
    // arrival. A click did know, and passes it.
    setPos({ id: next, at: spot });
  }, []);

  const travel = useCallback((delta: 1 | -1) => {
    const walk = delta === -1 ? back : forward;
    const landed = walk(trail.current, on.current);
    if (!landed) return null;
    trail.current = landed.trail;
    setPos({ id: landed.to, at: null });
    // The id rather than a flag, because the caller has to mirror it into the
    // open panel and cannot read `id` back until the next render.
    return landed.to;
  }, []);

  return { id, at: pos.at, step, jump, travel };
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
 * Say, on the document, whether the keyboard has left the cursor (C12).
 *
 * The cursor's ring and the browser's `:focus-visible` ring are the same two
 * declarations in the same colour, and both are on screen at once the moment the
 * keyboard steps off the view: `f` puts focus on a filter value, `run` starts
 * reading `document.activeElement` to decide what `j` means, and the card the
 * cursor sat on goes on claiming the keyboard it no longer has. Two rings, one
 * keyboard, and the reader has to guess which.
 *
 * So the card keeps its place and loses the accent. `--cursor-ink` is the one
 * value all six drawings of a cursor share — a card's outline, a row's four inset
 * shadows, a spread page's top edge — so this is one attribute rather than an
 * override per surface, and the stylesheet beside `:focus-visible` is where the
 * argument is written.
 *
 * ## What counts as leaving
 *
 * **A level above does not.** A popover or a modal dialog draws *over* the plane
 * rather than beside it, so the ring underneath is context — where Escape puts you
 * back — and not a competing claim. This is the one duplication that was never
 * confusing, and the rule has to say so out loud or it takes the facet picker, the
 * ref picker and the palette with it.
 *
 * **Nothing having focus does not.** The active element is `document.body` after a
 * click on a column's background, and there `j` moves the cursor: the grid is the
 * default owner of the keyboard, so an empty focus means the cursor is live.
 *
 * **Being inside the cursor's own element does not** — a chip on the card face, a
 * link inside a spread page. The keys still reach the surface the cursor is on,
 * which is what `[data-card]` and `[data-page]` mark.
 *
 * Everything else is: a rail value, a panel row, a select, a field. Text being
 * typed is checked separately and first, because a field inside the cursor's own
 * element still takes the keystroke.
 *
 * ## Why an attribute and not state
 *
 * Focus moves on every click and every list step, and none of it changes a single
 * React tree — it changes one custom property. Putting it in state would re-render
 * the whole shell to repaint one outline. `useEdgeInset` below writes to the DOM
 * from an effect for the same reason and with the same justification: the value is
 * a fact about the document, not about a component.
 */
export function useDormantRing(): void {
  useEffect(() => {
    const root = document.documentElement;

    const away = (el: Element | null): boolean => {
      if (!el || el === document.body) return false;
      if (el.closest('[aria-modal="true"], .popover')) return false;
      if (inField(el as HTMLElement)) return true;
      return !el.closest('[data-card], [data-page]');
    };

    const say = (el: Element | null): void => {
      if (away(el)) root.dataset.keys = 'away';
      else delete root.dataset.keys;
    };

    say(document.activeElement);
    const arrived = (e: FocusEvent): void => say(e.target as Element | null);
    /**
     * Only a focus that goes *nowhere*, because `focusout` fires before the
     * matching `focusin` — so answering every one of them would read the outgoing
     * element and be corrected a moment later. A `relatedTarget` of `null` is the
     * case with no `focusin` coming: focus fell back to the document, which is the
     * grid.
     */
    const left = (e: FocusEvent): void => {
      if (!e.relatedTarget) say(null);
    };
    document.addEventListener('focusin', arrived);
    document.addEventListener('focusout', left);
    return () => {
      document.removeEventListener('focusin', arrived);
      document.removeEventListener('focusout', left);
      delete root.dataset.keys;
    };
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
