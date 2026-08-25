## Where the model landed

Relations became reference facets and `edges:` left the file format; `kind` went, since carrying a
`status` is what makes a note work and being named by any reference facet is what makes it a
container;
`chips` and `edges.show` became one `show`; `connect` moved onto the shape; `groupBy` draws bands on a
canvas. Then facets got a `type` — `label · ref · date · number` — so `due` is an ordinary facet, range
filters work on any ordered one, the type picks the editing control, and project instructions moved out
of the body into the `project:` block.

All of it is described in [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md). The phase
documents it was designed in are gone: the design is the code now, and a second place saying so would
only drift.

One decision worth remembering: **`parent` is `single: true`.** Nothing had ever created a second
parent and no note carried one, so it states what was already true. Flip the flag if a card genuinely
needs to be part of two things.

## Not now

- **The expression language.** Moving the five remaining computed axes — `type`, `blocked`, `triage`,
  `staleness`, `linked` — into `facets.yaml` needs one, and its hardest case cannot be a per-note
  expression at all: `blocked` requires the aggregate pass over every note's blocking references.
  Since P8 the case is weaker anyway: each of the five computes over something a facet *cannot*
  describe — a `project:` block, the reference graph, an absence, a note's links, the app-written
  `updated` — so `COMPUTED` has a coherent residual job rather than being a holding pen.
- **Per-column summaries.** Not blocked on the expression language, which was the wrong reason: a
  built-in summary is a *named aggregate* — count, sum, average, min, max — and needs no parser, and
  `type: number` now exists so the arithmetic ones would mean something.

  Two better reasons to wait. **It would not retire `projectRollups`**: `direct`/`total` is a
  transitive walk over the membership graph, not an aggregate over the visible result set, so a summary
  mechanism sits beside the special case instead of absorbing it — the opposite of what P6–P8 each did.
  And **there is nothing to aggregate**: one ordered facet, no note carrying it, no numeric facet, so
  the arithmetic summaries would ship with zero users. What is left — count with a predicate — mostly
  duplicates the counts already on a board column, a table section and the project table.

  Revisit when a numeric facet exists or deadlines are in use, i.e. when there is a question on screen
  that cannot be answered.
- **`created` and `updated` as axes.** They are note fields rather than facets, so `sort` accepts them
  and `filter` and `groupBy` do not — `validateViews` exempts exactly those three names, `title`
  included. A `?f.updated=` matches nothing and says nothing, which is the asymmetry.

  The obvious repair — make `updated` an app-owned ordered facet, the way `project` is an app-owned
  reference one — was looked at properly and **rejected**. Three things it breaks, each true today:

  1. **A facet's values live in `rec.facets[name]`, and these do not.** `updated` sits at the
     frontmatter root, in `KEY_ORDER`. `valuesOf` and `rawOf` are plain map lookups, and "the engine
     reads a facet in exactly two places" is a property `FacetType` states about itself. This would be
     the first facet needing a branch in both.
  2. **Every facet in the map is editable, by construction.** The panel builds its controls by
     filtering `defs`, so a `date` facet called `updated` renders an editable date field for a stamp
     the app rewrites on every save. `FacetDef` has no read-only key, so this needs a new one whose
     only setter is `updated` — the shape `container:` and `subtitle:` are both waiting out.
  3. **The name is reserved for a reason**, and `a note field outranks a facet wearing its name` pins
     it. Un-reserving gives one axis two sources.

  It also would not remove the asymmetry, only move it: `created` and `title` stand in exactly the same
  place, so the choice is three exceptions or a new odd one out.

  And the payoff shrank. Once `show` learned to draw a computed axis, `staleness` shows, filters,
  groups and sorts; what is left is range filters on a raw date. The design already says which side
  this belongs on — the reason the five computed axes stay computed is that each covers something a
  facet *cannot* describe, and "the app-written `updated` field" is on that list. A facet is what a
  person or an agent asserts about a card; `updated` is a fact about the file.

  **If it is picked up, the shape is a raw value on a computed axis** — `Computed` gains an optional
  `raw`, so `staleness` *shows* the date and *filters* the bucket. That is the rule an ordered facet
  already follows (`due` draws `2026-08-27` and filters `overdue`), applied where `updated` already
  lives: no facet, no new vocabulary key, no un-reserving, no editable timestamp, `valuesOf` untouched
  — and `created` joins as a second computed axis with no new machinery. It would also retire the
  static `Updated` column, leaving a table with no value column that `show` did not name. Range
  filters on the raw value would be a filter-layer change on top, still without a facet.

  Not now because `staleness` covers the common case and nothing has asked for the rest.

- **`container: true`, when the proxy breaks.** Three semantics are inferred from `single: true` on a
  reference facet: which notes are siblings, which relation the bulk bar's "set …" button writes, and
  — for `single` alone, any type — which axes `pj log` narrates. `single` is a *structural* property
  doing semantic work, and it is a good proxy: one value is what makes a container a container, and a
  card holding one value on an axis is a card whose change to it is a transition.

  It has one failure that is easy to state. A vault declaring **two** single-valued reference facets
  gets the first for the button, by declaration order, arbitrarily — and siblings from both at once,
  which may be right or may be two unrelated senses of *beside*. Nothing in the seeded vault hits this,
  because `parent` is the only single-valued relation it has.

  The fix is a fifth relation key, and it is deliberately not written yet: adding a declaration to
  express something no vault has needed is how the vocabulary grows keys nobody sets. Add it the first
  time a vault has two containers and the wrong one wins.

