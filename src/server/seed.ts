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
#   ref:     true  → the values are record ids in this vault, so the facet is
#                    also traversable: it lays out a canvas, walks under focus,
#                    and refuses a cycle. open is implied and values ignored.
#
# Every facet is stored and written identically. There is deliberately no kind of
# facet the app writes through some other mechanism — kind and project included.

# Work, or the scaffolding that organises it. An ordinary facet: it filters,
# groups, drags and bulk-edits through the same code path as everything else.
kind:
  label: Kind
  values: [card, node]
  open: false
  single: true

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
  values: [brain, slack, jira, gmail, git]
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
# the ids of records carrying a project: block. Parent edges are a separate
# thing: they mean decomposition and are what the canvas draws.
project:
  label: Project
  ref: true
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
  kind: [card]            # card = work, node = scaffolding. An ordinary facet
  priority: [now]
  status: [active]
  tech: [k8s, kafka]
edges:                    # typed graph edges
  - { type: parent, to: project-a-eventing }
  - { type: blocks, to: project-a-conduktor-config }
links:                    # read-only references, resolved and cached by the app
  - jira:PROJ-303
  - gh:pr:Acme/staging#412
  - claude:local_9e09a116-6b70-4c4a-8d9e-c2a61e52f4c4
  - doc:../../keycloak-consolidation-plan.md   # relative to the vault root
due: 2026-09-01           # optional deadline
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
- **\`kind\` is an ordinary facet.** \`card\` is work and appears on boards; \`node\` is scaffolding that
  organises it. Nothing about it is special — it filters, groups and drags like \`priority\`.
- **\`project\` is an ordinary facet too.** \`project: [project-d, mapping]\` means the card belongs to both
  and inherits the repos and instructions of both. Values are the **ids** of records carrying a
  \`project:\` block. \`parent\` edges are a separate thing — they mean decomposition and are what the
  canvas draws. A card may have either, both or neither.
- **\`due\` is a field, not a facet**, because a deadline is compared against today rather than matched
  against a vocabulary. \`priority\` says what you intend to do next; \`due\` says what the world expects
  regardless of intent.
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
\`\`\`

Config inherits along the \`project\` facet: \`repos\` union, \`instructions\` concatenate outermost-first,
everything else takes the nearest value. A card in two projects merges both. Write instructions in the
project record's body under an \`## Instructions\` heading.

## Edge types

| Type | Meaning |
|---|---|
| \`parent\` | decomposition — this record is part of that one. Gives the mind-map tree |
| \`blocks\` | this must finish before the target. Powers the \`blocked\` axis and \`ck next\` |

\`project\` is a **reference facet**: its values are record ids, so it is traversable like an edge — it
draws on a canvas, walks under \`focus\`, and refuses a cycle — while still filtering, grouping and
dragging like any other facet.

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
  kind: [card]
  status: [planning, active]
groupBy: [priority]
sort: [updated:desc]
chips: [project, tech]
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
  kind: [card]
  status: [planning, active]
  due: [overdue, today, week]
groupBy: [due]
sort: [due:asc]
chips: [project, priority]
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
chips: [status, priority]
`,
  },
  {
    path: 'unblocked.yaml',
    body: `# Derived, not maintained by hand: \`blocked\` is computed from blocks edges
# and \`waiting\` from waiting_on, so \`clear\` means neither applies.
shape: board
title: Unblocked now
filter:
  kind: [card]
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
edges:
  show: [parent, blocks]
`,
  },
];
