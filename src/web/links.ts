/**
 * The link kinds: what each one's prefix says, and what it draws in.
 *
 * A module rather than a corner of `CardBody`, because two components read it — a
 * card face draws `J`, the panel's link editor spells out `jira` — and a
 * vocabulary living inside one of its readers is how the two came to disagree
 * about the same kind in the first place.
 *
 * Two facts per kind in one place. It was one map of letters, with every prefix
 * painted `accent` by the stylesheet — so the app's one voice was spread across
 * eight kinds that are not the app speaking, and the colour carried nothing the
 * letters did not already carry. Now the kind is legible before the letters are,
 * which is the property the facet families exist for.
 *
 * The three `gh:` kinds share green deliberately: one host, three shapes, and
 * `PR` / `br` / `sha` separate them already. There are seven families in the
 * palette and spending three of them on one host is how a colour stops meaning
 * anything.
 *
 * Two families stay out. **Red** means a failure here, and `.linkchip.is-failed`
 * is a state every prefix has to survive without becoming an error. **Purple** is
 * the accent — the app speaking, and the note mark — which is exactly what this
 * change is spending less of.
 *
 * `url` names no family, and that is the Hints Are Hueless Rule's reasoning: it is
 * the kind for a link whose host the app does not recognise, so there is nothing
 * for a colour to say. `.linkchip b` holds the resting colour it falls back to.
 */
export const LINK_KINDS: Record<string, { glyph: string; hue?: string }> = {
  jira: { glyph: 'J', hue: 'blue' },
  'gh:pr': { glyph: 'PR', hue: 'green' },
  'gh:branch': { glyph: 'br', hue: 'green' },
  'gh:commit': { glyph: 'sha', hue: 'green' },
  claude: { glyph: 'AI', hue: 'orange' },
  workspace: { glyph: 'wt', hue: 'orange' },
  doc: { glyph: 'doc', hue: 'yellow' },
  slack: { glyph: 'sl', hue: 'pink' },
  url: { glyph: '↗' },
};

/**
 * The colour a kind draws in, as an inline style, or nothing when it names no
 * family.
 *
 * Exported because the panel's link editor states the same fact in words where a
 * face states it in letters — `jira` against `J` — and one kind having two
 * colours in two registers is the drift this map exists to prevent. Inline, like
 * a canvas edge's: the vocabulary names a family and the token knows what it
 * looks like.
 */
export function linkHue(kind: string): { color: string } | undefined {
  const hue = LINK_KINDS[kind]?.hue;
  return hue ? { color: `var(--hue-${hue})` } : undefined;
}
