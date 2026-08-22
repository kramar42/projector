# projector

A personal work-management app. One card database in markdown files, projected as a **board**, a
**mind-map canvas** or a **table** — whichever the current query asks for — with read-only inline views
of Jira issues, GitHub PRs, Claude sessions and local docs.

It is a single-user app that runs on your own machine against a folder of your own files. Two promises
shape everything else: **your markdown files are the source of truth**, and **nothing is ever written
back** to Jira, GitHub, Trello or Slack.

## Running

Node 24+ runs the TypeScript directly — no build step for the server or the CLI. The floor is
`engines` in `package.json`; anything newer is fine.

```bash
pnpm install
pnpm build && pnpm serve          # then open http://127.0.0.1:8092

alias pj='node "$PWD/src/cli/pj.ts"'
pj ls --group priority            # the CLI needs nothing running
```

One process, one URL: the server serves the built UI. `pnpm dev:web` alongside `pnpm serve` gives a
hot-reloading UI on 5176 instead. Tests: `node --test test/*.test.ts`

---

# The model

## Facets, not lists

A card does not live in a column. It carries **facets** — `priority`, `status`, `domain`, `energy`,
`owner`, `waiting_on`, `source`, `tech`, the relations `parent`, `blocks` and `project`, and any others
you declare — and **every facet value is an array**, uniformly. Group by any facet to get columns;
group by a multi-valued one and a card appears in every column it belongs to, by construction.

No facet is structurally privileged. Relations are facets like the rest, so "group by project" and
"group by priority" are the same board with one control moved rather than two boards to keep in sync —
and there is no axis with a top-level frontmatter key, a bespoke button or a column of its own in the
index.

Storage is uniform; the **vocabulary** is where the constraints live. `open: false` refuses a value the
list does not declare, and `single: true` refuses a second value at all — because `status: [planning,
done]` is not a card in two columns, it is a card in no coherent state, and the thing writing most of
these files is an agent (C3). `priority`, `status`, `energy`, `owner`, `parent` and `due` are single;
`project`, `blocks`, `tech`, `domain`, `waiting_on` and `source` are not.

A facet also declares a **type**, which says what its values *are*:

| | | |
|---|---|---|
| `label` | a member of the declared `values` list | sorts in declared order |
| `ref` | a record id in this vault | also traversable — see below |
| `date` | `YYYY-MM-DD` | sorts chronologically |
| `number` | | sorts numerically, not as text |

The file still holds strings and memory still holds `string[]`; the type governs *interpretation*. That
is what makes it cheap — the engine reads a facet in exactly two places.

## Pseudo-facets

Five axes are computed rather than stored, and appear in the filter panel indistinguishable from real
facets:

| | Values | Derived from |
|---|---|---|
| `type` | `project`, `node`, `plain` | a `project:` block · being named as a `parent` |
| `blocked` | `blocked`, `waiting`, `clear` | an unfinished `blocks` edge · a non-empty `waiting_on` |
| `triage` | `needs-project`, `needs-priority`, `needs-status`, `complete` | absence of those facets |
| `linked` | `jira`, `gh:pr`, `doc`, `slack`, `url`, … | which kinds of link a record carries |
| `staleness` | `week`, `month`, `older`, `undated` | `updated` against today |

Each computes over something a facet cannot describe: a `project:` block, the reference graph, an
absence, a record's links, or the app-written `updated` field. Each is a count, a date comparison or the presence of a
reference — never a judgement. `type=project`
*is* the projects view, and `triage` turns the untriaged pile into something you can drag out of. The
three `type` values are exclusive — a project that something is part of stays a `project` — so the
counts always add up.

**Every one of them computes.** Nothing derivable is also storable, which is why there is no
`status: blocked` to disagree with the `blocked` axis and no `status: waiting` to disagree with
`waiting_on` — `status` is lifecycle alone. A record with no `due` has no value on that axis rather
than an `undated` bucket of its own, so "no deadline" is the same `(none)` refinement every other
facet already has.

