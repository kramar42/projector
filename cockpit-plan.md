# Cockpit — architecture plan

> Working name. Personal work-management app for Oleksii Kramarenko.
> Status: **plan only, no code.** Written 2026-08-19. Supersedes the `AGENTS.md` + `TODO.md` approach.

A single card database with two equally-important editable projections — a **board** (kanban) and a
**canvas** (mind-map) — over markdown files, enriched with read-only inline views of Jira, GitHub,
Claude sessions and local docs.

---

## 1. Locked constraints

These are decided, not up for re-litigation during the build.

| # | Constraint | Consequence |
|---|---|---|
| C1 | Markdown files are the source of truth | Any index/DB is derived and disposable |
| C2 | Everything external is read-only | No write path to Jira/GitHub/Trello/Slack exists in the codebase. **The app is read-only; the session it launches is not** — see §9.2 |
| C3 | Must stay agent-editable | An agent in any Claude session creates/edits cards with plain Write/Edit, no API, no app running |
| C4 | Two node classes | `node` (a thought) and `card` (work), with explicit promotion |
| C5 | Board and canvas are equally first-class | Both are editable, including card *content*, not just position |
| C6 | Free-form card body | Description, links, files, images — no rigid template |
| C7 | No freehand or drawing | Structured canvas only. Settles the canvas library outright (§6.1) |
| C8 | Derived signals are deterministic | The LLM narrates; it never computes a badge, a count or a status (§9.5) |

Not a constraint (considered, not selected): CLI-first capture. A CLI ships anyway because agents and
quick capture benefit, but the app is the primary interface.

---

## 2. The model

### 2.1 No lists. Facets.

The single most important decision. Trello's model is single-parent — a card lives in exactly one
list — and every frustration in the brief is that constraint leaking:

| Pain | Cause | Dissolves when |
|---|---|---|
| Card wanted in multiple columns | list = single parent | grouping field is multi-valued |
| Swap tags-as-projects ↔ lists-as-priority | one facet is structurally privileged | no facet is privileged |
| "Lists don't always work for me" | one hierarchy, several mental modes | view = filter + groupBy + sort |

So a card carries **facets**: `project`, `priority`, `status`, `domain`, `energy`, `owner`,
`waiting_on`, `source`, `tech`, plus **project-scoped** facets like `layer`. **Every facet value is an
array**, uniformly — even `priority`. No single-vs-multi special casing anywhere in the code, and
grouping by any facet works identically.

**Scoped facets.** `layer` (L2–L6) is the taxonomy of Project A specifically, not a global axis — Project A is the
biggest project for the next couple of years but not the only one. So a facet definition may carry a
`scope`, and the validator and the facet picker only offer it on cards inside that scope. This
generalises: every large domain can bring its own taxonomy without polluting the vocabulary of the
others, and no facet is privileged as a built-in axis.

A board view is `{filter, groupBy, sort}`. Group by a multi-valued facet and a card appears in
several columns *by construction*. Real example from the current board: `L3 stuff that depends on L4`
is one card with `layer: [layer-2, layer-3]` — unrepresentable in Trello, trivial here.

### 2.2 Two node classes

The mind-map and the board sit at different altitudes. In the existing mind-map, `Project A → L3 → Eventing
→ AsyncAPI`, most leaves are scoping scaffolding, not actionable work. If every mind-map leaf became
a card, the board would fill with ~60 items of noise.

- **`kind: node`** — a thought. Title, optional body, edges. No facets required. Never appears on a board.
- **`kind: card`** — work. Facets, links, checklists. Appears on boards and canvases.
- **Promotion** is one field flip, done from either view. Demotion works too.

Same file format, same directory, one discriminator field. Brainstorm at canvas altitude, promote
when something becomes real.

### 2.3 Edges are typed

| Type | Meaning | Powers |
|---|---|---|
| `parent` | containment / decomposition | the mind-map tree, roll-up progress |
| `blocks` | A must finish before B | the **unblocked-now** derived view |
| `relates` | soft association | canvas context, "see also" |

`blocks` is the highest-value edge and the thing neither Trello nor Jira gives usefully. Transitive
traversal is a recursive CTE — verified working on the local Node 26 `node:sqlite`:

```
with recursive chain(n, depth) as (
  select :root, 0
  union all
  select e.dst, c.depth + 1 from edges e join chain c on e.src = c.n
  where e.type = 'blocks' and c.depth < 10)
select * from chain;
-- → [{layer-3,0},{layer-2,1},{project-a-kpow,2}]
```

### 2.4 Positions belong to views, not cards

The brief asked for positions "in the card format". They must live in the **canvas file** instead —
for exactly the same reason lists don't live in the card. A card can appear on several canvases (a
Project A canvas, a quarter-planning canvas, an Project B canvas) at a different position and size in each.
Putting `x/y` on the card re-introduces the single-parent constraint through the back door, and
guarantees churn in card files on every pan.

Cards own *identity and content*. Views own *arrangement*.

### 2.5 Project records

Projects **nest**: Project A is a project, L3 – Platform inside it is a project, Keycloak inside that is a
project, and automatic realm provisioning inside *that* is a smaller project taking several cards. And
a single card can belong to several of them at once.

No third entity is needed for any of that. **`project:` is an optional frontmatter block on any
record.** No new kind, no new directory, no new
file type. A record carrying that block is a project. It works on cards as well as nodes — which is the
realm-provisioning case exactly: a deliverable that belongs on the board with a status *and* is a
container for the cards implementing it. `kind` stays orthogonal — node vs card is thought vs work,
while `project:` means "I own configuration that my members inherit".

