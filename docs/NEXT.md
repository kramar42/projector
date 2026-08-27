## Where the model landed

Relations became reference facets and `edges:` left the file format; `kind` went, since carrying a
`status` is what makes a note work and being named by any reference facet is what makes it a
container;
`chips` and `edges.show` became one `show`; `connect` moved onto the shape; `groupBy` draws bands on a
canvas. Then facets got a `type` — `label · ref · date · number` — so `due` is an ordinary facet, range
filters work on any ordered one, the type picks the editing control, and project instructions moved out
of the body into the `project:` block.

All of it is described in [MANUAL.md](MANUAL.md) and [ARCHITECTURE.md](ARCHITECTURE.md). The phase
documents it was designed in are gone: the design is the code now, and a second place saying so would
only drift.

One decision worth remembering: **`parent` is `single: true`.** Nothing had ever created a second
parent and no note carried one, so it states what was already true. Flip the flag if a note genuinely
needs to be part of two things.

## Not now

- **The aging view — who owes me what, and for how long.** `waiting_on` says the ball is in
  someone else's court and `staleness` says how long it has sat there, but nothing puts the two on
  screen together, so a parked note is only found by opening it. The view is a table filtered to
  `blocked: [waitingon]`, sorted by staleness descending, showing `waiting_on` and the note's project
  — a nudge list, in the order the nudges are overdue.

  It needs no new mechanism, which is exactly why it is filed rather than built. Both axes exist and
  both compute; `views/week.yaml` is the same kind of object and took one file. What it lacks is
  **data**: `waiting_on` is set on almost nothing, so the view would ship reading empty and prove
  nothing — the failure `blocked_by` already demonstrated, where an empty answer looked plausible for
  two days because there was no data to contradict it.

  So the order is deliberate: set `waiting_on` for a fortnight of real weeks first, then write the
  view against notes that exist. Shipping it before then would add a second empty board beside the
  first, and an empty view teaches the reader that the axis is decorative.

  One design question to settle when it lands, and it is the only one: **staleness is measured from
  the file's `updated`, not from when the waiting started.** Editing a note's body resets it, so a
  note you thought about on Tuesday reads as fresh on Wednesday while the person has been silent for
  a fortnight. That makes the sort wrong in exactly the case the view exists for. Either the view
  accepts the approximation and says so, or `waiting_on` needs a date beside the person — which is a
  second value on a label facet, and the vocabulary has no shape for that today.

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
  person or an agent asserts about a note; `updated` is a fact about the file.

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
  note holding one value on an axis is a note whose change to it is a transition.

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

  - **`⌥j` / `⌥k`, reordering within a column.** Cheap — the stored order is a splice through
    `saveArrangement` — and idle until a saved view is the thing being worked in. Card order only
    lives in a file, so on an ad-hoc query there is nothing for it to write to.
  - **A view's own `key:`.** `⌥1`–`⌥9` counts along the rail's order, so adding a view renumbers the
    ones after it. The fix is the one facets already have — let the file declare its letter — and it
    is not worth doing until the order actually churns.
  - **Focus restore on closing the panel.** Focus is left wherever it was rather than returned to the
    card. In practice the cursor *is* that card and `j` picks up from it, so the cost is one Tab in
    the rare case.

- **The palette (`.`), and why its job keeps shrinking.**

  `.` is bound in the grammar and acts on nothing. The shape was never the question: it is the bulk
  bar's state machine — pick an axis, then the control that axis's `type` picks — with
  `RecordPicker`'s type-to-filter over the front of it. Both halves exist and neither would have to be
  written twice.

  What has changed is how much would be *left* for it. When it was filed, the palette was the answer
  to "an axis with no letter", "an axis this note carries nothing on", and "a value I would rather
  type than walk to". The first two are gone: `gf` walks every drawn row and `g⇧F` adds one, so every
  axis in the vocabulary is reachable whether or not it declares a `key:` and whether or not the note
  carries it. What is left of the third is real but small — a project picked by typing three letters
  of its name rather than walked to — and `RecordPicker` already does that from the rail's Focus row
  and the bulk bar.

  So the honest residual is **the commands that are not axes**: merge, save this query as a view,
  delete. Delete is deliberately unbound and should stay that way; the other two live in the rail and
  are two keystrokes away. That is a thin case for a whole surface.

  Two things would change the answer. A vocabulary with **more axes worth reaching than there are
  letters** — fourteen are free, the seeded vault spends seven — at which point a name is the only
  address left. Or a **command set that outgrows the map**: the moment there is a third thing like
  merge that has no row in the rail and no letter, the palette stops being a nicer way to do what a
  key already does and starts being the only way to do something.

  The trap to avoid, and the reason not to build it early: a palette that duplicates the map is a
  second place for every binding to be kept in step, and the first one to drift will be the one nobody
  presses.

