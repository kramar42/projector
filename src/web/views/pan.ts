/**
 * Trello's board pan: press on the background, drag horizontally, the board
 * scrolls. With swimlanes, it scrolls in both directions. Press-and-drag already means something on the things of the board —
 * a card drags to move it — so panning belongs to everything that is *not* one:
 * the gaps between columns, a column's empty tail, the headers.
 *
 * The decisions live in the two pure exports; `attachPan` is only the wiring.
 */

/**
 * What a press must not start a pan on: anything that is itself pressable.
 * Cards drag (pragmatic-drag-and-drop owns that gesture), and controls click —
 * a pan stealing either would break the gesture the reader actually made.
 */
export const PAN_EXEMPT =
  '.column-card, .newcard, button, a, input, textarea, select, [contenteditable="true"]';

/**
 * A pan engages after 4px of horizontal travel, not on the press.
 *
 * The threshold is what keeps a plain click a click: without it, the press
 * half of every click on the background would capture the pointer and the
 * release would arrive marked as the end of a zero-length drag. Horizontal
 * only on a one-axis board, because its columns scroll themselves. Swimlanes
 * make the board itself vertically scrollable, so the same hand gesture owns
 * that axis there too.
 */
export const PAN_THRESHOLD = 4;

export function panEngages(dx: number, dy = 0, vertical = false): boolean {
  return Math.abs(dx) >= PAN_THRESHOLD || (vertical && Math.abs(dy) >= PAN_THRESHOLD);
}

/** Wire the gesture onto the scroll container. Returns the detach. */
export function attachPan(el: HTMLElement, options: { vertical?: boolean } = {}): () => void {
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(PAN_EXEMPT)) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    let engaged = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!engaged) {
        if (!panEngages(dx, dy, options.vertical)) return;
        engaged = true;
        el.classList.add('is-panning');
        // Captured only once the pan is real, so an un-engaged press still
        // delivers its click to whatever it was on. Guarded: capture can
        // refuse (a pointer already gone), and the pan works without it — it
        // only pins the cursor's ownership for the ride.
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          // still panning, just uncaptured
        }
      }
      el.scrollLeft = startLeft - dx;
      if (options.vertical) el.scrollTop = startTop - dy;
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!engaged) return;
      el.classList.remove('is-panning');
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      // A drag is not a click. Swallow the one that follows this release, or
      // letting go over a card would open it. The click fires in the same
      // task as the pointerup, so the guard is gone by the next tick — it must
      // never live long enough to eat a click the reader makes on purpose.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  el.addEventListener('pointerdown', onDown);
  return () => el.removeEventListener('pointerdown', onDown);
}