```yaml
project:
  key: keycloak                     # used for workspace directory naming
  repos:
    - { path: ~/Code/work/staging,           base: main }
    - { path: ~/Code/work/acme-platform, base: dev }
  jira: PROJ                        # default project for new jira: links
  branch: "kc/{card}"               # branch template
```

Repos are declared inline, by path, with no registry to populate first — a name→path indirection would
only become a chore of having to register a repo before referencing it. Relative paths resolve against
the data directory; `~` and absolute paths work as-is. The worktree subfolder name is the path basename.

**Membership is the `project` facet, and nothing else.** A card carries `project: [project-d, mapping]` —
an ordinary multi-valued facet, stored and written exactly like `priority`. Values are the keys of
records carrying a `project:` block.

An earlier draft derived membership from the parent chain. That was wrong twice over: it made `project`
a facet that could not be written, so the concept needed special-casing in sixteen files, and it capped
a card at one project — while the real data holds cards like `Project D + mapping project-a deployment` that
genuinely span three.

**`parent` edges mean decomposition only** — "this card is part of that one". They are what the canvas
draws, and they carry no config. The two are independent by design: a card may have a project and no
parent, a parent and no project, both, or neither.

**Inheritance is what makes "define once" work.** A card's effective project config is resolved by
walking its `project` facet outward — each value's record, then whatever *that* record belongs to —
merging every `project:` block found:

| Key | Merge rule | Why |
|---|---|---|
| `repos` | **union** across every project reached, deduped by resolved path | Keycloak work needs `acme-platform` from Project B *plus* `infra` of its own. Replacing would force re-listing. `repos_replace: true` narrows when wanted |
| `instructions` | **concatenate, outermost first** | The most specific advice reads last |
| everything else | nearest wins | `key`, `jira`, `branch` |

Instructions live in the project record's **body**, under an `## Instructions` heading, so the rest of
the body stays ordinary notes. No separate `instructions.md`: the record is already free-form markdown
(C6), and a project's body is exactly where "how we work on Keycloak" belongs.

**No facet is special.** Because `project` is stored like any other, board grouping, drag-and-drop,
bulk actions and the facet editor need no knowledge of it — the same code path serves `priority` and
`project`. That absence of special-casing is the main reason for this design: the derived version had
to be handled in sixteen files.

**Vocabulary comes from the data.** `project` declares `valuesFrom: project-records`, so a project is
offerable the moment it exists rather than once something already uses it. That affects the offered
values only, never how the facet is written.

**A project record is its own innermost context**, and belongs to whatever its own `project` facet
names — `keycloak` carries `project: [project-b]`, so a card in `keycloak` inherits from both.

One consequence worth stating, because this is where a model wobbles later: `layer` does **not** become
redundant now that L2–L6 are projects. The project facet says which domain a card belongs to and what
it inherits; `layer` is free to cut across that. `L3 stuff that depends on L4` is `project: [project-a]` with
`layer: [layer-2, layer-3]`.

### 2.6 Links are read-only references

A link is a typed string, resolved lazily and cached. Never a copy of the remote object, never
writable. See §7.

---

## 3. File format

### 3.1 Directory layout

Two directories: **`cockpit/`** for the app, and **`cockpit/data/`** for the data as a subdirectory of
it — gitignored, and configurable so it can be relocated later.

```
work/cockpit/                    # the app
  package.json  tsconfig.json
  src/
    schema/                      # card + facet + project types, validation
    index/                       # indexer, node:sqlite, queries
    fetch/                       # read-only integration fetchers (P3)
    server/                      # hono HTTP + SSE (P1)
    web/                         # React app (P1)
    cli/                         # ck
    import/                      # trello, todo.md
  cockpit.config.json            # { "dataDir": "./data" }
  .gitignore                     # data/, node_modules/, *.db

work/cockpit/data/               # the data — gitignored, relocatable
  cards/
    project-a-kpow-fix.md              # kind: card
    project-a-eventing.md              # kind: node, may carry a project: block
    assets/project-a-kpow-fix/kpow-glue-error.png
    README.md                    # schema conventions, for agents and humans
  facets.yaml                    # facet vocabulary, order, scope
  views/
    board/  priority-lists.yaml  project-lists.yaml  unblocked.yaml
    canvas/ project-a.yaml
  .index.db                      # derived, gitignored
```

The data directory is resolved from `COCKPIT_DATA`, else `cockpit.config.json`, else `./data`. Cards are
plain files under a path of your choosing; the app is versioned on its own and can be thrown away without
touching them.

### 3.2 Card file

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
  - claude:local_9e09a116-6b70-4c4a-8d9e-c2a61e52f4c4
  - doc:keycloak-consolidation-plan.md
  - slack:https://acme.slack.com/archives/D01234567/p1745...
created: 2026-08-19
updated: 2026-08-19
---

Verify Glue SR is exposed as a Confluent-compatible endpoint before anything else — most
tools advertise Confluent SR support but Glue behaves differently.

- [x] Deploy kpow to eu-dev/project-a
- [ ] Drop the `KAFKA_` prefix from env vars
- [ ] Point at MSK with SSL config