- **The panel is not modal, and that overrides what the panel critique asked for.** The critique of
  2026-08-22 wanted a focus trap, `inert` on the background and focus restore on close. It got the
  opposite, deliberately: the cursor is the only pointer, so an open panel *is* the cursor's card and
  `j` turns the page to the next one. A trap would break the single most useful thing the keyboard
  does.

  What the critique asked for that did land: the panel no longer claims `role="dialog"` — it is an
  `<aside>`, which is what a non-modal reading surface is — the rename has a keyboard path, the filter
  rail's disclosure heads carry `aria-expanded`, and the board tile and table row are focusable with a
  roving tabindex, which was the "no keyboard path to open a note" item.

  What is genuinely still open is **focus restore**: closing the panel leaves focus wherever it was
  rather than returning it to the card. In practice the cursor is that card and `j` picks up from it,
  so the cost is one Tab in the rare case, which is why it is filed rather than fixed.

- **What is left of the two panel critiques.** The critiques of 2026-08-22 and 2026-08-23 are gone as
  files: `6d4bf8a` rewrote the panel they cite, so every line reference in them was dead, and the two
  documents disagreed with each other about what was still true. Their P0s and P1s all shipped — the
  facets tier pruned, the project mark asking before it deletes a `project:` block, Escape stopping at
  the link field, the refusal banner moved into the sticky head, the labels off the UA form-control
  font and a test that fails on the original bug. What follows is the residue: the entries below, the
  modality decision above, and nothing else.

- **An open axis still draws its whole vocabulary.** `FacetEditor` renders `[...def.values,
  ...extras]` whichever way `def.open` points, so a carried `tech` draws nine chips with the note's
  actual value merely lit. Pruning uncarried axes fixed the larger half of the "mostly empty chrome"
  finding — thirteen label-only rows on a bare note became none — and this is what is left of it: a
  carried label axis is as tall as its vocabulary rather than as tall as its values.

  The shape is already in the file. The `ref` and `date` branches open a `PopoverButton` instead of
  drawing inline, so a values-only readout that expands to the picker on click is the third case of a
  pattern that already has two. What makes it worth doing is a vocabulary wider than what a note
  carries on it — which `tech` and `source` are and the frequent axes are not, since `single` axes
  draw few chips anyway. Do it when an `open: true` axis is in daily use, or when one declares more
  values than a row can hold.

- **The link field is documented by a placeholder.** `LinkEditor` is one input whose five syntaxes
  live in `placeholder`, which disappears on the first keystroke — the documentation goes away exactly
  when it is needed. A `+ link` control opening a kind picker would also give the genuinely awkward
  case a labelled destination: pasting an opaque `claude:local_…` id, where nothing on screen says
  which of the five kinds it is. `LINK_KINDS` in `src/web/links.ts` already declares each kind with a
  glyph and a hue, so the picker's contents are data rather than new vocabulary.

  Filed rather than fixed because the part that lost work is fixed: Escape stops at the field now, so
  what remains is discoverability for a syntax the README also states.

