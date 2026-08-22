# Components

**Status: record.** Written as the input to a whole-app `extract` pass; this is what that
pass established. Where the draft was wrong, the correction is kept alongside it, because a
document that quietly fixes itself teaches nothing about how it went wrong.

## Why this exists

`DESIGN.md` names the tokens — seven hue families, a nine-step type scale, four surfaces, nine
spacing steps — and `ARCHITECTURE.md` names the mechanisms. Between them is the tier that decides
*which token, in which arrangement, for which job*, and it was never written down.

The consequence was not theoretical, and it was not what the draft guessed either. The draft
counted six ways of drawing a count; there were eleven classes and fourteen numbers, and the
interesting defect was not the sprawl but that **seven of them lacked `tabular-nums`** against a
rule `DESIGN.md` states unconditionally — including the roll-up columns that rule names by name.

It is also why a six-pass refinement of the card panel produced *more* of the problem: every pass
was scoped to one surface, so a component invented for that surface was invisible to it. The unit
of work here was therefore a cross-surface comparison, never a single surface — and the two
findings worth the whole pass came from comparing things nobody had thought to compare:

- the collapsed rail **counted a different trichotomy than the app drew**. Its three numbers came
  from the `type` pseudo-facet, whose `node` means "named by any reference facet", while every `○` on
  screen came from a count of the `parent` facet alone. On the 27-card fixture the rail reported
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

- **`✕` (`glyph="close"`)** — severs an association. A reference chip stops naming that record; a
  link leaves the card; a focus is cleared; a switcher is dismissed. No file is destroyed and
  nothing is confirmed, because nothing is lost that a second click cannot restore.
- **The trash (`glyph="trash"`)** — destroys one record. Always confirmed, always says the file is
  in git.
- **A `danger`-toned word** — destroys many. The board's bulk bar, where the object is a selection
  rather than a thing on screen and a glyph would have nothing to sit beside.

Audited twice now; nothing crosses these lines. The rule is a record of a distinction that already
holds.

The adjacent distinction it is easy to break: **a disabled button takes `cursor: default`, a
disabled field takes `not-allowed`.** The pass found one violation — `.pop-pick.is-missing`, a
genuinely `disabled` button wearing the field's cursor, the only button in the app doing so.

### The One Casing Rule

**A string is cased once, wherever it appears. A surface reaches the uppercase register by taking
the Label type step, never by transforming a string at some other step.**

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

Still open: the rail renders a facet label in **sans** where the panel renders it in mono. The
casing agrees now; the font does not, and The Mono Label Rule reads against the rail.

### The Count Rule

**A count is quiet unless it is the only thing saying a filter is on. Any number that can change
while its neighbours stay put carries `tabular-nums`.**

The second sentence is `DESIGN.md`'s and was the real defect. Seven of fourteen numbers lacked it,
and the four where it genuinely bites were all among them: the roll-up columns (a column of numbers
read vertically — the case `DESIGN.md` names explicitly), the rail's value counts (right-aligned
down a list of up to eight values × thirteen axes), the bulk bar (the word "selected" follows the
digits), and the footer (changes on every keystroke of the search box). It is now one rule naming
fifteen selectors, because the property inherits and a rule per site is a rule to forget.

**`.quietcount`** is the extracted component: mono, `--text-micro`, `tabular-nums`, `ink-3`, no
fill. Four classes shared that spec in three type steps — one of them at the *Label* step, whose
register is uppercase and which a bare numeral is exactly not for. Each site keeps only how it sits
in its row.

`.facet-badge` is the single **marked** count and the only one that may take the accent fill: it is
the only signal that a filter is narrowing what you see. Six other numbers are deliberately not
members, each for a reason now in `DESIGN.md`'s Accepted Exceptions — including two that declare
only `color` so they inherit their heading's type run, and one (`.pop-count`) that is not a count
at all, since it renders `"board"` and `"missing"` as often as a number.

### The Drawn Control Rule

**Nothing on screen is drawn by the browser.**

The draft named two offending sites and claimed selects were already fine. Both halves were wrong.
There were **three** checkboxes and **two** stray selects:

- the filter rail's value — once per value, down the whole rail
- the facets popover's row — which had no `appearance: none` at all, so the shared field rule was
  dressing an OS checkbox in an input's border, radius and `5px 8px` padding
