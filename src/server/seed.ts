/**
 * What a brand-new vault starts with.
 *
 * The model, not somebody else's data: the facet vocabulary without this
 * workspace's project ids, people, or its Project A `layer` taxonomy.
 */

export const SEED_FACETS = `# Facet vocabulary. This file is the single place column order lives —
# what list-order does in Trello, made explicit and shared by every view.
#
#   values:  declared order == column order in every board
#   open:    true  → new values accepted
#            false → the validator rejects anything not listed
#   single:  true  → at most one value at a time
#   type:    label  → a member of the declared values list (the default)
#            ref    → a record id, so the facet is also traversable: it lays out
#                     a canvas, walks under focus, and refuses a cycle
#            date   → YYYY-MM-DD, compared rather than matched
#            number → sorts numerically rather than as text
#   buckets: named ranges an ordered facet presents itself as, in order. The
#            number is an inclusive upper bound — days from today for a date —
#            and anything past the last one is overflow.
#
# ref, date and number declare no values: their vocabularies are the vault and
# the number line.
#
# Every facet is stored and written identically, project and the relations
# included. There is deliberately no kind of facet the app writes through some
# other mechanism — and no facet saying what class of thing a record is: that is
# read off the record, never declared on it.

# What a record is part of. A reference facet, so it is both classification and
# structure: it filters and groups a board like any facet, and it lays out the
# canvas and walks under focus like an edge used to. Single, because one
# container is the shape every gesture already assumed.
parent:
  label: Part of
  type: ref
  single: true

# What must finish before the target. Its transitive closure is what ck next
# and the blocked axis are built from. Not worth grouping a board by — the
# question is always the inverse, which the derived blocked axis answers.
blocks:
  label: Blocks
  type: ref

# A deadline. priority says what you intend to do next; due says what the
# world expects regardless of intent, so it is compared against today rather than
# matched against a list. buckets is what an axis shows: filtering and grouping
# see the names, sorting and a range filter (f.due=>2026-09-01) see the date.
due:
  label: Due
  type: date
  single: true
  buckets: { overdue: -1, today: 0, week: 7 }
  overflow: later

priority:
  label: Priority
  values: [now, month, backlog, someday]
  open: false
  single: true

# Lifecycle only. "Blocked" and "waiting" are derived — from an unfinished blocks
# edge and from a non-empty waiting_on — so they are not values here: storing
# either beside the thing it is computed from gives two answers to one question.
status:
  label: Status
  values: [planning, active, frozen, done, dropped]
  open: false
  single: true

energy:
  label: Energy
  values: [deep, shallow, decide, delegate]
  open: false
  single: true

waiting_on:
  label: Waiting on
  values: []
  open: true

domain:
  label: Domain
  values: []
  open: true

source:
  label: Source
  values: [brain, slack, jira, gmail, git, claude]
  open: true

tech:
  label: Tech
  values: []
  open: true

owner:
  label: Owner
  values: []
  open: true
  single: true

# Which project(s) a card belongs to — an ordinary multi-valued facet, so a card
# can be in two at once and inherits repos and instructions from both. Values are
# the ids of records carrying a project: block. parent is a separate relation:
# it means decomposition, and config is inherited through project alone.
project:
  label: Project
  type: ref
`;

