---
name: pj-about
description: How to read and write everything in a projector vault — the markdown notes, the facet vocabulary in facets.yaml, and the saved views. Use whenever a request involves notes, projects, facets, views, the board, the canvas, the table, or the `pj` CLI: creating a note, changing its facets or project, adding or changing a facet axis, writing or fixing a saved view, linking a Jira issue / PR / Claude session / doc, finding what to work on next, or answering "what's on my plate". Read this before hand-editing any file in a vault — it is the only place the note format is written down.
---

# Projector

A personal work-management app. One markdown note database, projected as a board, a mind-map canvas or
a table — whichever the current query asks for. The project's `README.md` describes the app; **this file is
where the note format itself is written down**, so nothing in a vault restates it.

**A vault is a folder of markdown.** The notes sit at its root, at any depth; everything the app owns
is under `.projector/`. This skill covers all three editable things:

| | | |
|---|---|---|
| `<vault>/**/*.md` | the notes | mostly `pj` |
| `<vault>/.projector/facets.yaml` | the vocabulary — which axes exist, in what order | hand-edit |
| `<vault>/.projector/views/*.yaml` | saved queries and their arrangement | hand-edit |

**Every markdown file is a note, with no exceptions** — a `README.md` included, and one in a
subfolder. Folders are the user's to arrange and mean nothing to the app.

**A note with no frontmatter is still a note.** Its id is its filename lowercased with everything else
turned to dashes, and its title is its leading `# Heading`, or the filename if there is none. Do not
"fix" such a file by adding frontmatter to it: the derived identity is deliberate, and any `pj` write
writes down the same id anyway. The one thing to know is that until that happens, **renaming the file
renames the card** — so if other notes reference it, use `pj` rather than a rename.

**`<vault>` below is whichever folder is in play — never a path written down here.** `pj` resolves it
the way git finds a repository: `--vault <path>` wins, then `$PROJECTOR_DATA`, then a walk up from the
working directory, then the single registered vault. Ask `pj` rather than assuming:

```bash
pj vaults                    # the registered ones, and where each lives
pj --help                    # its header names the vault this invocation would act on
```

If several are registered and the request does not say which, **ask the user** — `pj` itself refuses to
guess here, and so should you: acting on the wrong vault writes real notes into the wrong database.

Everything is plain files: create and edit them with Write/Edit, no API and no running app. Prefer `pj`
for notes, because it validates and keeps formatting consistent. Run `pj check` after any batch.

```bash
alias pj="bun '$PWD/src/cli/pj.ts'"   # from the projector project root: freezes the path
```

## The model, in six facts

1. **Facets are arrays, and some hold one value.** Every value is an array, even when there is one. A
   note with two values for a grouped facet appears in two board columns — that is the model working.
   A facet declared `single: true` refuses a second value instead: `priority`, `status`, `energy`,
   `owner`, `parent` and `due` are single, because holding two at once is incoherent rather than
   expressive.
2. **`project` is a reference facet** — `type: ref`, so its values are note **ids**.
   `project: [project-d, mapping]` means the note belongs to both and inherits the repos and instructions
   of both. Being a reference makes it traversable as well as filterable: it draws on a canvas, walks
   under `--focus ... --via project`, and refuses a cycle. A project has no separate key.
3. **`parent` is a reference facet too** — "this note is part of that one". Single-valued, drawn by the
   canvas, and it carries **no config**: repos and instructions come through `project` alone. The two
   are independent, so a note may have either, both or neither. Set it with `--facet parent=X`; there
   is no `--parent` flag any more, because no relation gets a flag of its own. `blocked_by` is the
   third, and powers the `unblocked` view.
4. **There is no `kind`.** A note is not a class of thing. Whether it is work is whether it carries a
   `status` — which is what keeps a grouping note off a status-filtered board — and whether it
   contains anything is whether anything names it as a `parent`. Only `id` and `title` are required.
5. **Nothing derivable is stored.** The `blocked` axis names one value per facet declared
   `blocking:` — `blocked_by` when something it names is not `closed`, `waiting_on` when it holds any
   value at all. Neither is a status; `status` is lifecycle only.
   **`blocked_by` is stored on the note that is stuck**, pointing at what it is stuck on — the same
   direction as `parent` and `project`. Every reference in this model points at what the note
   depends on, so you note a blocker on the blocked note rather than on the blocker.
6. **A facet declares a `type`** — `label` (the default), `ref`, `date` or `number`. `due` is a date
   facet: `pj set <id> --facet due=2026-09-01`, cleared with `--facet due=`. An ordered facet presents
   **buckets** on an axis and compares raw values, so `--filter due=overdue` and
   `--filter due=">2026-09-01"` are both valid and mean different things.

## Reading

