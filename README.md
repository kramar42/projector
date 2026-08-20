# cockpit

Personal work-management app. One card database in markdown files, projected as a board and a
mind-map canvas. Spec: [`../cockpit-plan.md`](../cockpit-plan.md) — that file is authoritative.

**Status: P3 complete.** Everything above plus link enrichment: a Jira key, pull request, branch,
commit, Claude session or local doc resolves inline on the card.

## Two directories, two repos

| | |
|---|---|
| `cockpit/` | the app. Its own git repo |
| `cockpit/data/` | cards, facets, views. Its own git repo, ignored by the app's |

Data location resolves from `COCKPIT_DATA` → `cockpit.config.json` → `./data`, so it can be moved
without touching the code.

## Running

No build step for the server or CLI: Node 26 runs the TypeScript directly.

```bash
pnpm build && pnpm serve
```

Then open http://127.0.0.1:8092. One process, one URL — the server serves the built UI.

For frontend work, two processes with hot reload:

```bash
pnpm serve      # api on 8092
pnpm dev:web    # ui on 5176, proxies /api
```

Ports 8092 and 5176 are deliberately distinct from other local tools.

The CLI needs nothing running:

```bash
node src/cli/ck.ts ls --group priority
```

Worth an alias:

```bash
alias ck='node /Users/you/Code/work/cockpit/src/cli/ck.ts'
```

## Commands

| | |
|---|---|
| `ck ls [--group <facet>] [--filter f=v,v] [--nodes]` | list records, grouped by any facet |
| `ck show <id>` | one record, with its resolved project config |
| `ck next` | open cards with no unfinished blocker |
| `ck add <title> [--kind] [--parent] [--facet f=v] [--link ref]` | create a record |
| `ck link <id> <ref> …` | append links |
| `ck project <id>` | resolved project config and inherited instructions |
| `ck check` | validate every card file |
| `ck reindex` | rebuild the index from files |
| `ck search <query>` | full-text search |
| `ck import trello <file.json>` / `ck import todo <TODO.md>` | one-time imports |
| `ck stats` | index counts |

## Tests

```bash
node --test test/*.test.ts
```

## The two views

Both are projections of the same card files. Nothing is stored twice.

- **Board** — `views/board/*.yaml`. Columns come from `groupBy` over any facet, in the order declared
  in `facets.yaml`. A card whose grouped facet holds several values appears in every matching column;
  the header counts how many do.
- **Canvas** — `views/canvas/*.yaml`. A dagre tree over `parent` edges, with `blocks` drawn dashed and
  excluded from layout so it cannot distort the tree. `include.under` scopes to a subtree,
  `include.filter` to a facet query; ancestors of anything included are pulled in so the tree connects.

Records render at one of three sizes — `chip`, `card`, `expanded` — from **one** `<CardBody>`
component shared by both views, which is the reason React Flow was chosen: a canvas node is an
ordinary React component, so link chips and progress bars work there with no second implementation.

Size precedence is the node's own `size:`, then the canvas `defaultSize:`, then the record's nature
(plain nodes are chips, everything else a card). There is deliberately no rule that shrinks cards once
a canvas gets busy: that would make the same card look different depending on its neighbours, and past
a hundred records nothing is legible at fit-zoom in any size anyway.

Cards deep-link as `?card=<id>` on whichever view is open, so one can be pasted into Slack.

## Editing

| Where | What |
|---|---|
| Card panel | rename, toggle facet values, set parent, add/remove links, edit the body, promote/demote, delete |
| Board | drag between columns, `+` to create a card in a column, ⌘/⇧-click to select, bulk bar for the selection |
| Canvas | drag nodes and **Save layout**, drag handle-to-handle to create an edge, `+ node`, double-click to open |

**Drag semantics on a multi-valued facet.** A plain drag replaces the value the card came from. Holding
**⌥** on drop *adds* instead, so the card deliberately sits in two columns; **⇧** removes only the value
dragged from; dropping into `(none)` clears the facet. So "card in two columns" is always a gesture,
never an accident — the rules are unit-tested in `test/model.test.ts`.

**Project membership is an ordinary facet.** A card carries `project: [project-d, mapping]` and can belong
to several at once, inheriting the union of their repos and both instruction blocks. Nothing about
`project` is special: it drags, bulk-edits and groups through the same code path as `priority`.

**A parent edge means decomposition** — "this card is part of that one" — and is what the canvas draws.
It is independent of the project facet: a card may have either, both or neither.

**Bulk actions** are what make ~130 imported cards tractable: select with ⌘-click, then set a parent, set
or clear one facet, or delete, across the whole selection.

**Positions live in the canvas file**, never on a card, so the same card can sit at a different place on
each canvas. Saving a layout also flips that canvas to `layout: manual`.

**Conflicts are refused, not merged.** A card read into the panel carries its file mtime; a write sends
it back, and if the file changed meanwhile the server answers 409 and the panel shows a *changed on disk*
banner. Nothing is overwritten. The body editor likewise refuses to swallow an external change while
there is unsaved text.

## Enrichment