![Glue SR error](assets/project-a-kpow-fix/kpow-glue-error.png)
```

**Field reference**

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | slug | yes | Stable and immutable. Filename may drift from it; `id` is the join key everywhere |
| `kind` | `card` \| `node` | yes | The only structural discriminator |
| `title` | string | yes | Rendered in every view |
| `facets` | map of string→array | no | All values arrays. Unknown facets are preserved, not dropped |
| `edges` | array of `{type,to}` | no | `to` is an `id`. Dangling targets are a validation warning, not an error |
| `links` | array of typed strings | no | See §7 for the syntax per kind |
| `created`/`updated` | date | auto | `updated` written on every app save; agents may omit |

Everything below the frontmatter is **free-form markdown** (C6). No recognised sections, no required
structure. Checklists are ordinary markdown task lists — the app counts them for progress display,
but never rewrites them.

### 3.3 Node file

Same format, minimal:

```markdown
---
id: project-a-eventing
kind: node
title: Eventing
edges:
  - { type: parent, to: project-a }
---
```

### 3.4 Facet vocabulary

```yaml
# facets.yaml
priority:
  label: Priority
  values: [now, month, backlog, someday]   # order == column order
  open: false                              # new values rejected by the validator
project:
  label: Project
  values: [project-a, project-f, project-d, mapping, project-b, infra, settlement, demo, quarkus3]
  open: true                               # projects appear ad hoc
status:
  label: Status
  values: [planning, active, waiting, blocked, frozen, done]
  open: false
waiting_on:
  label: Waiting on
  values: [person-a, person-b, person-c, person-d, person-e, mark]
  open: true
energy:
  label: Energy
  values: [deep, shallow, decide, delegate]
  open: false

layer:                                     # scoped: Project A taxonomy, not a global axis
  label: Layer
  scope: { under: project-a }                    # any card at any depth beneath the Project A record
  values: [layer-1, layer-2, layer-3, layer-4, layer-5]
  open: false
```

Column order comes from here, not from the board file — that is what list-order does in Trello, made
explicit and shared across every view. `open: true` per facet decides whether the validator accepts
new values. Projects: yes. Priority: no.

`waiting_on` is confirmed as first-class: the current TODO already tracks other people's next steps
(`[Person A] Reinstate schemas on endpoints`, `[Person B] Testing stories`) with no way to surface them.
The facet plus one board view fixes that.

---

## 4. View config format

### 4.1 Board

```yaml
# views/board/priority-lists.yaml — the current Trello mode
kind: board
title: Priority lists
filter:
  status: [planning, active, waiting, blocked]
groupBy: priority
swimlanes: null            # opt-in only — no facet is a built-in axis (§2.1)
cardFacets: [project, layer]  # which facets render as chips on the card face
sort: [updated:desc]
dragBehaviour: replace
showEmpty: true
uncategorised: end          # cards lacking the groupBy facet: end | start | hide
```

```yaml
# views/board/project-lists.yaml — the other mode, same cards, zero migration
kind: board
title: Project lists
filter: { status: [planning, active, waiting, blocked] }
groupBy: project
cardFacets: [priority, layer]
sort: [priority:asc, updated:desc]
```

```yaml
# views/board/unblocked.yaml — derived, not manually maintained
kind: board
title: Unblocked now
filter:
  status: [planning, active]
  blockedBy: none           # computed from `blocks` edges, not a stored facet
groupBy: energy
sort: [priority:asc]
```

### 4.2 Drag semantics with multi-valued grouping

The subtle bit, and it must be explicit:

| Gesture | Effect |
|---|---|
| drag `now` → `month` | **replace**: remove `now`, add `month` (default, matches Trello muscle memory) |
| ⌥ + drop | **add**: card now appears in both columns |
| ⇧ + drag out of a column | **remove** just that value |
| drag into `uncategorised` | remove all values of the grouped facet |

So "card in two columns" is a deliberate gesture, never an accident. `dragBehaviour: add` in the view
file flips the default per board.

### 4.3 Canvas

```yaml
# views/canvas/project-a.yaml
kind: canvas
title: Project A
include:
  filter: { project: [project-a] }   # auto-pull matching cards; new ones arrive parked
  explicit: [project-f-n8n-decision]  # plus anything hand-added
layout: manual                 # manual | tree-lr | tree-radial
edges:
  show: [parent, blocks]
nodes:
  project-a:              { x: 0,    y: 0,   size: card }
  project-a-eventing:     { x: -320, y: 120, size: chip }
  project-a-kpow-fix:     { x: -320, y: 220, size: card, w: 280 }
  project-a-glue-schema:  { x: -320, y: 320, size: expanded, w: 480, h: 360 }
