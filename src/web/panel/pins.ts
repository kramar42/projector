/**
 * The one width the dock, the spread and the shell have to agree about.
 *
 * A spine is the sliver of a pinned note that never leaves the screen: the
 * dock is a row of them, a spread page folds down to one at either edge, and
 * `.shell` needs the dock's total reach for `--covered-right` so the cursor
 * never hides under it. Three readers, so the number lives here and nowhere
 * else — the sticky offsets and the dock width are computed from it inline
 * rather than stated again in the stylesheet.
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
