# Held consolidations — the second verification pass

Nine items. Six are consolidations proposed by a completeness sweep and its judge but **never
verified by the person migrating them**; three are concrete defects found late and not yet acted
on. Your job is to attack them.

## Read this first: the tree has moved

`findings.md` in this directory was written against a 2570-line `src/web/style.css`. It is now
~3080 lines, and the following changed *while* the previous pass ran. **Cite selectors and symbol
names, not line numbers** — the previous judge's report was full of stale citations for exactly
this reason, and two of six readers' top findings were things already fixed.

Since `findings.md` was written:

- `childCount` is now **`refCount`** everywhere, and means "how many records name this one across
  *any* reference facet" rather than "how many name it as `parent`". `countChildren` is deleted;
  `inboundCounts()` in `src/index/refs.ts` replaces it. `markOf` and the `type` pseudo-facet now
  agree by construction.
- `src/web/views/groups.ts` was rewritten around a `Lanes` discriminated union
  (`{lane} | {lanes:'all'|'merged'}`). The table renders both grouping levels in one section
  heading; the canvas merges lanes.
- New files not in `findings.md`: `src/web/components/BulkBar.tsx`, `src/web/selection.ts`.
  Selection and the bulk bar now exist in **all three shapes**, not just the board.
- New shared classes extracted last pass: `.quietcount`, `.emptystate`, `.truncate`,
  `.checkbox`, `.field-recessed`, and a `refresh` glyph in `Button.tsx`.

**Already fixed — do NOT report any of these as findings:** tabular-nums (7 scattered
declarations → 1 rule); the panel's hand-rolled uppercase axis label; the lane head's step and
weight; the Label step's missing `font-weight: 500` on `.rail-label`/`.pop-head`; `.derived`
painting `Ƒ`; the ribbon's trichotomy; the drawn checkbox in the rail, the facets popover and
markdown task lists; one `select` treatment on the element; the card face's `0.8em` resolving
against the wrong size; the lane head's non-functional `sticky`; the section `th`'s leaked UA
bold; chips touching at 0px in table cells; `CommitInput`'s two paints; duplicate `.canvas` /
`.canvas-wrap`; the picker's double frame inside a popover; the picker's second record-mark
implementation; `.pop-pick.is-missing`'s cursor; the truncation idiom.

**Known-deliberate, do not report:** `.bulkbar` is declared twice on purpose — appearance in one
place, placement in an override at the end of the file, with a comment pointing at it. A duplicate
selector is only a defect when undocumented.

---

## H1 — The refused-write message: 4 classes, 8 sites, 6 surfaces

One event — a write the server refused — rendered four ways.

- `.banner.is-bad` — `--text-body`, `--radius-base`, 1px `rule`, a 3px `bad` left stripe and a 10%
  wash. Five sites: `BoardView`, `CanvasView`, `TableView`, `CardPanel`, `FrontmatterEditor`,
  `VaultPicker`.
- `.rail-problem` — `--text-xs`, `bad`, `padding: 2px 2px 0`, no border, no fill, no stripe.
  One site: `SavedViews`, on the same `api.saveView(...).catch` shape the banner sites use.
- `.editor-note.is-bad` — mono `--text-meta`. `BodyEditor`.
- `.linkrow-note.is-bad` — sans `--text-sm`. `LinkEditor`.

Proposed: route the rail's and the two editors' refusals through `.banner` (or a compact modifier
of it) and delete the three one-off registers, keeping `.pane-error` / `.boot-error` separate as
the genuinely different region-level *read* failure.

Attack: are the two in-place ones (`editor-note`, `linkrow-note`) actually a different job — a
refusal *attached to the field that caused it* rather than a banner above a region? Does a banner
fit inside a link row or an editor bar at all? Is `.rail-problem`'s smaller register load-bearing
in a 248px rail?

## H2 — The 3px state stripe: 7 rules, and DESIGN.md permits four meanings

`.cardface.is-project` (hue-purple), `.cardface.is-blocked` (bad), `.reflink.is-open` (bad),
`.reflink.is-done` (ok, 0.7), `.banner.is-bad` (bad), `.banner.is-conflict` (warn),
`.linkrow.state-error` (bad).

DESIGN.md's **Load-Bearing Left Border Rule** enumerates four permitted meanings and closes: "not
available… for a fifth meaning without retiring one of the four." The banner's `conflict` and the
link row's `error` are a fifth and sixth. The stylesheet already argues "One state stripe, not
four" for the link row alone without noticing the six elsewhere.

Proposed: one `.stripe` rule holding the 3px geometry plus a `--stripe` custom property, so the
width lives once and the eligible token set becomes enumerable.

Attack: is a stripe on a *banner* even the same component as a stripe on a *card*? A banner is
already a bordered region; a card face's stripe is DESIGN.md's "the one place a face changes
shape". Does the rule's "four meanings" count meanings or *sites*? Note the design detector
already flags all seven as `side-tab` and they are documented as deliberate — so a consolidation
must not increase that count (baseline: 8 findings total).

## H3 — The tooltip affordance: 3 `cursor: help` against ~45 `title=`

Three rules give `cursor: help` to an element whose entire content is its `title`: `.blocked`,
`.unblocks`, `.derived` — card face, rail and panel. Against them, ~45 `title=` attributes in
`src/web/` and no tooltip component, including the richest: `.linkchip`, `.progress`,
`.recordmark`, the table's column definitions and roll-up, and three classless spans in the rail
footer.