## Ordered facets present buckets and compare raw

A date has as many values as there are days, so a filter panel listing them is useless and a board
grouped by one gets a column per day. An ordered facet therefore declares its own **buckets**:

```yaml
due:
  type: date
  single: true
  buckets: { overdue: -1, today: 0, week: 7 }   # days from today
  overflow: later
```

Filtering and grouping see `overdue · today · week · later`; sorting and range filters see the date.
The two are lexically distinct in a query — `f.due=overdue` is a bucket, `f.due=>2026-09-01` is a
range — so there is nothing to disambiguate. On a face the chip shows the value and *wears* the bucket,
so a passed deadline reads exactly and still colours itself red.

`due` was a top-level field until facets were typed, because the argument for a field was that a facet
is a string set matched for membership while a date needs comparison. Typing dissolved it. `created`
and `updated` stay fields: a facet is vocabulary you declare, and those are written by the app.

## There is only a record

A canvas and a board sit at different altitudes: most leaves of a mind-map are scaffolding, not work.
There used to be a `kind` saying `card` or `node`, and it turned out to assert two things the record
already showed:

- **Is it work?** Whether it carries a `status`. That is what keeps a grouping record off every
  status-filtered board — `kind: [card]` was doing a job the status filter already did.
- **Does it contain anything?** Whether anything names it as a `parent`. That is the count the glyph
  draws: `▣` a project, `○` something is part of it, `·` neither.

So it is gone (C11). Only `id` and `title` are required, and a record becomes work by acquiring a
lifecycle rather than by being reclassified.

Every record carries a mark before its title saying which it is, and a count after it when it contains
others:

| | |
|---|---|
| `·` | a card — work |
| `○` | a node — a thought |
| `▣` | a project — it owns configuration that its members inherit |
| `12` | how many records name this one as their parent |

## Relations are facets

A facet declared **`type: ref`** holds record ids rather than labels. That one word is the whole
relation model:

| | Meaning | Powers |
|---|---|---|
| `parent` | decomposition — this record is *part of* that one | the mind-map tree, roll-up progress |
| `blocks` | A must finish before B | the `blocked` axis, "what does finishing this unblock" |
| `project` | membership | config inheritance, the portfolio, transitive roll-up |

There is no `edges:` block, because a relation was never a different kind of thing. Being a facet means
a relation **filters, groups a board, reaches `(none)`, bulk-edits and drags** — none of which an edge
could do. Being a reference means it also **lays out a canvas, walks under `focus`, and refuses a
cycle** — everything an edge could do. One mechanism, strictly more capable than either half.

`blocks` is the one neither Trello nor Jira gives usefully. Its transitive closure is what "unblocked
now" is built from. It is the one relation not worth grouping a board by, because the question is
always the inverse — which is what the derived `blocked` axis answers.

There was a fourth, `relates`, for soft association. It is gone: every job it could do is done better
by something already here. "See also" is a link, "these are similar" is a label facet, and a canvas
already keeps connected records visible without one. It is also the one shape a reference facet is bad
at — an association where every value is unique makes a useless column and a noisy filter panel.

## Projects

Projects **nest**, and a card can belong to several at once. No separate entity is needed for this:
**`project:` is an optional frontmatter block on any record**, and a record carrying it is a project.
Any record can carry one, so a deliverable is both tracked work and a container for the cards
implementing it.

```yaml
project:
  repos:
    - { path: ../services,   base: main }
    - { path: ~/code/infra,  base: dev }
  jira: PROJ                          # default project for new jira: links
  branch: "plat/{card}"               # branch template
  instructions: |                     # how work here is done
    - Never change a realm in eu-prod without a ticket and a rollback plan.
```

A project's key is its record **id**. There is no separate `key`: a second name for one thing is a
second thing to keep in step, and it would let a `project` facet value point at something that is not
a record id.

Repos are declared inline by path — no registry to populate first. Relative paths resolve against the
vault.

