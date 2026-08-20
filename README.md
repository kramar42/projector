# cockpit

Personal work-management app for Oleksii Kramarenko. One card database in markdown files, projected as
a **board**, a **mind-map canvas** or a **table** — whichever the current query asks for — enriched
with read-only inline views of Jira, GitHub, Claude sessions and local docs.

## Constraints

| # | Constraint | Consequence |
|---|---|---|
| C1 | Markdown files are the source of truth | Any index is derived and disposable |
| C2 | Everything external is read-only | No write path to Jira/GitHub/Trello/Slack exists in the codebase. **The app is read-only; the session it launches is not** |
| C3 | Must stay agent-editable | An agent creates and edits cards with plain Write/Edit — no API, no app running |
| C4 | Two node classes | `node` (a thought) and `card` (work), with explicit promotion |
| C5 | Every shape is equally first-class | All three are editable, including card *content*, not just arrangement |
| C6 | Free-form card body | Description, links, files, images — no rigid template |
| C7 | No freehand or drawing | Structured canvas only. This is what settles the canvas library |
| C8 | Derived signals are deterministic | The LLM narrates; it never computes a badge, a count or a status |
| C9 | A view is a query, not a place | `view = filter × focus × shape × face`. Everything derivable is a live control; everything hand-curated is a saved-view-only key |
| C10 | Structure is edited by gesture; content is edited in the panel | Facets, `parent` and edges are written by drag, the bulk bar and canvas handles. Title, body, links and the `project:` block only through `?card=` |

## Running

No build step for the server or CLI: Node 26 runs the TypeScript directly.

```bash
pnpm build && pnpm serve
```

Then open http://127.0.0.1:8092 — one process, one URL, the server serves the built UI.

For frontend work, two processes with hot reload:

```bash
pnpm serve      # api on 8092
pnpm dev:web    # ui on 5176, proxies /api
```

Ports 8092 and 5176 are deliberately distinct from other local tools. Tests:

```bash
node --test test/*.test.ts
```

---

# The model

## No lists. Facets.

The single most important decision. Trello's model is single-parent — a card lives in exactly one
list — and every frustration that motivated this app is that constraint leaking:

| Pain | Cause | Dissolves when |
|---|---|---|
| Card wanted in two columns | list = single parent | the grouping field is multi-valued |
| Swapping tags-as-projects ↔ lists-as-priority | one facet is structurally privileged | no facet is privileged |
| "Lists don't always work for me" | one hierarchy, several mental modes | view = filter + groupBy + sort |

So a card carries **facets**: `project`, `priority`, `status`, `domain`, `energy`, `owner`,
`waiting_on`, `source`, `tech`, plus scoped ones like `layer`. **Every facet value is an array**,
uniformly — even `priority`. No single-vs-multi special casing anywhere, and grouping by any facet
works identically. Group by a multi-valued facet and a card appears in several columns *by
construction*: `L3 stuff that depends on L4` is one card with `layer: [layer-2, layer-3]`,
unrepresentable in Trello and trivial here.

**Scoped facets.** `layer` (L2–L6) is the taxonomy of Project A specifically, not a global axis. A facet
definition may carry `scope: { under: <id> }`, and the validator only accepts it on cards inside that
scope. Every large domain can bring its own taxonomy without polluting the others.

## Pseudo-facets

Five axes are **computed** rather than stored, and appear in the filter panel indistinguishable from
real facets. The query compiler knows the difference; the UI does not.

| Pseudo-facet | Values | Derived from |
|---|---|---|
| `kind` | `card`, `node` | the `kind` field |
| `type` | `project`, `plain` | presence of a `project:` block |
| `blocked` | `blocked`, `clear` | a `blocks` edge from a record whose status is not `done` |
| `triage` | `needs-project`, `needs-priority`, `needs-status`, `complete` | absence of those facets |
| `staleness` | `week`, `month`, `older`, `undated` | `updated` against today |

Each is a count, a date comparison or the presence of an edge — never a judgement (C8). `type=project`
*is* the projects view; `blocked=clear` is what a hand-written "unblocked" filter used to be; `triage`
is the untriaged pile as a view you can drag out of.

## Two node classes

The mind-map and the board sit at different altitudes. In the original mind-map, `Project A → L3 → Eventing
→ AsyncAPI`, most leaves are scoping scaffolding, not actionable work — if every leaf became a card the
board would fill with sixty items of noise.

- **`kind: node`** — a thought. Title, optional body, edges. No facets required. Filtered off boards
  by the default `kind: [card]` selection rather than by a rule.
- **`kind: card`** — work. Facets, links, checklists.
- **Promotion** is one field flip, from any shape. Demotion works too.

Same file format, same directory, one discriminator. Brainstorm at canvas altitude; promote when
something becomes real.

## Edges are typed

| Type | Meaning | Powers |
|---|---|---|
| `parent` | containment / decomposition | the mind-map tree, roll-up progress |
| `blocks` | A must finish before B | the `blocked` pseudo-facet, "what does finishing this unblock" |
| `relates` | soft association | canvas context, "see also" |
| `member-of` | **derived** from the `project` facet, never stored | the project hierarchy graph, transitive roll-up |