- a markdown task list in a card body — content rather than a control, which is why the draft's
  wording missed it, and the most visually foreign of the three
- the bulk bar's select and the canvas toolbar's select — the draft asserted "every `<select>`
  already takes `appearance: none`"; the shared field rule has none, so only `.rail-select` did.
  Three selects, three type steps, one of them an OS control.

All five are drawn now. The select treatment is declared **on the element**, not on a class,
because a select with no class is precisely the case that went wrong.

Two mechanics worth keeping: `box-sizing: border-box` is global, so a `width: 0` box floors at its
padding plus border — a hidden input needs `padding: 0; border: 0` as well. And the `font:`
shorthand resets every sub-property it does not name, `font-variant-numeric` included, which is how
a hoisted tabular rule can be silently undone by a rule further down the file.

### The Record Reference Rule

**A record carries its mark wherever you meet it, and the mark's size resolves against the type it
precedes.**

The picker row now carries the real `RecordMark` rather than a bare span holding `markOf(r).glyph`
— the size had coincided, but it carried neither the per-glyph optical nudge nor the `means` string,
in the one place a reader is choosing between records.

The second clause is new, and is a measurement. `DESIGN.md` says the mark sits at "`0.8em` of
whatever type it precedes… the 13px card face". On a face it did not: the mark is a flex *sibling*
of the title, so `0.8em` resolved against the row's inherited `--text-root` 14px and the mark came
out at 11.2px beside 13px text — a ratio of 0.862. Since the nudge is
`centre(glyph) × markSize − 0.254 × textSize`, that under-corrected by 0.255px. The head now names
its own step and the ratio is 0.8 exactly. Sub-pixel and invisible — but a measurement applied
against the wrong size is not a measurement.

