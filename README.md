# projector

[![CI](https://github.com/kramar42/projector/actions/workflows/ci.yml/badge.svg)](https://github.com/kramar42/projector/actions/workflows/ci.yml)

Work scatters. The issue tracker holds the shared work, email and chat hold the asks, markdown
notes hold the thinking — and the picture of what to do next lives in none of them. projector is a
personal work-management app for exactly that: one database of markdown notes, drawn as a
**board**, a **mind-map canvas** or a **table** — whichever the current question asks for — with
read-only inline views of Jira issues, GitHub PRs, Claude sessions and local docs.

The name is the pun it looks like. A **project** is a collection of items with a shared context. A
**projection** is one way of looking at something that has more dimensions than any single view can
show. The app is named after doing both.

**The same query, three shapes.** Planning starts on the board:

![Open work grouped by priority, as a board](docs/img/board.png)

Too many cards to scan at once, and the table is the natural summary — same filter, same grouping,
one control changed:

![The same query as a table](docs/img/table.png)

Deciding what to pick up next is a question about relations, so the same query again as a canvas —
`parent` lays out the tree, and the unfinished blocker is the dashed red edge:

![The same query as a canvas](docs/img/canvas.png)

## Why it exists

My work lives in systems that are also everyone else's: the issue tracker is where I work with
other people, email and messages are personal communication and asks, a folder of markdown captures
my notes. On top of those I used Trello for priorities and projects, Excalidraw and Miro for
high-level design, and reached for a table whenever a board grew past what one screen could show. Each
tool held a fragment; none of them was the truth; and Trello's real limit named the whole problem —
a card is stuck to its list. There is no *projection*: no way to keep the notes and change the
view.

Capturing everything made it worse before it made it better. A system that captures everything
greets you every morning with a hundred-item list, and I drowned in mine. So filtering things *out*
is not a convenience here, it is the point: a view that shows one project's actionable cards — open,
nobody waited on, no unfinished blocker — is the difference between a system that extends your
attention and one that spends it.

Being able to switch the shape without touching the rest of the view looks like a gimmick until you
live with it. It means no way of looking at the notes is privileged: the board when planning, the
table when there are too many cards, the canvas when the question is how things relate. Same notes,
same filter, one control moved.

The files are markdown because text is king: readable by people and by machines, diffable through
git, composable, open, independent of any program — this one included. There is no lock-in to
regret because there is nothing to be locked into.

And nothing is ever written back to Jira, GitHub, Trello or Slack, which a stranger reads as a
missing feature until it is said plainly: this is a *personal* context layer, and it should be
invisible to everyone else. It extends my brain — a card carries the text, the facets, the links
and the refs, so I do not have to remember that these three Slack messages are about that Jira
issue. The systems other people see stay exactly as they were.

The whole loop: **capture → triage → project** *(the verb)* **→ work** — and because projects nest
and combine context, by the time work starts the context is as full as it can be.

Three promises shape everything else:

- **your markdown files are the source of truth** — every index is derived and disposable; delete it
  and nothing is lost
- **nothing is ever written back** to Jira, GitHub, Trello or Slack. Everything external is read-only
- **the vocabulary is yours** — which axes a note can carry, and what each one means, are declared in
  your vault rather than built into the app

## Install

[Bun](https://bun.com) or Node 24+. Nothing is compiled ahead of time except the web UI, so there is
no build step for the server or the CLI.

```bash
git clone https://github.com/kramar42/projector && cd projector
bun install
bun run build && bun run serve
```

Then open <http://127.0.0.1:8092>. On first run it asks for a folder; point it at an empty one and it
sets itself up — a starter vocabulary and a few saved views under `.projector/`, and a `.gitignore`
for the caches. Your notes go in the folder itself. One process, one URL: the server serves the built UI.

The CLI needs nothing running:

```bash
alias pj="bun '$PWD/src/cli/pj.ts'"   # from the project root: the outer quotes freeze the path
pj ls --group priority                # now run it from inside any vault
```

**Nothing here is pinned to Bun.** The package scripts spell `node`, because Node is the floor
`engines` promises; Bun runs them because `bun run` substitutes itself for `node`. So the runtime is
whichever launcher you type — `bun run serve`, `node --run serve` and `pnpm serve` are the same script
on three runtimes, and `npm`, `pnpm` and `yarn` all install it. CI exercises every combination; see
[Toolchain](docs/MANUAL.md#toolchain) for the one command that is an exception and why.

## The words

Six terms carry the rest.

| | |
|---|---|
| **note** | one markdown file in the vault, and the only kind of thing a vault holds |
| **facet** | an axis a note carries values on — `status`, `priority`, `parent` — declared in `facets.yaml`. Every value is an array |
| **project** | a note carrying a block of configuration that its members inherit |
| **view** | a saved query, and how it is drawn |
| **shape** | `board`, `canvas` or `table`. A view is a query; the shape is one field of it |
| **vault** | a folder of markdown, with the vocabulary and the saved views under `.projector/` |

One mark worth knowing before the first minute on screen: an axis labelled `ƒ` is *computed* from
the notes — blocked, triage, staleness — never stored on them.

The full glossary is at the top of [docs/MANUAL.md](docs/MANUAL.md), which defines every word the app,
the docs and the CLI use.

## What it does

**Everything is a query.** A view is `filter × search × focus × group × sort × shape`. Grouping a
board by project and grouping it by priority are the same board with one control moved, not two
boards to keep in step — and changing the shape draws the same notes as a canvas.

**No facet is privileged.** Relations — `parent`, `blocked_by`, `project` — are facets whose values
happen to be note ids, so they filter, group and sort like every other axis. That is what makes a
mind-map leaf and a tracked task the same file.

**Links point outward, and only outward.** A note can carry a Jira issue, a GitHub PR, a Claude
session or a local doc. Each is fetched, cached and shown inline, and none is ever written to.

**An agent is a first-class writer — at the points of leverage.** Notes are plain files, so a Claude
session creates and edits them directly: no API, nothing running. The agent is used where judgement
pays — sweeping the intake, filling in facets, triage — and deliberately not where determinism does:
enrichment is plain fetching, and every count on screen is computed, never guessed.

**The vocabulary makes it extensible.** Facets are declared per vault, so every vault tracks exactly
what its domain needs; link kinds and their enrichments, intake sources, even shapes — a calendar, a
timeline — are additions to a registry, not rewrites.

## Documentation

| | |
|---|---|
| [docs/MANUAL.md](docs/MANUAL.md) | how to use it — the model, the query language, the shapes, the CLI, the keymap, the file format |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how it works inside, and the invariants to keep when changing it |
| [docs/DESIGN.md](docs/DESIGN.md) | the visual system — palette, type scale, the rules components follow |
| [docs/PRODUCT.md](docs/PRODUCT.md) | who it is for, and why |
| [docs/NEXT.md](docs/NEXT.md) | what is deliberately not being done, and why |
| [CLAUDE.md](CLAUDE.md) | working in this repo with an agent |

[docs/README.md](docs/README.md) is the map, if you would rather start there.

## Status

A single-user personal project, dogfooded daily. It runs on your own machine against your own
files: no server, no account, no telemetry. Desktop-only by construction — there are no breakpoints
and no responsive layout at all. There is no release, no packaging, no support, and no promise yet
that the file format is stable — though because the files are plain markdown, the worst case is a
folder of notes you can read anywhere.

## License

[0BSD](LICENSE) — do whatever you like with it, no attribution required.
