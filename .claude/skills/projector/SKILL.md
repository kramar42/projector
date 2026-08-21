---
name: projector
description: How to read and write everything in a projector vault — the markdown cards, the facet vocabulary in facets.yaml, and the saved views. Use whenever a request involves cards, projects, facets, views, the board, the canvas, the table, or the `pj` CLI: creating a card, changing its facets or project, adding or changing a facet axis, writing or fixing a saved view, linking a Jira issue / PR / Claude session / doc, finding what to work on next, or answering "what's on my plate". Read this before hand-editing any file in a vault — it is the only place the card format is written down.
---

# Projector

A personal work-management app. One markdown card database, projected as a board, a mind-map canvas or
a table — whichever the current query asks for. The project's `README.md` describes the app; **this file is
where the card format itself is written down**, so nothing in a vault restates it.

**A vault holds three editable things**, and this skill covers all three:

| | | |
|---|---|---|
| `cards/*.md` | the records | mostly `pj` |
| `facets.yaml` | the vocabulary — which axes exist, in what order | hand-edit |
| `views/*.yaml` | saved queries and their arrangement | hand-edit |

**`<vault>` below is whichever folder is in play — never a path written down here.** `pj` resolves it
the way git finds a repository: `--vault <path>` wins, then `$PROJECTOR_DATA`, then a walk up from the
working directory, then the single registered vault. Ask `pj` rather than assuming:

```bash
pj vaults                    # the registered ones, and where each lives
pj --help                    # its header names the vault this invocation would act on
```

If several are registered and the request does not say which, **ask the user** — `pj` itself refuses to
guess here, and so should you: acting on the wrong vault writes real records into the wrong database.

Everything is plain files: create and edit them with Write/Edit, no API and no running app. Prefer `pj`
for cards, because it validates and keeps formatting consistent. Run `pj check` after any batch.

```bash
alias pj='node "$PWD/src/cli/pj.ts"'   # from the projector project root
```

## The model, in six facts

1. **Facets are arrays, and some hold one value.** Every value is an array, even when there is one. A
   card with two values for a grouped facet appears in two board columns — that is the model working.
   A facet declared `single: true` refuses a second value instead: `priority`, `status`, `energy`,
   `owner`, `parent` and `due` are single, because holding two at once is incoherent rather than
   expressive.
2. **`project` is a reference facet** — `type: ref`, so its values are record **ids**.
   `project: [project-d, mapping]` means the card belongs to both and inherits the repos and instructions
   of both. Being a reference makes it traversable as well as filterable: it draws on a canvas, walks
   under `--focus ... --via project`, and refuses a cycle. A project has no separate key.
3. **`parent` is a reference facet too** — "this card is part of that one". Single-valued, drawn by the
   canvas, and it carries **no config**: repos and instructions come through `project` alone. The two
   are independent, so a card may have either, both or neither. Set it with `--parent X`, which is
   `--facet parent=X` spelled the way it reads. `blocks` is the third, and powers `pj next`.
4. **There is no `kind`.** A record is not a class of thing. Whether it is work is whether it carries a
   `status` — which is what keeps a grouping record off a status-filtered board — and whether it
   contains anything is whether anything names it as a `parent`. Only `id` and `title` are required.
5. **Nothing derivable is stored.** `blocked` comes from an unfinished `blocks` edge and `waiting`
   from a non-empty `waiting_on`; neither is a status. `status` is lifecycle only.
6. **A facet declares a `type`** — `label` (the default), `ref`, `date` or `number`. `due` is a date
   facet: `pj set <id> --facet due=2026-09-01`, cleared with `--facet due=`. An ordered facet presents
   **buckets** on an axis and compares raw values, so `--filter due=overdue` and
   `--filter due=">2026-09-01"` are both valid and mean different things.

## Reading

```bash
pj context <id>              # everything: facets, project chain, repos, instructions, links, body
pj context <id> --json       # same, machine-readable
pj show <id>                 # compact
pj ls --group project        # or any facet
pj ls --focus project-a --via project --dir in    # the whole portfolio, transitively
pj ls --focus project-a --via parent --dir in     # everything decomposed under it
pj ls --group parent                        # or filter parent=X, or parent=(none)
pj ls --filter linked=jira                  # which records carry a Jira link
                                            # out = follows references, in = referenced by
pj ls --filter status=active,planning
pj next                      # open cards with no unfinished blocker
pj untriaged --json          # cards missing project/priority/status, and why
pj next                      # actionable now: deadline first, then priority
pj log --since "1 week ago"  # what actually changed, out of git
pj search <query>
pj project <id>              # just the resolved project config
pj enrich <ref> --force      # resolve a link's live state
```

`pj context` is the right first move for almost any question about a card. It already resolves the
project chain, the inherited repos and instructions, and the cached link enrichment — do not
re-derive those by reading files.

## Writing