**Still unfinished:** `.reflink` (the panel's inbound lists) and the focus pill draw a record with
no mark at all. This is not a CSS change: `blockedBy` and `children` ship as `{ id, title }` with
no `isProject` or `childCount`, and `countChildren` lives in `src/view/` which `src/index/` may not
import from. It needs a server DTO change across an architectural boundary.

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
record mark.

So `refresh` is a drawn path, on the precedent `trash` already sets, at 15px: an ink box of 11×12
identical to `trash`, so the two drawn glyphs are the same size as each other, and 30.1 lit pixels,
which sits with `✕` and `+` so it reads at the characters' weight. The arrowhead is filled because a
stroked chevron renders about 1.1px here and does not read as an arrow at all.

Every member's metric lives beside its character in `Button.tsx`. A new glyph is a row there.

### The One Pattern Rule

**Two things that look alike are one component, unless the difference is written down.**

The test is not "are they identical" but "is the difference load-bearing". This pass put twelve
candidate families through an adversarial pass, and roughly half survived. What did not survive is
now written down in `DESIGN.md`'s **Accepted Exceptions**, with what would have to change for each
to go — which is the point: a rediscovered difference reads as drift, and a recorded one reads as a
decision.

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
the two disclosure heads stayed apart — and, in the second verification pass, why four of nine
proposed consolidations were dropped rather than built.

---

## The families, and what happened to them

| family | draft said | outcome |
|---|---|---|
| **Count** | 6 treatments, 7 declarations | 11 classes, 14 numbers. `.quietcount` extracted from 4; `tabular-nums` consolidated from 7 scattered declarations to one rule over 15 selectors; 6 exclusions recorded |
| **Casing** | 1 defect (the panel) | 1 defect, confirmed — plus the lane head corrected onto its own documented step. Three uppercase sites are legitimate |
| **Computed marker** | 2 classes, an accidental duplicate | 2 classes, a *deliberate* duplicate — and the panel's was painting a different letter. One class now, with `text-transform: none` as its load-bearing line |
| **Quiet text** | 6 impls, 3 sizes, 2 jobs mixed | 9 classes, 4 steps. One real defect: the table said "no records match" in the app's *mono* voice through the loading class. `.emptystate` extracted from 5; the annotation half is below threshold and stays split |
| **Drawn control** | 2 native checkboxes | 3 checkboxes and 2 selects. All drawn; the select treatment moved onto the element |
| **Record mark** | 3 impls, 2 hardcoded sites | The picker's second implementation removed; the ribbon's hardcoded glyphs removed along with the trichotomy bug; the face's `0.8em` corrected to resolve against its title |
| **Record reference** | 5 renderings, 4 classes | Merge rejected: five documented differences over two call sites, and it needs a DTO change. Two sites still carry no mark |
| **Disclosure** | 2 impls sharing only a caret | Merge rejected: four load-bearing differences, including that the rail's active state is the accent (a filter the user turned on) and the panel's is not (a property of the record) |
| **Clickable row** | 5 impls, incidental differences | Merge rejected: the shared hover is `DESIGN.md`'s Ghost-hover token obeyed, the radii come off the documented ladder, and no reader can ever see two of them at once |
| **Truncation** | *not in the draft* | 10 sites, one idiom, five different constraints. `.truncate` extracted |
| **Section-head control** | *not in the draft* | Two float mechanisms for one corner slot, and every control 2.5–3.5px below its label's optical centre. One flex row, one slot |
| **Group heading** | *not in the draft* | 4 treatments. Merge rejected — `DESIGN.md` commits both ends, and only the column head's value is a write target. But its `th` was leaking the UA's bold at weight 700 beside a sibling normalised to 500 |

---

## Settled during the pass

**The filter value is a drawn checkbox.** Three treatments were built and compared at real
repetition behind `?filterstyle=`. `chip` fitted nine facets where the box fits five and unified
the rail with the panel's editor, at the cost of a wall of pills and a count that ran into its
value; `edge` was quietest and gave up the affordance with the box — with nothing in the left
column the rows read as a readout. The box keeps the column the eye scans down, which is what a
filter rail is for. The two losers and the URL parameter are gone.

**`○` means "some other record names this one, through any reference facet".** It meant "something
names it as `parent`", which is why the mark and the `type` pseudo-facet disagreed: `type` has
always counted a node as named-by-any-reference-facet. Both halves moved — the mark now reads a
`refCount` built from `inboundCounts`, and the collapsed rail tallies through `markOf` instead of
reading a facet. On the fixture the glyphs, their tally and the `type` axis now all report 3 / 4 /
20, where the rail said 3 / 4 / 20 and the marks drew 3 / 1 / 23. `countChildren` is retired, and
the payload builds one map for the whole query rather than walking every record once per card.

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
cited is the stylesheet's own record of deliberate ones).

**Migrated.** Two nested Y scrollers, both live rather than latent — the record picker's list
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
`.cardface.is-blocked` by one class, so a blocked card's `bad` edge went `rule-2` under the cursor
and `accent` when picked — The Load-Bearing Left Border Rule's one element silently losing the one
thing the rule protects, on the surface where hover is continuous. `:where()` on the state half of
those selectors fixes it without naming the variants: an unstriped face still follows the ring on
all four sides, and a striped one keeps its edge. `.reflink` had been surviving the identical
collision only because its two rules tie and the stripe is declared eleven lines later.

Also from that sweep: the vault switcher swallowed both of its failures (`.catch(() => undefined)`
and a list that fell back to `[]`), so "forget this vault" failing looked exactly like succeeding
and a failed list rendered as *no vaults* — a fifth register for a refused write, and the worst
one. Three `className`s passed to `PopoverButton` had no CSS behind them at all. A comment sat on
`.facetedit-values` describing the count in `.facetedit-head`, an element that only exists when
that count does not. And `components.input-rail` referenced `{typography.body-compact}`, a key the
`typography:` map does not contain — invisible to `test/theme.test.ts`, which compares key sets
and never resolves a reference inside `components:`.

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

What is *not* closed is the thing that made all of this necessary: only the type scale, the radius
ladder and — now — the frontmatter's token references are enforced. Every other rule in this
document is prose, and prose is what drifted.

## How this relates to the other documents

- `PRODUCT.md` — who reads this and why.
- `DESIGN.md` — the tokens, the rules that govern them, and now the **Accepted Exceptions**: the
  cases where a rule appears broken and is not, with what would have to change for each to go.
- `ARCHITECTURE.md` — the mechanisms the components display.
- This document — the tier between a token and a screen.
