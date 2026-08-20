/**
 * What a brand-new vault starts with.
 *
 * The model, not somebody else's data: the facet vocabulary without this
 * workspace's project keys, people, or its Project A-scoped `layer` facet.
 */

export const SEED_FACETS = `# Facet vocabulary. This file is the single place column order lives —
# what list-order does in Trello, made explicit and shared by every view.
#
#   values:  declared order == column order in every board
#   open:    true  → new values accepted
#            false → the validator rejects anything not listed
#   scope:   { under: <id> } → only valid on records beneath that record
#   valuesFrom: project-records → offer every record carrying a project: block
#
# Every facet is stored and written identically. There is deliberately no kind of
# facet the app writes through some other mechanism.

priority:
  label: Priority
  values: [now, month, backlog, someday]
  open: false

status:
  label: Status
  values: [planning, active, waiting, blocked, frozen, done]
  open: false

energy:
  label: Energy
  values: [deep, shallow, decide, delegate]
  open: false

waiting_on:
  label: Waiting on
  values: []
  open: true

domain:
  label: Domain
  values: [eventing, identity, master-data, workflow, observability, lifecycle]
  open: true

source:
  label: Source
  values: [brain, trello, slack, jira, gmail, gdocs]
  open: true

tech:
  label: Tech
  values: [k8s, aws, github, kafka, keycloak, quarkus, temporal, mongodb, devops]
  open: true

owner:
  label: Owner
  values: []
  open: true


# Which project(s) a card belongs to — an ordinary multi-valued facet, so a card
# can be in two at once and inherits repos and instructions from both. Values are
# the keys of records carrying a project: block. Parent edges are a separate
# thing: they mean decomposition and are what the canvas draws.
project:
  label: Project
  values: []
  open: true
  valuesFrom: project-records
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
kind: card                # required. card = work, node = a thought
title: Fix Kpow           # required
facets:                   # every value is an array, even when there is one
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
created: 2026-08-19
updated: 2026-08-19
---
\`\`\`

## Rules that matter

- **Facet values are arrays.** A card with two values for the grouped facet appears in two columns.
  That is the model working, not a mistake.
- **Facet names and values are validated** against \`../facets.yaml\`. A facet with \`open: false\` rejects
  new values.
- **\`project\` is an ordinary facet.** \`project: [project-d, mapping]\` means the card belongs to both and
  inherits the repos and instructions of both. Values are the keys of records carrying a \`project:\`
  block. \`parent\` edges are a separate thing — they mean decomposition and are what the canvas draws.
- **A scoped facet** only applies beneath the record named in its \`scope\`. \`layer\` in the work vault
  is Project A taxonomy that way, not a global axis.
- **\`doc:\` paths are relative to the vault root**, or absolute (\`/…\`, \`~/…\`). A document living
  outside the vault is reached with \`../\`.
- **Arrangement is not here.** A card can appear on several canvases at different positions, and in a
  different order in each board column, so \`x/y\` and card order live in \`../views/<name>.yaml\`.
  Cards own identity and content; views own arrangement — which is why only a *saved* view can hold it.

## Projects

Any record may carry a \`project:\` block. That makes it a project: it owns configuration that its
members inherit. Membership is the \`project\` facet naming its key. It works on cards as well as nodes,
so a deliverable can be both tracked work and something others belong to.

\`\`\`yaml
project:
  key: keycloak
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
| \`parent\` | containment — gives the mind-map tree and the project hierarchy |
| \`blocks\` | this must finish before the target. Powers \`ck next\` |
| \`relates\` | soft association |

## Link kinds

\`jira:\` \`gh:pr:\` \`gh:branch:\` \`gh:commit:\` \`claude:\` \`doc:\` \`slack:\` \`trello:\` \`cal:\` \`grafana:\`,
plus a bare \`https://…\` for anything else. All read-only.
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
  status: [planning, active, waiting, blocked]
groupBy: [priority]
sort: [updated:desc]
chips: [project, tech]
uncategorised: end
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
    body: `# Derived, not maintained by hand: \`blocked\` is computed from blocks edges.
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
