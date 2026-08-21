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
  rel-parent: "#a6a6e7"
  rel-blocks: "#df8787"
  rel-project: "#87afdf"
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
    typography: "{typography.body-compact}"
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
    padding: "18px 20px 40px"
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
scheme, taken whole. Nothing is interpolated: every value in the stylesheet is a literal from
`estilo/palettes/xoria256.yml`. The scheme is dark-first and has no light neutrals, so **the dark theme
*is* xoria and the light theme is derived** from it — the same seven hue families, using the dark shades
as ink where the light shades would disappear on white. The frontmatter above records the dark values
because they are the source; the light assignments are in `.impeccable/design.json`.

Two things make this a drawing rather than a dashboard. First, **colour is notation.** Each facet axis
owns one hue family, mapped from xoria's own syntax roles — priority is Number (orange), status is
PreProc (green), project is Type (purple), tech is Statement (blue), layer is Identifier (pink) — so a
chip's hue tells you which axis it is before you read the word. Second, **the surface is still.** Two
CSS transitions exist in 48 KB of stylesheet and both animate a width; there are no keyframes. A
surface that sits open on a second monitor all day is a readout, and a readout that moves is a
distraction.

The precision is literal, not atmospheric. The record mark beside every title carries two
`translateY` constants — `0.03em` and `-0.058em` — derived from where each glyph's ink actually centres
against lowercase text. They are measurements, not taste. That is the register: everything is sized to
the thing next to it, and the reason is written down.

**Key Characteristics:**

- Dark-first xoria256, taken literally; light derived from the same seven families
- Monospace for everything the app says, sans for everything a human typed
- A nine-step type scale in which the largest working size is 16px and the signature size is 9.5px
- One hue family per facet axis; hueless chips for facets that are hints rather than identity
- Four tonal surfaces and 1px hairlines — depth by layering, shadows only for what genuinely floats
- Still at rest: instant regrouping, motion only where a mouse gesture would feel broken without it
- Desktop-only by construction; no breakpoints, no responsive system, no top bar
- Precise and unadorned: no fill, stroke or radius that is not load-bearing

## Colors

Seven hue families and an eleven-step greyscale, all of it xoria's own — a muted, low-chroma palette
where saturation is reserved for notation and every neutral is a literal step in one ramp.

### Primary

- **Type Purple** (`accent`): the app's one voice. Focus rings, the selected card's ring, the drop
  target, the active filter head, the focus pill, the unsaved-view mark, badge counts, a link's kind
  prefix, the primary button. In light mode the accent is the family's dark shade so it reads as ink;
  in dark it is the light shade so it reads as light.
- **Accent Soft** (`accent-soft`): the accent's only fill — a hover-column wash, the bulk bar's ground,
  the focus pill. Never used for text.

### Secondary

The three relation colours, used exclusively on canvas edges so the graph says which relation it draws
without a legend.

- **Parent Purple** (`rel-parent`): decomposition edges. Shares the accent hue, because the parent tree
  is the canvas's default spine.
- **Blocks Red** (`rel-blocks`): blocking edges, and the only edge kind that carries a text label.
  Light mode moves it off the palette to `#b06060` — a deliberate exception, because xoria's red1 is
  illegible on white and red3 is too dark to read as an edge.
- **Project Blue** (`rel-project`): membership edges.

### Tertiary

The facet families. Each is one xoria hue in two roles: the `hue-*` value is the chip's *text*, the
`hue-*-bg` value is its *fill*.

- **Number Orange** (`hue-orange`): `priority` — what you intend to do next.
- **PreProc Green** (`hue-green`): `status` — lifecycle, and nothing else.
- **Type Purple** (`hue-purple`): `project` — membership.
- **Statement Blue** (`hue-blue`): `tech`.
- **Identifier Pink** (`hue-pink`): `layer`. The one family that also carries weight 600, because a
  layer is a coarser cut than the rest.
- **Special Red** (`hue-red`): `waiting_on` — the only facet whose presence is itself a warning.
- **Constant Yellow** (`hue-yellow`): `domain`.

### Neutral

- **Text** (`ink`): every title, value and piece of body copy.
- **Gandalf** (`ink-2`): control labels and secondary values — the resting colour of a button or a
  filter row, which goes to `ink` on hover.
- **Grey** (`ink-3`): every label, key, count, meta line and excerpt. Roughly half the type in the app
  is this colour; it is the ground state of annotation.
- **Darker / BG / Shadow-Step** (`ground`, `surface`, `surface-2`, `surface-3`): the four-surface
  stack, in that order, outermost to innermost.
