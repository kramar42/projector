/**
 * How wide a note is drawn — the open panel and every page of the spread alike.
 *
 * A named step rather than a pixel count, and the names are all this module
 * knows. The widths themselves live in the stylesheet as `--panel-w` under
 * `:root[data-panel-width]`, because `--panel-w` is already the one token the
 * panel, the pin dock, a spread page and the cursor's `--covered-right` agree
 * about; a number here as well would be a second answer to the same question
 * (C11).
 *
 * Steps rather than a drag: a step is a keystroke (`-` / `=`), so the keyboard
 * reaches it as a pointer does, and a short closed set keeps the spread's
 * geometry one of a few known shapes rather than any width a hand left it at.
 *
 * Pure apart from the two storage helpers at the end, which is what lets
 * `node --test` load it.
 */
export const PANEL_WIDTHS = ['narrow', 'default', 'wide', 'widest'] as const;

export type PanelWidth = (typeof PANEL_WIDTHS)[number];

/** The step a reader starts on, and the one `:root` draws with no attribute. */
export const DEFAULT_PANEL_WIDTH: PanelWidth = 'default';

/**
 * One step wider (`1`) or narrower (`-1`).
 *
 * The keys stop at either end — pressing `=` on the widest step is a no-op, so
 * holding it down lands somewhere you can predict. The panel's button `wrap`s,
 * because it is one control for both directions and a dead end would leave it
 * unable to come back.
 */
export function stepPanelWidth(from: PanelWidth, delta: 1 | -1, wrap = false): PanelWidth {
  const at = PANEL_WIDTHS.indexOf(from) + delta;
  const n = PANEL_WIDTHS.length;
  if (wrap) return PANEL_WIDTHS[(at + n) % n]!;
  return PANEL_WIDTHS[Math.max(0, Math.min(n - 1, at))]!;
}

/** Whatever storage held, read as a step — anything unrecognised is the default. */
export function parsePanelWidth(raw: string | null | undefined): PanelWidth {
  return (PANEL_WIDTHS as readonly string[]).includes(raw ?? '') ? (raw as PanelWidth) : DEFAULT_PANEL_WIDTH;
}

const KEY = 'projector.panelWidth';

/**
 * Per browser, deliberately. A width is a fact about the screen you read on, not
 * about the vault — a laptop and a second monitor want different answers — so it
 * is not written into the vault, and it is not a query, so it is not in the URL
 * (C9). Storage can throw (a private window, blocked site data), and a width that
 * failed to persist is still a width, so both sides swallow it.
 */
export function loadPanelWidth(): PanelWidth {
  try {
    return parsePanelWidth(globalThis.localStorage?.getItem(KEY));
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

export function savePanelWidth(width: PanelWidth): void {
  try {
    if (width === DEFAULT_PANEL_WIDTH) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, width);
  } catch {
    /* see above */
  }
}
