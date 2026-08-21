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
  values: [planning, active, frozen, done, archived]
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
