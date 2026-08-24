# Components

**Status: note.** Written as the input to a whole-app `extract` pass; this is what that
pass established. Where the draft was wrong, the correction is kept alongside it, because a
document that quietly fixes itself teaches nothing about how it went wrong.

## Why this exists

`DESIGN.md` names the tokens — seven hue families, a fourteen-step type scale, four surfaces, nine
spacing steps — and `ARCHITECTURE.md` names the mechanisms. Between them is the tier that decides
*which token, in which arrangement, for which job*, and it was never written down.

The consequence was not theoretical, and it was not what the draft guessed either. The draft
counted six ways of drawing a count; there were eleven classes and fourteen numbers, and the
interesting defect was not the sprawl but that **seven of them lacked `tabular-nums`** against a
rule `DESIGN.md` states unconditionally — including the roll-up columns that rule names by name.

It is also why a six-pass refinement of the note panel produced *more* of the problem: every pass
was scoped to one surface, so a component invented for that surface was invisible to it. The unit
of work here was therefore a cross-surface comparison, never a single surface — and the two
findings worth the whole pass came from comparing things nobody had thought to compare:

- the collapsed rail **counted a different trichotomy than the app drew**. Its three numbers came
  from the `type` computed axis, whose `node` means "named by any reference facet", while every `○` on
  screen came from a count of the `parent` facet alone. On the 27-note fixture the rail reported
  3 / 4 / 20 beside `▣ ○ •` while the app drew 3 / 1 / 23. Both halves have since moved — see
  **Settled during the pass**.
- the `ƒ` that marks a computed value **was two different letters**. `ƒ` is U+0192 and
  `.panel-section h3` uppercases its own headings, so the panel painted U+0191 `Ƒ` while the rail
  painted `ƒ` — under a comment in the stylesheet reading "one mark means one thing in both places".

So this tier answers one question: **when two things look similar, is that one pattern implemented
twice, or two patterns that must stay apart?** A difference that is load-bearing is welcome. A
difference nobody chose is the thing to remove — and where a difference turned out to be
load-bearing after all, it is recorded in `DESIGN.md`'s **Accepted Exceptions**, not here.

---

## Named rules

### The Removal Rule

**`✕` unlinks. The trash destroys. A `danger` word destroys many.**

- **`✕` (`glyph="close"`)** — severs an association. A reference chip stops naming that note; a
  link leaves the note; a focus is cleared; a vault stops being tracked. No file is destroyed and
  nothing is confirmed. The first three are lost only until a second click; the fourth is a
  persisted write — `vaultApi.forget` drops the folder from the tracked list, so undoing it means
  re-entering the path through the vault picker, which is why it is the one `✕` the code grew a
  failure banner for.
- **The trash (`glyph="trash"`)** — destroys one note. Always confirmed, always says the file is
  in git.
- **A `danger`-toned word** — destroys many. The bulk bar, in all three shapes, where the object is
  a selection rather than a thing on screen and a glyph would have nothing to sit beside.

Audited twice now; nothing crosses these lines. The rule is a note of a distinction that already
holds.

The bulk bar's **Merge…** is the case that looks like it crosses one and does not. It removes files,
several of them — but the word opens a chooser, exactly as *Set part of…* does, and a control that
asks a question is not the act. What destroys is the row you pick inside it, behind the same confirm
the trash uses. The ellipsis is doing real work here: it is the difference between a button that acts
and a button that asks, and both of the bulk bar's are spelled with one.

The adjacent distinction it is easy to break: **a disabled button takes `cursor: default`, a
disabled field takes `not-allowed`.** The pass found one violation — `.pop-pick.is-missing`, a
genuinely `disabled` button wearing the field's cursor, the only button in the app doing so.

### The One Casing Rule

**A string is cased once, wherever it appears. A surface reaches the uppercase register for a
vocabulary string by taking the Label type step, never by transforming that string at some other
step.**

The second sentence is the whole rule, and the draft did not see it. `facets.yaml` says
`label: Part of`; four places rendered a vocabulary string in uppercase, and only one of them was
wrong:

| site | verdict |
|---|---|
| the panel's axis label | **violation.** `text-transform: uppercase` plus `0.1em` at the *Chip* step — the Label register at the wrong size, i.e. a third register. Now renders `Part of`. |
| the table's column header | permitted. On the Label step, which `DESIGN.md` names. |
| the table's section head | permitted, same reason. |
| the board's lane head | permitted — and it was not actually *on* the step `DESIGN.md` assigns it. Corrected from `--text-chip` to `--text-label` at weight 500. |

