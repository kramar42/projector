# cockpit

Personal work-management app. One card database in markdown files, projected as a board and a
mind-map canvas. Spec: [`../cockpit-plan.md`](../cockpit-plan.md) — that file is authoritative.

**Status: P0 complete.** Schema, indexer, validator, project resolution, and both importers. No UI yet.

## Two directories, two repos

| | |
|---|---|
| `cockpit/` | the app. Its own git repo |
| `cockpit/data/` | cards, facets, views. Its own git repo, ignored by the app's |

Data location resolves from `COCKPIT_DATA` → `cockpit.config.json` → `./data`, so it can be moved
without touching the code.

## Running

No build step: Node 26 runs the TypeScript directly.

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

## How it fits together

```
data/cards/*.md, facets.yaml, views/**   ← source of truth. Git-tracked, agent-editable
        │
        ▼
   readAll → validate → node:sqlite index (data/.index.db)
        │                    derived and disposable; ck reindex is always correct
        ▼
   ck  (P1 adds: hono server + SSE, React board and canvas)
```

The index is never authoritative. Nothing in it survives a `reindex`, and nothing needs to.

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

There is no code path in this repo that writes to Jira, GitHub, Trello, Slack or any other external
system, and no network call of any kind in P0. Every frontmatter write goes through
`writeCardFile`, which writes a temp file and renames, so a concurrent reader never sees half a file.

## What P0 deliberately leaves undone

- **43 cards have no project.** Trello's labels were empty, so there was nothing to migrate. This is
  the first real test of `/triage`, kept on purpose.
- **11 research cards are titled with a bare URL.** They need titles fetched.
- **Two PNG attachments** on `analyze-high-worker-cpu-levels` need a manual export — Trello's image
  URLs require an auth token. Each such card carries a checklist noting what to attach.
- `TODO.md`'s *Upcoming* section is not imported: those are dates, and belong on a calendar.