export const SEED_README = `# Card conventions

One file per record. \`id\` is the join key everywhere and never changes; the filename may drift from it.
Everything below the frontmatter is free-form markdown — no required sections, no template.

Agents can create and edit these files directly with Write/Edit. No API, no running app. Run
\`ck check\` afterwards.

## Frontmatter

\`\`\`yaml
---
id: project-a-kpow-fix          # required. lowercase slug, stable, immutable
title: Fix Kpow           # required
facets:                   # every value is an array, even when there is one
  priority: [now]
  status: [active]
  tech: [k8s, kafka]
  parent: [project-a-eventing]  # a reference facet: values are record ids
  blocks: [project-a-conduktor-config]
  project: [project-a]
  due: [2026-09-01]       # a date facet: compared against today, not matched
links:                    # read-only references, resolved and cached by the app
  - jira:PROJ-303
  - gh:pr:Acme/staging#412
  - claude:local_9e09a116-6b70-4c4a-8d9e-c2a61e52f4c4
  - doc:../../keycloak-consolidation-plan.md   # relative to the vault root
created: 2026-08-19
updated: 2026-08-19
---
\`\`\`

Only \`id\` and \`title\` are required. Everything else is optional, and a facet the vocabulary does not
know is preserved rather than dropped — \`ck check\` reports it.

## Rules that matter

- **Facet values are arrays.** A card with two values for the grouped facet appears in two columns.
  That is the model working, not a mistake — unless the facet declares \`single: true\`, which is how
  \`status\` and \`priority\` say that holding two at once is incoherent rather than expressive.
- **Facet names and values are validated** against \`../facets.yaml\`. A facet with \`open: false\` rejects
  new values.
- **There is no \`kind\`.** A record is not a class of thing. Whether it is work is whether it carries a
  \`status\`, which is what keeps a grouping record off a status-filtered board; whether it contains
  anything is whether anything names it as a \`parent\`. Both are read off the record.
- **Relations are facets too.** A facet declared \`ref: true\` holds record **ids** rather than labels —
  \`parent\`, \`blocks\` and \`project\` are the ones that exist. Being a facet means a relation filters,
  groups a board and bulk-edits like \`priority\`; being a reference means it also draws on the canvas,
  walks under \`focus\` and refuses a cycle. There is no \`edges:\` block.
- **\`parent\` and \`project\` are independent.** \`parent\` is decomposition — this card is *part of*
  that one. \`project\` is membership, and the only thing repos and instructions are inherited through.
  A card may have either, both or neither.
- **A facet's \`type\` says what its values are** — a \`label\` from the declared list, a \`ref\` to a
  record, a \`date\`, or a \`number\`. Storage is uniform; the type governs comparison. An ordered facet
  may declare \`buckets\`, and then it **presents buckets and compares raw**: filtering and grouping see
  \`overdue · today · week · later\`, while sorting and a range filter (\`f.due=>2026-09-01\`) see the
  date. \`created\` and \`updated\` stay fields — a facet is vocabulary you declare, and those are
  written by the app.
- **Blocked and waiting are never written.** Both are derived: \`blocked\` from an unfinished \`blocks\`
  edge, \`waiting\` from a non-empty \`waiting_on\`. They appear in the filter panel like any other axis.
- **\`doc:\` paths are relative to the vault root**, or absolute (\`/…\`, \`~/…\`). A document living
  outside the vault is reached with \`../\`.
- **Arrangement is not here.** A card can appear on several canvases at different positions, and in a
  different order in each board column, so \`x/y\` and card order live in \`../views/<name>.yaml\`.
  Cards own identity and content; views own arrangement — which is why only a *saved* view can hold it.

## Projects

Any record may carry a \`project:\` block. That makes it a project: it owns configuration that its
members inherit. Membership is the \`project\` facet naming its **id** — a project has no separate key.
It works on cards as well as nodes, so a deliverable can be both tracked work and something others
belong to.

\`\`\`yaml
project:
  repos:
    - { path: ~/Code/work/staging, base: main }
  jira: PROJ
  branch: "kc/{card}"
  instructions: |
    - Never change a realm in eu-prod without a ticket and a rollback plan.
\`\`\`

Config inherits along the \`project\` facet: \`repos\` union, \`instructions\` concatenate outermost-first
so the most specific advice reads last, everything else takes the nearest value. A card in two projects
merges both. The body stays free-form: nothing in it is read by the app.

Membership is not decomposition: putting a card under a project with \`parent\` does *not* make it
inherit anything. The two are separate facets on purpose.

## Relations

| Facet | Meaning |
|---|---|
| \`parent\` | decomposition — this record is part of that one. Gives the mind-map tree |
| \`blocks\` | this must finish before the target. Powers the \`blocked\` axis and \`ck next\` |
| \`project\` | membership — the only thing config is inherited through |

All three are ordinary facets with \`ref: true\`. A canvas lays out by the **first** one it is asked to
show, so \`parent\` first is a decomposition tree and \`project\` first is the portfolio.

## Link kinds

\`jira:\` \`gh:pr:\` \`gh:branch:\` \`gh:commit:\` \`claude:\` \`doc:\` \`slack:\`, plus a bare \`https://…\` for
anything else. All read-only. A kind exists when something resolves it; everything else is a URL.
`;

/**
 * Views a new vault starts with. Generic: only built-in facet names appear.
 *
 * Flat, and each one states its `shape` — a saved view is a named query, so the
 * directory it sits in is not allowed to mean anything.
 */
export const SEED_VIEWS: { path: string; body: string }[] = [
  {
    path: 'home.yaml',
    body: `# Opened when nothing else is asked for. The filter is a default *selection*:
# it shows as clearable chips in the sidebar rather than hiding cards silently.
shape: board
title: Home
filter:
  status: [planning, active]
groupBy: [priority]
sort: [updated:desc]
show: [project, tech]
uncategorised: end
`,
  },
  {
    path: 'due.yaml',
    body: `# Deadlines, soonest first. \`due\` is a pseudo-facet over the \`due\` field —
# the buckets are computed against today, so this view never goes stale.
shape: board
title: Due
filter:
  status: [planning, active]
  due: [overdue, today, week]
groupBy: [due]
sort: [due:asc]
show: [project, priority]
uncategorised: hide
`,
  },
  {
    path: 'projects.yaml',
    body: `# Every project, with its roll-ups. \`type\` is a pseudo-facet: nothing is stored.
shape: table
title: Projects
filter:
  type: [project]
sort: [title:asc]
show: [status, priority]
`,
  },
  {
    path: 'unblocked.yaml',
    body: `# Derived, not maintained by hand: \`blocked\` is computed from the blocks facet
# and \`waiting\` from waiting_on, so \`clear\` means neither applies.
shape: board
title: Unblocked now
filter:
  status: [planning, active]
  blocked: [clear]
groupBy: [energy]
sort: [priority:asc]
`,
  },
  {
    path: 'everything.yaml',
    body: `# Every record as a graph, laid out from the roots.
shape: canvas
title: Everything
show: [parent, blocks]
`,
  },
];
