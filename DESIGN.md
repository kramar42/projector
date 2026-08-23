---
name: projector
description: A dense, still, text-first work surface — terminal grammar drawn with drafting precision.
colors:
  ground: "#080808"
  surface: "#101010"
  surface-2: "#1a1a1a"
  surface-3: "#262626"
  ink: "#dddddd"
  ink-2: "#bbbbbb"
  ink-3: "#999999"
  rule: "#262626"
  rule-2: "#444444"
  dot: "#323232"
  accent: "#a6a6e7"
  accent-soft: "#2a2a3c"
  ok: "#afdf87"
  warn: "#dfdf87"
  bad: "#df8787"
  hue-red: "#df8787"
  hue-orange: "#dfaf87"
  hue-yellow: "#dfdf87"
  hue-green: "#afdf87"
  hue-blue: "#87afdf"
  hue-purple: "#a6a6e7"
  hue-pink: "#dfafdf"
  hue-red-bg: "#3c2a2a"
  hue-orange-bg: "#3c322a"
  hue-yellow-bg: "#3c3c2a"
  hue-green-bg: "#323c2a"
  hue-blue-bg: "#2a363c"
  hue-purple-bg: "#2a2a3c"
  hue-pink-bg: "#3c2a3c"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "22px"
    fontWeight: 650
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  lg:
    fontSize: "15px"
  root:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    lineHeight: 1.45
  lede:
    fontSize: "13.5px"
    lineHeight: 1.55
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.35
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12.5px"
    lineHeight: 1.45
  body-sm:
    fontSize: "12px"
    lineHeight: 1.4
  sm:
    fontSize: "11.5px"
  xs:
    fontSize: "11px"
  meta:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "10.5px"
    letterSpacing: "0.08em"
  chip:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "10px"
    letterSpacing: "0.01em"
  label:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "9.5px"
    fontWeight: 500
    letterSpacing: "0.1em"
  micro:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "9px"
    letterSpacing: "0.04em"
rounded:
  xs: "2px"
  sm: "3px"
  md: "4px"
  base: "5px"
  lg: "6px"
  badge: "7px"
  xl: "8px"
  pill: "10px"
spacing:
  hair: "1px"
  tight: "4px"
  snug: "6px"
  stack: "7px"
  base: "8px"
  gutter: "12px"
  lane: "14px"
  panel: "18px"
  page: "20px"
components:
  button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.base}"
    padding: "5px 10px"
  button-hover:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ground}"
    typography: "{typography.body}"
    rounded: "{rounded.base}"
    padding: "5px 10px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.base}"
    padding: "5px 10px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.bad}"
    rounded: "{rounded.base}"
    padding: "5px 10px"
  button-small:
    padding: "3.5px 8px"
  button-tiny:
    padding: "1px 6px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    width: "20px"
    height: "20px"
    padding: "0"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.base}"
    padding: "5px 8px"
  input-rail:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.base}"
    padding: "5px 8px"
  chip:
    typography: "{typography.chip}"
    rounded: "{rounded.sm}"
    padding: "1.5px 6px"
  chip-muted:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    typography: "{typography.chip}"
    rounded: "{rounded.sm}"
    padding: "1.5px 6px"
  card-face:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "9px 10px"
  column:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.xl}"
    width: "292px"
  column-count:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink-3}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  popover:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "5px"
  panel:
    backgroundColor: "{colors.surface}"
    width: "min(560px, 92vw)"
    padding: "0 0 30px"
  table-header:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    padding: "5px 9px"
---

# Design System: projector

## Overview

**Creative North Star: "Terminal Drafting"**

*Terminal* supplies the dense, text-first grammar and the xoria lineage. *Drafting* supplies
projection, annotation, hierarchy and technical precision. Not a retro terminal wearing blueprint
decoration — a working drawing made interactive.