```

`size` is one of three display modes shared with the board (§5.3). `layout: tree-lr` recomputes
positions on open and ignores stored `x/y` — that reproduces the existing mind-map screenshot
exactly; `manual` is free positioning.

---

## 5. Both views are editable

### 5.1 Board

Create card (inline, in a column — inherits that column's facet value), edit title inline, drag
between columns and swimlanes, reorder, toggle checklist items on the card face, open the editor.

### 5.2 Canvas

Double-click empty canvas creates a `kind: node` — cheap capture, no facets demanded. Drag from a
node handle to another creates an edge (`parent` by default, type picker on the edge). Free
positioning, persisted to the canvas file. Select → **Promote to card** opens the facet picker.
Auto-layout button applies `tree-lr` non-destructively (preview, then commit).

### 5.3 One card component, three sizes

This is how C5 is satisfied without cramming a markdown editor into a 260px node:

| Size | Shows | Editable |
|---|---|---|
| `chip` | title only | title |
| `card` | title, facet chips, link chips, checklist progress | title, facets, checkboxes |
| `expanded` | everything + full body editor | everything |

The same `<CardBody size=…>` React component renders inside a canvas node, inside a board column,
and inside the side panel. A canvas node at `size: expanded` grows to ~480×360 and hosts the real
editor in place — so content is genuinely editable on the canvas, not just in a panel. The side
panel is an alternative surface for the same component, not a separate implementation.

---

## 6. Library decisions

All package facts below were checked against the npm registry on 2026-08-19.

### 6.1 Canvas — `@xyflow/react` 12.11.3, MIT

**Decided.** The requirement that settles it: nodes must contain arbitrary React, because a card face
renders live Jira/PR/session chips and, at `expanded`, a full markdown editor. React Flow's custom
nodes are ordinary components. Nothing else on the list can do that.

| Ruled out | Version | Why not |
|---|---|---|
| `tldraw` | 5.3.2 | Licence: production use needs a commercial licence (~$6k/yr per team); otherwise a "made with tldraw" watermark is required. Also shape-model-first, so structured cards fight the grain |
| `@excalidraw/excalidraw` | 0.18.1 | Sketch-first. Shapes aren't structured data; poor fit for typed edges and rich node content |
| `cytoscape` | 3.34.1 | Canvas/WebGL graph renderer — excellent for 10k-node analysis, cannot host a React editor inside a node |
| `konva` | 10.3.1 | Too low-level; we'd rebuild node/edge/handle semantics from scratch |
| `reactflow` (v11) | 11.11.4 | Superseded by `@xyflow/react`; last published 2024 |

C7 settles what would otherwise be the one open trade-off: React Flow is a node-graph canvas, not a
whiteboard, and freehand ink is out of scope by decision. Nothing is given up.

### 6.2 Auto-layout — `@dagrejs/dagre` 3.1.1, MIT

`rankdir: LR` reproduces the existing mind-map layout directly. `elkjs` 0.12.0 is more configurable
(`mrtree`, `radial`) but is dual EPL-2.0/GPL-3.0 and a transpiled Java library needing a web worker —
keep it behind a flag if radial layouts become interesting.

### 6.3 Board drag & drop — `@atlaskit/pragmatic-drag-and-drop` 3.0.0, Apache-2.0

Chosen over `@dnd-kit/core` on maintenance grounds: dnd-kit's stable core (6.3.1) was last published
December 2024, and its v7 line (`@dnd-kit/react`) is still 0.5.0, pre-1.0. Pragmatic DnD was
published August 2026, is what Trello and Jira themselves run on, is under 5KB, and being built on
native HTML5 drag events sidesteps React 19 StrictMode concerns. `react-beautiful-dnd` is formally
deprecated and excluded.

### 6.4 Body editor — CodeMirror 6 + `@codemirror/lang-markdown`

**Decided, and the reasoning matters more than the library.** A ProseMirror-based WYSIWYG (Tiptap,
Milkdown) round-trips content through a document model and *re-serialises* markdown on save. Under
C1+C3 that is actively harmful: it silently reformats agent-authored files, churns git diffs, and can
drop constructs it doesn't model. CodeMirror edits the text itself — byte-identical except where you
type.

Free-form content (C6) is handled by a paste/drop handler: images land in
`cards/assets/<id>/<hash>.png` and an `![](…)` reference is inserted. A rendered-preview toggle sits
next to the editor for reading.

### 6.5 Frontmatter writes — `yaml` 2.9.0, ISC

Its Document API patches surgically, preserving comments, key order and formatting. `gray-matter`
(4.0.3, last published 2021) re-serialises the whole block and is read-only-safe at best — fine for
the indexer, wrong for the writer.

### 6.6 Index — `node:sqlite`, built in

Verified working on the local Node 26, including recursive CTEs and FTS. Zero dependencies, no native
rebuild, nothing to install. `better-sqlite3` is unnecessary.

### 6.7 App stack — chosen, not inherited

Not `demo-shell`. That project carries `@lovable.dev/vite-tanstack-config`, so it is a Lovable scaffold
and its dependency list is what a generator emitted rather than what anyone chose — and two of its pins
are stale: TypeScript **5.8** against a current **7.0.2** (the Go-based compiler) and zod **3.24**
against **4.4.3**, two majors behind.

**Server:** `hono` 4.13.3 (MIT) — typed routing, a first-class SSE helper, static-file serving; the three
things this server does. Plus `zod` 4.4.3, `yaml` 2.9.0, `chokidar` 5.0.0, and built-in `node:sqlite`.

**Web:** `react` 19.2.8, `vite` 8.2.1, `tailwindcss` 4.3.3, `typescript` 7.0.2, `@xyflow/react`,
`@dagrejs/dagre`, `@atlaskit/pragmatic-drag-and-drop`, CodeMirror 6 + `@codemirror/lang-markdown`,
`wouter` 3.10.0, ~8 Radix primitives (installed individually, not all 26), `lucide-react`.

**Dropped from what `demo-shell` would have brought:**

| Package | Why not |
|---|---|
| `@tanstack/react-start` | An SSR/full-stack framework. This is a localhost single-user SPA with its own backend; SSR buys nothing |
| `@tanstack/react-router` | Heavy for four or five routes. Its typed search params are nice but not worth the machinery |
| `@tanstack/react-query` | See below |
| `react-hook-form` | There is a facet picker and a title input. That is not a forms problem |
| `@lovable.dev/vite-tanstack-config` | Scaffold artifact |

**Why not TanStack Query,** since §7's rendering rule *is* stale-while-revalidate and that is Query's
core competency: because **the server already owns the cache.** The SQLite `cache` table holds every
fetched payload with an explicit per-kind TTL, and SSE pushes invalidations when files or cache entries
change. Query would put a second cache with a second staleness model in front of a localhost source that
answers in under a millisecond. A thin typed `fetch` plus SSE-driven invalidation instead. *Honest
counter-argument:* Query also gives loading/error/retry states and request dedup for free, and
hand-rolling those badly is a classic own-goal — if the SSE plumbing gets irritating, adding it later is
a contained change.

**Router:** `wouter` (~2KB, hook-based) covers `/board/:view`, `/canvas/:view`, `/card/:id`, `/search`,
which should be deep-linkable so a card or canvas can be pasted into Slack. One caveat: it is released
under the **Unlicense** — permissive in substance, but some corporate scanners flag it as "unknown".
`react-router` 8.3.0 (MIT) is the drop-in fallback.

**Validation:** `zod` 4 over `valibot` 1.4.2. Valibot is a third the size, which would settle it in a
browser bundle — but the validator is server-side, so size is irrelevant and error quality is what
matters. `ck check` must collect **every** problem across **every** card rather than stop at the first,
and point at a file and field in human terms. Note how little it validates: facet *values* are dynamic,
loaded from `facets.yaml` at runtime, so no static schema can check them — that stays hand-rolled against
the loaded vocabulary. zod covers the fixed skeleton only.

---

## 7. Integration contracts

Every integration is a **server-side, read-only, cached fetcher**. Credentials stay in the Node
process; the browser only ever receives cached JSON. Read-only is enforced structurally: fetcher
modules export no mutation functions, so there is no code path to write back (C2).

| Kind | Link syntax | Fetched via | Rendered inline | TTL |
|---|---|---|---|---|
| `jira` | `jira:PROJ-303` | Atlassian MCP `getJiraIssue` | key, summary, type, status, assignee, priority | 15 min |
| `gh:pr` | `gh:pr:ORG/repo#412` | `gh pr view --json` | title, state, draft, checks, reviews, ±lines | 5 min |
| `gh:branch` | `gh:branch:ORG/repo@ref` | `gh api` | ahead/behind, last commit, author, date | 10 min |
| `gh:commit` | `gh:commit:ORG/repo@sha` | `gh api` | subject, author, date | immutable |
| `claude` | `claude:local_9e09…` | session-mgmt MCP | title, running dot, last activity, PR badge, cwd, branch | 60s running / 10 min idle |
| `doc` | `doc:path/to.md` | filesystem | H1, mtime, size, first-paragraph excerpt | on mtime change |
| `slack` | `slack:<permalink>` | none in P3 — channel + date parsed from the URL | channel, date | — |
| `cal` | `cal:<eventId>` | Calendar MCP | title, start, attendees | 10 min |
| `grafana` | `grafana:<url>` | Grafana MCP (two instances configured) | dashboard title, alert state | 5 min |