`blocks` is the highest-value edge and the thing neither Trello nor Jira gives usefully; its transitive
closure is a recursive CTE.

`member-of` exists because membership *is* the facet: `resolveProject` reads the facet and nothing
else, so drawing the project hierarchy from `parent` edges would show a picture that inheritance does
not follow. Deriving it means nothing has to be stored twice. It is off by default in `edges.show`, so
the redundant second line on a project record that carries both is not drawn.

## Project records

Projects **nest**: Project A is a project, L3–Platform inside it is a project, Keycloak inside that is a
project, and automatic realm provisioning inside *that* is a smaller project spanning several cards.
A single card can belong to several at once.

No third entity is needed. **`project:` is an optional frontmatter block on any record.** A record
carrying it is a project. It works on cards as well as nodes — which is the realm-provisioning case
exactly: a deliverable that belongs on a board with a status *and* contains the cards implementing it.
`kind` stays orthogonal.

```yaml
project:
  key: keycloak                     # used for workspace directory naming
  repos:
    - { path: ~/Code/work/staging,           base: main }
    - { path: ~/Code/work/acme-platform, base: dev }
  jira: PROJ                        # default project for new jira: links
  branch: "kc/{card}"               # branch template
```

Repos are declared inline by path, with no registry to populate first. Relative paths resolve against
the vault; `~` and absolute paths work as-is. The worktree subfolder name is the path basename.

**Membership is the `project` facet, and nothing else.** A card carries `project: [project-d, mapping]` —
an ordinary multi-valued facet, stored and written exactly like `priority`. An earlier design derived
membership from the parent chain; that was wrong twice over: it made `project` a facet that could not
be written, so the concept needed special-casing in sixteen files, and it capped a card at one project
while the real data holds cards spanning three.

**Inheritance is what makes "define once" work.** A card's effective config walks its `project` facet
outward — each value's record, then whatever *that* record belongs to — merging every block found:

| Key | Merge rule | Why |
|---|---|---|
| `repos` | **union**, deduped by resolved path | Keycloak work needs `acme-platform` from Project B *plus* its own `infra`. `repos_replace: true` narrows when wanted |
| `instructions` | **concatenate, outermost first** | The most specific advice reads last |
| everything else | nearest wins | `key`, `jira`, `branch` |

Instructions live in the project record's **body**, under an `## Instructions` heading, so the rest of
the body stays ordinary notes. No separate file: the record is already free-form markdown (C6), and a
project's body is exactly where "how we work on Keycloak" belongs.

**No facet is special.** Because `project` is stored like any other, grouping, drag-and-drop, bulk
actions and the facet editor need no knowledge of it — the same code path serves `priority` and
`project`. Its vocabulary comes from the data (`valuesFrom: project-records`), so a project is
offerable the moment it exists.

`layer` does **not** become redundant now that L2–L6 are projects. The project facet says what a card
belongs to and inherits; `layer` cuts across that.

## Arrangement belongs to views, not cards

Positions must live in the **view**, for the same reason lists don't live in the card. A card can
appear on several canvases at a different position and size in each. Putting `x/y` on the card
re-introduces the single-parent constraint through the back door and churns card files on every pan.
The same goes for **manual card order within a board column**.

Cards own *identity and content*. Views own *arrangement*.

The consequence, and it is load-bearing: an ad-hoc query has no file, so it is auto-laid-out and
auto-ordered. **Naming a view is what buys you manual arrangement.** *Save layout* on an unsaved
canvas asks for a name, writes the file, and redirects to it.

## Links are read-only references

