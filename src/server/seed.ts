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
#   closed:  values meaning no further work is expected, whatever the outcome
#   expected: true  → a well-filed card carries this; the triage axis is built
#            from it
#   inverse: what the other end of a relation is called — \`parent\` is answered by
#            children. Omit it and the relation gets an editable row and no
#            derived one, which is right: nothing computes an inverse it has no
#            word for
#   hue:     which family this axis draws in — orange green purple blue pink red
#            yellow, or omitted for no colour at all. \`pj check\` rejects a family
#            that is not one of those, rather than drawing it grey. A bucket may declare one
#            too, and it wins for a chip in that bucket, drawn filled rather than
#            tinted. The palette is the app's; the choice is yours
#   blocking: true  → while this axis is unsatisfied the card cannot proceed, and
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
# the group/sort/facet pickers, and the order of the rows in a card's panel. The
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
# is \`project\`, which is built in — its definition is not read from this file, so
# declaring it does nothing and \`pj check\` says so.

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

priority:
  label: Priority
  values: [now, month, backlog, someday]
  open: false
  single: true
  expected: true
  hue: orange

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

# Somebody else's move. A blocking facet, so it lands on the blocked axis beside
# the dependency relation — while it holds any value at all, this card is parked.
# A label rather than a ref because a person does not *complete*: you clear the
# axis, you do not mark them closed.
waiting_on:
  label: Waiting on
  values: []
  open: true
  blocking: true
  hue: yellow

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

# What must finish before this card can move. Stored on the card that is stuck,
# pointing at what it is stuck on — the same direction as parent and project, and
# the card you open when you are stuck is the card you note it on. The inverse,
# what this card holds up, is derived and drawn beside it.
#
# Its transitive closure is what the blocked axis and views/unblocked.yaml are
# built from. Not worth grouping a board by.
blocked_by:
  label: Blocked by
  type: ref
  blocking: true
  hue: red
  inverse: Blocks
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
`,
  },
  {
    path: 'due.yaml',
    body: `# Deadlines, soonest first. \`due\` is an ordered facet: it declares its own
# buckets, computed against today, so this view never goes stale. The filter is
# what keeps undated cards out — there is no separate policy for that.
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
    body: `# Every note as a graph, laid out from the roots.
shape: canvas
title: Everything
show: [parent, blocked_by]
`,
  },
];