**Rendering rule:** chips render from cache immediately and revalidate in the background
(stale-while-revalidate). A view never blocks on network. A failed fetch shows the last cached value
with a stale marker; a never-fetched link shows the raw ref. Nothing about an integration being down
can prevent the board from opening.

`gh` runs as `env -u GITHUB_TOKEN gh …` — required for the Acme org on this machine.

### 7.1 Claude sessions — the differentiating integration

Verified available today. A live sample from `list_sessions`:

```
"Acme demo platform continuation"    isRunning:false  lastActivityAt: 2026-08-19T10:45Z
"Keycloak issues investigation"          isRunning:false  lastActivityAt: 2026-08-18T13:29Z
"docs: Project F handover dossier…"          prNumber:10  prState:OPEN
```

So a session chip gets title, running state, last activity **and an already-resolved PR link** for
free. Beyond that:

- **Link picker** — `list_sessions` filtered by `cwd`.
- **Continue** — `send_message` pushes a message into that session. Caveat to surface in the UI: it
  does not work for unattended sessions (scheduled-task and remote-dispatched runs).
- **Auto-suggest links** — `search_session_transcripts` against a card's title and id proposes
  matching sessions. This is the feature to build: the board back-fills its own agent history instead
  of being hand-linked. 133 transcripts already exist locally.
- **Deeper mining** (optional) — the raw `~/.claude/projects/**/*.jsonl` transcripts carry
  first-prompt, `cwd` and `gitBranch` per session if richer chips are wanted.

### 7.2 Local docs — the integration that was missing

The workspace already holds ~20 substantial design documents: `keycloak-consolidation-plan.md`, four
`demo-platform-*.md`, `PRODUCT-244.md`, `entra-keycloak-sso-guide.md`,
`customer-provisioning-trace.md`. These are the primary artifacts of the domain-owner work that has
no Jira ticket. `doc:` links close the largest gap between the board and actual output, and cost
almost nothing to implement.

### 7.3 Trello

**Importer, not integration.** One-time migration in P0, then Trello is retired. Two-way sync is
explicitly a non-goal — it is the thing being replaced. Full mapping in §7.4.

### 7.4 Trello import — grounded in the actual export

Source: `~/Downloads/Mw8xxUe2 - gtd.json`, 3.6 MB, inspected 2026-08-19. It is the **whole board
history**, not the live board:

