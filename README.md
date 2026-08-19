# cockpit

Personal work-management app. One card database in markdown files, projected as a board and a
mind-map canvas. Spec: [`../cockpit-plan.md`](../cockpit-plan.md) — that file is authoritative.

**Status: P1 complete.** Schema, indexer, validator, project resolution, both importers, and a
read-only app with a board view and a mind-map canvas over the same cards.

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
| the server, every endpoint | `data/.index.db` only | there is no write endpoint; the app is read-only in P1 |

There is no code path in this repo that writes to Jira, GitHub, Trello, Slack or any other external
system, and no network call of any kind yet. A mutating request is additionally refused when it carries
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