```bash
pj context <id>              # everything: facets, project chain, repos, instructions, links, body
pj context <id> --json       # same, machine-readable
pj ls --group project        # or any facet
pj ls --focus project-a --via project --dir in    # the whole portfolio, transitively
pj ls --focus project-a --via parent --dir in     # everything decomposed under it
pj ls --group parent                        # or filter parent=X, or parent=(none)
pj ls --filter linked=jira                  # which notes carry a Jira link
                                            # out = follows references, in = referenced by
pj ls --filter status=active,planning
pj ls --filter project=-project-a                 # everything *except* Project A — see below
pj ls --view unblocked       # actionable now: open, nobody waited on, no unfinished blocker
pj ls --view triage --json   # notes missing project/priority/status, grouped by what is missing
pj log --since "1 week ago"  # what actually changed, out of git
pj search <query>
pj enrich <ref> --force      # resolve a link's live state
```

**A filter value may be negated with `-`.** `--filter project=-project-a` is "everything except Project A", and it
is not the same query as naming every other project: it keeps the notes with no project at all, and it
stays true when a new project is created. Both halves apply on a multi-valued axis, so
`--filter project=project-a,-project-b` is the Project A work that is not also Project B. A bare `-` is a value, not a
negation.

`pj context` is the right first move for almost any question about a note. It already resolves the
project chain, the inherited repos and instructions, and the cached link enrichment — do not
re-derive those by reading files.

## Writing

```bash
pj add "<title>" [--id slug] [--facet f=v] [--link ref] [--fingerprint fp] [--body text]
pj set <id>... [--title t] [--facet f=v] [--add f=v] [--remove f=v]
pj set <id> --set project.jira=PROJ --set 'project.repos=[{path: ~/x, base: main}]'
pj set <id> --set 'project={}'      # this is how a note becomes a project
pj merge <id>... --into <id>         # folds notes into one; the survivor keeps its facets
pj rm <id>...                       # deletes, dropping every reference pointing at it
pj link <id> <ref> [...] [--remove]   # --remove takes the same refs off
pj link <id> --session       # link the live Claude session working in this directory
pj check                     # validate everything; run this after a batch of edits
```

`--facet` replaces a facet's values, `--add`/`--remove` adjust them. `--fingerprint` makes a create
idempotent: a fingerprint already present short-circuits, so a sweep run twice converges instead of
refilling the inbox.

## Rules that matter

- **An unknown flag is an error.** `pj` used to drop them silently, so a typo looked like success.
- **Closed facets reject unknown values.** `priority` is `now|month|backlog|someday`; `status` is
  `planning|active|on-hold|done|archived`; `energy` is `deep|shallow|decide|delegate`. Check
  `<vault>/.projector/facets.yaml` before inventing a value; `pj set` will refuse anyway.
- **Never write `status: blocked` or `status: waiting`.** They are not values. If something is blocked
  by another note, set `blocked_by` **on the blocked note** naming the blocker; if it is waiting on a
  person, set `waiting_on`. Both surface on the `blocked` axis, under their own facet names, without
  being stored twice.
- **`archived` is how you retire a captured note**, not deletion. Deleting it destroys the
  `source_fingerprint` too, so the next `/pj-capture` sweep creates it again.