| In the file | Count | Import? |
|---|---|---|
| Cards, total | 1012 | no |
| Lists, total | 84 | no |
| …of which not closed | **6** | yes |
| Cards open, in an open list | **85** | mostly |
| …minus the `• lists •` meta-list | −23 | no — see below |
| …minus `---` and `*** … ***` separator cards | −8 | no — see below |
| **Real cards to import** | **54** | **yes** |
| Cards in `done`-type lists | 452 | no |
| Checklists on live cards | 5 (on 4 cards) | yes |
| Attachments on live cards | 4 (on 2 cards) | partly |
| Labels | 24 defined, **0–1 cards each** | no |

**The live board is six lists:** `🔝 priority` (18), `• lists •` (23), `🧳 quarkus 3 migration` (19),
`🔬 research` (11), `📂 backlog` (10), `🗓️ month` (4).

**`• lists •` is not work.** It holds 23 cards whose names are all list names — `📌 week 📌`,
`⏳ waiting ⏳`, `🧑 delegate 👩`, `🌊 overflow 🌊`, `🔒 keycloak 🔒`, `🔷 product 🔷` … It is a
palette of column names kept for re-organising the board. That is the mode-switching habit made
physical, and it is the single best piece of evidence for the facet model. It imports into
**`facets.yaml` vocabulary**, not into cards.

**Separator cards.** `---` appears five times as a visual divider inside a list, and
`*** platform ***` / `*** services ***` subdivide the quarkus list. Both are workarounds for one card
having one parent. `---` is dropped. The two `*** … ***` headers become `kind: node` records, and the
cards beneath them get `parent` edges to them — the structure the separators were faking.

**Labels are dead.** All 24 carry 0 or 1 cards, so there is no project data to import. Projects must be
assigned by a triage pass, not migrated — mostly inferable from titles (`keycloak Jira issues` → `project-b`,
`project-f handover` → `project-f`, `Project D + mapping project-a deployment` → `project-d`+`mapping`, `CDK pipeline`,
`BB -> GH`, `clean-up ecr` → `infra`). `ck check` will flag every card that still has no `project`.

**Field mapping**

| Trello | → | Cockpit |
|---|---|---|
| card `name` | → | `title` |
| list name | → | `priority` facet (`priority`→`now`, `month`→`month`, `backlog`→`backlog`, `research`→`someday`) |
| `🧳 quarkus 3 migration` list | → | a **project record** `quarkus3` (§2.5); its cards become children via `parent` edges, with `status: [frozen]` per `TODO.md` |
| `🔬 research` list | → | a **project record** `research`; its cards become children, URL into `links`, titles need fetching (all 11 are bare URLs) |
| card `desc` | → | body verbatim (thin — only ~16 live cards have one) |
| checklists | → | `## <checklist name>` + markdown task list, `state: complete` → `[x]` |
| Slack attachments | → | `slack:` links (2 of the 4 attachments are Slack permalinks — free) |
| image attachments | → | **manual.** 2 PNGs on `Analyze high worker CPU levels`; Trello image URLs need an auth token |
| card `shortUrl` | → | `trello:` link, kept for provenance during the transition, dropped later |
| `dateLastActivity` | → | `updated` |
| labels | → | nothing |
| archived cards, closed lists | → | nothing. The export file is retained as the archive; `--include-archived` exists as an escape hatch mapping to `status: [done]` |

---

## 8. Architecture

```
cards/*.md  facets.yaml  views/**          ← source of truth (C1), git-tracked, agent-editable (C3)
      │  ▲
      │  └──────────── atomic write: read → surgical YAML patch → tmp file → rename
      ▼
  chokidar watcher ──► indexer ──► node:sqlite  (.cockpit/index.db, derived, disposable)
                                      │
                              cache table ◄──── read-only fetchers (jira, gh, claude, doc, cal, grafana)
                                      │
                          local HTTP + SSE (one Node process, holds all credentials)
                                      │
                          React app: board view │ canvas view │ shared <CardBody>
```

**Index tables:** `cards`, `facets(card_id, facet, value)`, `edges(src, dst, type)`,
`links(card_id, kind, ref)`, `cache(kind, ref, json, fetched_at)`, `fts` (FTS5 over title + body).
The index is never authoritative — `ck reindex` from a cold start is always correct.

**Agent concurrency (C3).** The app holds no file open and no long-lived in-memory truth. Every save
re-reads the file, patches, and atomically renames. The watcher re-indexes external changes and
pushes them to the UI over SSE. Frontmatter-only operations — drag, edge creation, facet edit — never
touch body bytes. If a file changes on disk while its editor is focused, the UI shows a
non-destructive banner (*changed on disk — reload / keep mine*) and never silently overwrites. That
means a Claude session and the app can both be editing the board at the same time, which is the
point.

---

## 9. Agent surface

Cards are plain files, so any agent in any session already has full read/write access with no API and no
running app — C3 is satisfied by the format, not by tooling. Everything below makes agents *good* at it.

### 9.1 Conventions and skills

- **`data/cards/README.md`** — the schema conventions, colocated with the data.
- **A `cockpit` skill** — capture rules, facet vocabulary, id conventions, worked examples.
- **`/capture`** — sweep the Slack self-DM, Jira digest and recent git commits into inbox cards.
- **`/triage`** — assign facets to inbox cards and propose edges. It **presents and stops**; it does not
  apply. You may edit, drop or add before anything is written.
