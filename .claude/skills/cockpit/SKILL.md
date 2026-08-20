---
name: cockpit
description: How to read and write cockpit cards — the markdown card database in work/cockpit/data that backs the personal board and mind-map canvas. Use whenever a request involves cards, projects, facets, the board, the canvas, or the `ck` CLI: creating a card, changing its facets or project, linking a Jira issue / PR / Claude session / doc, finding what to work on next, or answering "what's on my plate". Also read this before hand-editing any file under cockpit/data/cards/.
---

# Cockpit

A personal work-management app. One markdown card database, projected as a kanban board and a
mind-map canvas. Full spec: `cockpit-plan.md` in the work root — authoritative if anything here
disagrees.

**Cards are plain files.** You can create and edit them directly with Write/Edit and no app running.
Prefer `ck` when a command exists, because it validates and keeps formatting consistent.

```bash
alias ck='node /Users/you/Code/work/cockpit/src/cli/ck.ts'
```

## The model, in four facts

1. **Facets are multi-valued.** Every value is an array, even when there is one. A card with two
   values for a grouped facet appears in two board columns — that is the model working.
2. **`project` is an ordinary facet.** `project: [project-d, mapping]` means the card belongs to both and
   inherits the repos and instructions of both. Values are keys of records carrying a `project:`
   block. It is *not* derived from anything.
3. **`parent` edges mean decomposition** — "this card is part of that one". They are what the canvas
   draws and they carry no config. Independent of `project`: a card may have either, both or neither.
4. **`kind`** is `card` (work, appears on boards) or `node` (a thought, canvas only).

## Reading

```bash
ck context <id>              # everything: facets, project chain, repos, instructions, links, body
ck context <id> --json       # same, machine-readable
ck show <id>                 # compact
ck ls --group project        # or any facet
ck ls --filter status=active,planning
ck next                      # open cards with no unfinished blocker
ck untriaged --json          # cards missing project/priority/status, and why
ck search <query>
ck project <id>              # just the resolved project config
ck enrich <ref> --force      # resolve a link's live state
```

`ck context` is the right first move for almost any question about a card. It already resolves the
project chain, the inherited repos and instructions, and the cached link enrichment — do not
re-derive those by reading files.

## Writing

```bash
ck add "<title>" [--facet f=v] [--link ref] [--parent id] [--fingerprint fp] [--body text]
ck set <id> [--title t] [--facet f=v] [--add f=v] [--remove f=v] [--parent id|none]
ck link <id> <ref> [...]
ck link-session <id>         # link the live Claude session working in this directory
ck check                     # validate everything; run this after a batch of edits
```

`--facet` replaces a facet's values, `--add`/`--remove` adjust them. `--fingerprint` makes a create
idempotent: a fingerprint already present short-circuits, so a sweep run twice converges instead of
refilling the inbox.

## Rules that matter

- **Closed facets reject unknown values.** `priority` is `now|month|backlog|someday`; `status` is
  `planning|active|waiting|blocked|frozen|done`; `energy` is `deep|shallow|decide|delegate`. Check
  `cockpit/data/facets.yaml` before inventing a value; `ck set` will refuse anyway.
- **`layer` (L2–L6) only applies beneath `project-a`.** It is Project A taxonomy, not a global axis.
- **Never set a `project` value with no matching project record.** Either use an existing key or
  propose creating the record — do not invent membership that resolves to nothing.
- **Positions are never on a card.** Canvas `x/y` lives in `cockpit/data/views/canvas/*.yaml`.
- **Everything external is read-only.** Never write to Jira, GitHub, Trello or Slack from a card
  operation. Links are references, not copies.

## Link kinds

`jira:PROJ-303` · `gh:pr:ORG/repo#412` · `gh:branch:ORG/repo@name` · `gh:commit:ORG/repo@sha` ·
`claude:<transcript-uuid>` · `doc:relative/path.md` · `slack:<permalink>` · `trello:<url>` ·
`cal:<id>` · `grafana:<url>` · a bare `https://…`

A `claude:` link takes the **transcript uuid** — the filename under `~/.claude/projects/<slug>/`.
A `local_…` id comes from the desktop app's store, is not on disk, and will not resolve.

## Don't compute what a query already answers

Board badges, blocker state, progress counts and "what's actionable" are SQL over the index, not
judgement calls. Ask `ck` and report what it says. Narrate; do not decide.