```bash
pj add "<title>" [--id slug] [--facet f=v] [--link ref] [--parent id] [--fingerprint fp] [--body text]
pj set <id>... [--title t] [--facet f=v] [--add f=v] [--remove f=v] [--parent id|none]
pj set <id> --set project.jira=PROJ --set 'project.repos=[{path: ~/x, base: main}]'
pj set <id> --set 'project={}'      # this is how a record becomes a project
pj rm <id>...                       # deletes, dropping every reference pointing at it
pj link <id> <ref> [...]
pj link-session <id>         # link the live Claude session working in this directory
pj check                     # validate everything; run this after a batch of edits
```

`--facet` replaces a facet's values, `--add`/`--remove` adjust them. `--fingerprint` makes a create
idempotent: a fingerprint already present short-circuits, so a sweep run twice converges instead of
refilling the inbox.

## Rules that matter

- **An unknown flag is an error.** `pj` used to drop them silently, so a typo looked like success.
- **Closed facets reject unknown values.** `priority` is `now|month|backlog|someday`; `status` is
  `planning|active|frozen|done|archived`; `energy` is `deep|shallow|decide|delegate`. Check
  `<vault>/facets.yaml` before inventing a value; `pj set` will refuse anyway.
- **Never write `status: blocked` or `status: waiting`.** They are not values. If something is
  blocked by another card, add a `blocks` edge from the blocker; if it is waiting on a person, set
  `waiting_on`. Both surface on the `blocked` axis without being stored twice.
- **`archived` is how you retire a captured card**, not deletion. Deleting it destroys the
  `source_fingerprint` too, so the next `/pj-capture` sweep creates it again.
- **`layer` (L2–L6) is Project A taxonomy.** Nothing enforces where it is used; do not put it on a card
  outside Project A.
- **Never set a `project` value with no matching project record.** Either use an existing id or
  propose creating the record — do not invent membership that resolves to nothing.
- **Positions are never on a card.** Canvas `x/y` lives in `<vault>/views/canvas/*.yaml`.
- **Everything external is read-only.** Never write to Jira, GitHub, Trello or Slack from a card
  operation. Links are references, not copies.

## The vocabulary — `facets.yaml`

Three things live in a vault, and cards are only one. **`facets.yaml` is the vocabulary**: which axes
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

- **`type` decides everything else.** `label` is a member of the declared list; `ref` is a record id,
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
Removing one leaves the values on the cards — `pj check` then reports them as unknown rather than
dropping them, which is the behaviour you want when a rename is half-done.

**Five axes are computed and are *not* in this file** — `type`, `blocked`, `triage`, `staleness`,
`linked`. Each reads something a facet cannot describe: a `project:` block, the reference graph, an
absence, a record's links, the app-written `updated`. They filter and group exactly like declared
facets. Never try to write one onto a card.

## Views — `views/*.yaml`

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
uncategorised: end            # end · start · hide — where the (none) group goes
show: [project, tech]         # which facets this view surfaces, in order
```

**The two halves are not the same kind of thing.** Everything above is *derivable*, so it is also a
live control in the UI. `nodes` (canvas x/y) and `order` (card order within a column) are hand-curated
**arrangement**, and exist only in a saved file — which is why an ad-hoc query cannot hold a layout.

- **`show` is one list and its order matters.** How each facet is drawn follows from what it is: a
  label facet is a chip and a table column; a reference facet is that *and* a line on a canvas — and
  **the first reference facet in `show` is what a canvas lays out by**. `show: [parent, blocks]` is a
  decomposition tree with blockers drawn across it; `show: [project]` is the portfolio. Get this wrong
  and the canvas puts every node in one column with the hierarchy invisible.
- **Never hand-edit `nodes` or `order`.** The app merges them by id on save, so it never drops the
  position of a card the current filter happens to hide. A wholesale rewrite loses exactly that.
- **An absent key means "inherit".** The server merges a saved view *under* the URL's parameters, so
  clearing something needs an explicit empty value — deleting the key lets the saved one back.
- **`(none)` is written as `(none)`**, never as a bare `none`, so a facet that one day has a literal
  value `none` cannot collide with the absence refinement.

Read one with `pj ls --view <name>`; the flags mirror the keys exactly. There is no CLI to write one —
create the file, and confirm it by opening it: `pj ls --view <name>`.

## Link kinds

`jira:PROJ-303` · `gh:pr:ORG/repo#412` · `gh:branch:ORG/repo@name` · `gh:commit:ORG/repo@sha` ·
`claude:<transcript-uuid>` · `doc:relative/path.md` · `slack:<permalink>` · a bare `https://…`

A kind exists when something resolves it. Everything else — a Trello card, a calendar entry, a Grafana
dashboard — is a bare URL, with provenance in the `source` facet where it matters.

A `claude:` link takes the **transcript uuid** — the filename under `~/.claude/projects/<slug>/`.
A `local_…` id comes from the desktop app's store, is not on disk, and will not resolve.

## Don't compute what a query already answers

Board badges, blocker state, progress counts and "what's actionable" are SQL over the index, not
judgement calls. Ask `pj` and report what it says. Narrate; do not decide.
