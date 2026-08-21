---
name: cockpit
description: How to read and write cockpit cards — the markdown card database that backs the board, canvas and table views. Use whenever a request involves cards, projects, facets, the board, the canvas, or the `ck` CLI: creating a card, changing its facets or project, linking a Jira issue / PR / Claude session / doc, finding what to work on next, or answering "what's on my plate". Also read this before hand-editing any card file.
---

# Cockpit

A personal work-management app. One markdown card database, projected as a board, a mind-map canvas or
a table — whichever the current query asks for. Full spec: `cockpit/README.md` — authoritative if
anything here disagrees.

**Cards are plain files.** You can create and edit them directly with Write/Edit and no app running.
Prefer `ck` when a command exists, because it validates and keeps formatting consistent.

```bash
alias ck='node "$PWD/src/cli/ck.ts"'   # from the cockpit project root
```

## The model, in four facts

1. **Facets are arrays, and some hold one value.** Every value is an array, even when there is one. A
   card with two values for a grouped facet appears in two board columns — that is the model working.
   A facet declared `single: true` refuses a second value instead: `priority`, `status`, `kind`,
   `energy` and `owner` are single, because holding two at once is incoherent rather than expressive.
2. **`project` is a reference facet** — `ref: true`, so its values are record **ids**.
   `project: [project-d, mapping]` means the card belongs to both and inherits the repos and instructions
   of both. Being a reference makes it traversable as well as filterable: it draws on a canvas, walks
   under `--focus ... --via project`, and refuses a cycle. A project has no separate key.
3. **`parent` is a reference facet too** — "this card is part of that one". Single-valued, drawn by the
   canvas, and it carries **no config**: repos and instructions come through `project` alone. The two
   are independent, so a card may have either, both or neither. Set it with `--parent X`, which is
   `--facet parent=X` spelled the way it reads. `blocks` is the third, and powers `ck next`.
4. **There is no `kind`.** A record is not a class of thing. Whether it is work is whether it carries a
   `status` — which is what keeps a grouping record off a status-filtered board — and whether it
   contains anything is whether anything names it as a `parent`. Only `id` and `title` are required.
5. **Nothing derivable is stored.** `blocked` comes from an unfinished `blocks` edge and `waiting`
   from a non-empty `waiting_on`; neither is a status. `status` is lifecycle only.
6. **A facet declares a `type`** — `label` (the default), `ref`, `date` or `number`. `due` is a date
   facet: `ck set <id> --facet due=2026-09-01`, cleared with `--facet due=`. An ordered facet presents
   **buckets** on an axis and compares raw values, so `--filter due=overdue` and
   `--filter due=">2026-09-01"` are both valid and mean different things.

## Reading

```bash
ck context <id>              # everything: facets, project chain, repos, instructions, links, body
ck context <id> --json       # same, machine-readable
ck show <id>                 # compact
ck ls --group project        # or any facet
ck ls --focus project-a --via project --dir in    # the whole portfolio, transitively
ck ls --focus project-a --via parent --dir in     # everything decomposed under it
ck ls --group parent                        # or filter parent=X, or parent=(none)
ck ls --filter linked=jira                  # which records carry a Jira link
                                            # out = follows references, in = referenced by
ck ls --filter status=active,planning
ck next                      # open cards with no unfinished blocker
ck untriaged --json          # cards missing project/priority/status, and why
ck next                      # actionable now: deadline first, then priority
ck log --since "1 week ago"  # what actually changed, out of git
ck search <query>
ck project <id>              # just the resolved project config
ck enrich <ref> --force      # resolve a link's live state
```

`ck context` is the right first move for almost any question about a card. It already resolves the
project chain, the inherited repos and instructions, and the cached link enrichment — do not
re-derive those by reading files.

## Writing

```bash
ck add "<title>" [--id slug] [--facet f=v] [--link ref] [--parent id] [--fingerprint fp] [--body text]
ck set <id>... [--title t] [--facet f=v] [--add f=v] [--remove f=v] [--parent id|none]
ck set <id> --set project.jira=PROJ --set 'project.repos=[{path: ~/x, base: main}]'
ck set <id> --set 'project={}'      # this is how a record becomes a project
ck rm <id>...                       # deletes, dropping every reference pointing at it
ck link <id> <ref> [...]
ck link-session <id>         # link the live Claude session working in this directory
ck check                     # validate everything; run this after a batch of edits
```

`--facet` replaces a facet's values, `--add`/`--remove` adjust them. `--fingerprint` makes a create
idempotent: a fingerprint already present short-circuits, so a sweep run twice converges instead of
refilling the inbox.

## Rules that matter

- **An unknown flag is an error.** `ck` used to drop them silently, so a typo looked like success.
- **Closed facets reject unknown values.** `priority` is `now|month|backlog|someday`; `status` is
  `planning|active|frozen|done|dropped`; `energy` is `deep|shallow|decide|delegate`. Check
  `cockpit/data/facets.yaml` before inventing a value; `ck set` will refuse anyway.
- **Never write `status: blocked` or `status: waiting`.** They are not values. If something is
  blocked by another card, add a `blocks` edge from the blocker; if it is waiting on a person, set
  `waiting_on`. Both surface on the `blocked` axis without being stored twice.
- **`dropped` is how you reject a captured card**, not deletion. Deleting it destroys the
  `source_fingerprint` too, so the next `/capture` sweep creates it again.
- **`layer` (L2–L6) is Project A taxonomy.** Nothing enforces where it is used; do not put it on a card
  outside Project A.
- **Never set a `project` value with no matching project record.** Either use an existing id or
  propose creating the record — do not invent membership that resolves to nothing.
- **Positions are never on a card.** Canvas `x/y` lives in `cockpit/data/views/canvas/*.yaml`.
- **Everything external is read-only.** Never write to Jira, GitHub, Trello or Slack from a card
  operation. Links are references, not copies.

## Link kinds

`jira:PROJ-303` · `gh:pr:ORG/repo#412` · `gh:branch:ORG/repo@name` · `gh:commit:ORG/repo@sha` ·
`claude:<transcript-uuid>` · `doc:relative/path.md` · `slack:<permalink>` · a bare `https://…`

A kind exists when something resolves it. Everything else — a Trello card, a calendar entry, a Grafana
dashboard — is a bare URL, with provenance in the `source` facet where it matters.

A `claude:` link takes the **transcript uuid** — the filename under `~/.claude/projects/<slug>/`.
A `local_…` id comes from the desktop app's store, is not on disk, and will not resolve.

## Don't compute what a query already answers

Board badges, blocker state, progress counts and "what's actionable" are SQL over the index, not
judgement calls. Ask `ck` and report what it says. Narrate; do not decide.