- **Duplicates are merged, not deleted.** `pj merge <id>... --into <id>` when two notes turn out to be
  one thing: the survivor keeps its own facets, and the rest contribute their body (one `##` section
  each, titled with the note's title), their links, their references, and their fingerprints — which
  land in `absorbed_fingerprints:` on the survivor, so a sweep does not re-create what you just folded
  in. Deleting the duplicate instead loses all four. Everything that referenced an absorbed note is
  repointed at the survivor; a merge that would make a note reach itself is refused outright.
- **`layer` (L2–L6) is Project A taxonomy.** Nothing enforces where it is used; do not put it on a note
  outside Project A.
- **Never set a `project` value with no matching project note.** Either use an existing id or
  propose creating the note — do not invent membership that resolves to nothing.
- **Positions are never on a note.** Canvas `x/y` lives in `<vault>/.projector/views/*.yaml`.
- **Everything external is read-only.** Never write to Jira, GitHub, Trello or Slack from a note
  operation. Links are references, not copies.

## The vocabulary — `.projector/facets.yaml`

Three things live in a vault, and notes are only one. **`facets.yaml` is the vocabulary**: which axes
exist, what order their values come in, and what a value is allowed to be. It is the single place
column order lives — what list-order does in Trello, made explicit and shared by every view. Editing
it is how you add an axis; there is no CLI for it, so write the YAML.

```yaml
priority:
  label: Priority          # what the UI calls it. Defaults to the key
  values: [now, month, backlog, someday]   # declared order IS column order
  open: false              # false → the validator rejects anything not listed
  single: true             # at most one value at a time

due:
  label: Due
  type: date               # label (default) · ref · date · number
  buckets:                 # named ranges an ordered facet presents itself as
    overdue: -1            # inclusive upper bound, in days from today
    today: 0
    week: 7
  overflow: later          # anything past the last bucket
```

**Four rules, each of which the loader enforces rather than trusts:**

- **`type` decides everything else.** `label` is a member of the declared list; `ref` is a note id,
  which makes the facet traversable — it lays out a canvas, walks under `focus`, refuses a cycle;
  `date` is `YYYY-MM-DD`; `number` sorts numerically. An unrecognised `type` silently becomes `label`.
- **Only a `label` declares `values`.** A `ref`'s vocabulary is the vault and an ordered facet's is
  unbounded, so a `values:` list on either is **dropped**, not half-honoured — and `open` is forced
  true. Writing one is a mistake that fails quietly.
- **An ordered facet presents buckets and compares raw.** With `buckets`, filtering and grouping see
  `overdue · today · week · later`; sorting and a range filter (`--filter due=">2026-09-01"`) see the
  date. Bucket order comes from `buckets` + `overflow`, not from `values` — without that it fell
  through to alphabetical and put `later` first.
- **`open: false` is the only thing that rejects a value.** Defaults to false for `label`, true for
  everything else.

Adding an axis is two steps and no code: declare it here, then set it with `pj set <id> --facet f=v`.
Removing one leaves the values on the notes — `pj check` then reports them as unknown rather than
dropping them, which is the behaviour you want when a rename is half-done.

**Five axes are computed and are *not* in this file** — `type`, `blocked`, `triage`, `staleness`,
`linked`. Each reads something a facet cannot describe: a `project:` block, the reference graph, an
absence, a note's links, the app-written `updated`. They filter and group exactly like declared
facets. Never try to write one onto a note.

## Views — `.projector/views/*.yaml`

**A view is a query, not a place.** `view = filter × focus × shape × show`. The same file describes
what a URL and `pj ls` flags describe, so a saved view and a live query are the same object.

```yaml
shape: board                  # board · canvas · table
title: Home
filter:
  status: [planning, active]  # facet → any of these values. `(none)` matches absence
q: keycloak                   # full-text, optional
focus: { id: project-a, via: project, dir: in }   # dir: out · in · both, plus depth
groupBy: [priority]           # primary axis first; a second one draws lanes/sections
sort: [updated:desc]          # `facet:asc` ranks by declared order, not alphabetically
show: [project, tech]         # which facets this view surfaces, in order
```

**The two halves are not the same kind of thing.** Everything above is *derivable*, so it is also a
live control in the UI. `nodes` (canvas x/y) and `order` (note order within a column) are hand-curated
**arrangement**, and exist only in a saved file — which is why an ad-hoc query cannot hold a layout.

- **`show` is one list and its order matters.** How each facet is drawn follows from what it is: a
  label facet is a chip and a table column; a reference facet is that *and* a line on a canvas — and
  **the first reference facet in `show` is what a canvas lays out by**. `show: [parent, blocked_by]` is a
  decomposition tree with blockers drawn across it; `show: [project]` is the portfolio. Get this wrong
  and the canvas puts every node in one column with the hierarchy invisible.
- **Never hand-edit `nodes` or `order`.** The app merges them by id on save, so it never drops the
  position of a note the current filter happens to hide. A wholesale rewrite loses exactly that.
- **An absent key means "inherit".** The server merges a saved view *under* the URL's parameters, so
  clearing something needs an explicit empty value — deleting the key lets the saved one back.
- **`(none)` is written as `(none)`**, never as a bare `none`, so a facet that one day has a literal
  value `none` cannot collide with the absence refinement.

Read one with `pj ls --view <name>`; the flags mirror the keys exactly. There is no CLI to write one —
create the file, and confirm it by opening it: `pj ls --view <name>`.

## Link kinds

`jira:PROJ-303` · `gh:pr:ORG/repo#412` · `gh:branch:ORG/repo@name` · `gh:commit:ORG/repo@sha` ·
`claude:<transcript-uuid>` · `doc:relative/path.md` · `slack:<permalink>` · a bare `https://…`

A kind exists when something resolves it. Everything else — a Trello note, a calendar entry, a Grafana
dashboard — is a bare URL, with provenance in the `source` facet where it matters.

A `claude:` link takes the **transcript uuid** — the filename under `~/.claude/projects/<slug>/`.
A `local_…` id comes from the desktop app's store, is not on disk, and will not resolve.

## Don't compute what a query already answers

Board badges, blocker state, progress counts and "what's actionable" are SQL over the index, not
judgement calls. Ask `pj` and report what it says. Narrate; do not decide.
