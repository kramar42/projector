# cockpit

A personal work-management app. One card database in markdown files, projected as a **board**, a
**mind-map canvas** or a **table** — whichever the current query asks for — with read-only inline views
of Jira issues, GitHub PRs, Claude sessions and local docs.

It is a single-user app that runs on your own machine against a folder of your own files. Two promises
shape everything else: **your markdown files are the source of truth**, and **nothing is ever written
back** to Jira, GitHub, Trello or Slack.

## Running

Node 26 runs the TypeScript directly — no build step for the server or the CLI.

```bash
pnpm install
pnpm build && pnpm serve          # then open http://127.0.0.1:8092

alias ck='node "$PWD/src/cli/ck.ts"'
ck ls --group priority            # the CLI needs nothing running
```

One process, one URL: the server serves the built UI. `pnpm dev:web` alongside `pnpm serve` gives a
hot-reloading UI on 5176 instead. Tests: `node --test test/*.test.ts`

---

# The model

## Facets, not lists

A card does not live in a column. It carries **facets** — `project`, `priority`, `status`, `domain`,
`energy`, `owner`, `waiting_on`, `source`, `tech`, and any others you declare — and **every facet value
is an array**, uniformly, even `priority`. Group by any facet to get columns; group by a multi-valued
one and a card appears in every column it belongs to, by construction.

No facet is structurally privileged, so "group by project" and "group by priority" are the same board
with one control moved rather than two boards to keep in sync. A facet may be **scoped** with
`scope: { under: <id> }` and is then only valid on records beneath that one, so a large project can
bring its own taxonomy without polluting the shared vocabulary.

## Pseudo-facets

Five axes are computed rather than stored, and appear in the filter panel indistinguishable from real
facets:

| | Values | Derived from |
|---|---|---|
| `kind` | `card`, `node` | the `kind` field |
| `type` | `project`, `plain` | presence of a `project:` block |
| `blocked` | `blocked`, `clear` | a `blocks` edge from a record that is not `done` |
| `triage` | `needs-project`, `needs-priority`, `needs-status`, `complete` | absence of those facets |
| `staleness` | `week`, `month`, `older`, `undated` | `updated` against today |

Each is a count, a date comparison or the presence of an edge — never a judgement. `type=project`
*is* the projects view, and `triage` turns the untriaged pile into something you can drag out of.

## Cards and nodes

A canvas and a board sit at different altitudes: most leaves of a mind-map are scoping scaffolding, not
work. So `kind: node` is a thought — title, optional body, edges, no facets required — and `kind: card`
is work, with facets, links and checklists. Same file format, same directory, one field. Brainstorm at
canvas altitude and promote when something becomes real; promotion and demotion are one field flip
from any shape.

Every record carries a mark before its title saying which it is, and a count after it when it contains
others:

| | |
|---|---|
| `·` | a card — work |
| `○` | a node — a thought |
| `▣` | a project — it owns configuration that its members inherit |
| `12` | how many records name this one as their parent |

## Typed edges

| Type | Meaning | Powers |
|---|---|---|
| `parent` | containment / decomposition | the mind-map tree, roll-up progress |
| `blocks` | A must finish before B | the `blocked` axis, "what does finishing this unblock" |
| `relates` | soft association | canvas context, "see also" |
| `member-of` | derived from the `project` facet, never stored | the project hierarchy, transitive roll-up |

`blocks` is the one neither Trello nor Jira gives usefully. Its transitive closure is what "unblocked
now" is built from.

## Projects

Projects **nest**, and a card can belong to several at once. No separate entity is needed for this:
**`project:` is an optional frontmatter block on any record**, and a record carrying it is a project.
It works on nodes as well as cards, so a deliverable can be both tracked work and a container for the
cards implementing it.

```yaml
project:
  key: platform                       # used for workspace directory naming
  repos:
    - { path: ../services,   base: main }
    - { path: ~/code/infra,  base: dev }
  jira: PROJ                          # default project for new jira: links
  branch: "plat/{card}"               # branch template
```

Repos are declared inline by path — no registry to populate first. Relative paths resolve against the
vault.

