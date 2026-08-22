# Whole-app extract — findings inventory (pre-verification)

Produced by reading every file in `src/web/` plus all 2570 lines of `style.css`.
Each finding names the surfaces it compares. A finding that looks at one surface only
is invalid by construction of this pass.

Decisions ALREADY MADE by the user (not open, do not re-litigate):
- D1 All four `text-transform: uppercase` on vocabulary-owned strings are removed.
- D2 The Count Rule is applied as written: one quiet count class; `.facet-badge` is the
     only "marked" count and moves from `surface` to `ground` text.
- D3 The group heading becomes one treatment at two levels (outer 13/600, inner 12.5/600).
- D4 The filter-value control gets three implementations behind `?filterstyle=box|chip|edge`.
- D5 The glyph set GROWS by one: `refresh` becomes a glyph. The user overruled the initial
     recommendation, with the argument that settles it: a word there is the same mistake as
     "delete" instead of the trash and "unlink" instead of the chip's `✕`. The new member
     needs a measured optical size in `Button.tsx`'s GLYPH table (The Measured Glyph Rule),
     and the Word-or-Glyph Rule gets a real criterion instead of "whatever is in the set".
- D6 `.reflink` + `.refchip` become one component with two modes.
- D7 `.picker-item` uses the real `RecordMark`.

---

## F1 — Count: 12 treatments, 7 sizes, 3 filled, 6 missing tabular-nums

| class | surface | step | px | fill | tabular |
|---|---|---|---|---|---|
| `.facet-badge` | rail facet head | micro | 9 | **accent** (text `surface`, not `ground`) | NO |
| `.facet-count` | rail facet value | label | 9.5 | — | NO |
| `.column-count` | board column head | xs | 11 | **surface-3**, radius-pill | yes |
| `.lane-count` | board lane head | chip (inherited, uppercase) | 10 | — | NO |
| `.count` | table title cell (childCount) | chip | 10 | **surface-3**, radius-xl | NO |
| `.section-count` (table scope) | table section head | label (inherited, uppercase) | 9.5 | — | NO |
| `.section-count` (panel scope) | panel section head | micro | 9 | — | yes |
| `.facetedit-count` | panel axis head | micro | 9 | — | yes |
| `.picker-capped` | record picker foot | micro | 9 | — | yes |
| `.pop-count` | popover row | label | 9.5 | — | NO |
| `.bulkbar-count` | bulk bar | sm | 11.5 | accent text, weight 600 | NO |
| `.sidebar-ribbon-info` | collapsed rail | micro | 9 | — | yes |

Sub-findings:
- F1a `.section-count` is declared twice (style.css:1838 panel, :2434 table) for different margins.
- F1b `.pop-count` renders a **word**, not a count: `SavedViews.tsx` puts `v.shape` in it
      ("board"/"canvas"/"table"). Same class, two jobs, one of them not a number.
- F1c DESIGN.md `components:` frontmatter declares `column-count` with `backgroundColor:
      surface-3` and `rounded: pill`. Applying D2 means that entry leaves the frontmatter.
      `test/theme.test.ts` checks only `typography:` and `rounded:` keys, so removing a
      `components:` entry cannot break it. VERIFY THIS.
- F1d `.facet-badge` uses `color: var(--surface)` on an `--accent` fill. Every other filled
      state in the app takes `--ground`: `.btn.primary`, `.chip.is-overdue`, `.chip.is-today`,
      `.togglechip.is-on`, `.tab.is-on`. DESIGN.md's Don't list says "Every filled state
      takes `ground`". Contrast holds either way; this is consistency, not a defect.
- F1e The card face draws NO child count, but DESIGN.md's Record Mark section says the mark is
      "followed by a count when others name it as parent". Only `TableView` renders one
      (`.count`). Either DESIGN.md overstates, or the face is missing it. Decide which.

## F2 — Casing: 4 uppercase declarations on vocabulary strings; one value in 5 casings

A `facets.yaml` **label** ("Part of", "Waiting on"):
- `.facet-label` (rail) — verbatim, sans `--text-body-sm` 12px. CORRECT.
- `.facetedit-label` (panel) — `text-transform: uppercase`, mono `--text-chip` **10px**,
  `0.1em`. Note: not even the Label step (9.5px) — a third register, hand-rolled.
