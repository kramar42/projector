/**
 * What a brand-new vault starts with.
 *
 * The model, not somebody else's data: the facet vocabulary without this
 * workspace's project ids, people, or its own niche taxonomies.
 */

export const SEED_FACETS = `# Facet vocabulary. This file is the single place column order lives —
# what list-order does in Trello, made explicit and shared by every view.
#
#   values:  declared order == column order in every board
#   open:    true  → new values accepted
#            false → the validator rejects anything not listed
#   single:  true  → at most one value at a time
#   key:     the letter that addresses this axis from the keyboard — \`p3\` sets its
#            third value, \`,g p\` groups by it, \`pp\` opens it to look. One letter
#            a-z, and not one the keyboard already owns (\`?\` in the app lists
#            those); \`pj check\` refuses a collision. Declare one for the axes you
#            keep reaching for and leave the rest without — most axes want none
#   closed:  values meaning no further work is expected, whatever the outcome
#   expected: true  → a well-filed note carries this; the triage axis is built
#            from it
#   inverse: what the other end of a relation is called — \`parent\` is answered by
#            children. Omit it and the relation gets an editable row and no
#            derived one, which is right: nothing computes an inverse it has no
#            word for. The built-in \`project\` brings its own, \`Members\`; declare
#            \`project: { inverse: ... }\` to call it something else
#   hue:     which family this axis draws in — orange green purple blue pink red
#            yellow, or omitted for no colour at all. \`pj check\` rejects a family
#            that is not one of those, rather than drawing it grey. A bucket may declare one
#            too, and it wins for a chip in that bucket, drawn filled rather than
#            tinted. The palette is the app's; the choice is yours
#   blocking: true  → while this axis is unsatisfied the note cannot proceed, and
#            the blocked axis says so by this facet's name. A ref blocks while
#            something it names is not closed; anything else blocks while it
#            holds a value at all
#   type:    label  → a member of the declared values list (the default)
#            ref    → a note id, so the facet is also traversable: it lays out
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
# the group/sort/facet pickers, and the order of the rows in a note's panel. The
# panel additionally splits on type — every ref facet is drawn together with the
# derived lists that point back along it — so a reference facet's position
# matters only relative to the other reference facets.
#
# Every facet is stored and written identically, the relations included. There is
# deliberately no kind of facet the app writes through some other mechanism — and
# no facet saying what class of thing a note is: that is read off the note,
# never declared on it.
#
# Everything below is a starting point, not a schema. Delete what your domain has
# no use for; an empty file is a valid vault. The one facet you will not find here
# is \`project\`, which is built in — its shape (type, values, open, single) is
# fixed and \`pj check\` refuses changing those; label, expected, hue and key are
# yours to set by declaring it.

# Lifecycle only. Being blocked is derived — see blocking: below — so it is not a
# value here: storing a reason beside the thing it is computed from gives two
# answers to one question, and nothing to arbitrate between them.
status:
  label: Status
  values: [planning, active, on-hold, done, archived]
  open: false
  single: true
  # No further work expected, whatever the outcome — so abandonment counts and
  # on-hold does not. A closed note stops blocking whatever waits on it.
  closed: [done, archived]
  expected: true
  hue: green
  key: s

priority:
  label: Priority
  values: [now, month, backlog, someday]
  open: false
  single: true
  expected: true
  hue: orange
  key: p

# A deadline. priority says what you intend to do next; due says what the
# world expects regardless of intent, so it is compared against today rather than
# matched against a list. buckets is what an axis shows: filtering and grouping
# see the names, sorting and a range filter (f.due=>2026-09-01) see the date.
due:
  label: Due
  type: date
  single: true
  buckets: { overdue: {upTo: -1, hue: red}, today: {upTo: 0, hue: yellow}, week: 7 }
  overflow: later
  key: d

# Somebody else's move. A blocking facet, so it lands on the blocked axis beside
# the dependency relation — while it holds any value at all, this note is parked.
# A label rather than a ref because a person does not *complete*: you clear the
# axis, you do not mark them closed.
waiting_on:
  label: Waiting on
  values: []
  open: true
  blocking: true
  hue: yellow
  key: w

energy:
  label: Energy
  values: [deep, shallow, decide, delegate]
  open: false
  single: true
  key: e

domain:
  label: Domain
  values: []
  open: true

tech:
  label: Tech
  values: []
  open: true
  hue: pink

source:
  label: Source
  values: [brain, slack, jira, gmail, git, claude]
  open: true

owner:
  label: Owner
  values: []
  open: true
  single: true

# What a note is part of. A reference facet, so it is both classification and
# structure: it filters and groups a board like any facet, and it lays out the
# canvas and walks under focus like an edge used to. Single, because one
# container is the shape every gesture already assumed.
parent:
  label: Part of
  type: ref
  single: true
  hue: purple
  inverse: Children
  key: a

# What must finish before this note can move. Stored on the note that is stuck,
# pointing at what it is stuck on — the same direction as parent and project, and
# the note you open when you are stuck is the note you note it on. The inverse,
# what this note holds up, is derived and drawn beside it.
#
# Its transitive closure is what the blocked axis and views/unblocked.yaml are
# built from. Not worth grouping a board by.
blocked_by:
  label: Blocked by
  type: ref
  blocking: true
  hue: red
  inverse: Blocks
  key: b
`;

