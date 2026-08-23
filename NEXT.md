## Where the model landed

Relations became reference facets and `edges:` left the file format; `kind` went, since carrying a
`status` is what makes a record work and being named by any reference facet is what makes it a
container;
`chips` and `edges.show` became one `show`; `connect` moved onto the shape; `groupBy` draws bands on a
canvas. Then facets got a `type` — `label · ref · date · number` — so `due` is an ordinary facet, range
filters work on any ordered one, the type picks the editing control, and project instructions moved out
of the body into the `project:` block.

All of it is described in [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md). The phase
documents it was designed in are gone: the design is the code now, and a second place saying so would
only drift.

One decision worth remembering: **`parent` is `single: true`.** Nothing had ever created a second
parent and no record carried one, so it states what was already true. Flip the flag if a card genuinely
needs to be part of two things.

## Not now

- **The expression language.** Moving the five remaining pseudo-facets — `type`, `blocked`, `triage`,
  `staleness`, `linked` — into `facets.yaml` needs one, and its hardest case cannot be a per-record
  expression at all: `blocked` requires the aggregate pass over every record's blocking references.
  Since P8 the case is weaker anyway: each of the five computes over something a facet *cannot*
  describe — a `project:` block, the reference graph, an absence, a record's links, the app-written
  `updated` — so `PSEUDO` has a coherent residual job rather than being a holding pen.
- **Per-column summaries.** Not blocked on the expression language, which was the wrong reason: a
  built-in summary is a *named aggregate* — count, sum, average, min, max — and needs no parser, and
  `type: number` now exists so the arithmetic ones would mean something.

  Two better reasons to wait. **It would not retire `projectRollups`**: `direct`/`total` is a
  transitive walk over the membership graph, not an aggregate over the visible result set, so a summary
  mechanism sits beside the special case instead of absorbing it — the opposite of what P6–P8 each did.
  And **there is nothing to aggregate**: one ordered facet, no record carrying it, no numeric facet, so
  the arithmetic summaries would ship with zero users. What is left — count with a predicate — mostly
  duplicates the counts already on a board column, a table section and the project table.

  Revisit when a numeric facet exists or deadlines are in use, i.e. when there is a question on screen
  that cannot be answered.
- **`container: true`, when the proxy breaks.** Three semantics are inferred from `single: true` on a
  reference facet: which records are siblings, which relation the bulk bar's "set …" button writes, and
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

- **`subtitle: true`, and the last two per-facet affordances.** `RecordPicker` draws a record's project
  under its title, and the projects table has a column of them; both read the built-in `project` facet
  directly. They are legal — being known by name is what built-in means — but they are the only two
  places left where one axis has UI no other axis can have.

  A `subtitle: true` key would generalise both: the picker draws whichever facets ask for it, the table
  gets a column per asking facet. Small, and worth doing the moment a second axis wants it. Until then
  it would be a key with exactly one setter, which is the shape of a thing that drifts.

- **Keyboard operation.** The largest thing the app cannot do. Structure is edited by gesture on
  purpose — drag, the bulk bar, canvas handles — and content through the panel, so there is no keyboard
  path to either: eight `aria`/`role` attributes in the whole client, and a board you can only
  rearrange with a pointer.

  It is not an accessibility item, which is why it sits here rather than being owed to anyone. This is
  a single-user tool on one machine, and the cost is *speed*: a surface open all day beside a terminal,
  with a Vim palette and full CLI parity, where every column is one hand on a mouse. `j`/`k` down a
  column, `1`–`4` for priority, `/` to search, `g` to regroup, `x` to select.

  Two reasons to wait. **The gesture semantics are the hard part, not the bindings**: a drag says
  replace, ⌥ says add, ⇧ says remove, and a keystroke has no modifier to carry that — so a key-driven
  facet edit needs a third way to say which of the three it means, and inventing one badly would put a
  second write path beside the one P2 unified. And **there is no evidence yet about which motions are
  frequent**; the honest input is a few days of noticing what the mouse keeps being reached for, which
  is cheaper to collect than to guess. Revisit with that list in hand.

  What the panel critique of 2026-08-22 added to this, and it is a shorter list than it was — the
  markup, as distinct from the bindings. Four items, each independently doable and none of them needing
  the gesture question answered first:

  - **There is no keyboard path to open a card.** The board tile is a `div` with `onClick` and the table
    row a `tr` with `onClick`; the canvas opens on double-click. None is focusable. Paths *do* exist —
    the sidebar's focus pill, and the panel's own reflinks and reference chips are native buttons — so
    the accurate statement is that the focus pill is the only cold start and the rest only switch cards
    once a panel is already open. Making the two openers buttons is the whole of it.
  - **The panel manages no focus.** `role="dialog"` with no `aria-modal`, nothing focused on open
    (`activeElement` stays on `body`), no trap — Tab from the last control lands in the sidebar behind
    the scrim — and no restore on close. The board behind it stays in the tab order with no `inert`.
  - **Rename is pointer-only.** The title is an `h2` with `onClick` and a `title` tooltip: no
    `tabIndex`, no `role`, no key handler, and a screen reader announces the heading as "Rename".
  - **The filter rail's disclosure heads carry no `aria-expanded`**, so an open axis and a closed one
    are indistinguishable to anything that is not looking at the caret. Eighteen of them.

  Two things came off the list rather than onto it. The card panel's own thirteen disclosure heads are
  gone — an axis carrying nothing is not drawn, so there is nothing to expand — and the Body and
  Frontmatter toggles now announce their state, because `aria-pressed` arrives with the pressed
  treatment they share. The `read`/`edit` pair had been two buttons a screen reader could not tell
  apart.
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
changing it — a handful of `pj check` warnings left, `energy` set on a few records, `owner` on one,
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
