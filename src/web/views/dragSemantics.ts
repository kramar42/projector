export { NONE } from '../../schema/vocabulary.ts';
import { NONE } from '../../schema/vocabulary.ts';

export type DragMode = 'replace' | 'add' | 'remove';

/** Which mode a drop means, from the modifier keys held at the moment of release. */
export function modeFor(input: { altKey?: boolean; shiftKey?: boolean }): DragMode {
  if (input.shiftKey) return 'remove';
  if (input.altKey) return 'add';
  return 'replace';
}

/**
 * The new values of the grouped facet after dropping a card from one column into
 * another.
 *
 * Plain drag replaces, matching Trello muscle memory. Holding ⌥ adds instead, so
 * a card deliberately sits in two columns at once; ⇧ removes only the value it
 * was dragged from. "Card in two columns" is therefore always a gesture, never
 * an accident — which is what makes a multi-valued grouping facet safe to use.
 *
 * Dropping into the uncategorised column clears the facet.
 */
export function nextValues(
  current: string[],
  from: string,
  to: string,
  mode: DragMode,
): string[] {
  const fromValue = from === NONE ? '' : from;
  const without = current.filter((v) => v !== fromValue);
  if (mode === 'remove') return without;
  if (mode === 'add') return to === NONE || current.includes(to) ? current : [...current, to];
  if (to === NONE) return without;
  return [...without.filter((v) => v !== to), to];
}
