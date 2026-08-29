/**
 * The one width the dock, the spread and the shell have to agree about.
 *
 * A spine is the sliver of a pinned note that stays reachable while reading:
 * the panel-side dock is a row of them, a spread page folds down to one at
 * either edge, and `.shell` needs the open dock's total reach for
 * `--covered-right` so the cursor never hides under it. Three readers, so the
 * number lives here and nowhere else — the sticky offsets and the dock width
 * are computed from it inline rather than stated again in the stylesheet.
 *
 * Its own module rather than a corner of `PinStack.tsx`, because the shell
 * imports it at first paint and the stack is a lazy chunk: importing the
 * constant from there would pull the markdown renderer into the shell.
 */
export const SPINE_W = 34;

/**
 * How far one `j` scrolls the focused page of the spread — a paragraph-ish
 * step. Here rather than in the dispatcher because it is the spread's own
 * measure, and here rather than in `PinStack.tsx` because the dispatcher is
 * the reader and lives in the shell chunk.
 */
export const PAGE_SCROLL = 160;

/**
 * The horizontal offset that leaves one spread page readable.
 *
 * Pure because sticky positioning is awkward enough to deserve a browser-free
 * regression test; `PinStack` supplies the live measurements and performs the
 * scroll.
 */
export function revealScroll(
  index: number,
  count: number,
  pageWidth: number,
  viewportWidth: number,
  scrollLeft: number,
  maxScroll: number,
): number {
  const layout = index * pageWidth;
  const most = layout - index * SPINE_W;
  const after = count - 1 - index;
  /*
   * The first younger page is still a whole page until normal flow reaches the
   * focused page's right edge. Only the pages behind that one have folded down
   * to spines. Reserving `after × SPINE_W` here is the tempting formula, but it
   * describes the final folded picture rather than the sticky page currently
   * painted over the title we are trying to reveal.
   */
  const rightReach = after > 0 ? pageWidth + (after - 1) * SPINE_W : 0;
  const least = layout + pageWidth + rightReach - viewportWidth;
  const target = scrollLeft > most ? most : scrollLeft < least ? Math.min(least, most) : scrollLeft;
  return Math.max(0, Math.min(target, maxScroll));
}
