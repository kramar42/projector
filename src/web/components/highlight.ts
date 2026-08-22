import { HighlightStyle, defaultHighlightStyle } from '@codemirror/language';

/**
 * Syntax colours for the two editors, from this app's own palette.
 *
 * They were CodeMirror's defaults, which are hardcoded light-mode inks — and
 * both editors sit on `--surface`, which is `#101010` in dark. Measured in the
 * frontmatter pane against that ground: every YAML key rendered `#221199` at
 * **1.46:1**, the `:` separators `#404740` at 1.99:1, and quoted values `#aa1111`
 * at 2.53:1. The key column of the one pane the app calls its escape hatch was
 * effectively invisible.
 *
 * The tags come from `defaultHighlightStyle.specs` rather than from
 * `@lezer/highlight`, which this package does not depend on directly — the specs
 * carry their own `tag`, so the roles are the library's and only the colours are
 * ours. Nothing here is a new vocabulary: xoria assigns these syntax roles
 * already, and DESIGN.md's facet families are *derived* from them, so this is
 * the palette used for the thing it was designed for.
 *
 * Every value is a `var(--…)`, so one style serves both themes and there is no
 * second palette to keep in step.
 */
const ROLE: Record<string, { color?: string; fontStyle?: string; fontWeight?: string; textDecoration?: string }> = {
  // Punctuation and prose the reader is not meant to stop on.
  meta: { color: 'var(--ink-3)' },
  comment: { color: 'var(--ink-3)', fontStyle: 'italic' },
  'local(variableName)': { color: 'var(--ink-2)' },

  // Statement blue: the key column in YAML, and property definitions.
  'atom,bool,url,contentSeparator,labelName': { color: 'var(--hue-blue)' },
  'definition(propertyName)': { color: 'var(--hue-blue)' },

  // Type purple.
  keyword: { color: 'var(--hue-purple)' },
  'typeName,namespace': { color: 'var(--hue-purple)' },
  className: { color: 'var(--hue-purple)' },

  // PreProc green for strings, Number orange for literals — the two things a
  // value most often is.
  'string,deleted': { color: 'var(--hue-green)' },
  'literal,inserted': { color: 'var(--hue-orange)' },

  // Identifier pink.
  'definition(variableName)': { color: 'var(--hue-pink)' },
  'special(variableName),macroName': { color: 'var(--hue-pink)' },

  // Special red, and the one outright failure.
  'regexp,escape,special(string)': { color: 'var(--hue-red)' },
  invalid: { color: 'var(--bad)' },

  // Markdown's own shapes. A heading is not a link, so it does not wear a link's
  // underline the way the default has it.
  heading: { color: 'var(--ink)', fontWeight: '650' },
  link: { color: 'var(--accent)', textDecoration: 'underline' },
  emphasis: { fontStyle: 'italic' },
  strong: { fontWeight: '650' },
  strikethrough: { textDecoration: 'line-through' },
};

export const projectorHighlight = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec) => {
    const role = ROLE[String(spec.tag)];
    // An unmapped role keeps its shape but loses the light-mode ink, which is
    // the failure being fixed — `ink-2` is legible on every surface here.
    return { tag: spec.tag, ...(role ?? { color: 'var(--ink-2)' }) };
  }),
);