- **`ck` CLI**: `ck add`, `ck ls --group <facet>`, `ck link`, `ck next`, `ck check`, `ck reindex`,
  `ck import`, `ck work`.
- **`ck check`** — validates frontmatter against `facets.yaml` and resolves edge targets. Wire it as a
  pre-commit hook so agent-authored cards can't drift.

### 9.2 `ck work <card>` — the multi-repo worktree workspace

The most valuable mechanism here. It fits this workspace well, because the work here genuinely spans several repos at once — `staging`, `live`,
`acme-platform`, `acme-services`, `infra`.

1. Create one workspace directory per card, **outside every repository** — so there is nothing to
   git-exclude, unlike placing it inside a repo.
2. Add a `git worktree` per repo from the card's resolved `project.repos` (§2.5), each as a subfolder
   named after the repo path's basename, all on one branch.
3. Write `AGENT_BRIEFING.md` at the workspace root (§9.3).
4. Open Terminal via `osascript`, running
   `claude "Read AGENT_BRIEFING.md and follow it exactly."`
5. Record the session on the card, so the action becomes **Reopen** rather than **Start**.

Branch name: the card's single linked `jira:` key when it has exactly one, else the card `id`, else the
project's `branch` template. Workspace directory: `<project.key>-wt-<branch>`.

Five details to copy verbatim — each is a bug already paid for in his implementation:

- Run `git worktree prune` **unconditionally**, including when the subfolder already exists. Without it,
  deleting a finished workspace by hand — ordinary housekeeping — leaves the repo believing the worktree
  still exists, and reopening fails with *"missing but already registered worktree"*.
- Reuse the branch if it already exists; skip a subfolder that is already present. Reopening is idempotent.
- One repo failing **must not stop the others**. The failure is part of the returned result, not an
  exception. Only if *every* repo fails does the launch abort.
- Base branch: the repo's declared `base` → `origin/HEAD` → `HEAD`.
- AppleScript quoting is not shell quoting. `shlex.quote` on a string containing an apostrophe emits the
  `'"'"'` trick, whose double quote terminates the AppleScript literal early. Escape backslashes and
  double quotes for AppleScript *on top of* shell quoting.

**This is where C2 is reconciled.** The app process keeps zero write paths to Jira, GitHub or Slack — C2
holds exactly as written. But the session `ck work` hands you can commit, push a branch, or file a ticket,
because you are sitting in front of it. C2 was always about the app not mutating things behind your back,
not about crippling the agent it launches. Put another way: **the app is read-only; the session it
launches is not.**

### 9.3 The briefing protocol

`AGENT_BRIEFING.md` follows a fixed five-step shape, and step 4 is the point of the whole thing:

1. **Fetch the full source.** Read the card file, and any linked Jira issue via MCP — *the summary is not
   enough*. This forces a real read instead of a title-driven guess.
2. **Learn the codebases.** For every repo in the workspace, read `README.md`, `CLAUDE.md` and anything
   under `docs/` before writing a line.
3. **Project instructions.** The concatenated `## Instructions` sections from the card's project chain,
   root first, so the most specific advice reads last (§2.5).
4. **Ask before you build.** *STOP. Ask clarifying questions and wait for answers. Do not plan or write
   code before they are answered.*
5. **Then build.** Implement, run the tests of every repo touched, and report **per repo** — what changed,
   which commands ran, and **what was deliberately left out**.

### 9.4 Fingerprints, so sweeps converge

Every card generated by a sweep carries `source_fingerprint: <stable-hash>` in its frontmatter, and
`/capture` skips any fingerprint already present. Without this, `/capture` refills the inbox with
duplicates on every run — it is the difference between a sweep that can run daily and one that runs once.

### 9.5 The LLM narrates; it never decides (C8)

Everything the board *asserts* — unblocked, stale, over-WIP, waiting-too-long, roll-up progress — is
computed in SQL over the index. The LLM writes prose that sits next to those signals and never produces
one. This is the difference between a board that is trusted and one that is second-guessed.

Two supporting habits from the same source:

- **Degrade, don't fail.** If an LLM step throws, keep the data, mark the record degraded, and store the
  error. Caches survive failed fetches rather than being emptied by them.
- **Compact prompts.** When board state is handed to a model, cap every list at ~30 items and replace
  longer ones with `{_truncated, total_items, showing_first, items}` so it reasons from aggregates instead
  of blowing the context. Compact only the prompt; never the stored data.

### 9.6 Operational notes

- **Origin check.** A localhost server is still reachable from any web page open in the browser. Accept a
  mutating request only when its `Origin` header, if present, is one of our own origins; a request with
  no `Origin` at all (curl, scripts) is unaffected.
- **Single-port production mode.** The backend serves the built frontend: one process, one URL. Two
  processes only in dev, for hot reload.
- **Fixed ports**, written down, distinct from other local tools: **8092** backend, **5176** dev server.
- **An enumerated safety inventory** in the README: every side-effecting endpoint listed with what it does
  and what it explicitly does not do. C2 as an auditable list, not only a principle.
- **If anything is ever scheduled:** in-process scheduling kept alive by a launchd agent with `RunAtLoad`
  and `KeepAlive` — plus three gotchas worth inheriting rather than rediscovering. launchd starts
  processes with a minimal `PATH` that excludes `claude`, `aws` and `node`, so `PATH` must be set
  explicitly in `EnvironmentVariables`; `launchctl kickstart -k` does **not** re-read those, so changing
  them needs a full `bootout` + `bootstrap`; and a run missed while the Mac is asleep is **not** replayed
  on wake.

