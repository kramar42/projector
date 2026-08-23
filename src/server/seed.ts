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
# The order of the facets themselves is also read, and in more places than the
# order of a facet's values: it is the filter rail's resting order, the order of
# the group/sort/facet pickers, and the order of the rows in a card's panel. The
# panel additionally splits on type — every ref facet is drawn together with the
# derived lists that point back along it — so a reference facet's position
# matters only relative to the other reference facets.
#
# Every facet is stored and written identically, the relations included. There is
# deliberately no kind of facet the app writes through some other mechanism — and
# no facet saying what class of thing a record is: that is read off the record,
# never declared on it.
#
# Everything below is a starting point, not a schema. Delete what your domain has
# no use for; an empty file is a valid vault. The one facet you will not find here
# is \`project\`, which is built in — its definition is not read from this file, so
# declaring it does nothing and \`pj check\` says so.

# Lifecycle only. "Blocked" and "waiting" are derived — from an unfinished blocks
# edge and from a non-empty waiting_on — so they are not values here: storing
# either beside the thing it is computed from gives two answers to one question.
status:
  label: Status
  values: [planning, active, frozen, done, archived]
  open: false
  single: true

priority:
  label: Priority
  values: [now, month, backlog, someday]
  open: false
  single: true

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

waiting_on:
  label: Waiting on
  values: []
  open: true

energy:
  label: Energy
  values: [deep, shallow, decide, delegate]
  open: false
  single: true

domain:
  label: Domain
  values: []
  open: true

tech:
  label: Tech
  values: []
  open: true

source:
  label: Source
  values: [brain, slack, jira, gmail, git, claude]
  open: true

owner:
  label: Owner
  values: []
  open: true
  single: true

# What a record is part of. A reference facet, so it is both classification and
# structure: it filters and groups a board like any facet, and it lays out the
# canvas and walks under focus like an edge used to. Single, because one
# container is the shape every gesture already assumed.
parent:
  label: Part of
  type: ref
  single: true

# What must finish before the target. Its transitive closure is what the blocked
# axis and views/unblocked.yaml are built from. Not worth grouping a board by — the
# question is always the inverse, which the derived blocked axis answers.
blocks:
  label: Blocks
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
    body: `# Deadlines, soonest first. \`due\` is an ordered facet: it declares its own
# buckets, computed against today, so this view never goes stale.
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
    body: `# Actionable now: open, nobody waited on, no unfinished blocker.
#
# \`blocked\` is computed from the blocks facet and \`waiting\` from waiting_on, so
# \`clear\` means neither applies. A deadline outranks an intention, so \`due\` sorts
# before \`priority\`: a card due tomorrow is next whatever bucket it was filed in.
shape: board
title: Unblocked now
filter:
  status: [planning, active]
  blocked: [clear]
sort: [due:asc, priority:asc, updated:desc]
show: [project, priority]
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
