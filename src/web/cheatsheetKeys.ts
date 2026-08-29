/** A stroke as the cheatsheet needs to draw it — no browser event required. */
export interface CheatsheetStroke {
  key: string;
  altKey: boolean;
}

/** The reader-facing name of the last key pressed in the practice sheet. */
export function cheatsheetStrokeLabel({ key, altKey }: CheatsheetStroke): string {
  const glyph = { Enter: '⏎', Backspace: '⌫', Escape: 'esc' }[key] ?? key;
  return `${altKey ? '⌥' : ''}${glyph}`;
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
    return isAxis && stroke.key === lower;
  }
  if (token === '⇧⟨axis⟩') return isAxis && stroke.key !== lower;
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