**Membership is the `project` facet and nothing else.** A card carries `project: [platform, mapping]`,
an ordinary multi-valued facet stored exactly like `priority` — it drags, bulk-edits and groups through
the same code path, and its vocabulary comes from the data, so a project is offerable the moment it
exists.

**Inheritance is what makes "define once" work.** A card's effective config walks its `project` facet
outward — each value's record, then whatever *that* record belongs to. `repos` accumulate as a union
(a nested project needs its parent's plus its own; `repos_replace: true` narrows), `instructions`
concatenate outermost-first so the most specific advice reads last, and everything else takes the
nearest value.

Instructions live in the project record's **body**, under an `## Instructions` heading — which is
exactly where "how we work on this" belongs.

`parent` edges are a separate thing: they mean decomposition and carry no config. A card may have a
project, a parent, both or neither.

---

# The query model

There is one page and one endpoint. The sidebar composes a query, the URL holds it, and any view is
shareable or bookmarkable without being saved first.

```
view = filter × focus × shape × facets
```

That is also the sidebar, top to bottom. No top bar, and only the filter panel scrolls:

```
[ vault ▾ ]                                  ( 152 cards · 7 nodes · 12 projects )
[ saved view ▾ ]  modified · save · revert
──────────────────────────────────────────
[ shape: board ▾ ]   group by [ priority ▾ ]   then by [ — ▾ ]
                     no value [ end ▾ ]
                     sort     [ priority ▾ ] [ ↑ ]
[ facets: project +1 ▾ ]
──────────────────────────────────────────
[ focus ]    record · via · direction · depth
[ filter ]   the facet panel
──────────────────────────────────────────
( 121 shown · 38 filtered out · 6 for context · clear )
[ search ]
```

**The rail does not change when the shape does** — no row appears or disappears. The three controls
only a canvas can honour float over the canvas instead, next to its transient actions:

```
[ edges ▾ ] [ keep context ▾ ] [ drag creates: parent ▾ ] [ + node ] [ Save layout ]
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
focus = { id, via: parent | member-of | blocks, dir: down | up | both, depth: n | ∞ }
```

The difference matters most with nested projects. If `platform` contains `identity`, which contains the
cards doing the work, then `filter: project=platform` finds only what names `platform` directly — while
`focus=platform via=member-of dir=down` finds the whole portfolio. Otherwise you have to tick every
sub-project by hand, and remember again when a new one appears.

It applies to every shape: `via=blocks dir=down` is "what does finishing this unblock", and `dir=up` is
"what is this part of".

## shape and facets

`shape` is `board`, `canvas` or `table` — explicit, never inferred. `facets` is which of them show on a
record: a board and a canvas draw them as chips, a table draws the same list as its columns, so
switching shape never asks the same question twice.

## grouping

`groupBy: [primary, secondary]` gives a board columns and swimlane rows, and a table sections and
sub-sections. Its options are shared, because they describe grouping rather than any one shape:
`uncategorised` places the no-value group, and `sort` orders within a column, a section or a canvas
rank. Every value the facet declares gets a group whether anything is in it or not — an empty column is
somewhere to drag a card to.

`sort: [priority:asc]` ranks by the order declared in `facets.yaml`, not alphabetically — so `now`
comes before `month`.

A canvas does not draw clusters yet, but it keeps the setting, so switching shape and back never loses
it.

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
filter: { kind: [card], status: [planning, active] }
focus: { id: platform, via: parent, dir: down, depth: 2 }
q: keycloak
groupBy: [priority, project]
sort: [priority:asc, updated:desc]
uncategorised: end | start | hide
chips: [project, tech]              # which facets show on a record
edges: { show: [parent, blocks] }  # canvas only
nodes: { platform: {x: 0, y: 0} }  # written by Save layout, not by hand
order: { now: [id, id] }           # written by a drag, not by hand
```

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

**Canvas.** A tree laid out from its roots, plus free positioning once saved. Drag handle-to-handle to
create an edge, `+ node` for cheap capture, double-click to open. The tree follows whichever hierarchy
you have chosen to draw — decomposition (`parent`) or membership (`member-of`).

Filtering a graph means **match plus context**: unmatched ancestors are kept so the tree stays
connected, drawn muted and counted separately, so a filtered graph still reads as a graph.

**Table.** The one thing neither other shape gives: columns of numbers. Its columns are the same facet
list a board draws as chips. A project row adds roll-ups — **direct / total** card counts, blocked,
untriaged, last activity — where total follows the `member-of` chain, so a project with one direct
member and six nested ones reads `1 / 7`.

## Editing

**Structure is edited by gesture; content is edited in the panel.** Facets, `parent` and edges
are written by drag, the bulk bar and canvas handles — the same writes for one card or fifty. Title,
body, links and the `project:` block go through the card panel only. Creating a card inline in a column
is the one exception.

| Where | What |
|---|---|
| Card panel | rename, toggle facets, set parent, add/remove links, edit the body, raw frontmatter, promote/demote, delete |
| Board | drag between columns and within them, `+` to create, ⌘/⇧-click to select, bulk bar |
| Canvas | drag nodes and **Save layout**, handle-to-handle to create an edge, `+ node` |
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

| Kind | Syntax | Source | Needs | TTL |
|---|---|---|---|---|
| `jira` | `jira:PROJ-303` | Jira REST | `COCKPIT_JIRA_URL`, `COCKPIT_JIRA_EMAIL`, `COCKPIT_JIRA_TOKEN` | 15 min |
| `gh:pr` | `gh:pr:ORG/repo#412` | `gh pr view --json` | the `gh` CLI, authenticated | 5 min |
| `gh:branch` | `gh:branch:ORG/repo@ref` | `gh api` | — | 10 min |
| `gh:commit` | `gh:commit:ORG/repo@sha` | `gh api` | — | never |
| `claude` | `claude:<uuid>` | `~/.claude/projects/**` | — | 1 min |
| `doc` | `doc:path.md` | filesystem | — | 30 s |
| `slack` `trello` `cal` `grafana` `url` | — | not fetched — parsed label only | — | — |

Every fetcher is read-only and runs server-side, so credentials stay out of the browser. Failures are
cached too, so a link that cannot resolve says why once instead of retrying on every render.

A `doc:` path is relative to the vault root, or absolute. A `claude:` link takes a session transcript
uuid and resolves to its opening prompt, last activity, turn count, working directory, branch, and the
`claude --resume` command to pick it back up.

```bash
ck enrich --all              # resolve every link on every card and print it
ck enrich <ref> --force
```

---

# Agents

Cards are plain files, so an agent can create and edit them directly with no API and no app running.
Two commands make that reliable:

**`ck context <id>`** assembles everything known about a card in one pass — the project chain, the
inherited repos and instructions, relations, and cached link enrichment — so an agent never
re-derives it from the filesystem.

**`ck work <id>`** prepares a workspace: a `git worktree` per project repo on one branch, a briefing
with the card's full context embedded, and a terminal running a Claude session in it. Reopening is
idempotent, and one repo failing does not stop the others. Workspaces default to `~/Code/wt`,
overridable with `COCKPIT_WORKSPACES`.

The briefing's key step: read the card, the linked issues and every repo's docs — then **stop and ask**
before planning or writing code. Its last step links the session back to the card, so a card
accumulates its own history.

## Skills

`.claude/skills/` ships four skills, invoked as slash commands from a Claude session in this project:

| | |
|---|---|
| `/cockpit` | the model and the `ck` surface — read by the others, and on its own for ad-hoc card work |
| `/capture` | sweep Slack, Jira, Gmail and git into new cards, deduplicated by fingerprint |
| `/triage` | give incomplete cards a project, priority and status |
| `/work` | start work on a card |

`/capture` and `/triage` both **propose and stop**: they present a table and apply nothing until it is
approved. A wrong project assignment hides a card in a column nobody will look in, which is worse than
leaving it blank. Fingerprinting makes a repeated sweep converge instead of refilling the inbox.

---

# Vaults

A **vault** is a folder holding `cards/`, `facets.yaml` and `views/`, opened the way Obsidian opens
one. The app has no built-in location and assumes no directory name: on first run it asks for a folder
and remembers the choice, and the switcher at the top of the sidebar opens or adds others.

Pointing at an empty or non-existent folder sets one up: a card directory, a facet vocabulary, four
starter views, a README of the conventions, and a `.gitignore` for the derived index and cache. A
non-empty folder that is not a vault is refused.

The folders you have opened are listed in `vaults.json` next to the app, and the server will only open
one that is on that list — so a page in your browser cannot point it at an arbitrary directory. It is
the only thing written outside a vault; delete it and you lose the list, nothing else.

```bash
ck vaults                                  # list
ck vaults add <path> [--name n] [--create] # open a folder as a vault
ck vaults forget <path>                    # stop tracking it; the folder is untouched
ck --vault <path> <command>                # act on a specific one
```

The CLI does not need the list at all: run `ck` anywhere inside a vault and it finds it by walking up,
the way git finds a repository. Otherwise `--vault`, then `COCKPIT_DATA`, then the single registered
one.

---

# CLI

| | |
|---|---|
| `ck ls [--view n] [--group f[,f]] [--filter f=v,v] [--sort k:d] [--q text] [--focus id --via v --dir d --depth n] [--nodes]` | list records, through the same query compiler the app uses |
| `ck show <id>` | one record, with its resolved project config |
| `ck next` | open cards with no unfinished blocker |
| `ck add <title> [--kind] [--parent] [--facet f=v] [--link ref] [--fingerprint fp]` | create a record |
| `ck set <id> …` | scripted edits: `--title`, `--facet f=v`, `--add`, `--remove`, `--parent id\|none` |
| `ck link <id> <ref> …` | append links |
| `ck project <id>` | resolved project config and inherited instructions |
| `ck context <id> [--json]` | everything known about a card, assembled |
| `ck untriaged [--json]` | cards missing project/priority/status, with the reason each surfaced |
| `ck work <id> [--dry-run] [--no-open]` | multi-repo worktree workspace, briefing, terminal |
| `ck link-session <id>` | link the live Claude session working in this directory |
| `ck enrich [<ref>…] [--all]` | resolve link enrichment |
| `ck check` | validate every card file |
| `ck reindex` · `ck stats` · `ck search <q>` | rebuild the index · counts · full text |
| `ck import trello <file.json>` · `ck import todo <TODO.md>` | one-time imports |

The CLI and the app share one query compiler, so `ck ls --view unblocked` and opening that view in the
browser mean the same thing.

---

# File format

```
<vault>/
  cards/
    fix-deploy.md                # kind: card
    eventing.md                  # kind: node, may carry a project: block
    assets/fix-deploy/error.png
    README.md                    # the format, written into every new vault
  facets.yaml                    # facet vocabulary, order, scope
  views/
    home.yaml  projects.yaml  …  # flat: a shape is a field, not a folder
  .index.db  .enrich.db          # derived, gitignored
```

## Card

```markdown
---
id: fix-deploy
kind: card
title: Fix the Kpow deployment
facets:
  project: [platform]
  priority: [now]
  status: [active]
edges:
  - { type: parent, to: eventing }
  - { type: blocks, to: conduktor-config }
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

`id`, `kind` and `title` are required; everything else is optional. The `id` is the join key everywhere
and never changes, though the filename may drift from it. Facet values are always arrays, and a facet
the vocabulary does not know is preserved rather than dropped.

Every vault gets its own `cards/README.md` documenting all of this, so the format travels with the data
rather than with the app. `ck check` validates every card and reports every problem at once, rather
than stopping at the first.

## Facet vocabulary

```yaml
# facets.yaml — one vocabulary, shared by every shape
priority:
  label: Priority
  values: [now, month, backlog, someday]   # declared order == column order, everywhere
  open: false                              # new values rejected by the validator
layer:
  scope: { under: platform }               # only valid beneath that record
  values: [infra, services, apps]
project:
  valuesFrom: project-records              # vocabulary from the data, not a list
  open: true
```

# Theme

[xoria256](https://github.com/neozenith/estilo-xoria256), one hue family per facet, so a chip's colour
says which axis it is before you read it — priority orange, status green, project purple, tech blue.
Light and dark follow the system setting.

---

How it works inside, and the invariants to keep when changing it: [ARCHITECTURE.md](ARCHITECTURE.md).
Open items: [TODO.md](TODO.md).