- `.table thead th` — `text-transform: uppercase`, mono `--text-label`. Renders BOTH literal
  words ("Title", "Cards", "Blocked", "Untriaged", "Member of", "Updated") AND
  `data.counts.find(...)?.label` — a mixed row. Removing the transform leaves Title Case
  throughout because the literals are already Title Case in source.

A `facets.yaml` **value** ("planning", "now", "master-data"):
- verbatim: `.chip` (face), `.column-name` (board), `.cluster-label` (canvas),
  `.facet-name` (rail filter row)
- UPPERCASE: `.lane-head` (board lane), `.table tr.section th` (table section)

Measured in the browser at 1280px, panel open on `every-facet`:
`.facetedit-label` → uppercase, 10px, mono, `rgb(187,187,187)`, text "Part of"
`.facet-label`     → none,      12px, sans, `rgb(187,187,187)`, text "Part of"
Same string, ~150px apart, in one viewport.

Sub-findings:
- F2a `.tab` declares `text-transform: none; letter-spacing: 0`. Measured: a `.btn` inside the
      same `h3` computes `text-transform: none` **without** declaring it — the UA form-control
      reset already handles buttons. So both declarations on `.tab` are dead. Low value.
- F2b `.linkkind` uppercases `kind` (a wire value: `jira`, `gh:pr`, `claude`). The same kind is
      drawn on a chip as an abbreviated glyph (`J`, `PR`, `br`, `AI`) via `LINK_GLYPH`. Two
      renderings of one datum — arguably load-bearing (a row has 62px, a chip has ~14px).
      Is `kind` vocabulary the app owns, or vocabulary the data owns?

## F3 — Group heading: 4 treatments, and the outermost is second-smallest

All four render `labelFor(value)` — the current value of the grouping axis, as a heading.

| class | level | font | size | case | colour |
|---|---|---|---|---|---|
| `.lane-head` | **outer** (groupBy[1]) | mono | 10 | UPPER 0.1em | ink-2 |
| `.column-name` | inner (groupBy[0]) | mono 600 | 12.5 | verbatim | ink |
| `.cluster-label` | inner (canvas band) | mono | 11 | verbatim | ink-3 |
| `.table tr.section th` | inner (groupBy[0]) | mono | 9.5 | UPPER 0.1em | ink-2, surface-2 bg |

The lane contains the columns, and is drawn quieter and smaller than what it contains.
Not named in COMPONENTS.md at all.

## F4 — Record mark: 3 implementations + 2 hardcoded glyph sites

- `RecordMark` (`CardBody.tsx`) — `0.8em`, `is-{role}` class carrying the measured
  `translateY` (`0.054em` / `-0.058em`), `title` explaining the glyph. Used by `.cardface`,
  the table row, `.refchip`. CORRECT.
- `ProjectMark` — the panel header's control variant, `--text-lg`, its own re-measured
  constants (`0.101em` / `-0.011em`). Documented, deliberate.
- `.picker-mark` (`RecordPicker.tsx`) — `markOf(r).glyph` in a bare span at fixed
  `--text-chip` 10px, `ink-3`, **no `is-{role}` class** so no optical nudge, **no title**.
  A second implementation of the mark.
- `.reflink` (panel Blocked by / Children) — **NO MARK**. Renders `{r.title}{r.done ? ' ✓' : ''}`,
  a literal string appended for done state. The one place a record appears unmarked.
- `.sidebar-ribbon-icon` (collapsed rail) — `▣ ○ •` hardcoded in `Sidebar.tsx` at
  `--text-body-sm`, coloured `--accent`. Not from `markOf`. Note: accent on a record property
  is against The App Voice Rule — though these are counts the app computed, so arguable.
- `.vaultbtn-mark` — `▣` hardcoded, `--accent`. A vault is not a record; probably fine.

## F5 — Record reference: 5 renderings, 4 classes

