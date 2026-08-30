/** An active key stroke as the cheatsheet needs to draw it — no browser event required. */
export interface CheatsheetStroke {
  key: string;
  altKey: boolean;
  /** Whether Shift was held for the stroke; optional for older pure callers. */
  shiftKey?: boolean;
}

/** Modifiers that have their own visible families in the keyboard grammar. */
export interface CheatsheetModifiers {
  altKey: boolean;
  shiftKey: boolean;
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
    const key = labelled && /^[a-z]$/.test(labelled) ? labelled : letter[1]!.toLowerCase();
    return {
      key: event.shiftKey ? key.toUpperCase() : key,
      altKey: true,
    };
  }
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) return event.shiftKey
    ? { key: digit[1]!, altKey: true, shiftKey: true }
    : { key: digit[1]!, altKey: true };
  return { key: event.key, altKey: true };
}

/** Render one key consistently: shifted letter bindings always show their modifier. */
export function cheatsheetKeyLabel(key: string): string {
  const glyph = { Enter: '⏎', Backspace: '⌫', Escape: 'esc' }[key] ?? key;
  return /^[A-Z]$/.test(glyph) ? `⇧${glyph}` : glyph;
}

/** The reader-facing name of the active key in the practice sheet. */
export function cheatsheetStrokeLabel({ key, altKey, shiftKey }: CheatsheetStroke): string {
  const shownKey = shiftKey && /^[a-z]$/.test(key) ? key.toUpperCase() : key;
  return `${altKey ? '⌥' : ''}${cheatsheetKeyLabel(shownKey)}`;
}

/** The reader-facing name of modifiers held without a completing key. */
export function cheatsheetModifierLabel({ altKey, shiftKey }: CheatsheetModifiers): string {
  return `${altKey ? '⌥' : ''}${shiftKey ? '⇧' : ''}`;
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
  const shifted = stroke.shiftKey ?? /^[A-Z]$/.test(stroke.key);
  if (token.startsWith('⇧')) {
    if (token === '⇧⟨axis⟩') return axisKeys.includes(stroke.key.toLowerCase());
    return shifted && matchesToken(
      token.slice(1),
      { ...stroke, key: stroke.key.toUpperCase(), altKey: false, shiftKey: false },
      axisKeys,
    );
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
  if (token === '1–9') return !shifted && /^[1-9]$/.test(stroke.key);
  if (token === '⏎') return stroke.key === 'Enter';
  if (token === '⌫') return stroke.key === 'Backspace';
  if (token === 'esc') return stroke.key === 'Escape';

  // Uppercase literal keys are shifted bindings (`J`, `G`, `U`, …). A shifted
  // stroke must not also light the lowercase command on the same physical key.
  if (shifted) return /^[A-Z]$/.test(token) && token === stroke.key;

  // `gg` is a sequence, but its first key deserves to show the reader what can
  // follow. Keep this explicit: `esc` is a label for Escape, not an `e` sequence.
  return token === stroke.key || (token === 'gg' && stroke.key === 'g');
}

/** Whether a printed key belongs to a modifier family currently held alone. */
export function matchesCheatsheetModifierToken(token: string, modifiers: CheatsheetModifiers): boolean {
  return (
    (modifiers.altKey && token.startsWith('⌥')) ||
    (modifiers.shiftKey && (token.startsWith('⇧') || /^[A-Z]$/.test(token)))
  );
}

/** Whether a row contains a binding in one of the held modifier families. */
export function matchesCheatsheetModifierRow(
  keys: string,
  modifiers: CheatsheetModifiers,
): boolean {
  return keys.split(' ').some((token) => matchesCheatsheetModifierToken(token, modifiers));
}

/** Whether a row contains a literal or template key that could answer a stroke. */
export function matchesCheatsheetRow(
  keys: string,
  stroke: CheatsheetStroke | null,
  axisKeys: readonly string[],
): boolean {
  return stroke !== null && keys.split(' ').some((token) => matchesToken(token, stroke, axisKeys));
}
