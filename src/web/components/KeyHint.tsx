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
  return (
    <kbd className="keyhint" title={means}>
      {keys}
    </kbd>
  );
}