| impl | surface | mark | unlinkable | shape |
|---|---|---|---|---|
| `.cardface` | board, canvas, table | yes | no | full face |
| table row | table | yes + `.count` | no | row |
| `.reflink` | panel Blocked by / Children | **NO** | no (inbound) | bordered block, surface-2 |
| `.refchip` | panel every ref facet | yes | yes (`✕`) | inline, surface-2 |
| `.picker-item` | record picker | second impl | no | menu row |

`.reflink` and `.refchip` both: `1px rule` border, `surface-2` fill, `radius-base`/`radius-sm`,
`ink-2` → `ink` on hover, `rule-2` border on hover. They differ by direction and removability.

## F6 — Disclosure: 2 impls sharing only `.facet-caret`

`.facet-head` (rail): `padding 4px 2px`, `gap 5px`, `color ink-2`, label sans 12px;
  `.facet.is-active` → `accent` + weight 600.
`.facetedit-head` (panel): `padding 2px 0`, `gap 5px`, `color inherit`, label mono 10px UPPER;
  `.facetedit.is-carried` → label `ink-2`.
Both implement the same behaviour rule ("an axis you are using starts open") in two separate
`useState(values.length > 0)` / `useState(selected.length > 0)` calls.
After D1 removes the uppercase, the remaining differences are padding and the active-state
colour. Candidate for one component.

## F7 — Quiet text: 6 impls, 3 sizes, 2 jobs mixed

Empty state:
- `.picker-empty` — `--text-body-sm`, ink-3, **italic**, `padding 6px 7px` ("nothing matches",
  "no subfolders")
- `.filters-empty` — `--text-sm`, ink-3, **not italic**, `padding 6px 2px`
  ("nothing to filter on")
- `.board-empty` — `--text-body-sm`, ink-3, not italic, `padding 8px 4px` ("nothing here")
- table empty state uses **`.pane-loading`** — mono `--text-body`, `padding 28px`
  (`TableView.tsx:91`, "no records match"). The *loading* class, doing an empty state's job,
  in a different font and 3.5× the padding of the board's.

Annotation:
- `.hint` — `--text-body-sm`, ink-3, italic, `margin 6px 0 0`
- `.board-nudge` — `--text-body-sm`, ink-3, `border-top`, `padding 8px 12px`
- `.linkrow-note` — `--text-sm`; both modifiers set `font-style: normal` but nothing sets
  italic, so those two declarations are dead.
- `.editor-hint` / `.editor-note` / `.editor-dirty` — mono `--text-meta`

Four surfaces say "nothing here" four ways, and one of them is the loading class.

## F8 — Computed marker: 2 impls, near-identical

`.facet-pseudo` (rail): mono `--text-title`, `line-height 1`, `ink-3`, italic. Has a `title`
  but **no `cursor: help`**.
`.derived` (panel): the same four declarations plus `margin-left: 5px` and `cursor: help`.
Same `ƒ`, same meaning. `.derived` was created during the panel work without noticing
`.facet-pseudo`. One class with an optional margin.

## F9 — Clickable menu row: 3 near-identical impls

| class | padding | radius | rest | hover |
|---|---|---|---|---|
| `.picker-item` | `4px 7px` | `--radius-md` | ink-2 | surface-2 + ink |
| `.browse-item` | `3px 6px` | `--radius-md` | ink-2 | surface-2 + ink |
| `.pop-pick` | `5px 7px` | `--radius-base` | ink-2 | surface-2 + ink |

Identical colour behaviour, three paddings, two radii. Exactly meets the 3-use threshold.
`.vaultrow` (bordered grid card, `--radius-lg`) and `.facet-more` (accent text, no hover fill)
are genuinely different and stay out.
`.facet-more` is already shared between `FilterPanel` and the panel's `Inbound` — already
consolidated, leave it.

## F10 — The native checkbox: 2 sites

`.facet-value input` (rail, once per filter value — 8 shown × up to 13 axes) and
`.pop-check input` (the Facets popover). The last browser-drawn controls in the app.
COMPONENTS.md names only the first.

## F11 — Misc, low value, listed for completeness

- `.count` uses `--radius-xl` (8px, the *container* step) on an inline count. Every other
  count badge uses `--radius-pill` or `--radius-badge`. Against the radius ladder.
