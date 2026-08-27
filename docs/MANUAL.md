# Manual

Everything projector can do, in one place: the words it uses, the query model, the three shapes, the
CLI, the keymap, and the format of the files it reads and writes.

[README.md](../README.md) is the short version — what this is and how to start it. This is the long
one. For how it works inside, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

# Glossary

Every word below means one thing throughout this document, the code and the CLI.

| | |
|---|---|
| **note** | one markdown file in the vault, and the only kind of thing a vault holds. It becomes work by carrying a lifecycle facet; most never do |
| **facet** | an axis a note carries a value on, declared in `facets.yaml`. Every value is an array |
| **axis** | anything a query can filter, group or sort by: a facet, or a computed axis. `created`, `updated` and `title` are note fields the sort accepts, and are not axes |
| **computed axis** | an axis with no stored value, worked out per query and marked `ƒ`: `type`, `blocked`, `triage`, `linked`, `staleness` |
| **value** | one entry on an axis. `(none)` is not a value but a *refinement* — "carries nothing here" |
| **bucket** | the named range an ordered facet presents itself as, so a date filters as `overdue` and sorts as `2026-09-01` |
| **relation** | a facet declared `type: ref`, whose values are note ids. Stored on the note that depends, pointing at what it depends on |
| **ref** | one value of a relation — a pointer *inside* the vault, traversable |
| **link** | a pointer *outside* it: `jira:`, `gh:pr`, `claude:`, `doc:`, `slack:`, a URL. Read-only, enriched for display, never written back |
| **project** | a note carrying a `project:` block of configuration, which its members inherit. A built-in facet points at them |
| **frontmatter** | the YAML between `---` fences at the top of a note. Everything below is the body, preserved byte for byte |
| **vault** | a folder of markdown, with the vocabulary and the saved views under `.projector/` |
| **view** | a saved query in `.projector/views/*.yaml`, with a name and a shape |
| **shape** | how a query is drawn: `board`, `canvas` or `table` |
| **group** | the notes sharing one value of the grouping axis. A board draws a **column**, a table a **section**, a canvas a **band**; a second grouping axis gives a board **lanes** |
| **mark** | the glyph before a note's title: `▣` a project, `○` something references it, `•` neither |

# The model

## Facets, not lists

A note does not live in a column. It carries **facets**, and **every facet value is an array**,
uniformly. Group by any facet to get columns; group by a multi-valued one and a note appears in every
column it belongs to, by construction.

**Every facet is your vault's.** `facets.yaml` is the whole vocabulary — the axes, their values, their
order, and what each one *means* — and the engine knows none of them by name. A new vault is seeded
with a working set (`priority`, `status`, `due`, `domain`, `energy`, `owner`, `waiting_on`, `source`,
`tech`, and the relations `parent` and `blocked_by`), and every one of those is an ordinary
declaration you can rename, retype or delete. An empty `facets.yaml` is a working vault.

That includes the behaviour, not just the labels. A deadline is loud when it passes, a note is blocked
while something it waits on is unfinished, an axis draws in orange, a relation has a name for its other
end — these are things a vault *says*, in five keys beside `type`:

| | |
|---|---|
| `closed:` | which values mean *no further work expected* — what makes a blocker stop blocking |
| `blocking:` | while this axis is unsatisfied the note cannot proceed |
| `expected:` | a well-filed note carries this; the triage axis is built from it |
| `inverse:` | what the other end of a relation is called |
| `hue:` | which family this axis draws in |

So `blocked` is not a feature about `blocked_by` — it is what *any* reference facet does once you mark
it `blocking: true`, and a vault with three such axes gets three values on the axis. `due` is not a
deadline feature — it is a `date` facet with buckets, and a vault that tracks `review_by` the same way
gets the same colouring, filtering and sorting. Neither is a special case in the app.

Storage is uniform; the **vocabulary** is where the constraints live. `open: false` refuses a value the
list does not declare, and `single: true` refuses a second value at all — because `status: [planning,
done]` is not a note in two columns, it is a note in no coherent state, and the thing writing most of
these files is an agent.