The draft also claimed one facet value appeared "in 5 casings". It appears in six places in
**two** casings, and the two uppercase ones are both legitimate. Direction right, arithmetic wrong.

One uppercase transform sits off the Label step and is not a vocabulary string: the panel's `kv`
keys (`.kv dt`, at the *Meta* step, which `DESIGN.md`'s Typography Hierarchy commits by name). A
link row's field keys were a second, at the *Micro* step and recorded nowhere; that one is gone.

### The Count Rule

**What a number means picks its treatment, and there are five treatments. A count is quiet unless it
is the only thing saying a filter is on. Every counter is mono, because a count is the app speaking.**

A whole-app pass over every number this interface draws — the rail, the board, the table, the note
face, the panel, the bulk bar, the pickers — found the families below. They were already there; what
was missing was anyone having written down which was which, so the differences between them read as
drift and two real defects hid among them.

**Quiet** — a bare numeral beside the thing it counts. `.quietcount`: mono, `--text-micro`, `ink-3`,
no fill, and each site adds only how it sits in its row. This is most of them, and it is the one that
was already extracted.

**Marked** — the accent, and the only family allowed it: a count of something *the reader caused*.
`.facet-badge` is how many values of this axis you checked, which is the only signal that a filter is
narrowing what you see, and `.bulkbar-count` is the sentence *"N selected"*. Nothing the server merely
computed may wear the accent — that is The App Voice Rule reaching the counters.

**A heading's own type** — `.lane-count` and `.section-count`, which declare colour and position and
*nothing else*, so the number reads as part of the heading's type run rather than as a badge beside
it. Giving either a step from the scale would break it on purpose.

**Filled** — a count that has to separate itself from things on *both* sides. `.column-count` sits
between a flexing column name and a 20px add button; `.count` sits in a table title cell between a
title and the cell edge. Both now take `--radius-pill`, which is the rung whose token comment says
"a count badge, a canvas band" — `.count` was on `--radius-xl`, the container rung, so one of the two
filled counts was shaped like a popover and neither token's enumeration was true.

**A column read vertically** — the roll-ups, `.table .num` and `.num-total`: right-aligned, `nowrap`,
compared down the column rather than across the row. The one place the tabular guard's *stated*
purpose is the actual purpose.

And a sixth group that is **not** counting at all, which is what dissolves most of the apparent drift:
`.pop-annotation`, `.popbtn`'s label, `.facet-more`, the table's `Updated` column, a numeric facet
value in a table cell. The discriminator is **position, not content** — a slot defined by where it
sits, which sometimes holds digits. `.pop-annotation` is the right-hand slot on a popover row, so it
renders a note count at one site and the word `board` at another; `.facet-more` and `.popbtn` are
control labels, which is why they are sans and why that is not a Mono Label Rule violation.

Two defects came out of the pass, and both were invisible because they were about a guard rather than
a rendering. `.facet-count` was named in the hoisted rule's own preamble and was not in the rule — it
held the guard only because one JSX template string happened to render `quietcount facet-count`
together. And `.popbtn`, the single counter in the app that is *not* mono and therefore the only one
whose digits can actually shift the words after them, was the one the rule had never reached.
`test/theme.test.ts` now pins the membership set and checks the `font:`-shorthand reset that had
already removed the guard twice. No tallies here: how many counters there are changes by working, and
the set that changes by deciding is in the test.

### The Drawn Control Rule

**Nothing on screen is drawn by the browser.**

Now actually true. The audit below found three checkboxes and two stray selects and missed a sixth
case entirely: the project's instruction blocks in the note panel were a native
`<details>`/`<summary>`, the only browser-drawn disclosure left in an app that draws its own caret in
two other places. It is a `.facet-more` button now — the control the panel and the rail already use
for "there is more of this list", which is the same sentence.

The draft named two offending sites and claimed selects were already fine. Both halves were wrong.
There were **three** checkboxes and **two** stray selects:

- the filter rail's value — once per value, down the whole rail
- the facets popover's row — which had no `appearance: none` at all, so the shared field rule was
  dressing an OS checkbox in an input's border, radius and `5px 8px` padding
- a markdown task list in a card body — content rather than a control, which is why the draft's
  wording missed it, and the most visually foreign of the three
- the bulk bar's select and the canvas toolbar's select — the draft asserted "every `<select>`
  already takes `appearance: none`"; the shared field rule has none, so only `.rail-select` did.
  Three selects, three type steps, two of them OS controls.

All five are drawn now — and a later pass found two the rule had never reached, because the shared
field rule declared no `appearance` at all: `input[type=search]` in the rail and `input[type=date]`
in the panel both measured `appearance: auto`. `appearance` now sits on that shared rule rather than
on nine classes, the select treatment stays declared **on the element**, and the search field's UA
cancel button — the app's own Escape handler drawn twice — is hidden. The date field's picker
indicator stays, because it is the only way to open the calendar; `color-scheme` is what themes it,
and nothing had declared that either.

Two mechanics worth keeping: `box-sizing: border-box` is global, so a `width: 0` box floors at its
padding plus border — a hidden input needs `padding: 0; border: 0` as well. And the `font:`
shorthand resets every sub-property it does not name, `font-variant-numeric` included, which is how
a hoisted tabular rule can be silently undone by a rule further down the file.

### The Note Reference Rule

**A note carries its mark wherever you meet it, the mark's size resolves against the type it
precedes, and a reference to it is drawn as a note rather than as a value.**

The picker row now carries the real `RecordMark` rather than a bare span holding `markOf(r).glyph`
— the size had coincided, but it carried neither the per-glyph optical nudge nor the `means` string,
in the one place a reader is choosing between notes.

The second clause is new, and is a measurement. `DESIGN.md` says the mark sits at "`0.8em` of
whatever type it precedes… the 13px card face". On a face it did not: the mark is a flex *sibling*
of the title, so `0.8em` resolved against the row's inherited `--text-root` 14px and the mark came
out at 11.2px beside 13px text — a ratio of 0.862. Since the nudge is
`centre(glyph) × markSize − 0.254 × textSize`, that under-corrected by 0.255px. The head now names
its own step and the ratio is 0.8 exactly. Sub-pixel and invisible — but a measurement applied
against the wrong size is not a measurement.

The third clause is the same rule reaching colour. A reference facet's value was a *value* on two
surfaces and a *note* on a third: a card face and a table cell drew `parent` as a purple chip and
`project` as a blue-declared-but-purple-drawn one, while the panel drew both as `.refchip` — a neutral
box holding a mark and a title, with a comment claiming a face already did the same. `src/web/hue.ts`
is now the one place that decides, and it answers for the chip *and* for the canvas edge, which were
two implementations with two different ideas of what an undeclared axis meant. Four registers: the
app's own axis (`project`, the accent), a reference (neutral), a declared family, and hueless. What a
reference axis's `hue:` still colours is its edge — the line, where the relation is the subject rather
than the note at the end of it.

`theme.test.ts` holds both seams shut now: every register the client can ask for has a rule behind it,
and every link kind names a family the palette defines. Neither was checked before, and both are the
kind of miss that renders as *almost* right — an unstyled chip is a transparent box with body text in
it, and a mistyped hue is a prefix that quietly inherits its container's colour.

**Finished since:** `.reflink` (the panel's inbound lists) and the focus pill drew a note with no
mark at all, and the reason looked structural — `blockedBy` and `children` shipped as
`{ id, title }`, and the child count sat on the wrong side of an import boundary. Moving the inbound
count into `src/index/refs.ts` for the `○` change dissolved it: `blockedBy` and `children` now ship
`isProject` and `refCount`, and there are six `RecordMark` call sites for the six places a note
appears. See **Still open**.

### The Word-or-Glyph Rule

**A control is a glyph when a mark exists that reads unambiguously at its measured optical size and
collides with nothing else in the set. Otherwise it is a word — and "otherwise" is a measurement,
not an inventory.**

The draft called this the weakest of these rules, because it amounted to "whatever is in the set",
and gave `refresh` as a word for want of a glyph. That was an honest state and the wrong
conclusion: `refresh` beside a trash can and a `✕` is the same mistake as spelling those two.

The set grew by one, measured. Four candidate characters sit on advances of 0.68 / 0.68 / 0.56 /
0.60 em against the family's 0.6021, so each is served by a substituted face and would draw
differently on another machine. Two more (`↺`, `↷`) are exact mirrors of `↶`, which is the one glyph
refresh must not be confused with. `↻` is on the family's own advance and at 14px matches `✕` for
ink — 28.8 against 29.7 lit pixels in an identical 8×8 box — but on the pixel grid its arrowhead
survives as about two pixels, so it reads as a broken ring and collides with `○`, the container
note mark.

So `refresh` is a drawn path, on the precedent `trash` already sets, at 15px: an ink box of 11×12
identical to `trash`, so the two drawn glyphs are the same size as each other, and 30.1 lit pixels,
which sits with `✕` and `+` so it reads at the characters' weight. The arrowhead is filled because a
stroked chevron renders about 1.1px here and does not read as an arrow at all.

The set grew by one again, the same way, and it is worth recording that the rule *held* the second
time. `edit` replaces two controls with one — the Body's `read` / `edit` tab pair and the
frontmatter's `edit raw` / `hide` word, which were two grammars for the identical act of revealing an
editor over a readout. No character was available on the terms the last four were rejected on: `✎`
`✏` `🖉` `🖊` sit on advances of 0.72 / 0.80 / 0.60 / 0.60 em against the family's 0.6021, and the two
that match are Miscellaneous-Symbols codepoints with no coverage in any face this stack resolves to —
tofu without a fallback emoji font and *colour* emoji with one, which is the objection that ruled out
`🗑`. So: a drawn parallelogram on the 45° axis the other two avoid, with a collar stroke, at 15px.
Rasterised beside its neighbours on one instrument: 10.5×10.5 at 34.7 lit px, against `refresh` at
10.5×11.8 and 33.4, and `trash` at 11.5×11.5 and 57.6. It reads at `refresh`'s weight and nowhere near
`trash`'s, which is twice as heavy because it destroys. Three shaft lengths were drawn; the longer two
square the bounding box up at 36.4 and 37.0 lit px, buying a tidier box by moving the coverage away
from the glyph it has to match. The box is not what a reader sees.

So `refresh` was the last control in the app spelled out for about as long as it took to find the next
one. That sentence is the rule working, not failing: "otherwise is a measurement, not an inventory"
means the set is open to anything that measures, and closed to anything that does not.

Every member's metric lives beside its character in `Button.tsx`. A new glyph is a row there.

### The One Pattern Rule

**Two things that look alike are one component, unless the difference is written down.**

The test is not "are they identical" but "is the difference load-bearing". This pass put twelve
candidate families through an adversarial pass, and roughly half survived. Four merges were
rejected. Two of the four — the reference chip against the reference row, and the four group
headings — are written down in `DESIGN.md`'s **Accepted Exceptions**, with what would have to change
for each to go; the other two (the two disclosure heads, the five clickable rows) are so far
recorded only in the families table below — which is the point: a rediscovered difference reads as
drift, and a recorded one reads as a decision.

### The Shared Register Rule

**When several sites do one job at different sizes, the register is shared and the fit is local.**

The shape every extraction in this pass took, and worth naming because the alternative is tempting
and wrong. `.truncate` carries `min-width: 0; overflow: hidden; text-overflow: ellipsis;
white-space: nowrap` — the idiom, repeated at ten sites — while each site keeps its own answer to
*where it cuts*: `flex: 1` to take the rest of a row, `130px` on a link chip, `26ch` on a reference
chip, `40%` on a picker's project column, and nothing at all on a grid cell already 180px wide.
Those five differ because their containers differ. `.quietcount` and `.emptystate` are the same
shape: one register, per-site positioning.

`.field-recessed` and `.checkbox` are the same shape again: a recessed field's register — fill,
border, radius, type and its accent-border focus exception — with `flex: 1`, `width: 120px` and
`width: 100%` as the three fits; and a drawn 11px box shared by the filter rail and the facets
popover, whose state comes off the input by sibling selector so neither surface has to coordinate
with the other.

The corollary is that a merge which needs a variant per site has not found a component. It is why
the two disclosure heads stayed apart — and, in the second verification pass, why three of the six
proposed consolidations were dropped rather than built.

---

## The families, and what happened to them

| family | draft said | outcome |
|---|---|---|
| **Count** | 6 treatments, 7 declarations | 11 classes, 14 numbers. `.quietcount` extracted from 4; `tabular-nums` consolidated from 7 scattered declarations to one rule over 13 selectors; 6 exclusions recorded |
| **Casing** | 1 defect (the panel) | 1 defect, confirmed — plus the lane head corrected onto its own documented step. Three uppercase sites are legitimate |
| **Computed marker** | 2 classes, an accidental duplicate | 2 classes, a *deliberate* duplicate — and the panel's was painting a different letter. One class now, with `text-transform: none` as its load-bearing line |
| **Quiet text** | 6 impls, 3 sizes, 2 jobs mixed | 9 classes, 4 steps. One real defect: the table said "no notes match" in the app's *mono* voice through the loading class. `.emptystate` extracted from 5; the annotation half is below threshold and stays split |
| **Drawn control** | 2 native checkboxes | 3 checkboxes and 2 selects. All drawn; the select treatment moved onto the element |
| **Note mark** | 3 impls, 2 hardcoded sites | The picker's second implementation removed; the ribbon's hardcoded glyphs removed along with the trichotomy bug; the face's `0.8em` corrected to resolve against its title |
| **Note reference** | 5 renderings, 4 classes | Merge rejected: five documented differences over two call sites. The DTO change it needed has since landed, and all six sites carry a mark |
| **Disclosure** | 2 impls sharing only a caret | Merge rejected: four load-bearing differences, including that the rail's active state is the accent (a filter the user turned on) and the panel's is not (a property of the note). **Moot since:** the panel's disclosure is gone rather than merged. Once an axis carrying nothing is not drawn at all, a collapsed row has nothing to collapse — so there is one implementation, in the rail, and the panel takes the absence rule instead of the widget |
| **Clickable row** | 5 impls, incidental differences | Merge rejected: the shared hover is `DESIGN.md`'s Ghost-hover token obeyed, the radii come off the documented ladder, and no reader can ever see two of them at once |
| **Truncation** | *not in the draft* | 10 sites, one idiom, five different constraints. `.truncate` extracted |
| **Section-head control** | *not in the draft* | Two float mechanisms for one corner slot, and every control 2.5–3.5px below its label's optical centre. One flex row, one slot |
| **Group heading** | *not in the draft* | 4 treatments. Merge rejected — `DESIGN.md` commits both ends, and only the column head's value is a write target. But its `th` was leaking the UA's bold at weight 700 beside a sibling normalised to 500 |

---

## Settled during the pass

**The filter value is a drawn checkbox.** Three treatments were built and compared at real
repetition behind `?filterstyle=` (retired — see below). `chip` fitted nine facets where the box
fits five and unified the rail with the panel's editor, at the cost of a wall of pills and a count
that ran into its value; `edge` was quietest and gave up the affordance with the box — with nothing
in the left column the rows read as a readout. The box keeps the column the eye scans down, which
is what a filter rail is for. The two losers and the URL parameter are gone.

**A retired parameter used to outlive its code.** `?filterstyle=` was deleted from the app and kept
appearing in the address bar, because `patchSearch` preserves keys it does not recognise — correctly,
since it writes what it is told — and nothing else ever looked. If the URL is the view, a key nothing
reads is not part of it: `strippedOfStrays` in `src/web/query.ts` names what the app owns (the query,
`f.<facet>`, and `note`) and the App replaces the location once on load when the URL carries anything
else. It returns `null` for "nothing to rewrite" rather than an unchanged string, because
`URLSearchParams` re-encodes as it serialises and a round-trip is not a fixed point — comparing the
output would have made the normalisation loop.

**`○` means "some other note names this one, through any reference facet".** It meant "something
names it as `parent`", which is why the mark and the `type` computed axis disagreed: `type` has
always counted a node as named-by-any-reference-facet. Both halves moved — the mark now reads a
`refCount` built from `inboundCounts`, and the collapsed rail tallies through `markOf` instead of
reading a facet. On the fixture the glyphs, their tally and the `type` axis now all report 3 / 4 /
20, where the rail said 3 / 4 / 20 and the marks drew 3 / 1 / 23. `countChildren` is retired, and
the payload builds one map for the whole query rather than walking every note once per note.

## Settled in the second pass

Nine held items went through the same refute-then-migrate treatment. Four were dropped, and the
reasons are worth more than the merges would have been.

**Dropped.** The `.stripe` extraction (three independent killers: specificity, a rule count that
goes *up*, and it would have taken the design detector from 8 findings to 2 — disarming the only
automated check on the rule it invoked). The `.explains` tooltip class (`cursor: help` on a
descendant beats an ancestor's `pointer`, so it would have broken three live click affordances —
and the 45 `title` attributes are not one population; a quarter sit on controls whose cursor is
already spoken for, and two are conditionally empty). The chip-row merge (its headline drift
vanished when the `chip` filter variant was deleted; the three survivors sit at one gap, and the
one carrying a written reason needs `align-items: center` for genuinely mixed-height children).
The panel's focus-ring exception (DESIGN.md sanctions one suppressor, and the "three" the item
cited is the stylesheet's own note of deliberate ones).

**Migrated.** Two nested Y scrollers, both live rather than latent — the note picker's list
inside a popover that already bounds and scrolls itself, measured at 340px through 286 with 737px
through 290 inside it; and the vault gate's browse listing, which engaged from about the
twenty-second subfolder. Neither took a row cap: the picker's `CAP = 40` is safe only beside a
query field and an `{n} of {N}` readout, and the gate's path field drives `inspect`, not the
listing. `BodyEditor`'s refusal became the `.banner.is-bad` its sibling on the same panel and the
same write contract already used — one component had been reporting one event two ways, in mono in
a button bar versus a banner in a column. `.rail-search input` folded into `.field-recessed`,
which it had been restating declaration for declaration *including the focus exception, with the
same rationale written in both comments* — the clearest evidence available that two rules are one
component. The base padding moved to `5px 8px`, which is what DESIGN.md's `components.input-rail`
had always committed and the code had implemented nowhere.

**The best find was not on the list.** A hovered or selected card face *lost its state stripe*:
`border-color` sets all four sides, and the hover and selection rules out-specified
`.cardface.is-blocked` by one class, so a blocked note's `bad` edge went `rule-2` under the cursor
and `accent` when picked — The Load-Bearing Left Border Rule's one element silently losing the one
thing the rule protects, on the surface where hover is continuous. `:where()` on the state half of
those selectors fixes it without naming the variants: an unstriped face still follows the ring on
all four sides, and a striped one keeps its edge. `.reflink` had been surviving the identical
collision only because its two rules tie and the stripe is declared later in the file.

Also from that sweep: the vault switcher swallowed both of its failures (`.catch(() => undefined)`
and a list that fell back to `[]`), so "forget this vault" failing looked exactly like succeeding
and a failed list rendered as *no vaults* — a fifth register for a refused write, and the worst
one. Three `className`s passed to `PopoverButton` had no CSS behind them at all. A comment sat on
`.facetedit-values` describing the count in `.facetedit-head`, an element that only exists when
that count does not. And `components.input-rail` referenced `{typography.body-compact}`, a key the
`typography:` map does not contain — invisible to `test/theme.test.ts`, which compared key sets
and resolved no reference inside `components:` — which is why it now has an eighth test that does.

## Still open

Nothing from the first two passes. The four items that were open are settled:

- **The rail's facet label stays sans, and so does the panel's.** Not an exception — the reading
  was simply wrong. The Mono Label Rule's own first clause is "if a human typed it, it is sans", and
  a facet label is a string in the vault's `facets.yaml`. The rail had it right; the panel was
  changed to match, which closes The One Casing Rule on both axes at once — one string, one casing,
  one font.
- **`.reflink` and the focus pill carry their marks.** The blocker was a DTO shape crossing an
  import boundary, and it dissolved on its own: moving the inbound count into `src/index/refs.ts`
  for the `○` change put it where `blocking.ts` could already reach. `blockedBy` and `children` now
  ship what a mark reads, and the literal `' ✓'` went with it — `.reflink.is-done` already drew that
  state as an `ok` edge.
- **The canvas stays silent when empty**, recorded in Accepted Exceptions. The minimap empties with
  it, so the surface already says so twice.
- **`.pop-count` is `.pop-annotation`**, which is what it always was.

What is *not* closed, though it is closing: `test/theme.test.ts` now enforces nine of these rules
rather than three — the type scale, the radius ladder, the frontmatter's token references, the One
Casing Rule's uppercase-via-the-Label-step, the Drawn Control Rule's `appearance`, stillness, the
absence of breakpoints, every hue a vocabulary names being a family the stylesheet defines, and that
every `className` resolves to a rule. A
tenth was added with the panel rework, and it is the one worth naming here: **every `<button>` must
carry a class that names a font family.** The Mono Label Rule is the most-cited rule in `DESIGN.md`
and was the least enforced, and it failed in the direction prose cannot catch — a commit *correcting*
the rail/panel divergence dropped the panel's explicit family onto a `<button>`, which has a family of
its own, and thirteen labels rendered in Arial with every test green. The rules still unenforced are
colour, contrast, and the register rules above. Prose is still what drifts.

## How this relates to the other documents

- `PRODUCT.md` — who reads this and why.
- `DESIGN.md` — the tokens, the rules that govern them, and now the **Accepted Exceptions**: the
  cases where a rule appears broken and is not, with what would have to change for each to go.
- `ARCHITECTURE.md` — the mechanisms the components display.
- This document — the tier between a token and a screen.