- `.badge` uses `--radius-xs` (2px), documented in DESIGN.md as "the progress track alone".
- `.rail-select:disabled` uses `cursor: not-allowed`; `.btn:disabled` uses `cursor: default`.
  COMPONENTS.md records this as deliberate. Confirmed present, leave it.
- `.pop-note` uses `--text-label` with `letter-spacing: 0.04em`; the Label step is documented
  as `0.10–0.14em`. Off-ladder tracking on a Label-step string.
- `.linkchip em` and `.linkrow-fields em` both use `font-style: normal` to undo `<em>` —
  correct, but two places.

## F12 — The refresh glyph (new, from D5)

`refresh` is the only control in the app that is a word for want of a glyph
(`blocks.tsx`, the Links section head — a `Button tone="ghost" size="tiny"` reading "refresh").

The existing set and its measured nominal sizes, from `Button.tsx`:

| name | mark | px | nudge |
|---|---|---|---|
| `close` | `✕` | 15 | — |
| `add` | `+` | 17 | — |
| `check` | `✓` | 14 | — |
| `revert` | `↶` | 16 | `-0.02em` |
| `trash` | SVG path | 15 | — |

Constraints on the new member:
- It must not be confusable with `revert` (`↶`). Both are arcs and both mean "undo-ish".
  They sit on different surfaces (revert in the rail's saved-view dirty state, refresh in the
  panel's Links head) but the marks must still read apart.
- `trash` is an SVG path precisely because no monochrome character existed — `🗑` is
  emoji-presentation and would be the only colour ink in the app. If the candidate characters
  measure badly or vary across the mono stack, the path precedent applies again.
- Whatever is chosen needs its ink bounding box measured at its nominal size and compared
  against `✕ + ✓ ↶`, so the family reads as one weight. That measurement goes in the table.

Candidates to measure: `↻` U+21BB, `⟳` U+27F3, `⟲` U+27F2, `⭮` U+2B6E, or an SVG path.

### F12 RESOLVED — measured, in the browser, on the pixel grid

Rejected characters and why:
- `⟳` U+27F3, `⟲` U+27F2 — advance 0.6797em; `⥁` U+2905 — 0.5596em; `⭮` U+2B6E — inkH 0.89em.
  The mono family's advance is 0.6021em, so all four are being served by a substituted face
  and would render differently on another machine.
- `↺` U+21BA and `↷` U+21B7 — exact mirrors of `↶` (`revert`), which is the one glyph refresh
  must not be confused with. `↷` measures identically to `↶` (inkW 0.53, inkH 0.325,
  centre 0.33).
- `↻` U+21BB — the only character on the family's own advance, and at 14px it matches `✕`
  for ink coverage (28.8 vs 29.7 lit px) at an identical 8×8 ink box. Rejected anyway: on
  the pixel grid its arrowhead survives as ~2px, so the mark reads as a *broken ring* and
  collides with `○`, the container record mark, which measures 9×10 at 15px.

Chosen: an SVG path, on the precedent `trash` already sets in the GLYPH table.

    refresh: {
      px: 15,
      path: 'M13 8A5 5 0 1 1 8 3',        // 270° arc, r5, gap in the NE quadrant
      fill: 'M7.6 1.1L11.5 3 7.6 4.9Z',  // filled triangle, east-pointing, at the terminus
    }

Measured at 15px against the shipped set:

| glyph | px | lit px | ink box |
|---|---|---|---|
| `✓` check | 14 | 15.5 | 7×7 |
| `↶` revert | 16 | 23.4 | 9×6 |
| `✕` close | 15 | 29.7 | 8×8 |
| **`refresh`** | **15** | **30.1** | **11×12** |
| `+` add | 17 | 31.6 | 10×10 |
| `trash` | 15 | 52.8 | 11×12 |

Two facts make 15px the answer: the ink box is *identical* to `trash`, so the app's two drawn
glyphs are the same size as each other; and the coverage sits with `✕` and `+`, so it reads at
the characters' weight. `trash` is deliberately heavier because it destroys.

No `translateY`: like `trash`, the path is centred by `.icon-button`'s grid rather than sitting
in a text run, so the Measured Glyph Rule's baseline formula does not apply. A *stroked*
chevron arrowhead was tried first and rejected — 1.2 units renders ~1.1px at this size, too
thin to read as an arrow, which is why the arrowhead is filled.

CONSEQUENCE for the Word-or-Glyph Rule: it can now state a real criterion. A control is a
glyph when a mark exists that reads unambiguously at its measured optical size and does not
collide with another member or with a record mark. `refresh` was a word because nobody had
looked for one, not because none was possible — and the two rejections above (a substituted
advance, a collision with `○`) are exactly the tests the rule should name.

## F13 — A control in the corner of a section head: 2 float mechanisms, 3 misalignments

`.panel-section h3` lays out as inline flow plus two separate right-floated wrappers:
- `.section-do { float: right }` — holds the Frontmatter head's `edit raw`/`hide` and (now)
  the Links head's `refresh`
- `.tabs { float: right; display: inline-flex; gap: 2px }` — holds the Body head's read/edit

One job — "the control in this section's corner" — two mechanisms. And because a float
top-aligns to the line box, the control is never vertically centred on the label it sits
beside. Measured in the browser, offsets from the `h3`'s top edge:

| element | box h | centre |
|---|---|---|
| the label's own text ink | 11 | **6.5** |
| `.tab` (Body) | 18 | 9.0 |
| `.btn` (Frontmatter) | 19.4 | 9.7 |
| `IconButton` (Links, new) | 20 | 10.0 |

So all three controls sit 2.5–3.5px low. This is pre-existing — the new refresh glyph moves
it by 0.3px — but it is the reason the panel's heads look subtly unlevel.

Consolidation: make `h3` a flex row with `align-items: center`, and let the corner group take
`margin-left: auto`. That centres all three against the label, removes both floats, and means
`.section-count` and `.derived` no longer depend on inline flow to sit where they do.
`.tab` keeps its own pill styling — it is a mode switch and COMPONENTS.md records that as a
deliberate difference from a chip; only the *positioning* mechanism is shared.

Note for the verification pass: `.tab` also declares `text-transform: none; letter-spacing: 0`
to escape the `h3`'s uppercase. Measured: a `.btn` inside the same `h3` computes
`text-transform: none` WITHOUT declaring it, because the UA form-control reset already stops
the inheritance. So both declarations on `.tab` are dead — but check this holds after D1 and
after any change to `h3`.

---

## F14 — NOT A DESIGN FINDING: the table renders zero rows with a second grouping axis

Found while trying to make F3's "table section head" render, so it is worth recording here
even though it is out of this pass's scope.

`src/web/views/groups.ts:29-30`

    const mine =
      'lane' in opts ? data.groups.filter((g) => g.lane === opts.lane)
                     : data.groups.filter((g) => !g.lane);

- The board calls `groupsFor(data, { lane, empties: 'keep' })` — `'lane' in opts` is true, so
  it selects that lane's groups. Correct.
- The table calls `groupsFor(data, { empties: 'drop' })` — no `lane` key at all, so it falls to
  the second branch and keeps only groups with **no** lane.

Measured against `/api/query` on the fixture vault:

| query | total | groups | with a lane | without |
|---|---|---|---|---|
| `shape=table&group=status` | 27 | 6 | 0 | 6 |
| `shape=table&group=status,priority` | 27 | 30 | **30** | **0** |

So with a second axis every group carries a lane, the filter keeps none, and the table renders
its header row and nothing else — while the footer still reads "27 shown". Verified in the
browser: `.table tbody` count is 0.

Two consequences for this pass:

- `TableView.tsx:68`'s `{section.lane ? \`${section.lane} · \` : ''}` is unreachable. That is
  why its raw `section.lane` — the one place `labelFor` was never applied, which would print
  the wire form `(none)` — has never been seen. The fix for the raw value is real but it is
  downstream of this.
- The refutation pass claimed F3 mislabelled the table's group heading as "inner (groupBy[0])"
  because the code renders `lane · value`. The code does; the behaviour does not, because that
  branch never executes. Both readings were half right, which is a reminder not to take an
  agent's citation as the behaviour.

Not fixed here — it is a functional defect, not a component one, and the pass has no mandate
for it. Flagged for a decision.