Three facets are built in — `project`, `intake` and `extends`, described [below](#the-built-ins). Everything else,
relations included, is yours: "group by project" and "group by priority" are the same board with one
control moved rather than two boards to keep in sync.

A facet also declares a **type**, which says what its values *are*:

| | | |
|---|---|---|
| `label` | a member of the declared `values` list | sorts in declared order |
| `ref` | a note id in this vault | also traversable — see below |
| `date` | `YYYY-MM-DD` | sorts chronologically |
| `number` | | sorts numerically, not as text |

The file still holds strings and memory still holds `string[]`; the type governs *interpretation*. That
is what makes it cheap — the engine reads a facet in exactly two places.

## Computed axes

Five axes are computed rather than stored. They appear in the filter panel alongside the facets and
behave identically — filter, group, sort, count — and carry `ƒ` to say nothing stores them:

| | Values | Computed from |
|---|---|---|
| `type` | `project`, `node`, `plain` | a `project:` block · being named through any reference facet |
| `blocked` | one value per `blocking:` facet, then `clear` | a reference naming something not `closed` · any other blocking axis holding a value |
| `triage` | one `needs-<facet>` per `expected:` facet, then `complete` | absence of those facets |
| `linked` | `jira`, `gh:pr`, `doc`, `slack`, `url`, … | which kinds of link a note carries |
| `staleness` | `week`, `month`, `older`, `undated` | `updated` against today — and it reads as **Updated**, because that is the field it is |

Each computes over something a facet cannot describe: a `project:` block, the reference graph, an
absence, a note's links, or the app-written `updated` field. Each is a count, a date comparison or
the presence of a reference — never a judgement. `type=project` *is* the projects view, and `triage`
turns the untriaged pile into something you can drag out of. The three `type` values are exclusive — a
project that something is part of stays a `project` — so the counts always add up.

Two of them take their *values* from your vocabulary. `blocked` names one value per facet declared
`blocking:`, and `triage` one per facet declared `expected:` — so declaring a fourth blocking axis
gives it a value on the filter, the grouping and the sort, and a vault that declares none has a
`blocked` axis reading `clear` for everything.

**Every one of them computes.** Nothing computable is also stored, which is why there is no
`status: blocked` to disagree with the `blocked` axis and no `status: waiting` to disagree with
`waiting_on` — `status` is lifecycle alone. A note with no `due` has no value on that axis rather
than an `undated` bucket of its own, so "no deadline" is the same `(none)` refinement every other
facet already has.

## Ordered facets present buckets and compare raw

A date has as many values as there are days, so a filter panel listing them is useless and a board
grouped by one gets a column per day. An ordered facet therefore declares its own **buckets**:

```yaml
due:
  type: date
  single: true
  buckets: { overdue: {upTo: -1, hue: red}, today: {upTo: 0, hue: yellow}, week: 7 }
  overflow: later
```

Filtering and grouping see `overdue · today · week · later`; sorting and range filters see the date.
The two are lexically distinct in a query — `f.due=overdue` is a bucket, `f.due=>2026-09-01` is a
range — so there is nothing to disambiguate. On a face the chip shows the value and *wears* the bucket,
so a passed deadline reads exactly and still colours itself red.

A bucket may declare a `hue` of its own, which is how `overdue` is loud on an axis that is otherwise
quiet; the terse `week: 7` form stays available for the ones that are not making a point. Which end of
a bucketed axis is urgent cannot be derived — `due` runs urgent-at-the-low-end and an `effort` axis
would run trivial-at-the-low-end — so it is declared or it is nothing.

Buckets are what makes a deadline a facet rather than a special field. Any `date` or `number` facet can
declare them, so an `effort` axis in points buckets exactly as `due` does in days. `created` and
`updated` are *not* facets and never will be: a facet is vocabulary you declare, and those two are
written by the app.

## There is only a note

A canvas and a board sit at different altitudes: most leaves of a mind-map are scaffolding, not work.
There is no field saying which a note is, because two questions the note already answers cover it:

- **Is it work?** Whether it carries a lifecycle facet. That is what keeps a grouping note off a
  status-filtered board — it has no status, so the filter does not select it.
- **Does anything point at it?** Whether any reference facet names it.

Only `id` and `title` are required, and a note becomes work by acquiring a lifecycle rather than by
being reclassified.

Every note carries a mark before its title saying which it is. The number is drawn only in a table,
after the title; a card face carries the same fact as the `○` glyph itself, with the number in the
mark's tooltip:

| | |
|---|---|
| `•` | a note — work |
| `○` | a node — some other note names it, through any reference facet |
| `▣` | a project — it owns configuration that its members inherit |
| `12` | how many notes name this one, across every reference facet |

## Relations are facets

A facet declared **`type: ref`** holds note ids rather than labels. That one word is the whole
relation model — there is no separate notion of an edge, and no limit on how many relations a vault
declares. The seeded ones:

| | Meaning | Points at | Powers |
|---|---|---|---|
| `parent` | decomposition — this note is *part of* that one | an ordinary note | the mind-map tree, roll-up progress |
| `blocked_by` | this note cannot move until that one is finished | any note | the `blocked` axis, "what does finishing this unblock" |
| `project` | membership *(built in)* | a project note | config inheritance, the portfolio, transitive roll-up |

The **points at** column is guidance, not a constraint — nothing refuses a `parent` that names a
project note. It is worth following anyway, because `project` already records that edge: a note whose
`parent` and `project` name the *same* note has stored one fact twice, and the panel then draws it
under two headings. See [Projects](#projects) for what each axis is for.

There is no `edges:` block, because a relation was never a different kind of thing. Being a facet means
a relation **filters, groups a board, reaches `(none)`, bulk-edits and drags** — none of which an edge
could do. Being a reference means it also **lays out a canvas, walks under `focus`, and refuses a
cycle** — everything an edge could do. One mechanism, strictly more capable than either half.

**Every reference is stored on the note that depends**, pointing at what it depends on — the child
names its parent, the member its project, the blocked note its blocker. That is one rule rather than
three facts, and it is why a canvas can flip every edge to draw it without being told which. It also
puts the edit where the motivation is: you open a note *because it is stuck*, and what it is stuck on
is recorded there rather than on the other note.

`blocked_by` is the relation neither Trello nor Jira gives usefully. Its transitive closure is what
"unblocked now" is built from. It is the one relation not worth grouping a board by, because the
question is always the inverse — which the computed `blocked` axis answers, and which the panel draws
beside it under whatever `inverse:` calls it.

**Not every association wants to be a relation.** A reference facet is poor at one shape: an
association where every value is unique makes a useless column and a noisy filter panel. "See also" is
a link, and "these are similar" is a label facet.

## Projects

Projects **nest**, and a note can belong to several at once. No separate entity is needed for this:
**`project:` is an optional frontmatter block on any note**, and a note carrying it is a project.
Any note can carry one, so a deliverable is both tracked work and a container for the notes
implementing it.

```yaml
project:
  repos:
    - { path: ../services,   base: main }
    - { path: ~/code/infra,  base: dev }
  jira: PROJ                          # default project for new jira: links
  branch: "plat/{note}"               # branch template
  instructions: |                     # how work here is done
    - Never change a realm in eu-prod without a ticket and a rollback plan.
```

A project's key is its note **id**. There is no separate `key`: a second name for one thing is a
second thing to keep in step, and it would let a `project` facet value point at something that is not
a note id.

Repos are declared inline by path — no registry to populate first. Relative paths resolve against the
vault.

**Membership is the `project` facet and nothing else.** A note carries `project: [platform, mapping]`,
an ordinary multi-valued facet stored exactly like `priority` — it drags, bulk-edits and groups through
the same code path, and its vocabulary comes from the data, so a project is offerable the moment it
exists.

**Inheritance is what makes "define once" work.** A note's effective config walks its `project` facet
outward — each value's note, then whatever *that* note belongs to. `repos` accumulate as a union
(a nested project needs its parent's plus its own), `instructions` concatenate outermost-first so the
most specific advice reads last, and everything else takes the nearest value.

A note may name **several** projects, and they are merged into one order rather than read one after
another: every project comes before anything that names it, and two that are equally general keep the
order the note listed them in. So a note belonging to both a subject and a way of working reads both
sets of instructions as general → specific, with its own last.

**Instructions are configuration**, so they live in the block with the rest of it rather than under a
heading in the body. The body is free-form: nothing in it is configuration. It is still read — task boxes become a
progress bar, the first prose paragraph becomes the note-face excerpt, and the whole of it goes into
FTS — but no heading or marker in it changes how the app behaves.

### `project` and `parent` are different questions

A note may have a project, a parent, both or neither, and the two axes do not compete:

| | `project` | `parent` |
|---|---|---|
| asks | who owns this | what is this a piece of |
| shape | many-to-many, flat | single, a tree |
| carries config | yes — repos, `jira`, `branch`, `instructions` | no |
| other end | `Members` | `Children` |

So the useful pattern is **both, naming different notes**: `project` names the project, `parent` names
the neighbouring note this one is a piece of. A task that is one of four steps in a piece of work says
`project: [platform]` and `parent: [the-piece-of-work]`, and each axis is then answering the question
it is for.

Pointing both at the same note is the shape to avoid. `parent: [platform], project: [platform]` adds
nothing to the membership already recorded — and it makes the decomposition tree a copy of the
portfolio tree, so the canvas draws one shape twice and the panel lists the note under both `Members`
and `Children`. A project note is the root of its portfolio; it is not a step in anything.

`parent` is otherwise a separate relation: it means decomposition and carries no config.

---

# The query model

There is one page and one endpoint. The sidebar composes a query, the URL holds it, and any view is
shareable or bookmarkable without being saved first.

```
view = filter × focus × shape × show
```

That is also the sidebar, top to bottom. No top bar, and only the filter panel scrolls:

```
[ vault ▾ ]                                       ( 191 notes · 16 projects )
[ saved view ▾ ]  modified · save · revert
──────────────────────────────────────────
[ shape: board ▾ ]   group by [ priority ▾ ]   then by [ — ▾ ]
                     no value [ end ▾ ]
                     sort     [ priority ▾ ] [ ↑ ]
[ show: project +1 ▾ ]
──────────────────────────────────────────
[ focus ]    note · via · direction · depth
[ filter ]   the facet panel
──────────────────────────────────────────
( 121 shown · 38 filtered out · 6 for context · clear )
[ search ]
```

**The rail does not change when the shape does** — no row appears or disappears. What floats over the
canvas is what only a canvas can do *and* only while one is open:

```
[ drag creates: parent ▾ ] [ + note ] [ Save layout ]
```

The bulk-selection bar floats over whichever shape has a selection, for the same reason: it exists
only while one does.
The footer always says how many notes are shown, how many the filter is hiding and how many are
context, with a one-click *clear* — so a note that is missing is never a mystery.

## filter

Multi-select over every facet and computed axis, plus **`(none)`** for absence — "notes with no project"
is a click, not a search. Values within a facet are ORed; facets are ANDed.

**Alt-click filters a value out** instead of in, and the box draws a bar rather than a tick:
`?f.project=-project-a` is "everything except Project A". It is deliberately not the same query as ticking every
other project. It keeps the notes with no project at all — which on a real vault is most of them, and
the whole point when you are working a backlog — and it stays true the next time a project is created,
where a list of the others silently stops including the new one. On a multi-valued axis the two
compose: `?f.project=project-a,-project-b` is the Project A work that is not also Project B, which no positive selection can
express.

Counts are **disjunctive**: an unselected value tells you how many notes adding it would bring in,
rather than reading 0 — so a selection can always be widened, not just narrowed. Refining one facet
never removes another from the panel, and a facet nothing in view carries is not offered at all.

## focus

A note plus a traversal. **Not a filter**: a facet filter tests membership one level deep over
values, while focus walks *edges*, transitively.

```
focus = { id, via: <any relation>, dir: out | in | both, depth: n | ∞ }
```

The difference matters most with nested projects. If `platform` contains `identity`, which contains the
notes doing the work, then `filter: project=platform` finds only what names `platform` directly — while
`focus=platform via=project dir=in` finds the whole portfolio. Otherwise you have to tick every
sub-project by hand, and remember again when a new one appears.

`dir` is mechanical rather than spatial: **`out`** follows a note's own references and **`in`** finds
the notes naming it. `up`/`down` would read correctly only for containment — on `blocked_by`, "up" means
toward the blocker, which is the same arrow as `parent`'s "down".

It applies to every shape: `via=blocked_by dir=in` is "what does finishing this unblock", and
`via=parent dir=out` is "what is this part of".

## shape and show

`shape` is `board`, `canvas` or `table` — explicit, never inferred.

`show` is which axes this view surfaces, and there is one list rather than two because how each is
drawn follows from what it is:

| | label facet | reference facet | computed axis |
|---|---|---|---|
| board / canvas face | a chip | a chip that opens the target | a chip |
| canvas | — | a line between notes, and the **first** one lays the graph out | — |
| table | a column | a column of links | a column |

A **computed axis** may be shown like any other, which is the same rule that lets one be filtered,
grouped and sorted by (C4): `show: [staleness]` gives a column of `week · month · older`. It arrives on
the note as `computed`, beside `facets` rather than merged into it — what the file stores is editable
and what the app derives is not, and a face draws either.

## grouping

`groupBy: [primary, secondary]` gives a board columns and swimlane rows, and a table sections and
sub-sections. Its options are shared, because they describe grouping rather than any one shape: `sort`
orders within a column, a section or a canvas rank. Every value the query *admits* gets a group — the facet's
declared order narrowed to the current selection, so a filter makes an axis smaller rather than empty.
A board keeps a group nothing is in, because an empty column is somewhere to drag a note to; a table
and a canvas drop it, because neither offers anything to drag.

The no-value group always comes last, and appears only when something is in it. To leave the
uncategorised out entirely, select the values you want — excluding them is what a filter is for.

Grouping by a **reference** facet gives a column per note — one board per parent, or per project.
That works because a hierarchy concentrates: 26 distinct parents across 134 references here, only 7 of
them used once.

`sort: [priority:asc]` ranks by the order declared in `facets.yaml`, not alphabetically — so `now`
comes before `month`.

A canvas draws them as **bands**, stacked in the order the facet declares. A note has one position,
so a note whose grouped facet holds several values is drawn in the *first* group it belongs to — and
the footer says how many that applies to, rather than letting the canvas quietly disagree with the
board. Notes kept for context matched no group, so they get a band of their own. An empty declared
value gets no band: an empty board column is somewhere to drag a note *to*, and dragging on a canvas
moves a position without changing any facet.

## search

Full text is another predicate in the same query, live and debounced. The trailing word is matched as a
prefix, so `keyc` finds `keycloak` while you are still typing.

## Saved views

A saved view is a named query in `.projector/views/*.yaml`, listed in the sidebar and switchable at any time.
Change a control while one is open and the sidebar says *modified*, with **save** and **revert** — so a
named view stays what you left it. *Save current as…* writes the query you are looking at; saving over
an existing name replaces its query and keeps its arrangement.

**Arrangement only exists in a saved view.** Node positions and manual note order live in the view file,
never on a note — the same note can sit at a different place on each canvas and in a different order in
each column. Notes own identity and content; views own arrangement. So an ad-hoc query is auto-laid-out
and auto-ordered, and *Save layout* on one asks for a name first: naming a query is what creates
somewhere for its layout to live.

```yaml
shape: board | canvas | table
title: Home
filter: { status: [planning, active] }
focus: { id: platform, via: parent, dir: in, depth: 2 }
q: keycloak
groupBy: [priority, project]
sort: [due:asc, priority:asc]
show: [parent, project, tech]      # references first: the canvas lays out by the first
nodes: { platform: {x: 0, y: 0} }  # written by Save layout, not by hand
order: { now: [id, id] }           # written by a drag, not by hand
```

`connect` is not a key: keeping unmatched ancestors so a graph stays readable is something only a
canvas ever honoured, so it follows the shape. Nor is `layout`, which was written beside `nodes` and
read by nothing — a canvas knows it is hand-arranged because `nodes` is there.

**Those are all the keys there are.** `pj check` rejects any other, because a view with a misspelled
or retired key parses exactly like one that works and then does nothing.

---

# The shapes

**Board.** Columns from the primary grouping axis, lanes as rows when a second axis is set. Create a
note inline in a column and it inherits that column's value. ⌘/⇧-click builds a selection for the bulk
bar.

| Gesture | Effect |
|---|---|
| drag `now` → `month` | **replace** — remove `now`, add `month` |
| ⌥ + drop | **add** — the note now appears in both columns |
| ⇧ + drag out | **remove** just that value |
| drop into `(none)` | remove the value dragged from — so a note with one value on that axis lands in `(none)`, and a note with several stays in its other columns |
| drag within a column | **reorder** — needs a saved view, since order is arrangement |

So "note in two columns" is always a gesture, never an accident.

**Canvas.** A tree laid out from its roots, plus free positioning once saved — and bands when the query
is grouped. Every note draws the same face — how much of a note to show is a property of the view, which is what `show` is, so a note
never changes shape because of a field it happens to carry. Drag handle-to-handle to create an edge,
`+ node` for cheap capture, double-click to open. The tree follows whichever hierarchy
you have chosen to draw first — decomposition (`parent`) or membership (`project`).

A container whose members contain nothing of their own does not grow a member-tall pillar: from
six such members they lay out as a grid, reading left → right and top → bottom in the view's own
sort order. A member with children of its own stays in the tree — it has structure a grid would
flatten.

Two kinds of line, told apart by geometry before colour: the relation the canvas is laid out by
curves — a fan out of one note diverges at its source, so forty members are forty traceable lines
rather than one trunk — and every other relation, a blocker, a second hierarchy, attaches top and
bottom and is drawn straight, cutting across the curved grain at an angle no tree edge takes.
**A line you cannot trace is a click away from an answer**: clicking an edge spotlights just that
line and its two ends; click it again, the pane, or any note to release it. Selecting notes lights
every line touching the selection — incoming and outgoing both — and recedes the rest, lines and
notes alike: what stays at full strength is the selection and everything one line away from it. The
first paint is capped both ways, never past 1:1 and never below reading size; when the query has a
`focus`, it frames the focused note and its first ring rather than the whole graph — the minimap
covers the rest.

Filtering a graph means **match plus context**: unmatched ancestors are kept so the tree stays
connected, drawn muted and counted separately, so a filtered graph still reads as a graph. They are
walked along the relation the canvas is *laid out by*, so a portfolio canvas never pulls in context
from the decomposition tree.

**Table.** The one thing neither other shape gives: columns of numbers. Its columns are the same facet
list a board draws as chips. A project row adds roll-ups — **direct / total** note counts, blocked,
untriaged, last activity — where total follows the `project` chain, so a project with one direct
member and six nested ones reads `1 / 7`.

## Editing

**Structure is edited by gesture; content is edited in the panel.** Facets — relations included — are
written by drag, the bulk bar and canvas handles, the same writes for one note or fifty. Title, body,
links and the `project:` block go through the note panel only. Creating a note inline in a column is
the one exception.

Since a relation is a facet, dragging between columns of a `parent` board re-parents a note through
exactly the code path that changes its priority.

| Where | What |
|---|---|
| Note panel | rename, edit any facet through the control its type picks, add/remove links, edit the body, raw frontmatter, make/unmake a project, delete |
| Board | drag between columns and within them, `+` to create, ⌘/⇧-click to select, bulk bar |
| Canvas | drag notes and **Save layout**, handle-to-handle to add a reference, `+ note`, ⌘-click or marquee to select, click a line to spotlight it, bulk bar |
| Table | click a row to open the panel, ⌘/⇧-click to select, bulk bar |
| Keyboard | the cursor, the digits, the trail, and the rail leader |

See [Keyboard](#keyboard) for the whole map.

**Bulk actions** make a few hundred notes tractable: ⌘-click a selection, then set or clear any one
facet, merge, or delete, across all of it. The facet control follows the same rule as the panel —
**the control its type picks** — so choosing a reference axis opens the note picker over every note in
the vault rather than offering the handful of ids that happen to be on screen. An axis holding one
value is replaced by a pick; an axis holding several is added to, since dropping the memberships
nobody mentioned is not what "set the project" means.

**Merging is the other half of capture.** Four notes about one thing is what a sweep from four
channels produces, and splitting them apart again by hand is work nobody does. Select them, press
**Merge…**, and pick which one survives — the rest are folded into it and their files removed.

The survivor keeps its own classification entire: its priority, status, energy, every label it
carries. What the absorbed notes bring is only what nothing else could recover — their prose, as a
`##` section titled with each note's title; their links; their references, so a project or a blocker
survives the collapse; and the `source_fingerprint` of wherever each was captured from, without which
the next sweep would propose it all over again. Everything that pointed *at* an absorbed note is
repointed at the survivor. A merge that would leave some note referencing itself, or reaching itself
through a chain, is refused before anything is written rather than half applied.

**Conflicts are refused, not merged.** If a file changed since the panel read it the write is refused
and the panel says so, rather than one of you silently losing an edit — which matters when an agent may
be working on the same note in another window.

---

# Links and enrichment

A link is a typed string on a note, resolved lazily and cached. It renders as its parsed label, and
enrichment replaces that with something richer if and when it arrives — nothing waits on it.

**A kind exists when something resolves it.** Anything that only ever renders its own text is a `url`
with extra vocabulary, so there is no `cal:` or `grafana:` — and no `trello:`, which was migration
provenance, which is the `source` facet's job. `slack:` is the one kind kept without a fetcher: a
Slack ref is not interchangeable with the permalink it wraps, and it is common enough to be worth
resolving.

**Where a link opens does not depend on a fetcher.** Six of the eight kinds resolve an `href` from the
ref alone — a fetcher adds a title, a status and a diff size, never the ability to click. The two that
do not are the two with nowhere on the web to go: a Claude session and a local file. Both are reached
the same way instead — a deep link where the machine has an app registered for one, and a copyable
command where it does not.

| Kind | Syntax | Source | Needs | TTL |
|---|---|---|---|---|
| `jira` | `jira:PROJ-303` | Jira REST | `PROJECTOR_JIRA_URL`, `PROJECTOR_JIRA_EMAIL`, `PROJECTOR_JIRA_TOKEN` | 15 min |
| `gh:pr` | `gh:pr:ORG/repo#412` | `gh pr view --json` | the `gh` CLI, authenticated | 5 min |
| `gh:branch` | `gh:branch:ORG/repo@ref` | `gh api` | the `gh` CLI, authenticated | 10 min |
| `gh:commit` | `gh:commit:ORG/repo@sha` | `gh api` | the `gh` CLI, authenticated | never |
| `claude` | `claude:<uuid>` | `~/.claude/projects/**` | — | 1 min |
| `doc` | `doc:path.md` | filesystem | `PROJECTOR_DOC_URL` to make it clickable | 30 s |
| `slack` `url` | — | not fetched — the ref is already the URL | — | — |

Every fetcher is read-only and runs server-side, so credentials stay out of the browser. Failures are
cached too, so a link that cannot resolve says why once instead of retrying on every render.

**A link row is one skeleton for all eight kinds** — the kind, then the label, then a remove — with
what a fetcher returned below it in a fixed order: what it is, what is true about it, what went wrong.
**The label is the way in**, whatever the href's origin, so "where do I click" is answered in the same
place for every kind. There is no separate control reading "open in Claude": the label already names
the session, and a click already means go there.

A `doc:` path is relative to the vault root, or absolute. It cannot be a `file://` link — a browser
will not navigate to one from an http page, and where it does anything at all it downloads a copy,
which is not opening the document but making a second one. So a doc opens through `PROJECTOR_DOC_URL`
when that names an editor scheme, and falls back to `open <path>` — macOS's own "hand this to whatever
owns it" — when it does not. No scheme means "open with the default app", so guessing one would be
choosing your editor for you:

```bash
export PROJECTOR_DOC_URL='cursor://file{path}'      # or vscode://file{path}
export PROJECTOR_DOC_URL='obsidian://open?path={path}'
```

A `claude:` link takes a session transcript uuid and resolves to its opening prompt, last activity,
turn count, working directory, branch, and either a `claude://` deep link into the desktop app or the
`claude --resume` command to pick it back up.

```bash
pj enrich --all              # resolve every link on every note and print it
pj enrich <ref> --force
```

---

# Intake

Enrichment's mirror image. Enrichment is handed a ref and answers *how to show it*; intake is handed a
channel and a cursor and answers *which refs nobody has filed*. Same Jira token, same
`~/.claude/projects`, opposite question — so the two share `src/sources/` and nothing else.

| Channel | Source | Unit | Fingerprint |
|---|---|---|---|
| `claude` | `~/.claude/projects/**` | a transcript that moved | `claude:<uuid>` |
| `git` | the project repos, via `git log` | a **branch**, or a lone commit on the base branch | `git:<repo>@<branch>` / `@<sha>` |
| `jira` | JQL, `PROJECTOR_JIRA_*` | an issue assigned to / reported by / watched by you | `jira:KEY` |
| `slack` | **not fetched here** — an agent, through MCP | a message | `slack:<channel>/<ts>` |
| `gmail` | **not fetched here** — an agent, through MCP | a thread | `gmail:<message-id>` |

```bash
pj intake                    # every channel, each from where it last got to
pj intake claude git --json
pj intake status
pj intake known claude:abc-123          # which notes already carry this
pj intake commit --advance --captured 2 # promote what that sweep recorded

pj intake suppress git:abc --reason "my own commit"   # a no, recorded
pj intake suppressed                                  # what a no hid, and why
pj intake unsuppress git:abc                          # offer it again
```

**`pj intake` creates no note and moves no cursor.** `pj add`/`pj link` do the first after a human
agrees, and `pj intake commit` does the second once the proposal is resolved. A run that fetched is not
a run that was resolved, and an abandoned sweep must not swallow what it listed.

What a sweep *does* write is where it **would** move each cursor to, alongside how many items it
examined. `--advance` promotes them. A pending proposal is inert until then, and promoting it
spends it, so a second `--advance` re-commits nothing. `--captured` stays an argument: capture happens
between the sweep and the commit, and nothing attributes a `pj add` back to a channel.

**Sweeping without being asked.** A vault can have the server sweep on a timer and write what it finds
straight into the queue, so the intake board fills on its own:

```yaml
# .projector/config.yaml
poll:
  enabled: true
  every: 900        # seconds; floored at 60, and 900 is the default
channels: [git, claude, jira]
```

It starts when the vault is first opened, and each candidate that survives judgement lands as an
ordinary note carrying `intake: unjudged` — so an open board shows it appear without doing anything.
Running twice writes nothing twice: a fingerprint the vault already holds short-circuits. Slack and
Gmail are skipped with a reason, having no credential here.

Unlike `pj intake`, a poll **does** move each channel's cursor — it can, because everything behind the
new boundary is a file rather than a line in a terminal you have already closed.

Without a server, `pj intake poll` runs exactly the same tick once, by hand.

**Every tick judges before it writes, and writes the card while it is there.** One pass answers both
questions: does this deserve a note, and if so what is the note. So a card arrives with a title a person
would actually use, a body saying where the work got to, and the axes it belongs on — rather than a
commit subject, a provenance string and nothing else.

Candidates that do not deserve a note are recorded as declined, with the reason, and never become
files — so a sweep of your own afternoon leaves the board empty and the declined pile three lines
longer. The rule it applies: your own routine progress is not news to you; what needs a decision, a
reply, or is unfinished and untracked, is. A candidate that is *more of something already tracked*
lands pointing at that note through `extends`, to be merged rather than filed.

**The model proposes; your vocabulary disposes.** Every facet value and every merge target is checked
against the vault before anything is written — an invented value is dropped and the rest of the card
kept, an invented target makes the candidate stand alone. It cannot set `intake` or `extends` itself,
and on an open axis it is shown the values your notes already use and asked to prefer them, so a queue
of cards does not sprawl your vocabulary.

Tune it for your vault by writing `.projector/classify.md`, which replaces the built-in instructions
entirely. Change the model or the command if you want something other than a small one:

```yaml
classify:
  enabled: true       # the default; `false` means "write everything down and let me sort it"
  model: haiku
  command: claude
```

**If it cannot judge, it does not write.** A tick that cannot reach the classifier holds — nothing
written, no cursor moved — and the next one tries again. That is deliberate: falling back to writing
everything down would hand you the pile the judgement exists to prevent, and you would find out by
looking at the board. `classify: {enabled: false}` is how you ask for that pile on purpose.

**Saying no is a step too, and there are three ways to do it.**

**Delete the note.** The obvious gesture, and it now sticks: deleting a note that came from a sweep
records its fingerprint as declined on the way out, so no later sweep offers it again. Before that it
destroyed the one thing stopping the card coming back, which made the gesture that plainly means *no*
the one that did not work.

**`pj intake suppress <fingerprint> --reason "…"`** says no to something that never became a note —
which is what the classifier itself does, for everything it drops.

**Archive it** — keep the note and set `status: archived`. For one considered rejection you would like
to find again; the note and its fingerprint both stay.

Read the pile back with `pj intake suppressed` and undo any of it with `pj intake unsuppress`. Both
matter more than they look: getting the order wrong costs you some scrolling, and hiding the wrong
thing costs you the item — so a no is always reversible and the pile is always readable. Each row says
whether the model or you decided, because a model's no is a guess you may want to check and yours is
not.

**A watermark is not what makes this correct.** `source_fingerprint` on the notes is — it stops a
duplicate whether or not a cursor knows the item exists. The cursor only decides how far back to look,
so deleting `.projector/intake.db` degrades a sweep to a default window: noisier, never wrong. That is also why
it is its own file rather than a table in `.projector/enrich.db`, which is a cache and is meant to be
throwaway-able.

Channels work **oldest-first from the cursor**, and a run truncated by `--limit` holds its cursor: a
cursor is one value, so it may only advance to a boundary with nothing unexamined behind it.

**What `pj` decides, and what it does not.** It decides only what is decidable — a ref already on a
note, a fingerprint already captured, a session too short to be work. Everything else arrives as
`evidence`, and each match carries the mechanical reason it matched: `cwd`, `worktree`, `branch`,
`mentions PROJ-303`, `text`. There is no score and no verdict, because the failure that would make this
useless is a confident wrong one — a session linked to the wrong note puts its history where nobody will
look. Choosing between note, link and neither is `/pj-capture`'s job, out loud.

Two channels have no fetcher here at all. Slack and Gmail are read by an agent through MCP — a second
token in a second place to rotate buys nothing — but `pj` still keeps their cursors, because a
watermark is a property of where the sweep got to, not of who fetched.

---

# Agents

Notes are plain files, so an agent can create and edit them directly with no API and no app running.
Three commands make that reliable:

**`pj context <id>`** assembles everything known about a note in one pass — the project chain, the
inherited repos and instructions, relations, and cached link enrichment — so an agent never
re-derives it from the filesystem.

**`pj log`** answers "what did I actually do last week", which nothing stored on a note can: `updated`
is one overwritten date and only ever says that *something* changed. The vault is a git repository, so
the answer was already on disk — this reads the two versions of every changed file through the note
parser and reports the transitions. Nothing is written, and no field was added to carry it.

**Starting work** prepares a workspace: a `git worktree` per project repo on one branch, a briefing
with the note's full context embedded, and a Claude session opened on it in the desktop app — the same
place the `claude:` link on a note reopens a *past* session, so work happens in one app rather than
two. Reopening is idempotent, and one repo failing does not stop the others.
**`PROJECTOR_WORKSPACES` is required** — worktrees are real directories on disk, so where they go is
told, never guessed.

Three ways in, one act behind them:

| | |
|---|---|
| the ▶ in the panel's top-right corner | beside the trash, and confirmed like it |
| `!` with a note under the cursor | opens the panel if it is shut, then presses the same control |
| `pj work <id>` | prints what it prepared, then hands the link to `open` |

The confirm names the workspace directory, the branch and every repo *before* any of them exists,
which is the whole of the safety on a one-keystroke launch. Backing out of it creates nothing.
`pj work --dry-run` prints the same plan plus the entire briefing and touches nothing; `--no-open`
prepares the workspace and prints the link instead of following it.

The briefing's key step: read the note, the linked issues and every repo's docs — then **stop and ask**
before planning or writing code. Its last step links the session back to the note, so a note
accumulates its own history.

## Skills

`.claude/skills/` ships five skills, invoked as slash commands from a Claude session in this project:

| | |
|---|---|
| `/pj-about` | the model and the `pj` surface — read by the others, and on its own for ad-hoc note work |
| `/pj-setup` | choose this vault's channels, prove each one answers, and write `.projector/config.yaml` |
| `/pj-capture` | sweep the five intake channels; each candidate becomes a note, a link on an existing note, or nothing |
| `/pj-triage` | give incomplete notes a project, priority and status |
| `/pj-work` | start work on a note |

`/pj-capture` and `/pj-triage` both **propose and stop**: they present a table and apply nothing until it is
approved. A wrong project assignment hides a note in a column nobody will look in, which is worse than
leaving it blank. Fingerprinting makes a repeated sweep converge instead of refilling the inbox — which
is why a rejected note gets `status: archived` rather than being deleted: deleting it destroys the
fingerprint with it, and the next sweep creates it again.

`/pj-capture` reads its candidates from `pj intake` rather than deciding what is new itself, and it makes
one decision per candidate that `pj` deliberately does not: **note, link, or neither.** A Claude session
is usually not new work — it is more of something already tracked, or a question that was answered — and
only "already on a note" is a fact. The rest is a judgement, made on evidence it has to quote.

---

# Vaults

A **vault** is a folder of markdown, opened the way Obsidian opens one. The notes sit at the root, at
any depth; the only thing the app adds is `.projector/`, holding the vocabulary, the saved views and
three derived databases. The app has no built-in location and assumes no directory name: on first run
it asks for a folder and remembers the choice, and the switcher at the top of the sidebar opens or
adds others.

**Notes you already keep are a vault.** Point at an Obsidian folder or a directory of meeting notes
and it opens: every `.md` is a note, and one with no frontmatter is titled by its leading heading and
identified by its filename. **A key it cannot use counts as a key you did not write** — an `id:` that
is not a lowercase slug, or a `created:`/`updated:` a foreign tool stamped in its own format, falls
back to the derived value rather than failing the note, so an export is never partly invisible.
Dates are read in either ISO form, `2026-08-27` or `20260827`, with anything after the date dropped.
Nothing is moved, converted, or written back until you change something —
and the first change writes down the id the note was already going by, so a later rename moves a file
rather than a note. There is no exempted filename: a `README.md` is a note like the rest.

Opening a folder that has no `.projector/` sets one up — a facet vocabulary, seven starter views, and a
`.gitignore` for the databases. If the folder already has a `.gitignore`, which an adopted repository
usually does, the missing lines are appended to it and nothing already there is touched or repeated.
That is all it writes: the folder's own files are not touched. A
non-empty folder holding no markdown is refused. No prose document is written into a vault — there is
no seeded README, and the note format is explained in the `pj-about` skill.

The folders you have opened are listed in `vaults.json` next to the app, and the server will only open
one that is on that list — so a page in your browser cannot point it at an arbitrary directory. It is
the only thing written outside a vault; delete it and you lose the list, nothing else.

```bash
pj vaults                                  # list
pj vaults add <path> [--name n] [--create] # open a folder as a vault
pj vaults forget <path>                    # stop tracking it; the folder is untouched
pj --vault <name|path> <command>           # act on a specific one, or -v <name|path>
```

Run `pj` anywhere inside a vault and it finds it by walking up, the way git finds a repository.
Otherwise `--vault`, then `PROJECTOR_DATA`, then the single registered one.

`--vault` takes **a registered name or a path, name first**: `-v work` is the vault you called `work`
wherever it lives, and only a folder called `work` next to you if nothing is registered under that
name. The name must match exactly — a near miss is read as a path, never as a guess at which vault you
meant. A `--vault` that resolves to a folder that is not there is refused, because every reader treats
a missing vault as an empty one, so a typo would otherwise come back as `0 match(es)` and exit 0.

---

# CLI

| | |
|---|---|
| `pj ls [--view n] [--group f[,f]] [--filter f=v,v] [--sort k:d] [--q text] [--focus id --via v --dir out\|in\|both --depth n] [--shape s] [--show f,f] [--json]` | list notes. `--filter due=>2026-09-01` is a range on any ordered facet. `--json` is the payload the app receives |
| `pj log [--since "1 week ago"]` | what changed, read out of git: status transitions, deadlines, creations |
| `pj add <title> [--id slug] [--facet f=v] [--link ref] [--fingerprint fp] [--body text]` | create a note |
| `pj set <id>… …` | scripted edits, over any number of ids: `--title`, `--facet f=v`, `--add`, `--remove`, `--set path=yaml` |
| `pj merge <id>… --into <id>` | fold notes into one. The survivor keeps its facets; the rest bring their body, links, references and capture fingerprints, and their files go |
| `pj rm <id>…` | delete, dropping every reference pointing at it |
| `pj link <id> <ref> … [--remove] [--session] [--cwd dir]` | add or remove links. `--session` names the live Claude session working here, so it is a way of spelling a ref rather than a command of its own |
| `pj context <id> [--json]` | everything known about a note, assembled |
| `pj work <id> [--dry-run] [--no-open]` | multi-repo worktree workspace, briefing, a session in the app |
| `pj enrich [<ref>…] [--all] [--force]` | resolve link enrichment |
| `pj intake [<channel>…] [--since iso] [--limit n] [--json] [--verbose]` | what has happened elsewhere since each channel's cursor. Writes nothing |
| `pj intake status [--json]` · `pj intake known <ref>…` | each channel's cursor and last run · which notes already carry these refs |
| `pj intake commit --advance [--captured n]` · `pj intake reset [--channel c]` | promote the cursor(s) the last sweep recorded, after the proposal is resolved · forget one. `--channel c --cursor v` still says it by hand |
| `pj intake poll` | one tick by hand: sweep, judge, write what deserves a note, record the rest as declined |
| `pj intake suppress <fp>… --reason <why>` · `pj intake suppressed [--json]` · `pj intake unsuppress <fp>…` | record a decline so sweeps stop offering it · read the pile back · put one back in |
| `poll:` · `classify:` in `.projector/config.yaml` | sweep on a timer and write what deserves a note into the queue · who judges that, and with which model. `.projector/classify.md` replaces the instructions |
| `pj setup [--json]` · `pj setup --init [--channels a,b] [--no-enrich]` | what this vault can actually reach, asked rather than assumed · write `.projector/config.yaml` and gitignore it. It refuses to overwrite an existing one |
| `pj check` | validate every note file, and every saved view against the same vocabulary |
| `pj reindex` · `pj search <q>` | rebuild the index and report what it holds · full text, most relevant first |

**Every flag shortens.** One dash or two, cut to any prefix that names exactly one flag of that
command: `pj ls -j`, `pj ls -g status`, `pj set x -f status=done`, `pj intake commit -a`. A prefix that
names two says which two rather than picking one, so `-s` on `pj ls` is refused with `--shape`,
`--show` and `--sort` on the line and `-so` gets the sort. There is no table of letters to fall behind
the flags — a flag added later can make an abbreviation ambiguous, never silently point it elsewhere.
`-v` is `--vault` on every command, since the vault is read before the command is; `--view` and
`--verbose` are `-vie` and `-ve`.

`pj search` and `pj ls --q` match the same notes through the same sanitiser and differ only in order:
search ranks by relevance, which belongs to a result set rather than to any note in it, so it cannot
be a sort key. `pj context` is the only way to read one note — `show` and `project` printed subsets of
what it already assembles.

A saved view's curated note order is applied in the payload, so `pj ls`, a board column and a table
section of the same view agree about it.

The CLI and the app share one query compiler *and* one payload builder, so `pj ls --view unblocked` and
opening that view in the browser mean the same thing, and `pj ls --json` is what `GET /api/query`
returns. There is no `pj next` or `pj untriaged`: those were two queries hardcoded in TypeScript, and
they are `views/unblocked.yaml` and `views/triage.yaml` now — askable from either surface, and checked
by `pj check` like anything else.

---

# File format

```
<vault>/
  fix-deploy.md                  # a note
  eventing.md                    # a node, may carry a project: block
  reading-list.md                # no frontmatter: still a note
  archive/last-year.md           # any depth; folders mean nothing to the app
  assets/fix-deploy/error.png
  .projector/
    facets.yaml                  # facet vocabulary, order, constraints
    views/
      home.yaml  projects.yaml … # flat: a shape is a field, not a folder
    index.db  enrich.db  intake.db  # derived · cache · cursors — all gitignored
```

Delete `.projector/` and what is left is the folder of markdown you started with. That is the test the
layout is built to pass.

## Note

```markdown
---
id: fix-deploy
title: Fix the Kpow deployment
facets:
  priority: [now]
  status: [active]
  due: [2026-09-01]               # a date facet: compared, not matched
  parent: [eventing]              # reference facets: values are note ids
  blocked_by: [kpow-deployment]
  project: [platform]
links:
  - jira:PROJ-303
  - gh:pr:ORG/services#412
  - doc:docs/schema-registry.md
created: 2026-08-19
updated: 2026-08-19
---

Free-form markdown below the frontmatter. Checklists are ordinary task lists —
the app counts them for the progress bar and never rewrites them.

- [x] Deploy to the dev namespace
- [ ] Drop the `KAFKA_` prefix from env vars
```

`id` and `title` are required; everything else is optional. The `id` is the join key everywhere and
never changes, though the filename may drift from it. Facet values are always arrays, and a facet the
vocabulary does not know is preserved rather than dropped.

`priority` says what you intend to do next; `due` says what the world expects regardless of intent.
Both are facets — the type is what tells the engine one is matched and the other compared.

The format is documented once, in the `pj-about` skill — the audience for it is an agent editing files
directly, and an agent already loads that. `pj check` validates every note and reports every problem at
once, rather than stopping at the first.

# Keyboard

Press `?` in the app for the same map, filled in with **this vault's** axis letters. Nothing below
names a facet, because the client may not (C4): an axis is addressed by the `key:` it declares in
`facets.yaml`, and `pj check` refuses one that collides with the map or with another axis.

**The keys are drawn where they apply.** Every facet row in the note panel and every addressable row
in the rail carries a small mono reminder of the key that reaches it — and an axis that declares no
`key:` carries nothing, which is the useful half: you can see that `Layer` has no letter before
pressing one that means something else.

Three rules carry most of it:

- **A digit is the Nth declared value of an axis.** A bare digit means the axis the view is grouped
  by, so `3` is the third column — the drag, keyed.
- **The walk follows the drawing.** `j` `k` go down what is stacked and `h` `l` go across what is
  laid out — cards in a column and columns on a board, links and filter values down a list, a facet's
  values across its row with `j` `k` changing axis. One rule read off the layout, not a convention
  per surface. `⏎` takes what is under the cursor, `Esc` steps back out. Walking forward into an
  `n more` **opens it** and carries on into what appears — the panel caps a link list at three and
  the rail caps a facet at eight, and a walk should not stop at a rendering decision.
- **A prefix never leaves you with nothing.** `,g` reaches Group by immediately and *then* accepts an
  axis letter; a key that is not one falls through to meaning what it normally means.

## Moving the cursor

| Keys | What |
|---|---|
| `j` `k` | next / previous card. A board stops at a column's end; a table runs on through its section headings |
| `h` `l` | previous / next column (board) or section (table). Empty columns are stepped over |
| `[` `]` | previous / next swimlane, on a board with a second grouping axis |
| `gg` | the first drawn card |
| `G` | the last drawn card |
| `⏎` `o` | open the panel on the cursor's card |
| `H` `L` | back / forward through notes you have *followed* — see the trail, below |
| `Esc` | close the cheatsheet, then leave a list, then dismiss a message, then close the panel, then clear the selection |

The cursor is the only pointer: with the panel open it **is** the panel, so `j` turns the page to the
next card. It is not stored in the URL and starts unset — the first motion key puts it on the first
drawn card. A canvas has no cursor: its nodes sit on a plane, so "the next one down" has no answer.

## Going to another note

| Keys | What |
|---|---|
| `g` `⟨axis⟩` | go to the note this card names on that axis. One value goes straight there; several put focus on the first chip |
| `g` `⇧⟨axis⟩` | set the view's focus to the notes naming *this* card on that axis, so `j` and `k` walk them |
| `g` `f` | this card's facet rows — `h` `l` across a row's values, `j` `k` between axes, `⏎` toggles |
| `g` `⇧F` | add an axis the card carries nothing on: the list opens with focus already in it |
| `g` `l` | this card's links. `j` `k` step, `⏎` opens one in a new tab |
| `g` `c` | edit the body. `⌘S` saves, `Esc` leaves it |
| `g` `y` | edit the raw frontmatter. `⌘S` saves, `Esc` leaves it |
| `⟨axis⟩⟨axis⟩` | one axis's own row — the axis prefix followed by anything that is not a digit |
| `!` | **start work** on the cursor's note: worktrees, a briefing, a session in the app. Confirmed first, and the confirm names what it is about to create |

`!` is the odd one out here: every other key in this section *reaches* something, and `!` does
something. It reads that way from vim, where `!` is the key that hands what you have to an external
program — which is exactly the act. It is also a mark rather than a letter on purpose: a facet's `key:`
is one letter `a`–`z`, so `!` is a keystroke no vocabulary can claim and it cost the reserved set
nothing. `w` for "work" would have cost `waiting_on` its letter.

`g f` is how you reach an axis that declares **no** `key:` — walk to its row and pick a value.
**`g ⇧F` adds one**: the list of axes the card carries nothing on opens with focus already in it, and
picking one reveals its row *and lands on its first value*, which is the next thing you were going to
do anyway. The same door is also the last step of the `g f` walk, and `+ ref` behaves identically one
section down. `g` plus a *shifted* axis letter lands on that axis's `Children`-style row when the
panel draws one, and reshapes the view when it does not.

The two are not alternatives, they compose. A derived row lists at most three notes and then pages, so
when the list is the thing you want — a project with sixty members — the row carries a **bullseye at
its right edge, after the count**. It applies exactly the reshape the shifted letter falls back to:
walk that relation inward from this note and show everything it reaches, as ordinary cards you can
sort, group and filter. The rail's **Focus** row is where it shows, with a `✕` to undo it.

**`⇧⟨axis⟩` without the `g` is that same reshape in one keystroke** — `⇧A` for children, `⇧R` for
members, on a vocabulary that spends those letters that way. Where `g ⇧A` prefers the drawn list when
there is one, this always makes it the view. It costs no reserved letter: shift already means *the
other end* behind `g`, and a bare axis letter is already that axis's namespace — `p3` sets priority's
third value and `pp` opens its control, so declaring `key: p` claims `⇧P` along with them. The
collision question answers itself, because the only bare shifted letters the map binds are `G H L J K
U`, and each is the shifted form of a letter no vault may declare.

**Setting a focus clears the `Type` filter, and only that one.** `Type` says where a note sits in the
reference graph and a focus selects by where a note sits in the reference graph, so on **Projects** —
whose filter is `type=[project]` — the two cancel: the members the walk exists to reach are exactly
what the filter removes. Every other filter survives, because `priority=[now]` is a preference about
notes rather than a claim about their position, and a focus is not a request to see things you have
said you do not want to see. The `Type` chips come back with one click in the rail.

**The shifted letter will not focus on nothing.** With the panel open on a note, a declared `inverse:`
and no row drawn means nothing points along that relation — so `g ⇧A` on a note with no children says
so and leaves the view alone, rather than reshaping it to show one note and *no notes match*. Where
there is no panel to read, or the relation names no inverse, it still reshapes: nothing has been
observed, and the traversal is the only way to see the other end.

## Choosing cards

| Keys | What |
|---|---|
| `x` | add or remove the cursor's card from the selection |
| `J` `K` | extend the selection down / up, moving the cursor with it |
| `*` | select everything on screen |
| `Esc` | clear the selection |

## Writing

A write lands on the **selection if there is one, and the cursor's card otherwise** — the rule a drag
already follows. The panel being open changes nothing, because the panel is the cursor's card.

| Keys | What |
|---|---|
| `1`–`9` | set the grouped axis to its nth declared value |
| `0` | clear the grouped axis |
| `⟨axis⟩` `1`–`9` | set that axis to its nth value, whether or not the card carries it yet |
| `n` | a new card in the cursor's column, inheriting that column's value. A board only |
| `u` `U` | undo · redo |

`u` covers what the digits and the axis letters write. A value **toggled in the panel** with `⏎` is a
panel write like a mouse click on the same chip, and is not on the stack — it needs none, since
pressing `⏎` again is its exact inverse.

Cardinality picks the verb, exactly as in the panel: a `single:` axis is **replaced**, an axis holding
several is **added to**. A digit never removes — `0` is the gesture that clears.

## The view

| Keys | What |
|---|---|
| `,v` | saved views |
| `,s` | shape |
| `,g` `,G` | group by · then by |
| `,o` | sort. The same axis twice flips the direction |
| `,O` | flip the direction alone, without touching what is sorted by |
| `,f` | which facets a note shows |
| `,F` | the filter rail |
| `,w` | focus — walk from a note |
| `,c` | clear the filters |
| `,\` | collapse the rail |
| `⌥1`–`⌥9` | the nth saved view, in the order `,v` lists them |
| `/` | the search box |
| `?` | the cheatsheet |

`,g` `,G` `,o` and `,f` take an axis letter directly: `,g p` groups by that axis without opening
anything.

Each rail row draws its letter without the comma — every row in the rail is `,` plus one letter, so
repeating the prefix seven times said nothing and made the letters different widths.

## Not bound yet

Two, and `?` lists neither: `⌥j` / `⌥k` to reorder within a column, and `.` for a command palette.
NEXT.md says why each is waiting — the short of it is that reordering is idle until a saved view is
what you are working in, and the palette's job keeps shrinking as the map covers more of it.

## Checking it works

Each of these starts from a fresh load of a board view — `?view=home` on a vault whose `facets.yaml`
declares at least `status`, `priority` and `project` keys. Where a step needs a letter, `s` and `p`
are the ones the shipped tutorial vault declares; `project` ships without one, so declare it first —
`project: {key: r}` in `facets.yaml`, which the built-in accepts — and substitute your own elsewhere.

1. **The cursor appears.** Press `j`. A ring appears on the first card of the first column. Press `j`
   twice more, then `k` — the ring walks down and back. Press `l` — it crosses to the next column at
   roughly the same height, and an empty column is skipped rather than landed in.
2. **The ends hold.** Press `G`, then `j`. The ring is on the last card and does not move. Press `gg`
   — it returns to the first.
3. **Selection is a wash, the cursor is a ring.** Press `x`, then `j`. The card you left has a filled
   accent background; the card you are on has an accent outline. They must not look the same.
4. **Opening follows the cursor.** Press `⏎`. The panel opens on the ringed card. Press `j` twice —
   the panel turns to the next card each time, without closing.
5. **The trail.** With the panel open on a card that has a project, press `g` then `r`. The panel is
   now on the project. Press `H` — you are back on the first card. Press `L` — forward again. (`H`
   before any `g` does nothing: ordinary `j`/`k` motion deliberately does not record.)
6. **The inverse direction.** On that project, press `g` then `⇧R`. The rail's Focus row fills in and
   the board now shows the notes that name it; `j` and `k` walk them as ordinary cards. Click the ✕
   beside Focus to undo.
7. **Links.** Open a card carrying two or more links and press `g` then `l`. Focus lands on the first
   link chip; `j` and `k` step between them. Press `Esc` — focus returns to the cards, and the next
   `j` moves the cursor rather than the link list.
8. **A digit writes.** Close the panel. Put the cursor on a card in the first column and press `2`.
   The card moves to the second column and washes briefly. Press `u` — it returns. Press `U` — it
   moves again. Press `u` once more to leave it as you found it.
9. **A digit past the end says so.** Press `9` on an axis with four values. A message appears naming
   the axis; no card moves.
10. **An axis by letter, on an axis the card lacks.** Find a card with no Energy (or any axis it
    carries nothing on), open it, and press that axis's letter then `1`. The value is set and the row
    appears in the panel — there is no equivalent of the panel's `+ facet` door to open first.
11. **Bulk undo restores each card's own value.** Select three cards from three different columns with
    `x`, `l`, `x`, `l`, `x`. Press `1`. All three move to the first column. Press `u` — each returns
    to the column it came from, not to a shared one.
12. **A saved view.** Press `,v`. The popover opens *and* focus is already on its first entry. Press
    `j` twice, then `⏎`. The view changes and the rail's View row shows the new name. Press `,v`
    again — it must open, not toggle shut.
13. **A select.** Press `,s`. The Shape row takes focus. Press `j` — the board becomes a canvas. Press
    `k` — back to a board.
14. **An axis letter skips the walk.** Press `,g` then `p`. The board regroups by that axis
    immediately. Press `,o` then `p` twice — it sorts by that axis, and the second press flips the
    arrow to descending.
15. **The filter rail.** Press `,F`. Focus lands on the first value of the first open axis, with a
    ring around its checkbox. Press `j` to a value that is not ticked and press `⏎` — it ticks, the
    footer count changes, and the URL gains an `f.` parameter. Press `⏎` again to untick it.
16. **A closed axis opens.** From the filter rail, keep pressing `j` past the open axis's values until
    focus reaches a collapsed axis's heading. Press `⏎` — it expands. Press `j` — focus is on its
    first value.
17. **Shifted completions.** Press `,` then `⇧G`, holding shift. The Then by row takes focus. Repeat
    with `,` `⇧F` for the filter rail. (These are worth their own step: the `Shift` keydown arrives
    before the letter, and it used to cancel the sequence.)
18. **The nth view.** Press `⌥3`. You land on the third view in the `,v` list. (On macOS `⌥3` types
    `£`; it is read from the physical key, so it must still work.)
19. **Search.** Press `/`. The rail's search box takes focus. Type a word — the board narrows. Press
    `Esc` — the box empties. Press `Esc` again — focus leaves the box, and the next `j` moves the
    cursor rather than typing a letter.
20. **Typing is never a shortcut.** With focus still in the search box, type `jjj333`. The text
    appears in the box; the cursor does not move and no card is written.
21. **The panel is not modal.** Open a card, then press `Tab` a few times. Focus moves through the
    panel's own controls and out into the page behind it — there is no trap. Press `Esc` to close.
22. **A rename is reachable.** Open a card and press `Tab` until the title has a ring, then `⏎`. The
    rename editor opens. Press `Esc` — the rename is abandoned and **the panel stays open**.
23. **Unsaved text is defended.** Open a card, open its raw frontmatter, type a character, then press
    `Esc`. A prompt asks before closing. Decline — the panel stays. Press `Esc` again and accept.
24. **The cheatsheet fits.** Press `?`. The map appears in balanced columns with no scrollbar. Every
    axis your vault gives a `key:` is listed under *This vault*, with `set` or `add` beside it. Press
    `?` again to close.
25. **The cheatsheet covers an open card.** Open a card, then press `?`. The map is drawn *over* the
    panel, not behind it. Press `Esc` — the map closes and the card stays open.
26. **Escape leaves a rail control.** Press `,s`, then `Esc`. Focus returns to the cursor's card;
    press `j` and the cursor moves while the Shape row stays where it was. (Without this, `j` and `k`
    go on changing the shape and there is no way back to the cards but the mouse.)
27. **The hints say what has a key, and what does not.** Open a card. Beside `Status` and `Priority`
    there is a small `s` and `p`; beside an axis your vault gives no `key:` — `Layer`, say — there is
    nothing. The rail shows `,v` `,s` `,g` `,G` `,o` `,f` `,w` in the case you actually press: only
    the two shifted ones are capital.
28. **A card written out of the view keeps taking writes.** On `home`, which keeps only `planning`
    and `active`, open a card and set its status to a value outside that filter — `s3` for `on-hold`.
    The card leaves the board and the panel stays on it. Now press `s1`. The status becomes `active`;
    it must not be silently ignored. Press `u` twice: `on-hold`, then the value you started from.
29. **And it can still be followed.** With that same card written out of the view and its panel still
    open, press `g` then the Project letter. You land on its project. (It used to report "nothing on
    Project" with the project visible on screen: the follow read the query's payload, and the payload
    no longer mentioned the card.)
30. **An axis with no key is still reachable.** Open a card carrying a value on an axis your vault
    gives no `key:` — `Layer`, say. Press `g` then `f`: focus lands on the first value of the first
    facet row. Press `j` until the ring is in the `Layer` row, `l` across to a value, and `⏎`. The
    value toggles. Press `⏎` again to put it back. (`j` `k` change axis because the axes are stacked;
    `h` `l` walk values because the values are laid across.)
31. **The body and the frontmatter.** With a card open, press `g` then `c`. The body editor opens and
    the cursor is in it. Type a character, press `⌘S` — it saves. Press `Esc` — the editor closes and
    **the panel stays open**. Repeat with `g` then `y` for the raw frontmatter. (Press `Esc` on a
    dirty editor and it should ask first.)
32. **A truncated list opens as you walk into it.** Open a card carrying more than three links and
    press `g` then `l`. Three are drawn. Press `j` three times: the fourth press expands the list and
    lands on the fourth link, rather than stopping. Press `k` — back to the third, without the list
    collapsing. Then do the same in the rail: `,F`, open an axis with more than eight values, walk to
    the eighth and press `j`. It must land on the **ninth value**, not skip to the next axis.
33. **The panel turns the page rather than blinking.** Open a card and hold `j` down a column of five
    or six. The title and contents change each time and `loading…` must never appear between them —
    the panel keeps the card you were reading up until the next one has arrived.
34. **Every hint is one letter, against the thing it names.** In the panel a letter sits beside its
    label — `s` by Status, `c` by Body, `A` by Children — and the row's *annotations* take the far
    edge: a section's control (refresh, pencil) and an inbound row's count. In the rail the letters
    right-align instead, because a fixed label column lets all seven form a column you read down;
    only `G` and `F` are capital there.
35. **Adding a facet, keyboard only.** Open a card and press `g` then `⇧F`. The list of axes the card
    carries nothing on opens with focus already on its first entry. Press `j` to one and `⏎`: its row
    appears in the grid **and the ring is already on that row's first value**. Press `l` to another
    and `⏎` to set it. The same door is also where `g f` then `j` past the last row lands, and `+ ref`
    one section down works the same way.
36. **Flipping the sort.** Press `,O`. The arrow beside the Sort row turns over and the board
    re-orders; the axis being sorted by does not change. Press `,O` again to put it back. (With
    nothing sorted it says so rather than doing nothing.)
37. **A new card, where the cursor is.** On a board, put the cursor in a column that is not the first
    and press `n`. The inline title field opens **in that column**, focused. Type a title and press
    `⏎`: the card is created there and carries that column's value for the grouped axis. Press `n`,
    then `Esc` — the field closes and nothing is made; press `n` again and it opens once more. On a
    table or a canvas `n` says that new cards are made on a board.
38. **An axis's own row.** With a card open, press an axis letter twice — `pp`. Focus lands on that
    axis's row in the panel, on its first value. On an axis the card carries nothing for, it says so
    and points at `g⇧F`.


# Facet vocabulary

```yaml
# facets.yaml — one vocabulary, shared by every shape
status:
  label: Status
  values: [planning, active, on-hold, done, archived]  # declared order == column order, everywhere
  open: false                              # new values rejected by the validator
  single: true                             # a second value rejected too
  closed: [done, archived]                 # no further work expected, whatever the outcome
  expected: true                           # the triage axis asks for it
  hue: green                               # which family its chips draw in
  key: s                                   # `s3` sets its third value; `,g s` groups by it
parent:
  label: Part of
  type: ref                                # values are note ids, so it is
  single: true                             # traversable as well as filterable
  inverse: Children                        # what the panel calls the other end
  hue: purple
blocked_by:
  label: blocked by
  type: ref
  blocking: true                           # an unfinished target stops this note
  inverse: Blocks
  hue: red
due:
  type: date                               # compared against today, not matched
  single: true
  buckets: { overdue: {upTo: -1, hue: red}, today: {upTo: 0, hue: yellow}, week: 7 }
  overflow: later
```

A `ref`, `date` or `number` facet declares no `values`: its vocabulary is the vault or the number
line, so `open` is implied and a declared list is dropped rather than half-honoured.

The five keys past `type` are where a facet's *behaviour* is declared. `closed` defines finished, for
the blocked axis and for `pj log`; `blocking` puts an axis on the blocked axis under its own name;
`expected` puts it on the triage axis; `inverse` names the computed row the panel draws beside a
relation; `hue` picks a family from the app's palette. All five are optional — declare none and the
axis is an ordinary one you can filter, group and sort by.

`pj check` rejects a declaration that cannot take effect: an `inverse:` on a facet that is not a
reference, a `hue:` outside the palette, a `closed:` value the vocabulary does not list.

## The built-ins

Three axes are the app's rather than the vault's, and for the same reason: the app writes them and
reads them back, so a vault redefining the shape would strand something with no way to say so. They are still
*facets* — injected into the vocabulary, so the filter rail, the panel, the pickers and drag-and-drop
reach them through the same loop as everything else, and they filter, group and drag exactly like an
axis you declared.

`project` is the older one. Its definition is not read from `facets.yaml` because config inheritance
walks it as a relation, so its shape is fixed.

A vault may declare `project:` to set what is its to set — its label, its hue, whether triage asks for
it, what its other end is called — and `pj check` errors only if the declaration touches the shape:

```yaml
project:
  label: Portfolio      # fine
  expected: true        # fine
  inverse: Owners       # fine — renames the derived row, `Members` by default
  type: label           # error: project is built in and its shape is fixed
```

It is the one relation that brings its own `inverse`. Every other relation gets a derived row only if
the vault names one, because nothing computes an inverse it has no word for — but a vault cannot name
this one's, since the definition is not read from the file. So `Members` is the default rather than an
omission, and renaming it is a vault's business like the label.

`intake` holds one value, `unjudged`. A sweep writes it onto a candidate it materialised; you remove it
when you have judged the note. Presence is the whole meaning, which is why there is no second value —
"judged" is the axis being absent, and storing it as well would be storing something the vault can
already answer.

What it means is stronger than "new": **nothing on an unjudged note has been confirmed by a human.**
Its title, its body and its facets are all a classifier's proposal, so judging it is accepting them —
or fixing what is wrong first and then accepting.

`extends` names the note a candidate wants folding into. A sweep often finds more of something already
tracked rather than something new, and that should not become a second card; so the candidate lands
pointing at the note it belongs to, and accepting it is a **merge** rather than a clearing of `intake`:

```bash
pj merge <candidate> --into <target>
```

The target keeps its own facets; the candidate brings its body, links and fingerprint across, and its
file goes. The reference pointing at the target is dropped on the way, so nothing has to be tidied
first. It is deliberately not `parent`: `parent` means *part of* and is walked, so a candidate parented
to a real note would sit in that note's children and roll-ups while it waited. Nothing walks
`extends`.

It is a facet rather than a flag on the file so that the queue is a *view*: `filter: {intake:
[unjudged]}` is a board like any other, and the panel, the bulk bar, the cursor and `pj ls` all reach
it without any of them being taught what intake is. The other side of that is worth setting up
deliberately — an unjudged candidate is missing every expected facet by construction, so a triage view
wants `filter: {intake: ['(none)']}` or the queue will swamp it:

```yaml
# views/intake.yaml — what a sweep left for you
shape: board
filter: { intake: [unjudged] }
groupBy: [source]

# views/triage.yaml — notes you started and left, and not the queue
filter: { intake: ['(none)'] }
groupBy: [triage]
```

# Theme

[xoria256](https://github.com/neozenith/estilo-xoria256). The app owns the palette — seven hue families
— and the vault chooses which axis takes which, with `hue:`. So a chip's colour says which axis it is
before you read it, a canvas edge is the same colour as its chips by construction, and a vault's own
vocabulary can have a colour rather than being permanently grey. Light and dark follow the system
setting.

---

# Toolchain

Nothing here locks you to the tools it was written with, and CI proves that rather than promising it.

**Either runtime, chosen by the launcher.** The server and the CLI have no build step, so the runtime
is a property of the command you type rather than a setting in the repo. Every script that runs this
repo's own TypeScript spells `node`, because Node is the floor `engines` promises — and `bun run`
prepends a `node` symlink pointing at itself, so the same script runs under Bun. One set of scripts,
three ways in:

```bash
bun run serve                     # Bun
node --run serve                  # Node, no package manager needed
pnpm serve                        # Node, via a package manager
```

`bunfig.toml` is what makes the first line honest. Bun only substitutes itself when asked, and its
default is to do so *only if `node` is absent from `$PATH`* — so with a Node installed, `bun run serve`
would quietly execute under Node. `[run] bun = true` settles it, and is exactly what `--bun` does per
invocation. It also means `bun run build` needs no flag, though `vite`'s `#!/usr/bin/env node` shebang
is the reason the flag exists.

**One script cannot play, and the reason is a rule.** A script that hands the runtime a *file* is
substitutable. A script that hands it a *runtime flag* is not, because the flag belongs to one runtime
only. `test` is `node --test`; substituted, that reads `bun --test`, and Bun's runner is the subcommand
`bun test`, never a flag. They are two different programs:

```bash
bun test                          # under Bun
node --run test                   # under Node
```

Both run the whole suite, CI runs each, and both must pass. Everything else — `serve`, `dev`, `pj`,
`redate`, and the scripts that call a binary rather than a runtime — substitutes cleanly.

**Any package manager, one lockfile.** No native builds, no workspace, no `.npmrc` — `npm`, `pnpm`,
`yarn` and `bun install` all resolve the same tree, and Bun's runtime reads a `node_modules` any of
them produced. The committed lockfile is Bun's, which is what CI installs frozen; every other manager
resolves fresh, which CI also exercises, and their lockfiles are gitignored so two of them can never
disagree about the tree. There is deliberately no `packageManager` field, since that would make
Corepack refuse every manager but one.

`bunfig.toml` asks Bun for pnpm's layout with `[install] linker = "isolated"`: one copy of each package
in a store under `node_modules/.bun`, symlinked into place rather than hoisted flat. That buys strict
resolution — a dependency this repo does not declare stops working by accident instead of silently
inheriting someone else's — and on APFS the store is filled by `clonefile`, so it shares blocks with
Bun's global cache instead of copying. It governs `bun install` only.

Bun starts faster, which is worth something for a CLI you run by hand and nothing for a server that
starts once, and it runs the suite in a fraction of the time. One thing has actually bitten: Bun ships
its own SQLite build, which has trailed Node's, and a version-sensitive `ALTER TABLE … DROP COLUMN` in
the test suite is where that showed up.

**Pins where a pin is the only thing there is.** Dependencies carry `^` ranges because the lockfile
is already the pin: the range says what is acceptable, the lockfile says what you got. A runtime has
no lockfile, so `mise.toml` *is* the pin: it names both runtimes at concrete versions rather than
`latest`, otherwise two people on two days get two of each. It tracks newer than the floor, because CI
tests the floor. Nothing pins a package manager, because no particular one is required.

`bun run deps:check` lists what has moved; `bun run deps:update` writes the new ranges, after which any
install refreshes the lockfile. `@types/node` is deliberately held at the floor rather than the
newest — see `.ncurc.yml` — because types for a Node this repo does not claim to support would let a
26-only API typecheck clean and then fail on the `node 24` job.

---

How it works inside, and the invariants to keep when changing it:
[ARCHITECTURE.md](ARCHITECTURE.md). What is deliberately not being done, and why:
[NEXT.md](NEXT.md).
