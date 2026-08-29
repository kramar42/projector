import { createContext, useContext } from 'react';

/**
 * The key that reaches this control, drawn beside it.
 *
 * A cheatsheet answers "what can I press"; this answers "what reaches *that*",
 * which is the question you actually have with your hand on the keyboard and your
 * eye on a row. The two are not redundant — `?` is read once and dismissed, and
 * this is read a hundred times without stopping.
 *
 * **Absence is the point.** An axis with no `key:` draws nothing, and that is the
 * useful half: reaching for `l` to set `Layer` and finding no hint beside it is
 * how you learn the axis has no letter *before* pressing a key that means
 * something else. It was worth building for that alone.
 *
 * Quiet by construction — mono at the label step, `ink-3`, no fill. It sits on
 * every facet row in the panel and every addressable row in the rail, so at that
 * repetition anything louder becomes the thing you read first.
 */
export function KeyHint({ keys, means }: { keys: string; means: string }) {
  if (!useContext(HintsOn)) return null;
  return (
    <kbd className="keyhint" title={means}>
      {keys}
    </kbd>
  );
}

/**
 * Whether the hints are drawn at all, for a surface where they would be lying.
 *
 * The spread draws a pinned note with the same blocks the panel does, and on a
 * page that is not the focused one those keys reach *the focused page* — so a
 * hint beside a row you cannot act on names a key that will do the same thing
 * somewhere else on screen. Absence is already this component's vocabulary for
 * "no key reaches this", which is exactly what is true there.
 *
 * A context rather than a prop because the hints sit five levels down inside
 * `NoteTiers`, and a surface that suppresses them suppresses all of them.
 */
const HintsOn = createContext(true);

export function KeyHints({ on, children }: { on: boolean; children: React.ReactNode }) {
  return <HintsOn.Provider value={on}>{children}</HintsOn.Provider>;
}