export const SEED_VIEWS: { path: string; body: string }[] = [
  {
    path: 'home.yaml',
    body: `# Opened when nothing else is asked for. The filter is a default *selection*:
# it shows as clearable chips in the sidebar rather than hiding notes silently.
shape: board
title: Home
filter:
  status: [planning, active]
groupBy: [priority]
sort: [updated:desc]
show: [project, tech]
`,
  },
  {
    path: 'due.yaml',
    body: `# Deadlines, soonest first. \`due\` is an ordered facet: it declares its own
# buckets, computed against today, so this view never goes stale. The filter is
# what keeps undated notes out — there is no separate policy for that.
shape: board
title: Due
filter:
  status: [planning, active]
  due: [overdue, today, week]
groupBy: [due]
sort: [due:asc]
show: [project, priority]
`,
  },
  {
    path: 'week.yaml',
    body: `# Does this week fit?
#
# The horizon \`due\` already draws, with one axis added: \`energy\` lanes, so a
# column shows the *shape* of a day rather than only its count. Three \`deep\` notes
# stacked in today is a claim about the day that can be judged before it is lived,
# which a flat count of nine never is.
#
# Two columns carry the weight. \`overdue\` should be empty — anything sitting in it
# is a promise already broken and not yet admitted. And \`later\` is left out on
# purpose: a horizon with no far edge is a backlog, and a backlog can never say
# you are finished for the day.
shape: board
title: This week
filter:
  status: [planning, active]
  due: [overdue, today, week]
groupBy: [due, energy]
sort: [due:asc, priority:asc]
show: [project, priority]
`,
  },
  {
    path: 'projects.yaml',
    body: `# Every project, with its roll-ups. \`type\` is a computed axis: nothing is stored.
# A table's columns are its \`show\` list, \`project\` included: it is which project
# this project is nested under, and the roll-ups only appear because every row here
# is a project.
shape: table
title: Projects
filter:
  type: [project]
sort: [title:asc]
show: [status, priority, project]
`,
  },
  {
    path: 'unblocked.yaml',
    body: `# Actionable now: open, nobody waited on, no unfinished blocker.
#
# \`blocked\` names one value per blocking facet, so \`clear\` means none of them
# applies. A deadline outranks an intention, so \`due\` sorts
# before \`priority\`: a note due tomorrow is next whatever bucket it was filed in.
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
    path: 'intake.yaml',
    body: `# What a sweep left for you, and nobody has judged yet.
#
# \`intake\` is a built-in axis holding one value: a sweep writes it onto a
# candidate it materialised, and judging the note is removing it. So this view
# needs no state of its own — it is a filter, which is what keeps the queue a
# board you already know how to use rather than a second kind of place.
#
# Flat, and not grouped by \`source\`. The channels were the columns while these
# arrived as an import from somewhere else; a candidate is written as an ordinary
# note carrying its own link now, so which pipe it came down is a chip on the
# card rather than the shape of the queue. It is also a column of \`triage\`,
# and a column cannot group.
#
# Nothing has to be excluded from the other seeded views — every one of them
# filters on \`status\`, and a candidate has none until you give it one.
shape: board
title: Unjudged
filter:
  intake: [unjudged]
sort: [updated:desc]
show: [source, project, priority, status]
`,
  },
  {
    path: 'needs-project.yaml',
    body: `# Judged, and still unfiled.
#
# \`intake: [(none)]\` is what makes this drainable rather than permanent: a
# candidate nobody has looked at is not a filing failure, it is a queue. The
# question here is only asked of notes you have already accepted.
#
# \`type\` exempts projects, and only projects. A root project carries a
# \`project:\` block and no \`project\` facet, so without this every project in
# the vault sits here for ever. A container is not exempt — a note things hang
# off still belongs somewhere.
shape: board
title: Needs project
unlisted: true
expect: empty
filter:
  intake: ['(none)']
  project: ['(none)']
  type: [plain, node]
sort: [updated:desc]
show: [status, priority]
`,
  },
  {
    path: 'needs-status.yaml',
    body: `# Planned, but not committed to: it says when you mean to do it and never says
# it is work.
#
# One of the two halves of a note that claims to be work on one axis and not the
# other. Both are invariants rather than piles — zero is the only correct state —
# which is what \`expect: empty\` asserts and \`pj audit\` runs.
shape: board
title: Needs status
unlisted: true
expect: empty
filter:
  intake: ['(none)']
  priority: ['-(none)']
  status: ['(none)']
sort: [updated:desc]
show: [project, priority]
`,
  },
  {
    path: 'needs-priority.yaml',
    body: `# Committed to as work, but unplanned: it has a lifecycle and no horizon, so
# nothing on a board grouped by \`priority\` will ever show it to you.
#
# The mirror of \`needs-status\`. See it for why these are two views rather than
# two values of one axis: they are conditions on *different* facets at once, and
# no single filter — and therefore no grouping — can hold them apart.
shape: board
title: Needs priority
unlisted: true
expect: empty
filter:
  intake: ['(none)']
  status: ['-(none)']
  priority: ['(none)']
sort: [updated:desc]
show: [project, status]
`,
  },
  {
    path: 'triage.yaml',
    body: `# Everything waiting on a decision, in one board.
#
# \`lists:\` draws other views as this one's columns. It exists because grouping
# cannot answer this: a grouped board derives its columns from one axis over one
# result set, and two of these four are conditions on two axes at once. Each
# column is an ordinary view file, which is the same file \`pj audit\` runs — so a
# rule and the place you fix it are one object rather than two that can disagree.
#
# Naming any children groups this view by \`lists\` — the one axis whose values
# are other views rather than something read off a note. Everything else is an
# ordinary view: \`shape\` below draws it as a board, and \`table\` and \`canvas\`
# draw the same columns as sections and as bands.
#
# Drop \`groupBy\` in and the columns gain lanes:
#
#     groupBy: [lists, priority]
#
# which is also the only way anything here is draggable. A column is a query, so
# no drop across one could write a value — but a *lane* is a facet value like any
# other, so dragging a card down a row sets it.
shape: board
title: Triage
lists: [intake, needs-project, needs-status, needs-priority]
`,
  },
  {
    path: 'everything.yaml',
    body: `# Every note as a graph, laid out from the roots.
shape: canvas
title: Everything
show: [parent, blocked_by]
`,
  },
];
