/** A stroke as the cheatsheet needs to draw it — no browser event required. */
export interface CheatsheetStroke {
  key: string;
  altKey: boolean;
}

/** The event facts practice mode needs, deliberately narrower than the DOM type. */
export interface CheatsheetKeyEvent {
  key: string;
  code: string;
  altKey: boolean;
  shiftKey: boolean;
}

/** The small, browser-provided part of a keyboard layout map we need. */
export interface KeyboardLayout {
  get(code: string): string | undefined;
}

/**
 * Translate a browser event into the keyboard grammar's stable spelling.
 *
 * `event.key` is the character a keyboard layout produced and is therefore the
 * right answer for ordinary and Shift strokes — Dvorak's physical J key is `h`,
 * not `j`. macOS is the deliberate exception for Option: it turns ⌥J into `∆`
 * and ⌥1 into `¡`. Option digits remain physical, but letters resolve through
 * the active layout map so Dvorak's labelled J is both recognised and displayed
 * as J rather than as its QWERTY position.
 */
export function cheatsheetStrokeOf(event: CheatsheetKeyEvent, layout?: KeyboardLayout): CheatsheetStroke {
  if (!event.altKey) return { key: event.key, altKey: false };
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter) {
    const labelled = layout?.get(event.code)?.toLowerCase();
    return { key: labelled && /^[a-z]$/.test(labelled) ? labelled : letter[1]!.toLowerCase(), altKey: true };
  }
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) return { key: digit[1]!, altKey: true };
  return { key: event.key, altKey: true };
}

/** Render one key consistently: shifted letter bindings always show their modifier. */
export function cheatsheetKeyLabel(key: string): string {
  const glyph = { Enter: '⏎', Backspace: '⌫', Escape: 'esc' }[key] ?? key;
  return /^[A-Z]$/.test(glyph) ? `⇧${glyph}` : glyph;
}

/** The reader-facing name of the last key pressed in the practice sheet. */
export function cheatsheetStrokeLabel({ key, altKey }: CheatsheetStroke): string {
  return `${altKey ? '⌥' : ''}${cheatsheetKeyLabel(key)}`;
}

/**
 * Whether one printed key pattern can answer this stroke.
 *
 * `KEYMAP` includes both literal keys and templates filled by a vault's
 * `key:` letters. Keeping the recognition beside the sheet gives practice mode
 * one small, pure vocabulary rather than borrowing the dispatcher and risking a
 * training keystroke doing the thing it is meant to explain.
 */
function matchesToken(token: string, stroke: CheatsheetStroke, axisKeys: readonly string[]): boolean {
  if (token.startsWith('⌥')) {
    return stroke.altKey && matchesToken(token.slice(1), { ...stroke, altKey: false }, axisKeys);
  }
  if (stroke.altKey) return false;

  const lower = stroke.key.toLowerCase();
  const isAxis = axisKeys.includes(lower);
  if (token === '⟨axis⟩' || token === '⟨axis⟩⟨axis⟩') {
    return isAxis;
  }
  // Shift changes which end of an axis command the dispatcher reaches, not the
  // axis itself. In practice mode either case should therefore light every
  // pattern for that facet and train the same physical key.
  if (token === '⇧⟨axis⟩') return isAxis;
  if (token === '1–9') return /^[1-9]$/.test(stroke.key);
  if (token === '⏎') return stroke.key === 'Enter';
  if (token === '⌫') return stroke.key === 'Backspace';

  // `gg` is a sequence, but its first key deserves to show the reader what can
  // follow. The literal `G` is still separate because casing is meaningful.
  return token === stroke.key || (token.length > 1 && token.startsWith(stroke.key));
}

/** Whether a row contains a literal or template key that could answer a stroke. */
export function matchesCheatsheetRow(
  keys: string,
  stroke: CheatsheetStroke | null,
  axisKeys: readonly string[],
): boolean {
  return stroke !== null && keys.split(' ').some((token) => matchesToken(token, stroke, axisKeys));
}