**Membership is the `project` facet and nothing else.** A card carries `project: [platform, mapping]`,
an ordinary multi-valued facet stored exactly like `priority` — it drags, bulk-edits and groups through
the same code path, and its vocabulary comes from the data, so a project is offerable the moment it
exists.

**Inheritance is what makes "define once" work.** A card's effective config walks its `project` facet
outward — each value's record, then whatever *that* record belongs to. `repos` accumulate as a union
(a nested project needs its parent's plus its own), `instructions` concatenate outermost-first so the
most specific advice reads last, and everything else takes the nearest value.

**Instructions are configuration**, so they live in the block with the rest of it. They were a
`## Instructions` heading in the record's body once, matched by regex — the one place prose was
load-bearing, where renaming a heading silently stopped inheritance with nothing to check against. The
body is free-form again: nothing in it is read by the app.

`parent` is a separate relation: it means decomposition and carries no config. A card may have a
project, a parent, both or neither.

---

# The query model

There is one page and one endpoint. The sidebar composes a query, the URL holds it, and any view is
shareable or bookmarkable without being saved first.

```
view = filter × focus × shape × show
```

That is also the sidebar, top to bottom. No top bar, and only the filter panel scrolls:

```
[ vault ▾ ]                                       ( 191 records · 16 projects )
[ saved view ▾ ]  modified · save · revert
──────────────────────────────────────────
[ shape: board ▾ ]   group by [ priority ▾ ]   then by [ — ▾ ]
                     no value [ end ▾ ]
                     sort     [ priority ▾ ] [ ↑ ]
[ show: project +1 ▾ ]
──────────────────────────────────────────
[ focus ]    record · via · direction · depth
[ filter ]   the facet panel
──────────────────────────────────────────
( 121 shown · 38 filtered out · 6 for context · clear )
[ search ]
```

**The rail does not change when the shape does** — no row appears or disappears. What floats over the
canvas is what only a canvas can do *and* only while one is open:

```
[ drag creates: parent ▾ ] [ + record ] [ Save layout ]
```

The board floats its bulk-selection bar for the same reason: it exists only while a selection does.
The footer always says how many records are shown, how many the filter is hiding and how many are
context, with a one-click *clear* — so a card that is missing is never a mystery.

## filter

Multi-select over every facet and pseudo-facet, plus **`(none)`** for absence — "cards with no project"
is a click, not a search. Values within a facet are ORed; facets are ANDed.

Counts are **disjunctive**: an unselected value tells you how many cards adding it would bring in,
rather than reading 0 — so a selection can always be widened, not just narrowed. Refining one facet
never removes another from the panel, and a facet nothing in view carries is not offered at all.

## focus

A record plus a traversal. **Not a filter**: a facet filter tests membership one level deep over
values, while focus walks *edges*, transitively.

```
focus = { id, via: <any relation>, dir: out | in | both, depth: n | ∞ }
```

The difference matters most with nested projects. If `platform` contains `identity`, which contains the
cards doing the work, then `filter: project=platform` finds only what names `platform` directly — while
`focus=platform via=project dir=in` finds the whole portfolio. Otherwise you have to tick every
sub-project by hand, and remember again when a new one appears.

`dir` is mechanical rather than spatial: **`out`** follows a record's own references and **`in`** finds
the records naming it. `up`/`down` would read correctly only for containment — on `blocks`, "up" means
toward the blocker, which is the same arrow as `parent`'s "down".

It applies to every shape: `via=blocks dir=out` is "what does finishing this unblock", and
`via=parent dir=out` is "what is this part of".

## shape and show

`shape` is `board`, `canvas` or `table` — explicit, never inferred.

`show` is which facets this view surfaces, and there is one list rather than two because how each is
drawn follows from what it is:

| | label facet | reference facet |
|---|---|---|
| board / canvas face | a chip | a chip that opens the target |
| canvas | — | a line between records, and the **first** one lays the graph out |
| table | a column | a column of links |

There used to be `chips` for the first row and `edges.show` for the second, asking the same question
twice — and "why does my canvas draw nothing" was answered by the one you forgot.

## grouping

`groupBy: [primary, secondary]` gives a board columns and swimlane rows, and a table sections and
sub-sections. Its options are shared, because they describe grouping rather than any one shape:
`uncategorised` places the no-value group, and `sort` orders within a column, a section or a canvas
rank. Every value the facet declares gets a group whether anything is in it or not — an empty column is
somewhere to drag a card to.

Grouping by a **reference** facet gives a column per record — one board per parent, or per project.
That works because a hierarchy concentrates: 26 distinct parents across 134 references here, only 7 of
them used once.

`sort: [priority:asc]` ranks by the order declared in `facets.yaml`, not alphabetically — so `now`
comes before `month`.

A canvas draws them as **bands**, stacked in the order the facet declares. A record has one position,
so a card whose grouped facet holds several values is drawn in the *first* group it belongs to — and
the footer says how many that applies to, rather than letting the canvas quietly disagree with the
board. Records kept for context matched no group, so they get a band of their own. An empty declared
value gets no band: an empty board column is somewhere to drag a card *to*, and dragging on a canvas
moves a position without changing any facet.

## search

Full text is another predicate in the same query, live and debounced. The trailing word is matched as a
prefix, so `keyc` finds `keycloak` while you are still typing.

## Saved views

A saved view is a named query in `views/*.yaml`, listed in the sidebar and switchable at any time.
Change a control while one is open and the sidebar says *modified*, with **save** and **revert** — so a
named view stays what you left it. *Save current as…* writes the query you are looking at; saving over
an existing name replaces its query and keeps its arrangement.

**Arrangement only exists in a saved view.** Node positions and manual card order live in the view file,
never on a card — the same card can sit at a different place on each canvas and in a different order in
each column. Cards own identity and content; views own arrangement. So an ad-hoc query is auto-laid-out
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
uncategorised: end | start | hide
show: [parent, project, tech]      # references first: the canvas lays out by the first
nodes: { platform: {x: 0, y: 0} }  # written by Save layout, not by hand
order: { now: [id, id] }           # written by a drag, not by hand
```

`connect` is not a key: keeping unmatched ancestors so a graph stays readable is something only a
canvas ever honoured, so it follows the shape.

---

# The shapes

**Board.** Columns from the primary grouping axis, lanes as rows when a second axis is set. Create a
card inline in a column and it inherits that column's value. ⌘/⇧-click builds a selection for the bulk
bar.

| Gesture | Effect |
|---|---|
| drag `now` → `month` | **replace** — remove `now`, add `month` |
| ⌥ + drop | **add** — the card now appears in both columns |
| ⇧ + drag out | **remove** just that value |
| drop into `(none)` | remove every value of the grouped facet |
| drag within a column | **reorder** — needs a saved view, since order is arrangement |

So "card in two columns" is always a gesture, never an accident.

**Canvas.** A tree laid out from its roots, plus free positioning once saved — and bands when the query
is grouped. Every record draws the same face — how much of a record to show is a property of the view, which is what `show` is, so a card
never changes shape because of a field it happens to carry. Drag handle-to-handle to create an edge,
`+ node` for cheap capture, double-click to open. The tree follows whichever hierarchy
you have chosen to draw first — decomposition (`parent`) or membership (`project`).

Filtering a graph means **match plus context**: unmatched ancestors are kept so the tree stays
connected, drawn muted and counted separately, so a filtered graph still reads as a graph. They are
walked along the relation the canvas is *laid out by*, so a portfolio canvas never pulls in context
from the decomposition tree.

**Table.** The one thing neither other shape gives: columns of numbers. Its columns are the same facet
list a board draws as chips. A project row adds roll-ups — **direct / total** card counts, blocked,
untriaged, last activity — where total follows the `project` chain, so a project with one direct
member and six nested ones reads `1 / 7`.

## Editing

**Structure is edited by gesture; content is edited in the panel.** Facets — relations included — are
written by drag, the bulk bar and canvas handles, the same writes for one card or fifty. Title, body,
links and the `project:` block go through the card panel only. Creating a card inline in a column is
the one exception.

Since a relation is a facet, dragging between columns of a `parent` board re-parents a card through
exactly the code path that changes its priority.

| Where | What |
|---|---|
| Card panel | rename, edit any facet through the control its type picks, add/remove links, edit the body, raw frontmatter, make/unmake a project, delete |
| Board | drag between columns and within them, `+` to create, ⌘/⇧-click to select, bulk bar |
| Canvas | drag records and **Save layout**, handle-to-handle to add a reference, `+ record` |
| Table | click a row to open the panel |

**Bulk actions** make a few hundred cards tractable: ⌘-click a selection, then set a parent, set or
clear one facet, or delete, across all of it.

**Conflicts are refused, not merged.** If a file changed since the panel read it the write is refused
and the panel says so, rather than one of you silently losing an edit — which matters when an agent may
be working on the same card in another window.

---

# Links and enrichment

A link is a typed string on a card, resolved lazily and cached. It renders as its parsed label, and
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
| `gh:branch` | `gh:branch:ORG/repo@ref` | `gh api` | — | 10 min |
| `gh:commit` | `gh:commit:ORG/repo@sha` | `gh api` | — | never |
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
pj enrich --all              # resolve every link on every card and print it
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
pj intake known claude:abc-123          # which cards already carry this
pj intake commit --advance --captured 2 # promote what that sweep recorded
```

**`pj intake` creates no card and moves no cursor.** `pj add`/`pj link` do the first after a human
agrees, and `pj intake commit` does the second once the proposal is resolved. A run that fetched is not
a run that was resolved, and an abandoned sweep must not swallow what it listed.

What a sweep *does* write is where it **would** move each cursor to, alongside how many items it
examined — both `pj`'s own numbers, and both previously carried from one process to the next by hand,
once per channel. `--advance` promotes them. A pending proposal is inert until then, and promoting it
spends it, so a second `--advance` re-commits nothing. `--captured` stays an argument: capture happens
between the sweep and the commit, and nothing attributes a `pj add` back to a channel.

**A watermark is not what makes this correct.** `source_fingerprint` on the cards is — it stops a
duplicate whether or not a cursor knows the item exists. The cursor only decides how far back to look,
so deleting `.intake.db` degrades a sweep to a default window: noisier, never wrong. That is also why
it is its own file rather than a table in `.enrich.db`, which is a cache and is meant to be
throwaway-able.

Channels work **oldest-first from the cursor**, and a run truncated by `--limit` holds its cursor: a
cursor is one value, so it may only advance to a boundary with nothing unexamined behind it.

**What `pj` decides, and what it does not.** It decides only what is decidable — a ref already on a
card, a fingerprint already captured, a session too short to be work. Everything else arrives as
`evidence`, and each match carries the mechanical reason it matched: `cwd`, `worktree`, `branch`,
`mentions PROJ-303`, `text`. There is no score and no verdict, because the failure that would make this
useless is a confident wrong one — a session linked to the wrong card puts its history where nobody will
look. Choosing between card, link and neither is `/pj-capture`'s job, out loud.

Two channels have no fetcher here at all. Slack and Gmail are read by an agent through MCP — a second
token in a second place to rotate buys nothing — but `pj` still keeps their cursors, because a
watermark is a property of where the sweep got to, not of who fetched.

---

# Agents

Cards are plain files, so an agent can create and edit them directly with no API and no app running.
Three commands make that reliable:

**`pj context <id>`** assembles everything known about a card in one pass — the project chain, the
inherited repos and instructions, relations, and cached link enrichment — so an agent never
re-derives it from the filesystem.

**`pj log`** answers "what did I actually do last week", which nothing stored on a card can: `updated`
is one overwritten date and only ever says that *something* changed. The vault is a git repository, so
the answer was already on disk — this reads the two versions of every changed file through the card
parser and reports the transitions. Nothing is written, and no field was added to carry it.

**`pj work <id>`** prepares a workspace: a `git worktree` per project repo on one branch, a briefing
with the card's full context embedded, and a terminal running a Claude session in it. Reopening is
idempotent, and one repo failing does not stop the others. **`PROJECTOR_WORKSPACES` is required** —
worktrees are real directories on disk, so where they go is told, never guessed.

The briefing's key step: read the card, the linked issues and every repo's docs — then **stop and ask**
before planning or writing code. Its last step links the session back to the card, so a card
accumulates its own history.

## Skills

`.claude/skills/` ships four skills, invoked as slash commands from a Claude session in this project:

| | |
|---|---|
| `/projector` | the model and the `pj` surface — read by the others, and on its own for ad-hoc card work |
| `/pj-capture` | sweep the five intake channels; each candidate becomes a card, a link on an existing card, or nothing |
| `/pj-triage` | give incomplete cards a project, priority and status |
| `/pj-work` | start work on a card |

`/pj-capture` and `/pj-triage` both **propose and stop**: they present a table and apply nothing until it is
approved. A wrong project assignment hides a card in a column nobody will look in, which is worse than
leaving it blank. Fingerprinting makes a repeated sweep converge instead of refilling the inbox — which
is why a rejected card gets `status: archived` rather than being deleted: deleting it destroys the
fingerprint with it, and the next sweep creates it again.

`/pj-capture` reads its candidates from `pj intake` rather than deciding what is new itself, and it makes
one decision per candidate that `pj` deliberately does not: **card, link, or neither.** A Claude session
is usually not new work — it is more of something already tracked, or a question that was answered — and
only "already on a card" is a fact. The rest is a judgement, made on evidence it has to quote.

---

# Vaults

A **vault** is a folder holding `cards/`, `facets.yaml` and `views/`, opened the way Obsidian opens
one. The app has no built-in location and assumes no directory name: on first run it asks for a folder
and remembers the choice, and the switcher at the top of the sidebar opens or adds others.

Pointing at an empty or non-existent folder sets one up: a card directory, a facet vocabulary, four
starter views, and a `.gitignore` for the derived index and cache. A non-empty folder that is not a
vault is refused. No prose is written into a vault — the format lives in the `projector` skill.

The folders you have opened are listed in `vaults.json` next to the app, and the server will only open
one that is on that list — so a page in your browser cannot point it at an arbitrary directory. It is
the only thing written outside a vault; delete it and you lose the list, nothing else.

```bash
pj vaults                                  # list
pj vaults add <path> [--name n] [--create] # open a folder as a vault
pj vaults forget <path>                    # stop tracking it; the folder is untouched
pj --vault <path> <command>                # act on a specific one
```

The CLI does not need the list at all: run `pj` anywhere inside a vault and it finds it by walking up,
the way git finds a repository. Otherwise `--vault`, then `PROJECTOR_DATA`, then the single registered
one.

---

# CLI

| | |
|---|---|
| `pj ls [--view n] [--group f[,f]] [--filter f=v,v] [--sort k:d] [--q text] [--focus id --via v --dir out\|in\|both --depth n] [--json]` | list records. `--filter due=>2026-09-01` is a range on any ordered facet. `--json` is the payload the app receives |
| `pj log [--since "1 week ago"]` | what changed, read out of git: status transitions, deadlines, creations |
| `pj add <title> [--id slug] [--parent] [--facet f=v] [--link ref] [--fingerprint fp]` | create a record |
| `pj set <id>… …` | scripted edits, over any number of ids: `--title`, `--facet f=v`, `--add`, `--remove`, `--parent id\|none`, `--set path=yaml` |
| `pj rm <id>…` | delete, dropping every reference pointing at it |
| `pj link <id> <ref> … [--remove] [--session] [--cwd dir]` | add or remove links. `--session` names the live Claude session working here, so it is a way of spelling a ref rather than a command of its own |
| `pj context <id> [--json]` | everything known about a card, assembled |
| `pj work <id> [--dry-run] [--no-open]` | multi-repo worktree workspace, briefing, terminal |
| `pj enrich [<ref>…] [--all]` | resolve link enrichment |
| `pj intake [<channel>…] [--since iso] [--limit n] [--json] [--verbose]` | what has happened elsewhere since each channel's cursor. Writes nothing |
| `pj intake status [--json]` · `pj intake known <ref>…` | each channel's cursor and last run · which cards already carry these refs |
| `pj intake commit --advance [--captured n]` · `pj intake reset [--channel c]` | promote the cursor(s) the last sweep recorded, after the proposal is resolved · forget one. `--channel c --cursor v` still says it by hand |
| `pj check` | validate every card file, and every saved view against the same vocabulary |
| `pj reindex` · `pj search <q>` | rebuild the index and report what it holds · full text, most relevant first |

`pj search` and `pj ls --q` match the same records through the same sanitiser and differ only in order:
search ranks by relevance, which belongs to a result set rather than to any record in it, so it cannot
be a sort key. `pj context` is the only way to read one card — `show` and `project` printed subsets of
what it already assembles.

A saved view's curated card order is applied in the payload, so `pj ls`, a board column and a table
section of the same view agree about it — it used to run only in the browser, and only on a board.

The CLI and the app share one query compiler *and* one payload builder, so `pj ls --view unblocked` and
opening that view in the browser mean the same thing, and `pj ls --json` is what `GET /api/query`
returns. There is no `pj next` or `pj untriaged`: those were two queries hardcoded in TypeScript, and
they are `views/unblocked.yaml` and `views/triage.yaml` now — askable from either surface, and checked
by `pj check` like anything else.

---

# File format

```
<vault>/
  cards/
    fix-deploy.md                # a card
    eventing.md                  # a node, may carry a project: block
    assets/fix-deploy/error.png
  facets.yaml                    # facet vocabulary, order, constraints
  views/
    home.yaml  projects.yaml  …  # flat: a shape is a field, not a folder
  .index.db  .enrich.db          # derived, gitignored
```

## Card

```markdown
---
id: fix-deploy
title: Fix the Kpow deployment
facets:
  priority: [now]
  status: [active]
  due: [2026-09-01]               # a date facet: compared, not matched
  parent: [eventing]              # reference facets: values are record ids
  blocks: [conduktor-config]
  project: [platform]
links:
  - jira:PROJ-303
  - gh:pr:ORG/services#412
  - doc:notes/schema-registry.md
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

The format is documented once, in the `projector` skill — the audience for it is an agent editing files
directly, and an agent already loads that. `pj check` validates every card and reports every problem at
once, rather than stopping at the first.

## Facet vocabulary

```yaml
# facets.yaml — one vocabulary, shared by every shape
priority:
  label: Priority
  values: [now, month, backlog, someday]   # declared order == column order, everywhere
  open: false                              # new values rejected by the validator
  single: true                             # a second value rejected too
parent:
  label: Part of
  type: ref                                # values are record ids, so it is
  single: true                             # traversable as well as filterable
due:
  type: date                               # compared against today, not matched
  single: true
  buckets: { overdue: -1, today: 0, week: 7 }   # what an axis shows
  overflow: later
```

A `ref`, `date` or `number` facet declares no `values`: its vocabulary is the vault or the number
line, so `open` is implied and a declared list is dropped rather than half-honoured.

# Theme

[xoria256](https://github.com/neozenith/estilo-xoria256), one hue family per facet, so a chip's colour
says which axis it is before you read it — priority orange, status green, project purple, tech blue.
Light and dark follow the system setting.

---

How it works inside, and the invariants to keep when changing it: [ARCHITECTURE.md](ARCHITECTURE.md).
What is deliberately not being done, and why: [NEXT.md](NEXT.md).