The palette is [xoria256](https://github.com/neozenith/estilo-xoria256), Dmitriy Zotikov's pastel Vim
scheme, taken whole. Every hue in the stylesheet is a literal from `estilo/palettes/xoria256.yml`, and
what is not a hue is named as a departure: the derived light neutrals, the five shadow `rgba()` values
and the scrim, the two minimap masks, and the `color-mix` tints and washes. The scheme is dark-first
and has no light neutrals, so **the dark theme *is* xoria and the light theme is derived** from it —
the same seven hue families, using the dark shades as ink where the light shades would disappear on
white. The frontmatter above records the dark values
because they are the source; the light assignments are in `.impeccable/design.json`.

Two things make this a drawing rather than a dashboard. First, **colour is notation.** Each facet axis
owns one hue family — so a chip's hue tells you which axis it is before you read the word, and a canvas
edge is the same colour as its chips. The app owns the palette, seven families taken from xoria's own
syntax roles; the *vault* says which axis takes which, with `hue:` in `facets.yaml`. That was nine CSS
rules named after nine facets, which meant the stylesheet decided that priority was orange and a vault's
own vocabulary could only be grey. Second, **the surface is still.** Two
CSS transitions exist in the whole stylesheet — one on a grid track, one on a width, both a box
changing size — and there are no keyframes. A
surface that sits open on a second monitor all day is a readout, and a readout that moves is a
distraction.

The precision is literal, not atmospheric. The record mark beside every title carries two
`translateY` constants — `0.054em` and `-0.058em` — derived from where each glyph's ink actually centres
against lowercase text. They are measurements, not taste. That is the register: everything is sized to
the thing next to it, and the reason is written down.

**Key Characteristics:**

- Dark-first xoria256, taken literally; light derived from the same seven families
- Monospace for everything the app says, sans for everything a human typed
- A fourteen-step type scale in which the largest working size is 16px and the signature size is 9.5px
- One hue family per facet axis, chosen by the vault from the app's seven; hueless chips for facets that are hints rather than identity
- Four tonal surfaces and 1px hairlines — depth by layering, shadows only for what genuinely floats
- Still at rest: instant regrouping, motion only where a mouse gesture would feel broken without it
- Desktop-only by construction; no breakpoints, no responsive system, no top bar
- Precise and unadorned: no fill, stroke or radius that is not load-bearing

## Colors

Seven hue families and an eleven-step greyscale, all of it xoria's own — a muted, low-chroma palette
where saturation is reserved for notation and every neutral is a literal step in one ramp.

### Primary

- **Type Purple** (`accent`): the app's one voice. Focus rings, the selected card's ring, the drop
  target, the active filter head, the focus pill, badge counts, a panel link's clickable label, the
  primary button, and the Record Mark — the one thing in this list that is not live state, and it is
  here because a mark is *derived*: nothing writes it, so it is the app talking about a record rather
  than a value the record carries. See the Don't list.

  This list is meant to stay short, and it has been pruned three times on that ground: a link kind's
  prefix took it for all eight kinds and now takes its kind's family, `unblocks` took it for a count
  that is a property of a record, and a project's left border took it before both. A voice used
  everywhere is not a voice.

  It gained one in exchange, and only one: **the app's own axis**. `project` is `BUILTIN_FACETS`'
  rather than a vault's — the config chain walks it, its shape cannot be redeclared — so it draws in
  the app's colour where a vault's axes draw in the families a vault claims. That is `.facet-app` on
  a face, in a table and in the bulk bar, `.refchip.is-app` in the panel, `.picker-proj` in the
  record picker, and the accent for its canvas edges. It used to declare `blue` and be drawn in
  *purple* by the two surfaces that drew it at all, neither of them from the declaration. In light mode the accent is the family's
  dark shade so it reads as ink; in dark it is the
  light shade so it reads as light. The unsaved-view mark is the one live-state signal that is not the
  accent: `.rail-dirty` takes `warn`, as the Semantic list below says.
- **Accent Soft** (`accent-soft`): the accent's only fill — the drop-target column wash, the bulk
  bar's ground, the focus pill, the selected table row, and `::selection` in the document and in both
  editors. Never used for text.

### Secondary

A canvas edge has no palette of its own. It draws in the leading relation's `hue` — the family the
relation itself declares — so the graph says which relation it draws without a legend and without a
second set of colours to keep in step. It is now the *only* place a reference axis's family shows: the
values draw as records, in `facet-ref`, so the line is coloured and the chip at either end is not. There were three, `rel-parent`, `rel-blocks` and `rel-project`, keyed by facet
name; a renamed relation silently lost its colour, and the same axis could be one colour as a chip and
another as a line.

Two things about an edge are derived rather than declared. It is **solid** for the relation the canvas
is laid out by and **dashed** for the rest — which is a property of the view, and what a dash should
say. And it carries **text** unless it is that relation: the layout relation is the one you can read off
the arrangement, so any other line is one you cannot. The words are the facet's own `label`.

### Tertiary

The facet families. Each is one xoria hue in two roles: the `hue-*` value is the chip's *text*, the
`hue-*-bg` value is its *fill*. Which axis takes which is the vault's to say — `facets.yaml` declares
a `hue:` and the app names no facet — so this is what the **seeded** vocabulary claims, and the shape
of a sensible claim rather than a fixed table:

- **PreProc Green** (`hue-green`): `status` — lifecycle, and nothing else.
- **Number Orange** (`hue-orange`): `priority` — what you intend to do next.
- **Constant Yellow** (`hue-yellow`): `waiting_on` — somebody else's move, and the `today` bucket of
  `due`.
- **Identifier Pink** (`hue-pink`): `tech`.
- **Special Red** (`hue-red`): `blocked_by`, and the `overdue` bucket — the two states that are
  themselves a warning.
- **Type Purple** (`hue-purple`): `parent`.
- **Statement Blue** (`hue-blue`): claimed by no axis, and the family the `jira` link kind draws in.

Two of those are **reference** axes, and their family reaches one place only: the canvas edge. Their
values draw in `facet-ref` like every other reference — see Chips — so purple and red on that list
are a *relation's* colour, not a chip's.

`project` is deliberately absent: it is the app's axis rather than the vault's, so it draws in the
accent and claims no family. It used to declare `blue`, which put the one axis every vault shares in
a family a vault's own axis could also ask for.

### The Link Kind Vocabulary

Eight link kinds, and each draws its prefix in one family: `jira` blue, the three `gh:` kinds green,
`claude` orange, `doc` yellow, `slack` pink, and `url` none. It is one map in `src/web/links.ts` —
`LINK_KINDS`, the letters and the family together — read by the face's `J` and by the panel's
spelled-out `jira`, so one kind cannot be two colours in two registers. `theme.test.ts` holds the seam
shut: every kind's family has to be one the palette defines, and neither of the two reserved ones.

This borrows families the axes claim, and does not break The One Hue Per Axis Rule: a link kind is not
an axis, and it colours two or three mono characters, never a fill. Red stays out because it means a
failure here and `.linkchip.is-failed` is a state a prefix has to survive; purple stays out because it
is the accent. The three `gh:` kinds share green because they share a host, and `PR` / `br` / `sha`
separate them already — seven families do not survive spending three on one host.

### Neutral

- **Text** (`ink`): the document's default — every title and value, and a heading inside rendered
  markdown.
- **Gandalf** (`ink-2`): control labels, secondary values and body copy — the resting colour of a
  button, which goes to `ink` on hover, and the colour of the rendered card body. A filter row rests
  here too but reaches `ink` when it is *on*, not on hover.
- **Grey** (`ink-3`): every label, key, count, meta line and excerpt. Roughly half the type in the app
  is this colour; it is the ground state of annotation.
- **Darker / BG / Shadow-Step** (`ground`, `surface`, `surface-2`, `surface-3`): the four-surface
  stack, in that order, outermost to innermost.
- **Rule / Grey3** (`rule`, `rule-2`): the hairline and its emphasised form. `rule` separates regions;
  `rule-2` marks an interactive edge — an input, a popover, a hovered card. Three users are not that:
  the canvas band, which is never interactive and says so in its own comment; the scrollbar thumb,
  which takes it as a fill; and `.linkchip.is-live`, which takes it as a data state.
- **Shadow** (`dot`): the canvas dot grid, and nothing else.

### Semantic

- **PreProc Green** (`ok`): a finished reference, a filled progress bar.
- **Yellow** (`warn`): unsaved state, a deadline landing today.
- **Special Red** (`bad`): a failure, a blocked card's left border, an open reference, an overdue
  deadline.

### Named Rules

**The One Hue Per Axis Rule.** A facet axis owns exactly one hue family, and a hue family serves
exactly one axis. Adding a facet means claiming a family, not picking a colour you like. Two axes in
one family destroys the property the whole palette exists for: that a chip's colour is legible before
its text is.

A **link kind** is not an axis and does not claim: the eight kinds borrow families to colour two or
three mono characters, never a fill — see The Link Kind Vocabulary. A **reference** axis claims one
and spends it on its canvas edge alone, because its values draw as records rather than as values. The
**app's own axis** claims none at all: `project` draws in the accent, which no family may take and no
vault axis may ask for.

It is a rule the *seeded vault* keeps and the app cannot enforce, which is the honest position now that
`hue:` is a vault's choice: there are seven families and a vault may have twenty axes, so anything past
seven recedes, and a vault deliberately colouring two related axes alike is its own business. What the
app does enforce, in `theme.test.ts`, is that every hue a vocabulary names is a family the stylesheet
defines — the seam where the two halves can drift.

**The Hints Are Hueless Rule.** A facet that is a hint rather than an identity gets no hue at all —
transparent fill, `rule` border, `ink-3` text. Omitting `hue:` is how a vault says so; `energy`,
`source`, `owner` and `domain` are the seeded cases. If a new facet does not deserve a hue family, it
does not get a diluted one; it recedes.

**The Dilution Rule.** `--chip-tint` is `42%` in light and `100%` in dark. Xoria's light shades are
saturated pastels: full strength is fine on one chip and loud on eight stacked down a column, so light
mode mixes the fill toward the surface with `color-mix`. Dark mode already uses the darkest shades and
needs no help. Any new tinted surface goes through `--chip-tint`, not a hand-picked value.

**The App Voice Rule.** The accent marks live state and the app speaking — focus, selection, a drop
target, an active filter, a count the app computed — with the unsaved view as the one exception, which
takes `warn`. It never marks data structure.
A property of a record is drawn in that facet's own hue.

Two things sit inside "the app speaking" rather than beside it, and both are load-bearing:

- **The Record Mark.** Derived, never written — `markOf` reads it off what names the record — so the
  glyph is the app's reading of a record rather than a value the record carries.
- **The app's own axis.** `project` is defined by `BUILTIN_FACETS`, not by a vault, so its colour is
  the app's to spend. Every *vault* axis draws in a family it claims, and a vault cannot ask for the
  accent.

Anything else that is a property of a record and reaches for the accent is the rule being broken, and
three did: the project card's left border, every link kind's prefix, and the `unblocks` count.

## Typography

**Display / Body Font:** the system UI stack (`ui-sans-serif, system-ui, -apple-system, 'Segoe UI',
sans-serif`)
**Label / Mono Font:** the system mono stack (`ui-monospace, 'SF Mono', Menlo, Consolas, monospace`)

Every step is a `--text-*` custom property in `src/web/style.css`, and `test/theme.test.ts` fails on a
raw px font-size — so the names below are the handles, not descriptions of them.

**Character:** two system stacks and no webfont, which is the correct answer for a local tool that must
paint instantly and look native beside a terminal. The expression is not in the faces — it is in the
scale, which is unusually small and unusually finely stepped, and in the strict division of labour
between the two.

### Hierarchy

- **Display** (650, 22px, `-0.02em`): the vault gate's heading. The only full-page title in the app,
  and the only place type is allowed to be large.
- **Headline** (650, 16px, 1.3, `-0.015em`): the open record's title in the card panel. The largest
  type in normal use.
- **Title** (500, 13px, 1.35): a record's title on a face, in a column or on the canvas. Clamped to two
  lines on a canvas node, unclamped in a column.
- **Body** (400, 12.5px, 1.45): the working size — buttons, inputs, selects, table cells, reference
  rows, panel prose. `body` carries 14px as an inheritance root; almost nothing renders at it.
- **Body Compact** (400, 12px, 1.4): filter rows, rail selects, excerpts, `kv` values. One step down
  for anything that appears in a long vertical list.
- **Meta** (mono, 10.5px, `0.08em`): a face's meta line, and the panel's `kv` keys in uppercase.
- **Label** (mono, 500, 9.5px, `0.10–0.14em`, uppercase): the signature. Panel section heads, table
  headers, lane heads, rail labels, the vault gate's section heads. Tracking widens with prominence —
  `0.1em` in the rails and tables, `0.12em` on a popover head, `0.13em` in the panel, `0.14em` at the
  gate.
- **Chip** (mono, 10px, `0.01em`): every facet chip and link chip, and a canvas edge label.
- **Micro** (mono, 9px, `0.04em`): badge counts, a link chip's kind prefix, the
  React Flow attribution.

### Named Rules

**The Mono Label Rule.** If a human typed it, it is sans; if the app is naming, counting or annotating
something, it is mono. A facet's label is the first case, not the second: `label: Part of` is a string
in the vault's own `facets.yaml`, written by whoever keeps the vocabulary, so the filter rail and the
card panel both render it sans. The app names the *axis slot* — `SHAPE`, `GROUP BY`, `FACETS` — and
those are mono. Titles, excerpts and body copy are sans. Every label, key, count, chip, meta
line, column name, table header and glyph is mono. There is no third case, and the division is what
makes a screen with fourteen type sizes read as two voices rather than fourteen.

**The Tabular Number Rule.** Any number that can change while its neighbours stay put carries
`font-variant-numeric: tabular-nums`. A count that shifts width when it increments is a count you
cannot read at a glance.

The rule is a **guard, not a fix**, and it is worth knowing which: every counter in this app is mono,
and in a monospaced face the digits already share one advance, so the declaration changes the
rendering of exactly none of them. What it does is make a counter survive *losing* its mono — which is
not hypothetical, because a commit correcting a font-family divergence once dropped thirteen labels
onto a `<button>`'s own font with every test green. The one number in the app that is genuinely not
mono is `.popbtn` 's label, which renders `{n} columns` and `{first} +{n}` in the body sans; there the
rule does real work today, and it took this audit to notice it was the one place the rule was missing.

Membership is a decision, so it lives in one hoisted rule and is pinned by `test/theme.test.ts`
rather than counted in prose. The test also guards the mechanism that removed it twice: the `font:`
shorthand resets every sub-property it does not name, so a counter that acquires one has to
re-declare the guard, and two of them do.

**The Measured Glyph Rule.** A glyph placed in a text run is measured, not eyeballed. The record marks
sit at `0.8em` with `line-height: 1`, baseline-aligned, plus a per-glyph `translateY` derived from
where its ink actually centres: `•` centres at `0.3716em` of its own size, `○` and `▣` at `0.2598em`,
and lowercase text at `0.254em` of *its* size, which is where `0.054em` and `-0.058em` come from.

The leaf mark is `•` and not the middle dot `·` because the rule cuts both ways: at 15px the middle
dot's ink measures 1.85 × 2.23px against `○`'s 8.94 × 9.02, nearly five times smaller in each
dimension, which reads as a speck rather than as the quietest of three marks. The bullet is 4.35 ×
4.34 — legible, and still half the circle.

The panel header is the one place the mark is also a **control**: a record is a project by carrying a
`project:` block, so clicking the glyph adds or removes it. It takes `--text-lg` there rather than a
second relative size, and therefore its own pair of measured constants — same formula, different size
pair, written down beside them.

The same applies to the icon glyphs, which keep equal 20px hit targets while their nominal sizes are
tuned individually (14px check, 15px close, 16px revert, 17px add, and 15px for the three drawn
glyphs, `trash`, `refresh` and `edit`) so they read as one family — but
those metrics deliberately do **not** live here. The glyph set is closed, so the table in
`src/web/components/Button.tsx` carries the size beside the character it belongs to, and a new glyph is
a row there rather than a rule in the stylesheet. They are per-glyph measurements, not steps in the
type scale, which is why the scale test does not police them.

## Layout

**The shell** is a two-column CSS grid: `248px minmax(0, 1fr)`, collapsing to `38px`. There is no top
bar. The sidebar *is* the view — vault switcher, shape and grouping controls, search, then the filter
panel — and the footer carries the counts. The canvas floats its own transient toolbar rather than
adding a chrome row that would be empty in the other two shapes.

**Exactly one region scrolls per axis.** The sidebar's filter panel is the only scrolling part of the
rail (`flex: 1 1 auto` between two `flex: none` blocks); the board scrolls in the content area; a
column scrolls its own body under a fixed head. Nothing scrolls inside something that also scrolls on
the same axis, with one known exception: from three lanes up the board scrolls vertically, and the
column bodies inside it still scroll vertically too.

**The board** is a flex row of fixed 292px columns with a 12px gutter, `align-items: flex-start` so a
short column does not stretch. Cards stack 7px apart in an 8px-padded body. A single-lane board lets
its columns take the full available height; a laned board shares that height between its lanes,
`flex: 1 1 0` so they stay equal, floored at the `44vh` a column was capped at plus the head and gap
around it — so three lanes or more overflow and the board scrolls rather than every band becoming a
sliver. That cap was a fixed fraction of the viewport, which only added up for two lanes and left a
strip under the last one that nothing could use. Lanes are 14px apart, and a lane head is
`position: sticky; left: 0` so its name survives horizontal scroll.

**The panel** is fixed to the right edge at `min(560px, 92vw)` over a `rgba(10, 8, 14, 0.34)` scrim,
with `0 0 30px` of padding on the scrolling body and `10px` on every tier inside it — the deep bottom
pad so the last section clears the viewport edge when scrolled. **The tier owns its padding**, which is
what lets its divider reach the panel's edges instead of stopping 20px short at both ends; the panel
had 20px at the sides against 10px above and below the rule, so the horizontal breathing room was
twice the vertical. Uniform 10px is `.rail-block`'s own number, and it makes the interval between two
tiers exactly the interval to the edge — 6px between a section's parts, 5px between the rows of a
facet grid, 10px and a hairline between tiers.

**Density is the point.** At 1080p a column shows about ten cards, and a couple of hundred records are
four columns and one scroll. Every measurement in the system is hand-tuned to a 1px granularity rather
than snapped to a 4- or 8-point grid: `1.5px 6px` on a chip, `3.5px 8px` on a small button, `9px 10px`
on a card face. The nine named steps are `1 · 4 · 6 · 7 · 8 · 12 · 14 · 18 · 20`, and each exists
because something needed it — but they are names, not a closed set: `5px` is the second most common
spacing value in the stylesheet, and `2`, `3`, `9` and `10` are all in heavy use.

### Named Rules

**The Desktop-Only Rule.** The only `@media` query in the stylesheet is `prefers-color-scheme`. There
are no breakpoints and no responsive system, because the surface is a second monitor and never a phone.
Overlays clamp themselves against the viewport — `min(420px, 90vw)`, `min(560px, 92vw)`,
`min(680px, 100%)` — and that is the whole of the adaptive behaviour. Do not add breakpoints; if
something must fit a narrower window, clamp it.

**The No Chrome Rule.** New global controls go into a rail block or the footer. The app has no top bar
and adding one would cost 40px of board height on every shape to serve whichever shape needed it.

## Elevation & Depth

**Depth is tonal, not cast.** Four surfaces stack outermost to innermost — `ground` (the board and
canvas field), `surface` (the sidebar, a card face, the panel, a popover), `surface-2` (a column body,
an input in the rail, a hovered table row, a canvas band), `surface-3` (a count badge, a button on
hover) — and every boundary between regions is exactly one hairline of `rule`. A card face is flat: a
lighter fill inside a darker column, with a 1px border, and nothing else.

Shadows are reserved for the five things that genuinely float above the plane. Their values are not
interchangeable: the offset points away from the edge the element is attached to.

### Shadow Vocabulary

- **Panel** (`box-shadow: -12px 0 40px rgba(8, 6, 12, 0.18)`): the card panel, thrown leftward from
  the right edge it is docked to.
- **Popover** (`box-shadow: 0 12px 32px rgba(20, 15, 35, 0.18)`): portalled menus, which sit furthest
  from the plane and so cast furthest.
- **Picker** (`box-shadow: 0 8px 28px rgba(8, 6, 12, 0.22)`): the record picker — smaller throw,
  higher opacity, because it is a modal over a scrim.
- **Floating Bar** (`box-shadow: 0 6px 20px rgba(20, 15, 35, 0.16)`): the bulk bar, which exists only
  while a selection does.
- **Toolbar** (`box-shadow: 0 4px 14px rgba(20, 15, 35, 0.1)`): the canvas toolbar — the lightest,
  because it rests on the canvas rather than over content.

### Named Rules

**The Flat Plane Rule.** Anything that lives in the layout is flat: a fill, a hairline, and no shadow.
A shadow is permission to leave the plane, and only five elements have it. A card, a column, a chip, a
button, a table row and an input never do.

**The Stroke-As-Shadow Rule.** Three `box-shadow` idioms — five declarations in all — are not shadows
and must not be read as elevation: `0 0 0 1px var(--accent)` is the selected card's ring,
`0 ±2px 0 0 var(--accent)` is the reorder drop line above or below a card, and
`inset 2px 0 0 0 var(--accent)` marks a selected table row. All three use the shadow property to draw
a stroke where the border is already spoken for; the ring and the drop line are each written twice — a
card is selected in a column and on the canvas, and a card can be dropped above or below — which is
where the five come from. The
table row's is inset and on one side because a row cannot take a border — `outline` on a `<tr>` is
drawn per cell and a border shifts the column grid — so it is the same 3px-left-edge idea reaching a
container the border vocabulary cannot.

## Shapes

Radius rises with the size of the thing it is applied to, and the ladder is the whole form language:
`--radius-sm` **3px** on anything chip-sized — a facet chip, link chip, toggle chip or reference chip,
the panel's mark toggle and its new-value field — and on inline `code`;
`--radius-md` **4px** on a date input, a filter row, a hover highlight; `--radius-base` **5px** on
every control — button, input, select, reference row, banner, rail item; `--radius-lg` **6px** on a
card face, the picker, the minimap, the editor host and a vault row; `--radius-badge` **7px** on a
facet badge; `--radius-xl` **8px** on a container — a column, a popover, the bulk bar, the canvas
toolbar; `--radius-pill` **10px** on a count badge and a canvas band; and `--radius-xs` **2px** on the
smallest boxes — the progress track, the drawn checkbox, a markdown task-list checkbox and a link
row's kind badge. Nothing is a full pill and nothing is square.

Borders carry three distinct meanings, and the difference between them is the form language doing real
work:

- **1px solid `rule`** — a boundary. Between regions, around a card, under a table row.
- **1px dashed** — *not a real value.* Six rules draw it: the `(none)` column and a context-only
  canvas band, both also at reduced opacity; a toggle chip for a value the axis's vocabulary does not
  list; the panel's new-value field while it is empty; a link chip whose fetch returned nothing; and a
  vault row whose directory is gone. In each case the container exists but the value does not.
- **3px solid, left edge only** — state. A blocked card (`bad`), an open reference (`bad`), a
  finished one (`ok`, at 0.7 opacity). A project used to take a fourth in `hue-purple`; the Record
  Mark says that in every place a record appears, so the face said it twice and one of the two was
  the shape of the card itself. Every card face is now the same rectangle until something blocks it.

### Named Rules

**The Load-Bearing Left Border Rule.** The 3px left border is the only place a card face changes shape,
and it always encodes state. It is not available for decoration, for grouping, or for a fourth meaning
without retiring one of the three. Retiring one is what happened to the project's edge: a property a
glyph already states in every place a record appears was not paying for the only shape change a face
has.

**The Dashed Means Absent Rule.** Dashed is reserved for a container whose value does not exist. It
never means "draft", "disabled" or "optional".

## Components

Every control is **precise and unadorned**: a hairline border, a `surface-2` fill, `ink-2` text, and
nothing that is not load-bearing. Controls state their affordance by being crisp, not by being styled.

### Buttons

- **Shape:** gently rounded (`5px`), 1px `rule-2` border.
- **Default:** `surface-2` fill, `ink-2` text, `5px 10px`, 12.5px. Hover moves the fill to `surface-3`
  and the text to `ink` — the fill and the text brighten together, which is the standard hover gesture
  across the whole system.
- **Primary:** `accent` fill and border, `ground` text, weight 600. Hover is
  `filter: brightness(1.08)`, not a second colour, so the primary button needs no hover token.
- **Ghost:** no fill, transparent border; hover reveals a `surface-2` fill. For actions that must exist
  without occupying visual weight.
- **Danger:** `bad` text on no fill, border at `color-mix(bad 40%, transparent)`; hover adds a
  `bad 14%` wash. Never a filled red button.
- **Sizes:** `small` (11.5px, `3.5px 8px`), `tiny` (11px, `1px 6px`, `line-height: 1.4`).
- **Focus:** `2px solid accent` at `outline-offset: 1px` on every button, always visible, never
  removed.
- **Icon buttons:** a 20px square grid-centred box with zero padding, so glyphs of different ink area
  keep identical hit targets.

### Chips

- **Style:** mono 10px, `1.5px 6px`, `3px` radius, 1px border. Three values from one hue family: the
  family's text colour, its background diluted by `--chip-tint`, and its border at 30–34%
  `color-mix` with transparent.
- **Tones:** one class per hue *family* — `facet-hue-orange`, `-green`, `-purple`, `-blue`, `-pink`,
  `-red`, `-yellow` — plus `facet-muted` for an axis that declares none. Which axis takes which is
  `facets.yaml`'s to say; the chip looks it up through `useHue`. It was one class per facet *name*,
  which is what made a vault's own vocabulary permanently grey.
- **The app's axis:** `facet-app` — `accent` text on the `accent-soft` fill, with the border at 32%
  like purple's, which is the family pair the accent would have if it were one. Only `builtin` axes
  reach it, which today means `project` and nothing else. Not tinted through `--chip-tint`:
  `accent-soft` *is* the diluted shade already (it is `hue-purple-bg` exactly, in dark), and tinting
  a tint is how a chip turns into its own background.
- **Reference:** `facet-ref`, and it outranks a declared family. A reference value is not a value, it is
  another record, so it draws in the panel's `.refchip` register wherever it appears — `surface-2`
  box, `rule` edge, `ink-2` text, no family. A card face and a table row used to draw one as a hued
  chip, so the same record read as a purple `parent` pill on a board and as plain text in the editor.
  `ink-2` rather than `facet-muted`'s `ink-3` is the whole difference between the two rules: a hint
  recedes, a record does not. A reference axis's own `hue:` is not dead — the canvas draws its
  **edges** in it, which is the one place the relation is what is being coloured rather than the
  record at the end of it.
- **Bucket override:** on a card face and a canvas node, an ordered facet draws its bucket, and a
  bucket that declares its own `hue` wins — drawn **filled** rather than tinted, because that is the
  point of declaring one: `overdue` loud on an axis that is otherwise quiet. A filled chip takes
  `--ground`, not `--ink`, for the same contrast reason `.btn.primary` does. This replaced
  `.chip.is-overdue` and `.chip.is-today`, the last two *value* names in the stylesheet. A table cell
  does not draw the bucket — `TableView` renders `FacetChip` without it, though `card.buckets` is on
  the DTO the row already reads.
- **Toggle chip:** the interactive variant, in the card panel and the bulk bar, with `is-on`,
  `is-extra` and `is-clear` states. It carries its **axis's own family**, off as the hue in text on the
  plain surface and on as the hue in fill with `ground` text — the same two states the bucket chips
  use. It took the *accent* in both until the card editor became the one surface where a facet value
  did not say which axis it was, in the one place all the axes are on screen together: The App Voice
  Rule gives the accent to live state and the app speaking, never to a property of a record.
  The hue arrives as `--tone`, declared once per family beside that family's fill, because the
  `.facet-*` rules are declared above `.togglechip` at equal specificity — a tone class appended to the
  chip's className loses the cascade and changes nothing. The rail is not a home: its filter value is a
  drawn checkbox, and this document said "the filter panel and bulk bar" for a while after that
  stopped being true.
- **Link chip:** mono 10px, hairline `rule` border, `ink-3` text, with the link kind as a 9px bold
  prefix in **that kind's own family** and the label ellipsised at 130px. See The Link Kind
  Vocabulary — the prefix was `accent` for every kind, which spent the app's one voice on eight
  things that are not the app speaking and said nothing the letters did not.

### Cards / Containers

- **Card face:** `surface` fill, 1px `rule` border, `6px` radius, `9px 10px` padding, `6px` between
  its rows. Hover moves the border to `rule-2` and nothing else — no lift, no shadow, no scale.
  Selection adds a 1px `accent` ring; dragging drops it to `0.4` opacity.
- **Structure:** a head row (record mark + title, baseline-aligned), an optional two-line clamped
  excerpt, a chip row, and a mono meta line. The same face renders in a column and on the canvas — how
  much of it appears is a property of the view, never of the record. A table row is not the face: it
  builds the same parts (record mark, title, chips) into a single-line flex cell — see **Accepted
  Exceptions**.
- **Column:** `surface-2` fill, 1px `rule`, `8px` radius, fixed 292px. A head row with the axis value
  in mono 12.5px/600 and a pill count in `surface-3`, a hairline under it, then a scrolling body. The
  `(none)` column is the same column dashed at `0.72` opacity.
- **Canvas band:** `surface-2` at `0.55` opacity behind its members, `10px` radius,
  `pointer-events: none`. It is the grouping axis made visible, not a thing you can move; a
  context-only band is dashed at `0.35`.

### Inputs / Fields

- **Style:** `surface` fill, 1px `rule-2`, `5px` radius, `5px 8px`, 12.5px. In the rail the fill drops
  to `surface-2` so an input reads as recessed into the sidebar rather than raised out of it.
- **Focus:** `2px solid accent` at `outline-offset: -1px`, drawn inside the box so a focused field in a
  dense list does not shift its neighbours. `.field-recessed` is the exception, at three sites: it
  removes the outline and moves its border to `accent` instead, because a 2px ring against the rail's
  edge read as a second boundary. Two of the three are in the rail — its search and its saved-view
  namer — and the third is the canvas toolbar's view-namer, where the reason is inherited rather than
  re-argued. The panel’s new-value field is not this class: `.facetrow-add input` is its own register
  and re-implements the same swap in its own rule — see **Accepted Exceptions**.
- **Selects:** `appearance: none`, `surface-2` fill, `rule` border, 12px — flatter than a text input,
  because a select is a control rather than a field.
- **Disabled:** a field is `0.45` opacity and `cursor: not-allowed`; a button is `0.5` and
  `cursor: default`. The two cursors differ on purpose. No colour change either way.

### Navigation

The sidebar is the navigation, and it has no links. It is a stack of `rail-block` groups separated by
hairlines, each a row of a 62px mono uppercase 9.5px label and a control — every row, with no
exceptions: `Vault` and `View` were the two a reader had to identify from their value alone, and a
folder name beside a view name is two unlabelled words in the one place that says where you are
looking. Two groups sit above the filter: **which vault**, with its record and project counts, and
then **the whole query** — the saved view it starts from, then shape, grouping, sort, faces and
focus, which are the overrides on top of it and what a save writes back. The query used to be spread
across three groups — the saved view sat with the vault, and focus had a hairline of its own — and
each of those two hairlines said something untrue: that choosing where a query starts belongs with
choosing a vault, and that a traversal is a different kind of control from the axis it walks.

The filter panel below them is the only scrolling region: a facet head that turns `accent` and weight
600 when active, a caret, a count badge, and an indented list of values at 12px. A computed axis
carries an italic mono glyph so you know nothing is written on the card, right-aligned against the
label column's inner edge.

The card panel reads the rail's grammar rather than sharing its components. It takes the absence rule —
an axis carrying nothing is not drawn — the `ƒ` and its right alignment, and the 10px block padding;
it does **not** take the disclosure, because once an empty axis is absent there is nothing left to
disclose. Where the rail collapses, the panel omits and offers a door: `+ facet` and `+ ref` open a
popover of the axes this card carries nothing on.

### The Record Mark

The signature component, and the one nothing else can substitute for. A mono glyph before every title
saying what the record is — `•` a card, `○` a node, `▣` a project. The mark draws the glyph alone: how
many records name it is spelled out in its tooltip, and printed beside it only on a table row. It
draws in `accent` — one colour in all of them, so the glyph is one vocabulary rather than whatever
each surface paints; it was `ink-3` everywhere except a project's mark in the panel, which was
`hue-purple`, so the signature component was the colour of a label with one invisible exception. `○`
means named by **any** reference facet, which is what `nodesIn` has always meant
by a node: being named by `parent` and being named by `project` make a record a node equally. It read
the `parent` facet alone until this was settled, which is how the mark and the `type` axis came to
disagree about the same record. It sits at `0.8em` of whatever type it precedes, so one rule serves
the 12.5px table row, reference row and picker row, the 12px reference chip and focus pill, and the
13px card face — and that `em` resolves against the type it sits beside, not against whatever its row
inherited. The panel header is the one place it does not: there the mark is a control and names
`--text-lg` outright. See **The Measured Glyph Rule**.

### Progress

A 44px × 4px `surface-3` track with a `2px` radius and an `ok` fill, followed by a tabular number.
Used for a project's roll-up. It is the only bar in the system.

## Do's and Don'ts

### Do:

- **Do** claim a whole hue family when adding a facet axis, and take its text, `-bg` fill and 30–34%
  border together. A chip's colour is its axis name.
- **Do** put mono on anything the app says — labels, keys, counts, chips, column names, table headers —
  and sans on anything a human typed.
- **Do** give every count `font-variant-numeric: tabular-nums`.
- **Do** reach for the tonal stack before a shadow. `ground → surface → surface-2 → surface-3` is four
  levels of depth and covers every case that is not literally floating.
- **Do** reach for an existing `--text-*` step. Fourteen is already more than a scale needs; if
  something seems to need a fifteenth, it almost certainly needs one of the fourteen. Adding a step is
  a deliberate act that `test/theme.test.ts` will make you perform on purpose.
- **Do** measure a glyph you place in a text run, and write the measurement down in a comment beside
  the constant.
- **Do** clamp overlays with `min(px, vw)` when a window might be narrow.
- **Do** let motion exist exactly where a gesture would feel broken without it — dragging a card,
  panning or zooming the canvas, collapsing the rail, and the panel's new-value field widening as it
  takes focus. Regrouping, re-sorting and filtering are instant.

### Don't:

- **Don't** animate a card, chip, column, panel or table. There are no keyframes in this system and no
  transition longer than 140ms, and both existing ones animate a width. A surface that sits open all
  day must be still.
- **Don't** drift toward consumer SaaS polish: generous whitespace, 16px body type, large radii,
  gradients, illustrated empty states, spring easing. The working type size here is 12.5px and the
  largest radius is 10px, on purpose.
- **Don't** drift toward enterprise tracker chrome either: stacked toolbars, breadcrumbs, avatar rows,
  modal over modal, or status rendered as a filled pill competing for attention. There is no top bar,
  and status is a 10px chip.
- **Don't** dress the terminal up. Xoria and the mono labels are a working grammar, not a costume —
  no ASCII borders, scanlines, CRT glow, blinking cursors or fixed 80-column measures.
- **Don't** use the accent for data structure. It marks live state and the app speaking, and nothing
  else. A *value* is data: a chip takes its axis's own family, never the accent, and a hue family
  belongs to one axis — which is why the Record Mark is not the exception it looks like. Nothing
  writes a mark; `markOf` derives it from what names the record, so it is the app speaking, and
  `hue-purple` would have claimed an axis's family for something that is not an axis — `parent`'s, in
  the seeded vocabulary, which would have put a purple chip and a purple mark on one card face meaning
  two different things. The two tokens hold the same value in both themes, so this is which word is
  true and not which colour is drawn.
- **Don't** put `--ink` on a filled background. `ink` and the semantic hues follow the theme in the
  same direction, so the pair never has contrast: `ink` on `bad` measured 1.92:1 in light, and `ink` on
  `warn` **1.03:1** in dark — invisible. Every filled state takes `ground`, which is 7.58:1 at worst
  across the same four combinations, and is what every filled state does — `.btn.primary`, the two
  bucket chips, and `.togglechip.is-on`, which takes `ground` over its axis's hue and measured 5.90:1
  at worst across the seven families in light and 7.58:1 in dark. `.icon-button.is-on` is not in this list
  and is not an exception: it is an `accent` glyph on an `accent-soft` wash, which is a tint rather
  than a fill.
- **Don't** add a breakpoint. There are none, and the surface is a second monitor.
- **Don't** interpolate a hue. Every hue comes from `xoria256.yml`; the departures — `bad` at
  `#b06060` in light, the `chip-tint` and state-wash mixes, the derived light neutrals, the five
  shadow `rgba()` values and the scrim, and the two minimap masks — are documented where they occur
  and each has a stated reason.
- **Don't** give a hint facet a diluted hue. It gets no hue — transparent fill, `rule` border, `ink-3`
  text — or it earns a family of its own.
- **Don't** nest a scroll inside a scroll. One region scrolls per axis.
- **Don't** use dashed borders for anything but a container whose value does not exist.

## Accepted Exceptions

Cases where a named rule above appears to be broken and is not, decided during the whole-app
`extract` pass. Each is here because someone looked, found a reason, and chose to keep the
difference — so the next reader does not spend the same hour, and so the decision can be
**revisited on purpose** rather than rediscovered as drift.

Format: what looks wrong, why it stays, and what would have to change for it to go.

### The count that keeps its fill

`.column-count` carries a `surface-3` pill where The Count Rule says a count is quiet unless it
is the only signal a filter is on.

It stays because this document commits it in five places — the `components.column-count`
frontmatter, `surface-3 (a count badge, a button on hover)` under Elevation, `--radius-pill 10px
on a count badge and a canvas band` under Shapes, `a pill count in surface-3` under Cards, and
the token comment beside `--radius-pill` in the stylesheet — and because it is the only count in
the app that sits *between* two other things: a flexing column name on its left and a 20px add
button on its right. The fill is what separates it from both.

To remove it: update all five statements, and note that `--radius-pill` then has one remaining
user (the canvas band).

### The counts that declare no type

`.lane-count` declares `color` and nothing else and `.section-count` adds only a left margin, so both
inherit family, size, tracking and case from the heading they annotate.

Each has exactly one call site now — a board lane head and a table section head. This entry used to
name a second for `.section-count`, the card panel's inbound heading, and note that the class arrived
there beside `.quietcount` so the inheritance did not apply. That was true and is not: the panel's
inbound lists are rows of a facet grid rather than sections with headings, and their count is a plain
`.quietcount`. A one-site class is still the right shape here — the mechanism is the inheritance, not
the reuse.

That inheritance *is* the mechanism: the count reads as part of its heading's type run rather
than as a badge beside it. Giving either one a step from the scale would break it on purpose.

### The number that is not a count

`.count` on a table row looks like the count family and is not — it is the second half of the
Record Mark, the reference count DESIGN.md's Record Mark section describes. It appears in the table
and not on a card face because a table's title cell is a single-line flex row with a stable end,
where a face's title is unclamped in a column and clamped to two lines on a canvas node. The face
carries the same fact as the `○` glyph itself, with the number in the mark's tooltip.

`.bulkbar-count` is also not a count: it renders the sentence *"N selected"*, in the accent, on
the bulk bar's own `accent-soft` fill — The App Voice Rule speaking about live state. Folding it
into the quiet class would put the app's quietest ink on an accent fill as that bar's only
statement.

`.pop-annotation` is not a count either: it renders `v.shape` ("board") and the word `'missing'` as
often as it renders a number. It is the right-hand annotation slot on a popover row — the same job as
`.pop-note` beside it. It used to be `.pop-count`, and the rename was the whole fix; it was never
worth merging into a count.

### The three headings that stay four treatments

The current value of the grouping axis is drawn four ways — board column at mono 12.5/600, board
lane at the Label step, canvas band at `--text-xs`, table section at the Label step — and the
outer level (the lane) is smaller than the inner one it contains.

Both ends are committed independently above: the Label step names lane heads among its users, and
Cards / Containers names the column head as *"the axis value in mono 12.5px/600"*. The lane's
prominence is carried by uppercase and `0.1em` tracking rather than by size, and its job is a
sticky marker surviving horizontal scroll, not a page heading.

Unifying them would also flatten a real distinction: the column head is the only one of the four
whose value is a **write target** — a drag lands there and an inline-created card inherits it,
which is why a board keeps an empty declared column and a table and canvas do not. The canvas
label additionally inherits its band's `0.55` (or `0.35`) opacity, so giving it the column's type
would not make it read like the column's type, and compensating with a hand-picked colour is
forbidden elsewhere in this document.

### The uppercase that is not a transform

The One Casing Rule says a string is cased once, and three surfaces still render a facet value or
label in uppercase: the table's column header, the table's section head, and the board's lane
head.

They are permitted by the rule's own second clause — they take the **Label** type step, whose
register *is* uppercase mono, rather than transforming a string at some other step. The panel's
axis label was the violation, because it hand-rolled `text-transform: uppercase` plus `0.1em` at
the *Chip* step: the Label register at the wrong size, which is a third register rather than a use
of the second. It now renders the vocabulary's own casing.

Settled since, and the rail had it right: both surfaces render the facet label in **sans** at
`--text-body-sm`. The Mono Label Rule reads with both of them — a facet's `label:` is a string from
the vault's own `facets.yaml`, not the app naming an axis slot. Same casing, one font.

And the second half of that is a measurement, not an inference. This paragraph used to read *"declares
a size and a colour and no family, so the panel inherits the sans stack too"* — which was false, and
false in the direction nobody checks. The label's parent was `.facetedit-head`, a `<button>` declaring
no family, and a browser gives form controls a family of their own: the panel rendered thirteen axis
labels in **Arial**, 30px from the rail rendering the same strings in `--sans`. The label is now a
grid cell (`.facetrow-label`) with no form control in its chain, and it names `var(--sans)` anyway.
`test/theme.test.ts` has a test for it — every `<button>` must carry a class that names a family —
because inheritance is a default everywhere except the four elements where it is not.

### The reference chip and the reference row

`.refchip` and `.reflink` both show a record you can click, in a `surface-2` fill with a `rule`
border and the same hover, and they are not one component.

They differ five documented ways: the radius pair is prescribed by name in Shapes (`3px` on a
chip, `5px` on a reference row); the type step differs, which rescales the record mark's own
`0.8em` from 10px to 9.6px — the compounding failure the mark's own comment warns about; only the
inbound form carries the 3px left-edge state border, which is two of the three meanings The
Load-Bearing Left Border Rule permits; the DOM differs, one `<button>` against a span holding a
go-button and an unlink, which was a deliberate fix for one gesture doing two things; and
`.refchip-title` must ellipsise at 26ch because it wraps inside the panel while an inbound row
gets a line of its own.

Five modes across **two** call sites is under the three-use threshold. The structural reason that used
to stand beside it is gone: `blockedBy` and `children` once shipped as `{ id, title }`, so giving the
inbound row a mark meant a server DTO change. They now carry `isProject` and `refCount`, counted by
`inboundCounts()` in `src/index/refs.ts` — inside `src/index/`, so no boundary is crossed.

Settled since: `.reflink` and the focus pill were the two places a record appeared with no mark at
all. Both draw one now — there are six `<RecordMark>` call sites — so the Record Reference Rule holds
everywhere a record appears.

### The badge that takes `surface`, not `ground`

`.facet-badge` puts `color: var(--surface)` on an `--accent` fill where the Don't list says every
filled state takes `ground`.

Contrast holds either way — measured, the change is 8.80:1 → 8.36:1 in dark and 10.40:1 → 11.14:1 in
light, so it costs a little in one theme and gains a little in the other — and there is a live
reading in which `surface` is the right value: the badge sits in the sidebar, whose fill *is*
`surface`, so the digits read as knocked out of the accent rather than printed on it. It also
inherits `font-weight: 600` from the active facet head, which two of the four `ground` filled states
declare for themselves — `.btn.primary` and `.togglechip.is-on`; the other two carry no weight — so
a fill arriving with the weight is not unique to it.

Low confidence, and the cheapest of these to revisit.

### The mode switch that is gone

`.tab` and `.tab.is-on` are retired, and this entry is kept as the record of why rather than deleted.

They were the panel's Body `read` / `edit` pair — the last two `.tab` uses in the app — and the entry
here defended their `text-transform: none` and `letter-spacing: 0` as the one place a rule cancels an
*explicit* ancestor uppercase. That defence still holds for `.derived`, which cancels the same
inherited uppercase so the panel's `ƒ` is not rendered as `Ƒ`, and which is now the only rule doing it.

What retired the tab was not the casing but the shape. `.tab` said "you are in this mode" while the
frontmatter's `edit raw` said "do a thing", for the same act — reveal an editor over a readout — a
screen apart in one panel. Both are now one `.icon-button` with the `edit` glyph and a pressed state,
which is also the first time either announced that state: `aria-pressed` arrives with `on`, and two
plain buttons reading `read` and `edit` had announced nothing at all.

### The canvas that says nothing when it is empty

Six surfaces state their own emptiness — the board, the table, the filter rail, the record picker, the
vault gate's folder browser and the panel's body — through `.emptystate`. The canvas does not: a query
matching nothing leaves
an empty dot grid.

It stays that way. The minimap empties with it, so two things on screen agree that there is nothing
there, which is the information a message would carry. And the canvas is the one surface with no
chrome of its own by construction — the toolbar floats and vanishes — so a centred sentence would
be the only fixed element it ever draws.

To change it: it would want the same `.emptystate` register the other six use, not an illustration
— see the Don't list.

### The three left edges outside the record vocabulary

The Load-Bearing Left Border Rule enumerates three meanings for the 3px left edge and closes by
saying a fourth is not available without retiring one of the three. Six rules draw one. The three
enumerated are the *record* vocabulary — `.cardface.is-blocked`, `.reflink.is-open`,
`.reflink.is-done`. Three more sit outside it deliberately:

- **`.banner.is-bad` and `.banner.is-conflict`** are two branches of one typed decision —
  `bannerFor` returns `tone: 'conflict' | 'bad'` — on an element that *is* a message about state
  rather than a record carrying one. They are washed as well as striped, which no record edge is.
  `--warn` on a left edge appears nowhere else in this document; it is what separates "refused"
  from "saved, with warnings" where both render in one stack.
- **`.linkrow.state-error`** is `bad` meaning "a failure", which is this token's own first job. It
  is the documented survivor of a pruning from four link-row stripes to one, and the row it marks
  is not a record — it is a link on one.

So the rule governs the vocabulary a *record* is drawn in, and the count is three there — it was four
until the project's edge was retired, which is the rule being spent down on purpose rather than drifting
up. To change it: retire another, or restate the rule as being about records specifically.

Not consolidated into a shared `.stripe` rule, and this is the interesting part. Two reasons killed
it: the rule count would go up rather than down, because both banners
keep their `color-mix` wash and `.reflink.is-done` its `0.7` opacity; and the design detector
matches per declaration, so folding the six into one rule would collapse its findings to two —
disarming the only automated tripwire on this very rule.

A third reason has since dissolved: the hover and selection rules a bare `.stripe` used to lose to are
all wrapped in `:where()` now, so they contribute one class rather than three, and a `.stripe` would
tie them and win on order.

### The accent-border focus, at three sites

DESIGN.md's Inputs/Fields section gives every field a 2px `accent` ring at `outline-offset: -1px`.
`.field-recessed` replaces it with an accent *border* instead, because a 2px ring against the
rail's edge read as a second boundary.

That reason is a rail reason, and one of the three fields it paints is not in the rail: the canvas
toolbar's view-namer. The other two are the rail's own search and its saved-view namer; the panel's
new-value field is `.facetrow-add input`, which is not this class and re-implements the same swap on
its own. The canvas one keeps the treatment on purpose —
the alternative is a field whose focus depends on which surface its caller happened to mount it
in, which is exactly the defect that produced this component. `CommitInput` chose between two
paints based on the wrapper *tag* its caller passed; one register with one focus rule is what
replaced that.

To change it: scope the border-swap to `.rail-search .field-recessed, .rail-row .field-recessed` and
let the canvas float take the global ring — and expect the float to then disagree with the rail about
a field that is otherwise identical. Scoping to `.rail-row` alone would strip the accent border from
the rail's own search, which is the field the rationale was written for.

### The project that is named but not chipped

A record's project is a chip everywhere you meet it — a card face, a canvas node, a table cell —
and bare text in the record picker: `.picker-proj` is mono `--text-label` in `accent`, with no
fill, no border, no radius and no padding. (It said `hue-purple` until the built-in axis got a colour
of its own, and gave the reason as "never the accent for a property of a record" — the right rule read
one axis too widely, on an axis that was declaring `blue` at the time.)

It keeps the axis's colour, which is the part that carries meaning, and drops the chip because the
container is the case The Dilution Rule was written for: *"full strength is fine on one chip and
loud on eight stacked down a column"*, which is why the light theme already mixes the fill to 42%.
A picker lists every record in the vault — thirteen project labels on the fixture, and 27 rows —
so the chips would arrive not eight to a column but one per row for the length of the list. The
row is also already carrying a record mark and a title competing for the same eye; a filled chip
would be the third thing on it asking to be read first.

Measured side by side in one viewport: 13 bare labels in the popover against 14 filled chips on
the faces behind it.

To change it: give `.picker-proj` the `.chip.facet-app` treatment and check the popover in
both themes at full list length — the light theme is the harder of the two, since `accent-soft` there
is a near-white wash rather than a dark shade, so a filled chip is nearly all border.

### The vault glyph in the folder browser

`.browse-item` marks a directory that looks like a vault with `▣`, against `›` for a plain folder —
the Record Mark vocabulary's project glyph worn by something that is not a record.

It stays because the vault gate is a file browser: no record appears anywhere on that surface, so
there is nothing for the glyph to be confused with, and the pair it belongs to is `▣` against `›`
rather than `▣` against `○` and `•`.

The rail's vault button carried the same borrowing — `.vaultbtn-mark`, held here as a pun on the same
grounds — and it is gone. What dissolved was the premise: the pun only worked while nothing in the
rail said what that control *was*, and the row carries a `Vault` label now, so the glyph was a second
answer to a question already answered in words. To bring it back you would have to argue the label
away first.