---

## 9a. Deliberately not taken from the reference implementations

| Not taken | Why |
|---|---|
| Eight fixed sidebar areas | The single-parent problem in navigation form. Facets and views replace it |
| Jira-issue-as-atom | The exact constraint that makes this project necessary |
| FastAPI + Python | His stack follows his Python report scripts. Ours is Node + `node:sqlite` (§6.7) |
| Headless auto-filing of bugs to Jira | Even gated on confidence and severity, that is unsupervised external writing. §9.2 keeps it possible via a session if ever wanted |
| A name→path repo registry | Indirection that becomes a chore: register a repo before you can reference it. Paths are declared inline (§2.5) |
| The maturity-workbook machinery | Domain-specific to a data-layer maturity model. The *pattern* — current score → target → gap → generated backlog — is interesting for per-domain health later, but not P0–P4 |
| A scheduler and daily agents, for now | There are no recurring deterministic reports to run yet. The pattern is recorded in §9.6 for when there are |

---

## 10. Phasing

Each phase has an acceptance test that is a real usage claim, not a checklist.

### P0 — Format and import. No UI.
Schema including the `project:` block, `facets.yaml`, indexer with project resolution, validator,
Trello + `TODO.md` import (§7.4). The `project:` block and `layer`'s `scope: { under: … }` land here even
though nothing reads them until §9.2 in P3 — getting them wrong later means migrating card files.

> **Accepts when:** the 54 real Trello cards and every `TODO.md` item exist as card files; the
> `• lists •` palette has become facet vocabulary rather than cards; the two `*** … ***` separators have
> become nodes with `parent` edges; and `ck ls --group priority` reproduces today's board while
> `ck ls --group project` reproduces the other mental mode — from the same files, with no migration
> between them.

This is the phase that proves the model. If it's wrong, everything built on it is wasted.

### P1 — Read-only app, both views.
Vite app, board view, canvas view, shared `<CardBody>` at all three sizes, no editing.

> **Accepts when:** the existing mind-map screenshot is reproducible as a canvas file, and the same
> cards render in both views.

### P2 — Editing.
CodeMirror body editor, drag semantics incl. ⌥/⇧ modifiers, edge creation, canvas positions
persisted, image paste to assets, watcher + SSE, conflict banner, promote/demote.

> **Accepts when:** a full week of planning happens without opening Trello.

### P3 — Links and chips.
Jira, GitHub, Claude sessions, local docs. Cache with stale-while-revalidate. Session continue.

> **Accepts when:** one card simultaneously shows live PR check status, a Jira status, and a running
> Claude session — and the board still opens instantly with the network off.

### P4 — Intelligence.
`unblocked` derived view, auto-suggested session links from transcript search, the skills in §9,
Slack/calendar/Grafana link kinds, roll-up progress over `parent` edges.

> **Accepts when:** "what should I work on next" is answered by a view rather than by re-reading
> everything.

---

## 11. Non-goals

Multi-user or team features. Any write-back to Jira, GitHub, Trello or Slack. Trello two-way sync.
Real-time collaborative editing (CRDT). A mobile app. Freehand drawing. A GUI view-builder — view
configs are files, edited in a text editor.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| The tool competes with the work it organises | P0 lands in a day or two. If P0 isn't used for a week, stop — that's the signal, and it's cheap to obey |
| Canvas scope creep toward Miro | React Flow gives structured nodes, not ink. Accepted explicitly in §6.1 |
| Infinite view configurability | Ship four named views as files. No builder UI, ever |
| Facet vocabulary churn | `open:` per facet; `ck rename-facet` migration command |
| Index/file drift | Index is disposable; `ck reindex` is always correct |
| Format lock-in | Cards are markdown in git. Worst case the app is dropped and the files remain useful |

---

## 13. Decisions taken, and what is left

All six questions from the first draft are answered:

| # | Question | Answer | Effect |
|---|---|---|---|
| 1 | Name | Not worth deciding yet | `cockpit` stays as the working name |
| 2 | Repo layout | **Two directories** | Data in `work/`, code in `work/cockpit/` as its own repo (§3.1) |
| 3 | Trello export | `~/Downloads/Mw8xxUe2 - gtd.json` | Inspected; full mapping in §7.4 |
| 4 | Is `layer` the primary axis? | **No** — L2–L6 is Project A taxonomy, and Project A is the biggest project for the next couple of years but not the only one | `layer` becomes a *scoped* facet; no facet is a built-in axis; `swimlanes` is opt-in per view (§2.1, §3.4) |
| 5 | Freehand ink? | **No** | Now constraint C7; settles §6.1 with nothing given up |
| 6 | `waiting_on` facet? | **Yes** | First-class facet plus its own board view (§3.4) |

### Still open, and none of it blocks P0

1. **Project assignment for the 54 imported cards.** No data exists in Trello to migrate, since the
   labels are empty — so this is a triage pass over ~54 titles, not a migration problem. Deliberately kept
   as the **first real test of `/triage`**.
2. **Titles for the 11 `🔬 research` URL cards.** Same — a good second test of the same command.

Resolved since the first draft: `quarkus3` and `research` are **project records**, not statuses. The two
PNG attachments will be exported by hand and are out of scope for the importer.

**P0 is unblocked, and is being implemented now.**