- **Colour and contrast are the rules prose still guards.** `test/theme.test.ts` refuses a raw type
  step, a raw radius, an untokenised frontmatter colour, uppercase not taken via the Label step, a
  browser-drawn control, a breakpoint, a hue no vocabulary names, a `className` that resolves to no
  rule, and a `<button>` carrying no font family. It says nothing about whether two colours can be
  read against each other, which is the one gap `DESIGN.md`'s named rules cannot close by being read.

  There has been exactly one regression of this kind and it was caught by hand: `style.css:1827`
  records a `dt` label receding by `opacity: 0.72` and landing at 3.16:1, under the floor, found by
  measuring rather than by testing. The panel measured well when it was measured — 6.11:1 dark, 5.04:1
  light, nothing under 4.5:1 — and nothing holds it there.

  Why it is not written: a ratio needs resolved colour, and the palette is custom properties with a
  light definition and a dark override. That means either a browser — `puppeteer` is not a dependency,
  which is also why the design detector returns zero findings on TSX and why its clean run proves
  nothing about contrast — or resolving custom properties in the test. The second is the cheaper one
  and it is bounded: tokens on `:root` plus one override block. The next contrast regression is what
  makes it worth the afternoon.

- **The tier-1 ordering is emergent, and nothing pins it.** `project` and `parent` land first and
  adjacent among the reference facets because `BUILTIN_FACETS` inserts `project` first and the vault
  declares `parent` next — not because any code says so. That is the right architecture, and it is
  what closed the original complaint that `owner`, documented as declared and unused, held a permanent
  row between the two axes doing structural work. But it is an outcome of two files' line order, so a
  vocabulary edit can silently undo it. A test asserting what the reference tier's first rows are
  would pin the outcome without the panel naming a facet, which is the property worth keeping.

- **Native `confirm()` at every high-stakes moment.** Six call sites now — close with unsaved changes,
  discard an editor, un-project a note, delete a note, delete a selection, and the bulk bar's second
  one. The app draws its own checkboxes and selects on the grounds that a browser-drawn control is a
  seam; the most consequential moments are handed to the browser wholesale.

  The counter-argument is why it is filed. A native dialog cannot be styled into looking dismissible,
  cannot be missed, and blocks — which is most of what a confirm is for. What would change the answer
  is the first prompt that needs to show something a string cannot: the project block's own prompt
  already wants to be a list and settles for naming the kinds, because `data.project` resolves along
  the chain and a count would be confidently wrong on a project inside another project.

- **A body checkbox should toggle.** The rendered body draws each `- [ ]` as a real
  `<input type="checkbox">` — `marked` with `gfm: true` emits one per task item — but the HTML
  arrives through `dangerouslySetInnerHTML` and nothing listens: the whole rendered body is
  read-only by design, and flipping one box means entering the editor to change one character.
  A control that looks native and does nothing is the panel's one false affordance, and it is
  found the way false affordances are found — by someone clicking it, twice, and concluding the
  app is broken.

  The fix is bounded and needs no new write path. A click on `.md input[type='checkbox']` maps
  the box's ordinal among the rendered task inputs to the nth task marker in the source — the
  orders agree, because only a real task item becomes a checkbox, so a `- [ ]` inside a code
  fence counts in neither — flips exactly that `[ ]`↔`[x]`, and goes through `write.body`, the
  same mtime-guarded write the editor uses (C10: content is edited in the panel). One character
  changes; every other byte is preserved, which is the promise the progress bar already relies
  on.

  Until it lands, the honest interim is smaller still: render the boxes `disabled` so the
  cursor says what a click will do.

- **Three small panel things, each independent of the rest.** `updated` sits in the workshop block
  without the `ƒ` that marks its neighbours as resolved rather than stored, though it is derived from
  the file's mtime — one span. `.refchip-title` ellipsises at `26ch` while a `.reflink` row takes a
  full line, so the same note reads shorter as a Part-of chip than as a Children row inside one
  scroll. And `+ record` cannot mint one: linking a note that does not exist yet means closing the
  panel, creating it, and reopening. The third is the only one with a design question in it, and `n`
  narrowed it rather than answering it: a new card on the board inherits the column it was made in,
  because the board's own rule says what that column means. A picker has no column to inherit — what
  it has is the axis it was opened from and the note that opened it.

  `CommitInput` belongs to the same list. Field, explicit button, Escape; used in the rail and the
  canvas; used in the panel nowhere, whose remaining plain-Enter fields are exactly its shape. Its
  docstring explains why it did not generalise to the title textarea and is silent about these.

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