- **`subtitle: true`, the last per-facet affordance.** `RecordPicker` draws a note's project under its
  title, reading the built-in `project` facet directly. It is legal — being known by name is what
  built-in means — but it is the last place where one axis has UI no other axis can have.

  It used to be two. The projects table had a static `Member of` column reading the same facet the same
  way, and that one is gone: a table's columns are its `show` list, so the column a view wants is the
  one it names. What remains is the picker, where there is no `show` to name anything.

  A `subtitle: true` key would generalise it: the picker draws whichever facets ask for it. Small, and
  worth doing the moment a second axis wants it. Until then it would be a key with exactly one setter,
  which is the shape of a thing that drifts.

- **What is left of keyboard operation.** Most of it shipped. The cursor, the trail, positional and
  addressed facet writes, undo, the rail leader and `?` are in; `src/view/keys.ts` is the grammar and
  `test/keys.test.ts` pins it.

  Two of NEXT's reasons to wait turned out to be answered already. **The mode question** — "a
  keystroke has no modifier to carry replace/add/remove" — was solved in `FacetEditor` before it was
  asked: cardinality picks the verb, `single` replaces and everything else adds, and the frequent axes
  are all `single`. **The evidence question** — "which motions are frequent" — became a config field.
  `key:` in `facets.yaml` is where that evidence lands, one letter at a time, on the day you notice
  you keep reaching for an axis.

  Still not bound, and each for its own reason rather than as a batch:

  - **`n`, a new card in the cursor's column.** The only binding whose target is not a card. The
    inline `<textarea>` it wants belongs to `Column`, so it needs a way to say "open that editor"
    across a component boundary that nothing else in the map needs.
  - **`⌥j` / `⌥k`, reordering within a column.** Cheap — the stored order is a splice through
    `saveArrangement` — and idle until a saved view is the thing being worked in.
  - **`⟨key⟩⟨key⟩`, opening an axis's control.** `bind` emits `openAxisControl` and nothing consumes
    it. It wants a popover anchored to the cursor's card rendering `FacetEditor`'s body, which is the
    same component the palette will want. Worth doing once, for both.
  - **The palette (`.`)** is unclaimed. Its shape is known: the bulk bar's axis-then-value state
    machine with the record picker's type-to-filter.
  - **A view's own `key:`.** `⌥1`–`⌥9` counts along the rail's order, so adding a view renumbers the
    ones after it. The fix is the one facets already have — let the file declare its letter — and it
    is not worth doing until the order actually churns.

- **The panel is not modal, and that overrides what the panel critique asked for.** The critique of
  2026-08-22 wanted a focus trap, `inert` on the background and focus restore on close. It got the
  opposite, deliberately: the cursor is the only pointer, so an open panel *is* the cursor's card and
  `j` turns the page to the next one. A trap would break the single most useful thing the keyboard
  does.

  What the critique asked for that did land: the panel no longer claims `role="dialog"` — it is an
  `<aside>`, which is what a non-modal reading surface is — the rename has a keyboard path, the filter
  rail's disclosure heads carry `aria-expanded`, and the board tile and table row are focusable with a
  roving tabindex, which was the "no keyboard path to open a card" item.

  What is genuinely still open is **focus restore**: closing the panel leaves focus wherever it was
  rather than returning it to the card. In practice the cursor is that card and `j` picks up from it,
  so the cost is one Tab in the rare case, which is why it is filed rather than fixed.

- **Tokenizing the rest of the scale.** `font-size` and `border-radius` are `--text-*` and `--radius-*`
  now, and `test/theme.test.ts` refuses a raw one — which held through 349 lines of new panel CSS
  without a single new step. `padding`, `gap` and `letter-spacing` did not get the same treatment:
  163 raw declarations, a documented rhythm (`1 · 4 · 6 · 7 · 8 · 12 · 14 · 18 · 20`) and nothing
  enforcing it.

  Deliberate, and the asymmetry is the point. A type step and a radius step are *scales* — one value,
  reused, where a fifteenth is almost always a mistake. Spacing is not: `1.5px 6px` on a chip and
  `9px 10px` on a card face are two-axis measurements tuned against their own contents, and naming
  them would either invent a fake ladder or produce forty tokens with one user each, which is the
  clutter the naming was supposed to prevent.

  What would change the answer is finding the same padding pair in five unrelated components — a real
  repeat rather than a coincidence of taste. Until then the rhythm is documented in DESIGN.md and
  checked by reading, and the guard covers type and shape but not rhythm. Say so rather than implying
  the stylesheet is fully policed.

## The model is done for now

P6 removed what was stored twice, P7 collapsed relations into facets, P8 typed them. Nothing in the
model is presently known to be wrong, and the next useful work is likely to be *using* it rather than
changing it — a handful of `pj check` warnings left, `energy` set on a few notes, `owner` on one,
no deadlines set anywhere.

Two things the audit of 2026-08-21 turned up that belong here rather than in the model. **`blocked_by`
carries a single value across the whole vault**, and the `blocked` axis, the transitive closure, cycle
refusal and the `unblocked` view are all built on it — the mechanism is finished and idle, the same
way `due` and `owner` are. That is also how the since-removed `pj next` could filter on a deleted
facet unnoticed for two days: with no blocker data, an empty answer looked plausible.

The second has since been fixed rather than filed: **some of the `pj check` warnings were
structural** — top-level containers belong to no project by construction — and the answer turned out
not to be an exemption in the checker. Triage is a *view* now, `views/triage.yaml` narrows to
`type: [plain]`, and `pj check` stopped judging how a card is filed at all.
