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

/** At two spine widths, prose gives way to the page's compact title. */
export const PAGE_COMPACT_W = SPINE_W * 2;

/** Whether the painted part of a fixed-width page is only a folded sliver. */
export function isCompactPage(exposedWidth: number): boolean {
  return exposedWidth <= PAGE_COMPACT_W;
}

/**
 * How much of each fixed-width spread page is actually painted unobscured.
 *
 * Sticky pages overlap rather than resize. Later siblings paint over earlier
 * ones, so a page ends at the next page's left edge even though its DOM rect
 * remains full width. Keeping this geometry pure makes the spine/content switch
 * follow what a reader can see instead of what `offsetWidth` keeps reporting.
 */
export function exposedPageWidths(
  pages: readonly { left: number; right: number }[],
  viewport: { left: number; right: number },
): number[] {
  return pages.map((page, i) => {
    const younger = pages[i + 1];
    const left = Math.max(page.left, viewport.left);
    const right = Math.min(page.right, viewport.right, younger?.left ?? Infinity);
    return Math.max(0, right - left);
  });
}

/** The spread's pages in drawing order. */
export function stackPages(pins: readonly string[], openNote: string | null): string[] {
  if (!openNote) return [...pins];
  // Membership and placement are different facts. A pin promoted into the open
  // slot keeps its place in `?pins=` but leaves the run while it occupies the
  // trailing slot; replacing or closing it therefore restores the old order.
  return [...pins.filter((id) => id !== openNote), openNote];
}

/** Where focus lands when a page disappears from the spread. */
export function afterRemovingPage(pages: readonly string[], removed: string): string | null {
  const at = pages.indexOf(removed);
  if (at === -1) return pages[pages.length - 1] ?? null;
  return pages[at + 1] ?? pages[at - 1] ?? null;
}

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