- **`⏎` on a Tab-focused panel action.** Tab reaches the panel corner's two buttons, but `⏎` is claimed
  by the key map and resolved as `open`, which activates a focused item only when it sits inside a
  `[data-navlist]`. The corner is not one, so tabbing to the trash or to Start and pressing `⏎` opens
  the cursor's note instead of pressing the button under focus.

  Predates the Start control — the trash has behaved this way since `⏎` became the map's — and it fails
  safe in both cases, so it is a wart rather than a bug. The fix is either to make the corner a navlist
  (which would also put Delete in the `j`/`k` walk, and it is not obvious that it should be) or to have
  `open` press any focused button in the panel. Neither is worth deciding while the buttons are also
  reachable by `!` and by mouse.

- **C2's summary column still reads as a ban on notifications.** The rule is *nothing is written where
  somebody else reads* — Jira, GitHub, Trello and Slack are exactly the shared ones, and a sink only you
  read is not among them. The detail column has always said that; the summary says "everything external
  is read-only", which reads as forbidding the local notification that shipped and the private push that
  would be fine. Reword it when something actually pushes: today nothing does, so the wording is
  misleading rather than wrong.

- **Nothing re-judges a note that was already filed.** The pass writes a card once, on the way in. A
  vault holding cards from an earlier, thinner version of it keeps them — and deleting one to force a
  re-sweep now records the decline, so it does not come back either. `pj intake rejudge`, running the
  pass over notes still carrying `intake: unjudged` and rewriting title, body and facets in place, is
  the migration path and the way to benefit from a changed `classify.md` without emptying the queue by
  hand.

  It is not filed as an afterthought: it is the only operation in the pipeline that would *overwrite* a
  note rather than create one, so it needs a rule about what it may touch. Facets a person has since
  corrected must survive it, and there is nothing on a note today that distinguishes a value the model
  proposed from one you accepted.

- **The secrets rule is asked of a model, not applied by code.** Both prompts that reach one — the
  classifier's and the fetching agent's — say a credential's value must never be reproduced, and a test
  pins the wording. But the maxim below applies: never ask a model to honour a rule that can be applied
  deterministically. Full secret detection is not deterministic; the common shapes are — an AWS key id,
  a `ghp_` token, a PEM header — and a scrub at `materialise` time would sit on the one seam every
  unattended write already crosses, catching the model that forgot. Known shapes only: redacting
  anything that merely looks entropic would eat commit hashes.

## Ideas from elsewhere