- **Rule / Grey3** (`rule`, `rule-2`): the hairline and its emphasised form. `rule` separates regions;
  `rule-2` marks an interactive edge — an input, a popover, a hovered card.
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

**The Hints Are Hueless Rule.** A facet that is a hint rather than an identity gets no hue at all —
transparent fill, `rule` border, `ink-3` text, italic for `energy`. `energy` and `source` are the
existing cases. If a new facet does not deserve a hue family, it does not get a diluted one; it
recedes.

**The Dilution Rule.** `--chip-tint` is `42%` in light and `100%` in dark. Xoria's light shades are
saturated pastels: full strength is fine on one chip and loud on eight stacked down a column, so light
mode mixes the fill toward the surface with `color-mix`. Dark mode already uses the darkest shades and
needs no help. Any new tinted surface goes through `--chip-tint`, not a hand-picked value.

**The App Voice Rule.** The accent marks live state and the app speaking — focus, selection, a drop
target, an active filter, an unsaved view, a count the app computed. It never marks data structure.
A property of a record is drawn in that facet's own hue.

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
  `0.1em` in the rails and tables, `0.13em` in the panel, `0.14em` at the gate.
- **Chip** (mono, 10px, `0.01em`): every facet chip and link chip.
- **Micro** (mono, 9px, `0.04em`): canvas edge labels, badge counts, a link chip's kind prefix, the
  React Flow attribution.

### Named Rules

**The Mono Label Rule.** If a human typed it, it is sans; if the app is naming, counting or annotating
something, it is mono. Titles, excerpts and body copy are sans. Every label, key, count, chip, meta
line, column name, table header and glyph is mono. There is no third case, and the division is what
makes a screen with nine type sizes read as two voices rather than nine.

**The Tabular Number Rule.** Any number that can change while its neighbours stay put carries
`font-variant-numeric: tabular-nums` — column counts, progress numbers, roll-up columns, the sidebar
ribbon. A count that shifts width when it increments is a count you cannot read at a glance.

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
tuned individually (14px check, 15px close, 16px revert, 17px add) so they read as one family — but
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
column scrolls its own body under a fixed head. Nothing scrolls inside something that also scrolls.

**The board** is a flex row of fixed 292px columns with a 12px gutter, `align-items: flex-start` so a
short column does not stretch. Cards stack 7px apart in an 8px-padded body. A single-lane board lets
its columns take the full available height; a laned board caps them at `calc(100vh - 120px)` so the
next lane is visible below. Lanes are 14px apart, and a lane head is `position: sticky; left: 0` so its
name survives horizontal scroll.

**The panel** is fixed to the right edge at `min(560px, 92vw)` over a `rgba(10, 8, 14, 0.34)` scrim,
with 18px between sections and `18px 20px 40px` of padding — the deep bottom pad so the last section
clears the viewport edge when scrolled.

**Density is the point.** At 1080p a column shows about ten cards, and the whole 191-record vault is
four columns and one scroll. Every measurement in the system is hand-tuned to a 1px granularity rather
than snapped to a 4- or 8-point grid: `1.5px 6px` on a chip, `3.5px 8px` on a small button, `9px 10px`
on a card face. The scale is `1 · 4 · 6 · 7 · 8 · 12 · 14 · 18 · 20`, and each step exists because
something needed it.

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

Shadows are reserved for the four things that genuinely float above the plane. Their values are not
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

**The Stroke-As-Shadow Rule.** Two `box-shadow` declarations are not shadows and must not be read as
elevation: `0 0 0 1px var(--accent)` is the selected card's ring, and `0 ±2px 0 0 var(--accent)` is the
reorder drop line above or below a card. Both use the shadow property to draw a stroke outside the box
without moving anything — the border is already spoken for.

## Shapes

Radius rises with the size of the thing it is applied to, and the ladder is the whole form language:
`--radius-sm` **3px** on a chip, link chip or inline `code`; `--radius-md` **4px** on a date input, a
filter row, a hover highlight; `--radius-base` **5px** on every control — button, input, select,
reference row, banner, rail item; `--radius-lg` **6px** on a card face, the picker and the minimap;
`--radius-badge` **7px** on a facet badge; `--radius-xl` **8px** on a container — a column, a popover,
the bulk bar, the canvas toolbar; `--radius-pill` **10px** on a count badge and a canvas band; and
`--radius-xs` **2px** on the progress track alone. Nothing is a full pill and nothing is square.

Borders carry three distinct meanings, and the difference between them is the form language doing real
work:

- **1px solid `rule`** — a boundary. Between regions, around a card, under a table row.
- **1px dashed** — *not a real value.* The `(none)` column and a context-only canvas band, both drawn
  dashed and at reduced opacity, because in each case the container exists but the value does not.
- **3px solid, left edge only** — state. A project (`accent`), a blocked card (`bad`), an open
  reference (`bad`), a finished one (`ok`, at 0.7 opacity).

### Named Rules

**The Load-Bearing Left Border Rule.** The 3px left border is the only place a card face changes shape,
and it always encodes state. It is not available for decoration, for grouping, or for a fifth meaning
without retiring one of the four.

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
- **Tones:** one class per facet axis (`facet-priority`, `facet-status`, `facet-project`, `facet-tech`,
  `facet-layer`, `facet-waiting`, `facet-domain`), plus two hueless ones — `facet-energy` (italic) and
  `facet-muted`.
- **Bucket override:** an ordered facet draws its bucket as a class, so `is-overdue` and `is-today`
  colour themselves without anything knowing the facet by name. These are the system's only two filled
  chips.
- **Toggle chip:** the interactive variant, used in the filter panel and bulk bar, with `is-on` and
  `is-clear` states.
- **Link chip:** mono 10px, hairline `rule` border, `ink-3` text, with the link kind as a 9px `accent`
  bold prefix and the label ellipsised at 130px.

### Cards / Containers

- **Card face:** `surface` fill, 1px `rule` border, `6px` radius, `9px 10px` padding, `6px` between
  its rows. Hover moves the border to `rule-2` and nothing else — no lift, no shadow, no scale.
  Selection adds a 1px `accent` ring; dragging drops it to `0.4` opacity.
- **Structure:** a head row (record mark + title, baseline-aligned), an optional two-line clamped
  excerpt, a chip row, and a mono meta line. The same face renders in a column, on the canvas and in a
  table cell — how much of it appears is a property of the view, never of the record.
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
  dense list does not shift its neighbours. The rail search is the one exception: it removes the
  outline and moves its border to `accent` instead, because a 2px ring against the rail's edge read as
  a second boundary.
- **Selects:** `appearance: none`, `surface-2` fill, `rule` border, 12px — flatter than a text input,
  because a select is a control rather than a field.
- **Disabled:** `0.45–0.5` opacity and `cursor: not-allowed`. No colour change.

### Navigation

The sidebar is the navigation, and it has no links. It is a stack of `rail-block` groups separated by
hairlines, each a row of a 62px mono uppercase 9.5px label and a control. The filter panel below it is
the only scrolling region: a facet head that turns `accent` and weight 600 when active, a caret, a
count badge, and an indented list of values at 12px. A computed axis carries an italic mono glyph so
you know nothing is written on the card — the panel otherwise treats it identically to a stored one.

### The Record Mark

The signature component, and the one nothing else can substitute for. A mono glyph before every title
saying what the record is — `•` a card, `○` a node, `▣` a project — followed by a count when others
name it as parent. It sits at `0.8em` of whatever type it precedes, so one rule serves the 12.5px table
row, the 13px card face and the 16px panel header. See **The Measured Glyph Rule**.

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
- **Do** let motion exist exactly where a mouse gesture would feel broken without it — dragging a card,
  panning or zooming the canvas, collapsing the rail. Regrouping, re-sorting and filtering are instant.

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
  else. A record *being* a project is a property of the record, so `.cardface.is-project` draws its
  left border in `hue-purple` — the project axis's own family — even though the two tokens hold the
  same value in both themes.
- **Don't** put `--ink` on a filled background. `ink` and the semantic hues follow the theme in the
  same direction, so the pair never has contrast: `ink` on `bad` measured 1.92:1 in light, and `ink` on
  `warn` **1.03:1** in dark — invisible. Every filled state takes `ground`, which is 7.58:1 at worst
  across the same four combinations, and is what `.btn.primary` and the two bucket chips do.
- **Don't** add a breakpoint. There are none, and the surface is a second monitor.
- **Don't** interpolate a colour. Every value comes from `xoria256.yml`; the two exceptions
  (`rel-blocks` at `#b06060` in light, and the `chip-tint` mixes) are documented where they occur and
  each has a stated reason.
- **Don't** give a hint facet a diluted hue. It gets no hue — transparent fill, `rule` border, `ink-3`
  text — or it earns a family of its own.
- **Don't** nest a scroll inside a scroll. One region scrolls per axis.
- **Don't** use dashed borders for anything but a container whose value does not exist.
