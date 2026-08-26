import { useCallback, useEffect, useRef, useState } from 'react';

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
 * open it shows the cursor's card, so motion flips the panel down the list, and
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
 * a filter, a regroup, a re-sort, an agent writing a card in another window. An
 * id survives all four, and `motion.ts` re-derives the position from it. When the
 * card genuinely leaves the view, `stepped` answers with the first drawn row
 * rather than nothing, so the failure mode is "the cursor goes home" instead of
 * "the arrow keys stopped working".
 */

/**
 * The trail, which is a jumplist and not a history.
 *
 * `j` and `k` do **not** record. Vim's jumplist works the same way and for the
 * same reason: if every step were a stop, walking down a column of forty would
 * bury the one place you actually want to get back to. What records is a *jump* —
 * following a reference out of the card you were reading, which is the only way
 * the cursor moves somewhere it cannot walk back from.
 *
 * That makes `H` mean exactly one thing: **the card I came from**. Which is the
 * whole of "follow a ref, change something on that card, and come back".
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
 */
export function useCursorFocus(
  ref: { current: HTMLElement | null },
  isCursor: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!isCursor || !el) return;
    // `nearest`, so a cursor already on screen does not scroll the column under
    // it. A board scrolls in both directions and a table in one.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const active = document.activeElement as HTMLElement | null;
    const idle = !active || active === document.body || active.hasAttribute('data-card');
    if (idle) el.focus({ preventScroll: true });
    // The ref is stable for the life of the element; `isCursor` is the question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCursor]);
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
   * a silent no-op — which is exactly what `pp` was on an axis the card carries
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