[Watchtower](https://github.com/Ruben-M-D/Watchtower) is a public MIT-licensed triage agent: it polls
Jira, Gmail, IMAP and GitHub read-only, scores every item with a local model, and pushes what clears a
threshold to a private bot. It answers the question intake answers, from the other end — a background
daemon with a durable queue where projector has a sweep and a cursor. That difference is a change to
the model and not one of these; what follows is the smaller, separable things it does better.

- **A hard rule the source only asserts in a comment.** C2 says no code path writes to Jira, GitHub,
  Trello or Slack. `src/sources/jira.ts` says `Only GET is ever issued (C2)` in a docstring, and that
  is the whole enforcement — nothing greps for a write verb, and the write-path table pins concurrency
  guards on *vault* writes, which is a different claim. Watchtower's `scripts/audit_readonly.sh` fails
  its build on a non-GET verb in a source adapter, with two details worth copying: a negative lookbehind
  so a local route decorator is not mistaken for an outbound write, and per-file patterns, so a method
  name that is a write in one API is not flagged in a file that cannot call it.

  Its weakness is a hardcoded list of watched files — add a source and it is silently unaudited — which
  is exactly the half our table already gets right. So the pairing is the work: assert that every file
  under `src/sources/` and `src/enrich/` appears in the table, then grep those files for a verb other
  than GET. That is one test, and C2 would be checked rather than trusted.

- **A verb allow-list checked before the subprocess spawns.** Watchtower's read-only git module keeps
  a frozen set of safe verbs and refuses anything outside it *before* spawning, plus a
  separate set of flags that are writes wearing a safe verb — `branch -D`, `remote add`,
  `config --global`. `src/agent/` runs git for worktrees and history and does not have this shape.
  Worth having wherever a verb is assembled rather than literal.

- **Calibration from decisions already made.** Watchtower turns every Mark into "should have scored
  high" and every Skip into "should have scored low", pulls the recent N of each, and injects them into
  the classifier prompt as few-shot examples, with the instruction that a new item resembling a skipped
  one scores low *even if its subject looks urgent*. It converges on a person's taste without a
  prompt-tuning step.

  Not buildable here, and the reason is structural rather than an ordering preference: **there is
  nowhere to keep a rejection.** A candidate examined and not captured sits behind the cursor once the
  sweep commits, and `source_fingerprint` only stops what became a note — so the corpus this needs does
  not exist and cannot be reconstructed. It is downstream of a durable queue, not independent of it.

  Two flaws to leave behind if it ever lands. It shuffles the examples, so the prompt differs run to
  run and the zero temperature buys nothing reproducible. And it stamps two synthetic scores on them,
  so a model learns two buckets rather than an ordering.

- **A prior per person, with a cold start that makes it honest.** Counts of marked/skipped/done per
  sender, offered to the classifier as rates with an explicit *"a prior, not a rule — override it when
  the content diverges"*, and below a few observations it returns nothing at all so the base rubric
  applies cleanly. The cold-start null is the part that makes it more than a gimmick.

  The aging-view argument applies verbatim, and for once it is the same sentence: `owner` is set on one
  note and `waiting_on` on almost nothing, so a per-person prior would ship computing over an empty
  table and prove nothing — the `blocked_by` failure again, where an empty answer looked plausible
  because there was no data to contradict it.

- **A form that renders from the source's own schema.** Each Watchtower source declares its connect
  form as JSON Schema, and the accounts page draws it — a new source is one file and one import, with
  no frontend change. Two non-standard keys carry most of the value: a `help_url` and `help_label` that
  link straight to the page where the credential is minted.

  `Channel` in `src/intake/types.ts` declares `name`, `defaultDays` and `collect`, and everything about
  *how to configure it* lives in `src/setup.ts` and in the `/pj-setup` skill's prose instead. A channel
  that declared its own required credentials and where to get them would move that to the one place
  that already knows.

- **Enforce the hard rule in code, then say that you did.** A trusted-sender floor is applied *after*
  the model returns rather than asked for in the prompt, and when it fires the stored reason is
  prefixed with the address that caused it — so a dull item that surfaced anyway explains itself. The
  general form: never ask a model to honour a rule that can be applied deterministically, and make the
  override visible where its effect shows.

- **Two orthogonal columns instead of one overloaded status.** Watchtower keeps "was pushed" on
  `notified_at`, separate from the triage `status` the person owns, and the notifier never touches the
  latter. Quiet hours are then not a state at all — they leave the timestamp null, so the item is
  visible, the next poll will not re-push it, and nothing has to lie. The same split is why the
  notifier can decline to ping something already acted on in the UI. Worth remembering as the shape
  for any "surfaced" axis, which is a thing an intake queue would need and no facet describes.

- **Optional integrations that are absent rather than broken.** Its optional executor client raises
  three distinct types — not configured, configured but unreachable, and a structured upstream error
  carrying status, detail and URL — and unconfigured resolves to a feature that is simply off, with no
  broken control and no console error. Stated in the docstring as a goal: someone who never heard of
  the other tool gets a working app. `pj intake`'s `fetched: false` with a `reason` is the same
  instinct already; the three-way split is what the enrich fetchers and the Jira credential do not
  have.

- **A launcher that checks its own build.** `scripts/start.sh` refuses to start a second instance and
  names why — two pollers would double every notification and race on one SQLite file — and it compares
  the mtime of the UI sources against the built output before serving, because *"a stale build silently
  means API up, no dashboard."*

  We document that footgun instead of closing it: `serve` serves `dist/`, and CLAUDE.md spends a
  paragraph warning that a reading at 8092 which says the fix did not take is almost always a stale
  bundle. A staleness check in the script would retire the paragraph. It is the only one of these that
  needs no design thought at all.

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
`type: [plain]`, and `pj check` stopped judging how a note is filed at all.