Proposed: one `.explains` class carrying the cursor, plus a decision about which titles are
load-bearing enough to advertise.

Attack: is `cursor: help` on an element the user *cannot* interact with otherwise the same job as
on one that is also a button or a row? `.recordmark` inside `.panel-title` is a `ProjectMark`
button with `cursor: pointer` — advertising "help" there would contradict the click. Is "which of
45 to advertise" a component question at all, or a content question? Would a rule requiring the
cursor make 45 sites noisier rather than clearer?

## H4 — The wrapping chip row: 4 holders, and a gap that drifted

`.chiprow` (`display: flex; gap: 4px; flex-wrap: wrap`) — card face, board, canvas, table.
`.bulkbar-values` and `.facetedit-values` are the same three declarations verbatim.
`.facet-values.is-chip` was the same at `gap: 3px` — **that variant is now deleted**, so re-check
whether the drift still exists at all.

The table's missing holder is already fixed (chips were touching at 0px), and `.table .chiprow`
now takes `flex-wrap: nowrap` because a table column is elastic where a 292px card column is not.

Attack: after the `is-chip` deletion, are there still three holders with the same intent, or two
plus a bulk bar whose contents are toggles rather than display chips? Does `align-items: center`
on the toggle variants make it a parameterised component (which the brief's own threshold calls
premature)?

## H5 — The sticky heading: a policy rather than a class

The only three `position: sticky` declarations in the stylesheet, one per surface, each answering
"what repaints behind me, and where am I in the z stack" differently: `.panel-top` (`top: 0`,
`background: surface`, `z-index: 2`, hairline); `.table thead th` (`top: 0`,
`background: ground`, `z-index: 1`); `.lane-head` (`left: 0`, and it now has
`background: ground`, `z-index: 1` and `align-self: flex-start` because its sticky was fixed last
pass).

Proposed: not one class but one stated policy — a sticky heading repaints its own ground and names
its stacking level — with the axis staying per-site.

Attack: three sites is exactly the threshold, not above it. Is a policy in a document worth
anything a comment on each of three rules is not? Are the z-index values (2 vs 1) load-bearing
relative to the panel's scrim and the board's bulk bar at `z-index: 6`?

## H6 — The recessed control box, beyond `CommitInput`

`.field-recessed` was extracted last pass because `CommitInput` painted its input two ways
depending on the wrapper tag its caller passed. The judge claims two more carry the same seven
declarations: `.popbtn` (plus flex/appearance/cursor) and `.rail-search input` (the same core at
`5px 8px` rather than `3px 6px`).

DESIGN.md declares this component as `input-rail` in its `components:` frontmatter, prescribing
`padding: 5px 8px` — which only `.rail-search input` matches. Note `test/theme.test.ts` compares
frontmatter *key sets* against the token names and never reads `components:` values, so a stale
per-component value passes.

Attack: is `.popbtn` a field or a button? It is a `<button>` opening a popover — DESIGN.md gives
buttons `rule-2` borders and `surface-2` fills, which overlaps by coincidence rather than by
intent. Is the rail search's own documented exception (it replaces the focus ring with an accent
border because "a 2px ring against the rail's edge read as a second boundary") evidence it is the
same component, or evidence it is a third?

---

## Three loose defects, not consolidations

## H7 — The vault gate nests a second Y scroller

`.vaultgate` has `overflow-y: auto`; `.browse-list` inside it has `overflow-y: auto` and
`max-height: 220px`. Verified in the browser: both are `auto` on the Y axis and `.browse-list` is
a descendant of `.vaultgate`. Neither overflows at 820px height yet, so it is latent.

This is a stated non-negotiable — "no nested scroll on one axis" — and it is the identical shape
the record picker was twice fixed for. (Both of the picker's fixes are now gone, and the second one
is the better precedent: `.picker.is-inline .picker-list` surrendered the scroll while the picker sat
in the card panel's flow, and that variant is retired because the picker no longer sits there — it
floats in a popover, which measures its own `maxHeight` and does the scrolling. Escaping the
containing scroller beat negotiating with it.) The picker's other answer was to cap at 40 rows and
make typing the way past it; the browse list has no cap and a folder can hold hundreds of entries.

Attack: is a `max-height` cap on an intrinsically-sized list the same thing the rule forbids, or
is the rule about two *panes* competing for a wheel? What is the right bound for a directory
listing, and does capping it hide entries with no way past?

## H8 — A dashed border meaning "optional"

`.facetedit-add input` draws a 1px dashed border for the empty new-value field, turning solid on
focus. DESIGN.md's **Dashed Means Absent Rule** reserves dashed for "a container whose value does
not exist" and says by name that it "never means 'draft', 'disabled' or 'optional'".

Attack: an empty new-value field arguably *is* a container whose value does not exist — is this
the rule being obeyed rather than broken? Note the field also carries the stylesheet's only
`transition: width`, which the design detector flags (part of the documented baseline of 8).

## H9 — The panel's field replacing its focus ring

`.facetedit-add input:focus` removes the outline and moves its border to `accent`. DESIGN.md
sanctions that for exactly three inputs, on the stated ground that "a 2px ring against the rail's
edge read as a second boundary" — a rail rationale. This input is in the **panel**, which is a
560px surface with no such edge.

Attack: is the panel's facet-editor row dense enough that the rail's reason transfers? The panel's
own documented focus behaviour is `outline-offset: -1px`, drawn inside the box "so a focused field
in a dense list does not shift its neighbours" — does that already cover it?