A link is a typed string, resolved lazily and cached. Never a copy of the remote object, never
writable. See [Enrichment](#enrichment).

---

# File format

A **vault** is a folder holding `cards/`, `facets.yaml` and `views/`.

```
<vault>/
  cards/
    project-a-kpow-fix.md              # kind: card
    project-a-eventing.md              # kind: node, may carry a project: block
    assets/project-a-kpow-fix/kpow-glue-error.png
    README.md                    # conventions, for agents and humans
  facets.yaml                    # facet vocabulary, order, scope
  views/
    home.yaml  projects.yaml  project-a.yaml  …   # flat: a shape is a field, not a folder
  .index.db  .enrich.db          # derived, gitignored
```

## Card file

```markdown
---
id: project-a-kpow-fix
kind: card
title: Fix Kpow deployment
facets:
  layer:    [layer-1, layer-2]
  project:  [project-a]
  priority: [now]
  status:   [active]
  domain:   [eventing]
  energy:   [deep]
edges:
  - { type: parent, to: project-a-eventing }
  - { type: blocks, to: project-a-conduktor-config }
links:
  - jira:PROJ-303
  - gh:pr:Acme/staging#412
  - gh:branch:Acme/staging@feat/kpow-glue
  - claude:9e09a116-6b70-4c4a-8d9e-c2a61e52f4c4
  - doc:keycloak-consolidation-plan.md
created: 2026-08-19
updated: 2026-08-19
---

Verify Glue SR is exposed as a Confluent-compatible endpoint before anything else — most
tools advertise Confluent SR support but Glue behaves differently.

- [x] Deploy kpow to eu-dev/project-a
- [ ] Drop the `KAFKA_` prefix from env vars

![Glue SR error](assets/project-a-kpow-fix/kpow-glue-error.png)
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | slug | yes | Stable and immutable. The filename may drift from it; `id` is the join key everywhere |
| `kind` | `card` \| `node` | yes | The only structural discriminator |
| `title` | string | yes | Rendered in every shape |
| `facets` | map of string→array | no | All values arrays. Unknown facets are preserved, not dropped |
| `edges` | array of `{type,to}` | no | `to` is an `id`. A dangling target is a warning, not an error |
| `links` | array of typed strings | no | Syntax per kind under [Enrichment](#enrichment) |
| `project` | block | no | Makes this record a project |
| `source_fingerprint` | string | no | Written by importers and `/capture` so a re-sweep converges |
| `created`/`updated` | date | auto | `updated` on every app save; agents may omit |

Everything below the frontmatter is **free-form markdown** (C6). No recognised sections, no required
structure. Checklists are ordinary task lists — the app counts them for the progress bar and never
rewrites them.

A node is the same format, minimal:

```markdown
---
id: project-a-eventing
kind: node
title: Eventing
edges:
  - { type: parent, to: project-a }
---
```

## Facet vocabulary

```yaml
# facets.yaml
priority:
  label: Priority
  values: [now, month, backlog, someday]   # declared order == column order, everywhere
  open: false                              # new values rejected by the validator
status:
  label: Status
  values: [planning, active, waiting, blocked, frozen, done]
  open: false
layer:                                     # scoped: Project A taxonomy, not a global axis
  label: Layer
  scope: { under: project-a }
  values: [layer-1, layer-2, layer-3, layer-4, layer-5]
  open: false
project:
  label: Project
  values: []
  open: true
  valuesFrom: project-records               # offerable the moment a project exists
```

Column order comes from here, not from a view file — that is what list-order does in Trello, made
explicit and shared by every shape. `open:` per facet decides whether the validator accepts new
values: projects yes, priority no. `sort: [priority:asc]` ranks by *this* order, not alphabetically.

## Saved view

One schema for all three shapes.

```yaml
shape: board | canvas | table      # explicit, never inferred
title: Home
filter:                            # facets and pseudo-facets; `(none)` allowed
  kind: [card]
  status: [planning, active, waiting, blocked]
focus: { id: project-a, via: parent, dir: down, depth: 2 }
q: keycloak                        # full text
groupBy: [priority, project]       # primary, then secondary
sort: [priority:asc, updated:desc]
uncategorised: end | start | hide  # where the no-value group goes
showEmpty: true                    # keep a declared group nothing is in
face:
  size: chip | card
  chips: [project, tech]           # chips on a face; the same list is a table's columns
edges: { show: [parent, blocks] }  # canvas
nodes: { project-a: {x: 0, y: 0} }       # canvas — written by Save layout, never by hand
order: { now: [id, id] }           # board — written by a drag, never by hand
```

`nodes` and `order` are arrangement, so they exist only in a saved view (C9). Everything else is a
live control in the sidebar.

---

# The query model

A view is a **query**. There is one page, one endpoint (`/api/query`), and the query lives in the URL,
so any view is shareable and back-buttonable without being saved first.

```
view = filter × focus × shape × face
```

## filter

Multi-select over every facet and pseudo-facet, plus `(none)` for absence — 77 of 159 cards carry no
project, and reaching them is the most useful thing in the panel. Values within a facet are ORed;
facets are ANDed.

Two properties do the real work, and conflating them makes the panel a trapdoor:

- **Which facets are offered** is decided by the *universe* — what focus and search left. A facet
  selection never removes another axis, or narrowing hard sheds the panel down to the one axis you
  already used with no way to look sideways. (Amazon does not hide Price because you picked a Brand.)
  A facet with no real value anywhere in the universe is dropped, which is what keeps `layer` — absent
  from 157 of 159 cards — out of the way without a UI rule for `scope:`.
- **What each value counts** lifts that facet's own selection and applies every other one, so an
  unselected value says what adding it would bring. Counted against the fully filtered set instead,
  every unselected value reads 0 and a selection can be narrowed but never widened.

Values the universe holds stay listed at zero. A *selected* value always stays listed, or it could
never be unselected.

## focus

A record plus a traversal. **Not a filter**: a facet filter tests membership one level deep over
values, while focus walks *edges*, transitively.

```
focus = { id, via: parent | member-of | blocks, dir: down | up | both, depth: n | ∞ }
```

Measured on the real vault, which is why both mechanisms exist:

| Selection | Records |
|---|---|
| `filter: project=project-a` | 15 |
| `focus=project-a via=parent dir=down` | 30 — `project-a` itself plus the whole `project-d` subtree |
| overlap | 14 |
| `filter: project=project-b` | 1 — project-b's work lives one level down |
| `focus=project-b via=member-of dir=down` | 8 — `project-b`, `keycloak`, and keycloak's six members |

45 of 159 records have no `parent` edge at all, so focus alone misses a third of the database.

It earns its place in every shape, not just the canvas. "Everything in the Project B portfolio, grouped by
priority" is a board question that no facet checkbox can express — you would have to know to also tick
`keycloak`, and to remember again when a third level appears. `via=blocks dir=down` is "what does
finishing this unblock", which wants a list. `dir=up` is "what is this part of". The projects table's
`1 / 7` column is the same traversal.

`dir=both` is the union of two separate walks, not one walk over both directions — the latter drags in
every sibling's subtree and stops being a focus.

**Clearing it needs a sentinel.** The server merges a saved view's parameters *under* the URL's, so an
absent `focus` means "inherit" and the saved one comes straight back. `focus=` means "explicitly
none" — the same mechanism `f.status=` uses to override a saved default selection.

## shape

`board`, `canvas` or `table`. Explicit, never inferred from whether a grouping is set.

## face

`chip` or `card`, and which facets are visible. A board and a canvas draw those as chips; a table draws
the same list as its columns — one parameter, so switching shape never asks the same question twice.

Records render from **one** `<CardBody>` shared by every shape, which is the reason React Flow was
chosen: a canvas node is an ordinary React component, so link chips and progress bars work there with
no second implementation. There is no third `expanded` size — `?card=` and the panel are that, with the
real editors and a deep link.

## Grouping is generic

`groupBy: [primary, secondary]` gives a board columns and swimlane rows, a table sections and
sub-sections, and (not yet) a canvas nested clusters. Most of what looks like board configuration is
really *grouping* configuration, so it is defined once:

| Option | board | canvas | table |
|---|---|---|---|
| `groupBy[0]` | columns | clusters *(not yet)* | section headers |
| `groupBy[1]` | swimlane rows | nested clusters *(not yet)* | sub-sections |
| `showEmpty`, `uncategorised` | ✓ | ✓ | ✓ |
| `sort` | order within a column | seeds dagre's within-rank order | row order |
| `face.size`, `face.chips` | card face | node face | row density, **columns** |

Two keys therefore do not exist: **`swimlanes`** is `groupBy[1]`, so a matrix falls out of calling the
axis function twice; and **`columns`** is `face.chips`.

**The one lossy switch.** Grouping by a multi-valued facet puts a card in several groups — on a board
that is several columns. A canvas node has *one position*, so it cannot be in two clusters.
Duplicating the node breaks identity and edges; hulls are not a React Flow primitive. So canvas
clustering lands last, and until then `groupBy` is accepted and ignored on a canvas, so switching
shapes never silently drops the parameter.

## Full text

Just another predicate: `q` compiles to an FTS5 match ANDed with everything else. Live and debounced.
The trailing token is matched as a prefix, because a search box is typed one letter at a time and
`keyc` should find `keycloak`; every FTS5 operator character is stripped rather than passed through, so
a query mid-keystroke cannot throw. Punctuation alone is treated as no query rather than an error.

---

# The sidebar is the view

No top bar. Everything a header would carry has a better home: the counts sit in the footer next to
the filter that produced them, and anything shape-local floats over the content.

> **Shape-invariant controls live in the sidebar; anything shape-local floats over the content.**
> A control that appears and vanishes mid-rail makes the sidebar jump — whether it vanishes because of
> state or because of the shape.

```
[ vault ▾ ]                          ← portalled, never clipped
( 152 cards · 7 nodes · 12 projects )
[ saved view ▾ ]  modified · save · revert
─────────────────────────────────────  presentation
[ shape: board ▾ ]
    group by  [ priority ▾ ]   then by [ — ▾ ]
    no value  [ end ▾ ]        [ ] show empty groups
    sort      [ priority ▾ ] [ ↑ ]
[ face: card ▾ ]  [ chips: project +1 ▾ ]
─────────────────────────────────────  what is in scope
[ focus ]   record · via · direction · depth
[ filter ]  the facet panel            ← the only scrolling region
─────────────────────────────────────
( 121 shown · 38 filtered out · 6 for context · clear )
[ search ]
```

**The rail does not change when the shape does.** Not one row appears or disappears. The controls only
a canvas can honour live in the canvas's own floating bar, alongside its transient actions:

```
[ edges ▾ ] [ keep context ▾ ] [ drag creates: parent ▾ ] [ + node ] [ Save layout ]
```

The board floats its bulk-selection bar for the same reason: it exists only while a selection does.

**Popovers are portalled** to `document.body` with fixed positioning from the trigger's rect. The rail
establishes its own overflow context, so a panel positioned inside it gets clipped at the rail's edge.
One primitive, four uses: vault, saved views, face chips, focus picker.

Always visible, because the worst failure mode of global filtering is **"the card isn't there and I
don't know why"**: how many are shown, how many the filter is hiding, how many are context, and a
one-click *clear*. The hidden count is exact — the server reports the size of the universe (what focus
and search left, before the facet filter) rather than the client inferring it from the histogram.

**Saved views are not optional.** Once shape, face and filter are all live, opening a saved view and
changing one control leaves you somewhere ambiguous. The name plus *modified · save · revert* is what
keeps a named view trustworthy.

Query state lives in the URL, consistent with `?card=`:

```
/?view=home&shape=board&group=priority,project&f.project=project-a,(none)&q=keycloak&card=fix-kpow
```

`(none)` travels as itself so a facet that one day has a literal value `none` cannot collide with the
absence refinement. On load with no parameters the `home` view is opened and the URL is **rewritten**,
so the URL is always authoritative and "explicitly no filter" stays representable.

---

# The shapes

## Board

Columns from the primary grouping axis; with a second axis, lanes as rows and the board becomes a
matrix. Create a card inline in a column (it inherits that column's value), ⌘/⇧-click to build a
selection, bulk bar for the selection.

**Drag semantics on a multi-valued facet:**

| Gesture | Effect |
|---|---|
| drag `now` → `month` | **replace**: remove `now`, add `month` (matches Trello muscle memory) |
| ⌥ + drop | **add**: the card now appears in both columns |
| ⇧ + drag out | **remove** just that value |
| drop into `(none)` | remove every value of the grouped facet |
| drag within a column | **reorder** — needs a saved view, since order is arrangement |

So "card in two columns" is always a gesture, never an accident. The rules are unit-tested.

Stored order pins its cards to the top and leaves the rest in the query's sort order, so ordering three
cards out of sixty does not scatter the other fifty-seven, and a card that appears later lands at the
end rather than vanishing from a list that did not mention it.

## Canvas

A dagre tree, plus free positioning once saved. Drag handle-to-handle to create an edge of the
currently selected type; `+ node` for cheap capture; double-click to open.

**Layout follows the hierarchy edges that are shown**, not `parent` alone. `parent` is decomposition
and `member-of` is membership — either can lay a graph out, while `blocks` and `relates` are drawn but
never fed to dagre, since an edge pointing sideways across the tree distorts every rank it crosses.

**One edge per pair of records**, whatever the types. `parent` and `member-of` agreeing is the expected
shape for a project record, so drawing both put two identical lines on top of each other with no way to
tell there were two. Collapsed, a pair that agrees reads as one relationship and a pair that
*disagrees* still shows as two edges pointing at different records — which is the case worth seeing.
Every edge carries an arrowhead in its own colour; only `blocks` gets text, and the label is neutral,
because an edge label inherits the stroke as its fill and a red word floating over a graph reads as an
error.

**Filtering a graph means match + context.** A board filter is the set; dropping a parent from a canvas
turns the tree into scattered orphans. So unmatched ancestors are kept, drawn muted and
non-interactive, and reported separately — "121 shown · 6 for context". A filter that quietly widens
its own result set is a filter you stop trusting.

## Table

The one thing neither other shape gives: columns of numbers. Read-only like every shape — a row click
opens `?card=` and the panel does the editing (C10).

For a project row it adds roll-ups: **direct / total** card counts, blocked, untriaged, last activity,
and which project it is itself a member of. Both counts are reported because the difference answers a
real question — `project-b` has one direct member and seven transitive ones, so a single number would either
hide its portfolio or overstate its workload. Transitive is the `member-of` walk, the same traversal
the focus control uses, not a second notion of hierarchy.

---

# Editing

**Structure is edited by gesture; content is edited in the panel** (C10). Facets, `parent` and edges
are written by drag, the bulk bar and canvas handles — the same writes for one card or fifty. Title,
body, links and the `project:` block go through `?card=` only. Inline create in a column is the sole
carve-out: creating is not editing.

| Where | What |
|---|---|
| Card panel | rename, toggle facet values, set parent, add/remove links, edit the body, raw frontmatter, promote/demote, delete |
| Board | drag between columns and within them, `+` to create, ⌘/⇧-click to select, bulk bar |
| Canvas | drag nodes and **Save layout**, handle-to-handle to create an edge, `+ node`, double-click to open |
| Table | click a row to open the panel |

**Bulk actions** are what make ~130 imported cards tractable: select with ⌘-click, then set a parent,
set or clear one facet, or delete, across the whole selection. The facet list offered comes from the
query's own histogram, so it names the axes actually present on screen.

**Conflicts are refused, not merged.** A card read into the panel carries its file mtime; a write sends
it back, and if the file changed meanwhile the server answers 409 and the panel shows a *changed on
disk* banner. Nothing is overwritten. The body editor likewise refuses to swallow an external change
while there is unsaved text.

**Saving arrangement merges, never replaces.** The client sends only the nodes it currently renders,
and that is a filtered subset — replacing would silently discard the position of everything the filter
happened to hide. An entry is dropped only when its card is actually gone.

**Saving a view keeps its arrangement.** *Save current as…* over an existing name replaces the query
wholesale and leaves `nodes` and `order` alone, so refining a saved view's filter does not cost you its
layout.

---

# Enrichment

Strictly additive. A link renders as its parsed label, and enrichment replaces that with something
richer *if and when* it arrives. No view waits on it, no endpoint that serves cards knows it exists,
and deleting `src/enrich/` would leave the app behaving as it did before enrichment existed.

| Kind | Link syntax | Source | Needs | TTL |
|---|---|---|---|---|
| `jira` | `jira:PROJ-303` | Jira REST | `COCKPIT_JIRA_URL`, `COCKPIT_JIRA_EMAIL`, `COCKPIT_JIRA_TOKEN` | 15 min |
| `gh:pr` | `gh:pr:ORG/repo#412` | `gh pr view --json` | the `gh` CLI, authenticated | 5 min |
| `gh:branch` | `gh:branch:ORG/repo@ref` | `gh api` | — | 10 min |
| `gh:commit` | `gh:commit:ORG/repo@sha` | `gh api` | — | never (a commit does not change) |
| `claude` | `claude:<uuid>` | `~/.claude/projects/**` | — | 1 min |
| `doc` | `doc:path.md` | filesystem | — | 30 s |
| `slack` `trello` `cal` `grafana` `url` | — | not fetched — parsed label only | — | — |

Every fetcher is server-side and read-only. Credentials stay in the Node process; the browser only ever
receives cached JSON. Read-only is enforced structurally: fetcher modules export no mutation
functions, so there is no code path to write back (C2).

A `doc:` path is **relative to the vault root**, or absolute (`/…`, `~/…`). A document outside the
vault is reached with `../` — and since relative means relative to the *vault*, those refs travel with
it rather than following it. When one misses, the error names the path it tried.

A Claude session link takes the **transcript uuid** — the filename under `~/.claude/projects/<slug>/`.
Enrichment gives its opening prompt, whether a process is currently holding it, last activity, turn
count, cwd, git branch, and the `claude --resume <uuid>` command. An id of the form `local_<uuid>`
comes from the desktop app's own store, is not on disk, and says so rather than failing silently.

**Reads never block.** `POST /api/enrich` answers from cache immediately — possibly with nothing — then
fetches what is missing in the background and emits an `enriched` server event, deliberately separate
from `change` so a chip resolving never makes a board rebuild itself. Failures are cached too, so a ref
that cannot resolve says why once instead of being retried on every render.

The cache is its own SQLite file, `.enrich.db`, not a table in the index: the index is derived from the
card files and rebuilt whenever they change, which would throw away network data.

```bash
ck enrich --all              # resolve every link on every card and print it
ck enrich <ref> --force
```

**Enrichment is deliberately outside the query.** Filtering on "has an open PR" would be tempting and
would break this boundary: the cache is non-blocking and may be empty, so the result would depend on
what happened to be fetched.

---

# The agent layer

Cards are plain files, so an agent can always edit them directly (C3). What this layer adds is the
context to do it well and the discipline to do it safely.

**`ck context <id>`** is the entry point for anything about a card: it resolves the project chain, the
inherited repos and instructions, relations, and the cached link enrichment in one pass, so an agent
never re-derives them from the filesystem.

**`ck work <id>`** prepares a workspace: one directory outside every repo, a `git worktree` per project
repo on a single branch, `AGENT_BRIEFING.md` with the full context embedded, and a Terminal running
`claude "Read AGENT_BRIEFING.md and follow it exactly."` Five behaviours worth knowing, each adapted
from an earlier tool where they were bugs already paid for:

- `git worktree prune` runs unconditionally, so a hand-deleted workspace can be reopened
- an existing branch is reused and an existing folder skipped — reopening is idempotent
- **one repo failing does not stop the others**; the briefing lists the failures as out of scope
- base branch: declared → `origin/HEAD` → `HEAD`
- AppleScript quoting is applied on top of shell quoting, because a path may contain a quote

The briefing's step 4 is the point of it: read the card, the linked issues and every repo's docs — then
**stop and ask** before planning or writing code. Its last step is `ck link-session <id>`, so the card
accumulates its own history rather than depending on someone pasting an id.

Workspaces default to `~/Code/wt`, overridable with `COCKPIT_WORKSPACES`.

**The LLM narrates; it never decides** (C8). Every badge, count and derived signal is computed by the
query engine. An agent summarises what it reads and proposes changes; it does not invent a status.

## Skills

In `work/.claude/skills/`, invoked as slash commands:

| | |
|---|---|
| `/cockpit` | the model and the `ck` surface — read by the others, and on its own for ad-hoc card work |
| `/capture` | sweep Slack, Jira, Gmail and git into new cards, deduplicated by `source_fingerprint` |
| `/triage` | give incomplete cards a project, priority and status |
| `/work` | start work on a card |

`/capture` and `/triage` both **propose and stop**. They present a table and apply nothing until it is
approved — a wrong project assignment hides a card in a column its owner will not look in, which is
worse than leaving it blank. `--fingerprint` on `ck add` makes a sweep converge instead of refilling
the inbox, so `/capture` is safe to run daily.

---

# Vaults

A vault is opened the way Obsidian opens one. The app has no built-in location and assumes no
directory name: on first run it asks for a folder, remembers the choice in `localStorage`, and the
switcher at the top of the sidebar opens or adds others.

Known vaults live in `~/.cockpit/vaults.json`. The browser names its vault with an `X-Cockpit-Vault`
header on every request, and the server refuses one it has not been asked to open — so this is a
reference to a folder the user chose, not an arbitrary path the page can name. A request naming no
usable vault gets **428**, which is how the UI knows to show the picker rather than an error.

Pointing at an empty or non-existent folder sets one up: `cards/`, `facets.yaml`, four saved views (a
home board, a projects table, unblocked, and an everything canvas), a `README.md` of the conventions,
and a `.gitignore` for the derived index and cache. Pointing at a non-empty folder that is not a vault
is refused.

For the CLI: `--vault <path>`, else `COCKPIT_DATA`, else the single registered vault if there is
exactly one. With several registered and no choice made it lists them and asks.

```bash
ck vaults                                  # list
ck vaults add <path> [--name n] [--create] # open a folder as a vault
ck vaults forget <path>                    # stop tracking it; the folder is untouched
ck --vault <path> <command>                # act on a specific one
```

In this workspace the app lives in `cockpit/` and the vault in `cockpit/data/`, each its own git repo,
the vault ignored by the app's. Nothing depends on that arrangement.

---

# CLI

```bash
alias ck='node /Users/you/Code/work/cockpit/src/cli/ck.ts'
```

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
| `ck work <id> [--dry-run] [--no-open]` | multi-repo worktree workspace + briefing + a Terminal |
| `ck link-session <id>` | link the live Claude session working in this directory |
| `ck enrich [<ref>…] [--all]` | resolve link enrichment |
| `ck check` | validate every card file |
| `ck reindex` / `ck stats` / `ck search <q>` | rebuild the index; counts; full text |
| `ck import trello <file.json>` / `ck import todo <TODO.md>` | one-time imports |

The CLI has had `--filter` and `--group` since the first version; the web app is what caught up.
Sharing one compiler is what keeps them from drifting, and it means a saved view is a name both a
human and an agent can say.

---

# Architecture

```
cards/*.md, facets.yaml, views/**        ← source of truth. Git-tracked, agent-editable
        │
        ▼
   readAll → validate → node:sqlite index (.index.db)
        │                    derived and disposable; ck reindex is always correct
        ▼
   hono: /api/meta  /api/query  /api/card/:id  /api/view/:name
        │                    re-read whenever a file changes, gated on an exact stamp
        ▼
   React: the sidebar composes the query │ board │ canvas │ table │ card panel
```

The index is never authoritative. Nothing in it survives a `reindex`, and nothing needs to.

**Filtering runs in memory** over the record map rather than in SQL. Not a performance trade — at this
scale both are free — it is what lets a pseudo-facet be indistinguishable from a real one. In SQL,
`blocked` and `triage` would each need their own expression in the filter, the grouping *and* the
histogram; in JS they need one function and the rest of the engine cannot tell them apart. SQLite keeps
the two jobs it is genuinely better at: full text, and the recursive `blocks` closure.

**The index is memoised on an exact stamp** of every file `load` reads — each mtime, plus how many
files there are. Rebuilding costs ~37ms at 159 cards; checking the stamp costs ~0.5ms. Before P5 the
index was rebuilt on every request, which was right while a request meant a click; a live search box
makes that several rebuilds a second. The stamp is not a TTL or a heuristic, so C1 is intact: if any of
those bytes could have changed, the answer is rebuilt. Mutating routes additionally invalidate
directly, so our own writes never depend on mtime resolution being finer than a burst of them.

## Libraries

The decisions that still bind:

- **`@xyflow/react`** for the canvas. The requirement that settles it: a node must contain arbitrary
  React, because a card face renders live Jira/PR/session chips. `tldraw` needs a commercial licence
  and is shape-model-first; `excalidraw` is sketch-first; `cytoscape` and `konva` cannot host a React
  editor inside a node. C7 makes the "but no freehand" trade-off a non-issue.
- **`@dagrejs/dagre`** for auto-layout. `rankdir: LR` reproduces the original mind-map directly.
- **`@atlaskit/pragmatic-drag-and-drop`** for the board. What Trello and Jira themselves run on, under
  5KB, built on native drag events so React 19 StrictMode is a non-issue. `dnd-kit`'s stable core has
  been unpublished-since-2024; `react-beautiful-dnd` is deprecated.
- **CodeMirror 6** for the body, and the reasoning matters more than the library. A ProseMirror-based
  WYSIWYG round-trips content through a document model and *re-serialises* markdown on save. Under
  C1+C3 that is actively harmful: it silently reformats agent-authored files, churns git diffs, and can
  drop constructs it does not model. CodeMirror edits the text itself.
- **`yaml`** for writes. Its Document API patches surgically, preserving comments, key order and
  formatting. `gray-matter` re-serialises the whole block.
- **`node:sqlite`**, built in. Recursive CTEs and FTS5 both verified. No native rebuild, nothing to
  install.
- **`hono`** for the server — typed routing, a first-class SSE helper, static files: the three things
  this server does.
- **No TanStack Query**, even though the rendering rule *is* stale-while-revalidate, because the server
  already owns the cache and answers from localhost in under a millisecond. A second cache with a
  second staleness model in front of that is only something extra to reason about.

## Palette

[xoria256](https://github.com/neozenith/estilo-xoria256) — Dmitriy Zotikov's pastel Vim scheme. Every
value in the stylesheet comes from `estilo/palettes/xoria256.yml`; nothing is interpolated.

The palette is dark-first and has no light neutrals, so **the dark theme *is* xoria** — `#040404`
through `#323232` for the panel stack, `#dddddd`/`#bbbbbb`/`#999999` for ink, `purple1 #a6a6e7` as the
accent — and the light theme is derived from the same seven hue families, using each hue's dark shade
where its mid shade would disappear on white.

One hue family per facet, following xoria's own syntax mapping where there is an obvious fit, so a
chip's colour says which axis it is before you read it:

| Facet | Hue | xoria role |
|---|---|---|
| `priority` | orange `#dfaf87` | Number |
| `status` | green `#afdf87` | PreProc |
| `project` | purple `#a6a6e7` | Type |
| `tech` | blue `#87afdf` | Statement |
| `layer` | pink `#dfafdf` | Identifier |
| `waiting_on` | red `#df8787` | Special |
| `domain` | yellow `#dfdf87` | Constant |
| `energy`, `source` | none | hints, not identity — they recede |

Edges take the same families: `parent` purple, `blocks` red, `member-of` blue, `relates` grey. A single
`--chip-tint` token controls how much of a hue's background shade a chip carries — xoria's light shades
are saturated pastels, fine for one chip and loud for eight stacked in a column, so light mode dilutes
toward the surface while dark mode uses the darkest shades at full strength.

---

# Safety inventory

C2 says everything external is read-only. Rather than leave that as a principle, here is every
operation that writes anything at all:

| Operation | Writes | Never |
|---|---|---|
| `ck add` | one new file under `cards/` | never overwrites an existing file |
| `ck link` | the `links` key of one card's frontmatter | never touches the body |
| `ck set` | one card's frontmatter | never touches the body |
| `ck import …` | new card files; skips any id already present | never edits or deletes an existing card |
| `ck reindex`, `ck ls`, `ck next`, `ck search` | `.index.db` only | never touches a card file |
| `ck check`, `ck show`, `ck project`, `ck context` | nothing | — |
| server, GET routes | `.index.db` only | never touches a card file |
| `PATCH /api/card/:id` | one card's frontmatter, or its body when `body` is sent | a frontmatter change never touches body bytes |
| `POST /api/card` | one new card file | never overwrites an existing file |
| `DELETE /api/card/:id`, `POST /api/bulk` | card files, and edges that pointed at a deleted card | nothing outside `cards/` |
| `PUT /api/card/:id/edges` | one card's `edges` | refuses an edge that would create a parent cycle |
| `PUT /api/card/:id/frontmatter` | one card's whole frontmatter block | never touches the body |
| `PATCH /api/view/:name/arrangement` | one view file's `nodes`/`order`, merged by id | never touches a card; never drops an entry whose card still exists |
| `PUT /api/view/:name` | one view file's query half | never touches its stored arrangement |
| `DELETE /api/view/:name` | one view file | never touches the cards it selected |
| `POST /api/card/:id/asset` | one file under `cards/assets/<id>/` | never overwrites: the name is a content hash |
| `POST /api/enrich`, `/api/enrich/clear` | `.enrich.db` only | never touches a card; every fetcher is read-only |

There is no code path in this repo that writes to Jira, GitHub, Trello, Slack or any other external
system. The only outbound calls are reads: `gh pr view`, `gh api` GETs, Jira GETs. Fetchers export no
mutation functions, so there is nothing to call.

A mutating request is additionally refused when it carries an `Origin` header that is not one of ours,
since a localhost server is reachable from any page open in the browser. Every frontmatter write goes
through `writeCardFile`, which writes a temp file and renames, so a concurrent reader never sees half a
file.

# Non-goals

Multi-user or team features. Any write-back to Jira, GitHub, Trello or Slack. Trello two-way sync.
Real-time collaborative editing. A mobile app. Freehand drawing.

**The view builder is ephemeral; persistence is a file.** Filter, focus, shape and face are live
controls held in the URL. Nothing you adjust survives a reload unless you name it, and naming it writes
the same `views/*.yaml` an agent or a text editor can write. An earlier draft forbade a builder UI
outright to guard against endless configuration; the ephemeral/persistent split keeps that property
without giving up the filtering, which is the most common act of using the thing.

# Risks

| Risk | Mitigation |
|---|---|
| Canvas scope creep toward Miro | React Flow gives structured nodes, not ink. Accepted explicitly (C7) |
| Facet vocabulary churn | `open:` per facet; the index is rebuilt from files so a rename is a text edit |
| Index/file drift | The index is disposable; `ck reindex` is always correct |
| Format lock-in | Cards are markdown in git. Worst case the app is dropped and the files remain useful |