Strictly additive. A link renders as its parsed label, and enrichment replaces that with something
richer *if and when* it arrives. No view waits on it, no endpoint that serves cards knows it exists,
and deleting `src/enrich/` would leave the app behaving exactly as it did in P2.

| Kind | Source | Needs | TTL |
|---|---|---|---|
| `gh:pr` | `gh pr view --json` | the `gh` CLI, already authenticated | 5 min |
| `gh:branch` | `gh api` | — | 10 min |
| `gh:commit` | `gh api` | — | never (a commit does not change) |
| `claude` | `~/.claude/projects/**` + `~/.claude/sessions` | — | 1 min |
| `doc` | filesystem | — | 30 s |
| `jira` | Jira REST | `COCKPIT_JIRA_URL`, `COCKPIT_JIRA_EMAIL`, `COCKPIT_JIRA_TOKEN` | 15 min |
| `slack` `trello` `cal` `grafana` `url` | not fetched — parsed label only | — | — |

A Claude session link takes the **transcript uuid** — the filename under
`~/.claude/projects/<slug>/`. Enrichment gives its opening prompt, whether a process is currently
holding it, last activity, turn count, cwd, git branch, and the `claude --resume <uuid>` command to
pick it back up. An id of the form `local_<uuid>` comes from the desktop app's own store, is not on
disk, and says so rather than failing silently.

**Reads never block.** `POST /api/enrich` answers from cache immediately — possibly with nothing —
then fetches what is missing or stale in the background and emits an `enriched` server event, which is
deliberately separate from `change` so a chip resolving never makes a board rebuild itself. Failures
are cached too, so a ref that cannot resolve says why once instead of being retried on every render.

The cache is its own SQLite file, `data/.enrich.db`, not a table in the index: the index is derived
from the card files and rebuilt on every request, which would throw away network data on each read.

```bash
node src/cli/ck.ts enrich --all        # resolve every link on every card and print it
node src/cli/ck.ts enrich <ref> --force
```

## How it fits together

```
data/cards/*.md, facets.yaml, views/**   ← source of truth. Git-tracked, agent-editable
        │
        ▼
   readAll → validate → node:sqlite index (data/.index.db)
        │                    derived and disposable; ck reindex is always correct
        ▼
   hono: /api/meta /api/board/:name /api/canvas/:name /api/card/:id
        │                    reads the files on every request — no cache to invalidate
        ▼
   React: board │ canvas │ card panel   (P2 adds editing, a watcher and SSE)
```

The index is never authoritative. Nothing in it survives a `reindex`, and nothing needs to. The server
re-reads the files on each request, which at this scale costs milliseconds and means the app can never
disagree with what an agent just wrote.

## Safety inventory

C2 says everything external is read-only. Rather than leave that as a principle, here is every
operation in P0 that writes anything at all:

| Operation | Writes | Never |
|---|---|---|
| `ck add` | one new file under `data/cards/` | never overwrites an existing file |
| `ck link` | the `links` key of one card's frontmatter | never touches the body |
| `ck import …` | new card files; skips any id already present | never edits or deletes an existing card |
| `ck reindex`, `ck ls`, `ck next`, `ck search` | `data/.index.db` only | never touches a card file |
| `ck check`, `ck show`, `ck project` | nothing | — |
| server, GET routes | `data/.index.db` only | never touches a card file |
| `PATCH /api/card/:id` | one card's frontmatter, or its body when `body` is sent | a frontmatter change never touches body bytes |
| `POST /api/card` | one new card file | never overwrites an existing file |
| `DELETE /api/card/:id`, `POST /api/bulk` | card files, and edges that pointed at a deleted card | nothing outside `data/cards/` |
| `PUT /api/card/:id/edges` | one card's `edges` | refuses an edge that would create a parent cycle |
| `PATCH /api/canvas/:name` | one view file under `data/views/canvas/` | never touches a card |
| `POST /api/card/:id/asset` | one file under `data/cards/assets/<id>/` | never overwrites: the name is a content hash |
| `POST /api/enrich`, `/api/enrich/clear` | `data/.enrich.db` only | never touches a card; every fetcher is read-only — `gh pr view`, `gh api` GETs, Jira GETs, filesystem reads |

There is no code path in this repo that writes to Jira, GitHub, Trello, Slack or any other external
system. P3 adds the first outbound network calls, and they are all reads: `gh pr view`, `gh api` GETs,
and Jira `GET /rest/api/3/issue`. Fetchers export no mutation functions, so there is nothing to call. A mutating request is additionally refused when it carries
an `Origin` header that is not one of ours, since a localhost server is reachable from any page open in
the browser. Every frontmatter write goes through
`writeCardFile`, which writes a temp file and renames, so a concurrent reader never sees half a file.

## What P0 deliberately leaves undone

- **43 cards have no project.** Trello's labels were empty, so there was nothing to migrate. This is
  the first real test of `/triage`, kept on purpose.
- **11 research cards are titled with a bare URL.** They need titles fetched.
- **Two PNG attachments** on `analyze-high-worker-cpu-levels` need a manual export — Trello's image
  URLs require an auth token. Each such card carries a checklist noting what to attach.
- `TODO.md`'s *Upcoming* section is not imported: those are dates, and belong on a calendar.
