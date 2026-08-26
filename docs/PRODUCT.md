# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: one person on their own machine.** Someone running the app locally against a folder of
their own notes. They keep it **open all day on a second monitor** — the board or canvas
is ambient, glanced at and dragged on continuously, not visited for a session and closed.

**Second, and first-class: Claude agent sessions.** Notes are plain files, so an agent creates and
edits them directly through `pj` and the five `.claude/skills/` slash commands, with no API and no app
running. Both write the same vault; the agent is not a guest.

Two consequences future work must honour:

- the vocabulary has to be **reliably writable by an agent** — `open: false` and `single: true` exist
  because the thing writing most of these files is not a human;
- the interface is read **at desk distance, for hours** — legibility at a glance and sustained comfort
  in both themes are usage facts, not polish.

No third audience is planned. The documentation is written for a reader and the source is public,
but no external user base is assumed.

## Product Purpose

A personal work-management app. **One note database in markdown files, projected as a board, a
mind-map canvas or a table** — whichever the current query asks for — with read-only inline views of
Jira issues, GitHub PRs, branches and commits, Claude sessions and local docs.

Success, in the user's own terms, all at once:

- **nothing falls through** — every commitment from Slack, Jira, git and Claude sessions ends on a note;
- **"what's next" is one query**, answered fast enough not to think about;
- **no hand-kept TODO.md survives** beside it — capture and triage are cheap enough that the habit dies;
- **an agent starts unbriefed** — a note carries enough context that `pj work` plus a Claude session is
  productive with nothing explained;
- **actual TODOs and conceptual mind-maps live in one place.**

## Positioning

> "I can keep both my actual TODOs but also conceptual mindmaps in one place. It replaces the need for
> trello, miro." — the user

Executable work and conceptual thinking in **one note set**, not two tools that have to be kept in
step. The mechanisms a neighbouring product could not truthfully copy:

- **Facets, not lists.** Every facet value is an array, uniformly; no facet is structurally privileged.
  Relations — `parent`, `blocked_by`, `project` — are reference facets, so "group by project" and "group by
  priority" are the same board with one control moved rather than two boards to keep in sync.
- **One note type at two altitudes.** A note becomes *work* by acquiring a `status` and a
  *container* by being named by **any** reference facet. A mind-map leaf and a tracked note are the
  same file, which is what makes Trello-and-Miro-in-one structurally true rather than a feature list.
- **Two promises.** The markdown files are the source of truth, and nothing is ever written back to
  Jira, GitHub, Trello or Slack.
- **`blocked_by` and its transitive closure** — the relation neither Trello nor Jira gives usefully, and
  what "unblocked now" is built from.
- **Agent-first by construction**, not by integration: no API surface to expose, because the storage
  format *is* the interface.

## Operating Context

- **Two surfaces, one engine.** The web app (`127.0.0.1:8092`, one process serving the built UI) and
  the `pj` CLI share one query compiler and one payload builder — `pj ls --json` is exactly what
  `GET /api/query` returns, so a view means the same thing in both.
- **A vault** is a folder of markdown — the cards at the root, the vocabulary and the saved views
  under `.projector/` — opened the way Obsidian opens one. It is a git repository, which is where
  `pj log` reads history from. Two ship in this one: `vaults/tutorial`, which a fresh clone opens
  onto, and `vaults/coverage`, the fixture.
- **Intake channels:** Claude transcripts, git branches and lone commits, Jira JQL — plus Slack and
  Gmail, which have no fetcher here and are read by an agent through MCP. Sweeps propose and stop;
  `pj intake` creates no note and moves no cursor.
- **`pj work`** prepares a multi-repo git worktree workspace, a briefing with the note's full context,
  and a terminal running a Claude session in it.
- **Configuration is the vault's.** `.projector/config.yaml` says which channels this vault sweeps,
  whether links are enriched, and holds the credentials both need — gitignored, because a vault is
  often a repository. The matching `PROJECTOR_*` variables still override it for one run. `pj setup`
  writes the file and reports what actually answered; GitHub is the exception with nothing to store,
  since `pj` shells out to an authenticated `gh`. Every fetcher is read-only and runs server-side, so
  credentials stay out of the browser.
- **The vault holds real notes, not a demo dataset.** The app is judged against the author's own
  vault rather than a seeded one, which is why `vaults/coverage` has to carry states a seeded vault
  never produces. That vault is private and is not in this repository.

## Capabilities and Constraints

**The three shapes.** Board: columns from the primary grouping axis, lanes from a second, with drag
semantics that make "a note in two columns" a gesture and never an accident (replace / ⌥ add / ⇧
remove / drop into `(none)`). Canvas: a tree laid out from its roots plus free positioning once saved,
bands when grouped, and filtering as match-plus-context so a filtered graph still reads as a graph.
Table: the one thing the others cannot give — columns of numbers, with project roll-ups as
`direct / total`, blocked, untriaged, last activity.

**Editing has two channels.** Structure is edited by gesture — drag, bulk bar, canvas handles — and
content in the note panel. Creation is the exception, in two places: inline in a board column, which
inherits that column's value for the grouped facet, and `+ note` on the canvas toolbar, which
prompts for a title and sets no facets at all.

**Conflicts are refused, not merged.** If a file changed since the panel read it, the write is refused
and says so. This matters specifically because an agent may hold the same note in another window.

**Five computed axes compute and are never stored:** `type`, `blocked`, `triage`, `linked`,
`staleness`. Nothing derivable is also storable — which is why there is no `status: blocked` able to
disagree with the `blocked` axis.

**Ordered facets present buckets and compare raw.** `due` filters and groups as
`overdue · today · week · later` while sorting and range filters see the date.

**Views are saved queries.** There is no hardcoded `pj next` or `pj untriaged`; they are
`views/unblocked.yaml` and `views/triage.yaml`, askable from either surface and validated by
`pj check`.

**Technical constraints.** Node 24+ runs the TypeScript directly — no build step for server or CLI.
React 19 and Vite for the UI, Hono for the server, hand-written CSS with no framework. The server will
only open a vault listed in `vaults.json`, so a page in the browser cannot point it at an arbitrary
directory.

**Deliberately undecided** (recorded in `NEXT.md`, deferred rather than missing): an expression
language for moving the five computed axes into `facets.yaml`, per-column summaries, and keyboard
operation. The first two wait on a question appearing on screen that cannot currently be answered.
Keyboard operation waits on something else — a keystroke has no modifier to say replace / add /
remove, so the gesture semantics are the hard part, and there is no evidence yet about which motions
are frequent.

**Finished but idle mechanisms** — design must not assume data on these axes: `blocked_by` carries one
value, `due` is set nowhere, `owner` is set on one note, `energy` is on a handful. `pj check`
reports warnings against the live vault, some of them structural — run it rather than trusting a
count written here.

## Brand Commitments

- **`projector`**, lowercase. The CLI is `pj`.
- **xoria256** (Dmitriy Zotikov's pastel Vim scheme, via `estilo-xoria256`) is the committed palette —
  dark-first, light derived, following the system setting. **One hue family per facet axis** — the app
  owns the seven families, the vault picks which axis takes which — so a chip's colour says which axis
  it is before you read it. In the seeded vault: status green, priority orange, `waiting_on` yellow,
  tech pink, `blocked_by` red, `parent` purple. Every hue in `src/web/style.css` comes from the palette
  file, with the departure DESIGN.md documents where it occurs: the `--chip-tint` fills, which dilute a
  hue toward the surface.
- **Three things are drawn by what they are rather than by an axis**, and `src/web/hue.ts` is the one
  place that decides: a **reference** value draws as a note — the neutral register, no family,
  because it is another note and not a value — with its axis's family reaching its canvas edge alone;
  the **built-in `project` axis** draws in the accent, since it is the app's axis rather than the
  vault's; and a **link kind** draws its two-letter prefix in a family of its own (`jira` blue, `gh:`
  green, `claude` orange, `doc` yellow, `slack` pink) so a note's links tell themselves apart before
  you read them.
- **The note marks are vocabulary, not decoration:** `•` a note, `○` a note something else
  names, `▣` a project, plus a
  count of how many notes name it through any reference facet.
- **Voice:** lowercase, declarative, reasons-first. The docs state what a mechanism is and what it
  replaced; there is no marketing register anywhere in this project, and adding one would be
  off-voice.
- `src/web/favicon.svg` exists and is in use.

## Evidence on Hand

- `README.md` and `docs/ARCHITECTURE.md` are the written product note; `docs/NEXT.md`
  notes what is deliberately not being done and why.
- `vaults/tutorial`: the vault a stranger opens first, and the only one anything written for a reader
  should describe.
- `vaults/coverage`: the fixture, carrying every state the app can draw. Tests reference it; prose
  does not need to.
- The author's own vault is their own real notes. It is private, it is not in this repository, and
  nothing written here describes it or counts what is in it — a number that changes by working is a
  claim that goes stale on its own.
- One author; no external contributors.
- **Absences that must not be filled by invention:** no testimonials, users, customers, benchmarks,
  pricing, licence or deployment story exists. Nothing is published or hosted, and there is no landing
  page or marketing surface of any kind.

## Product Principles

1. **One mechanism, not two that must agree.** Nothing derivable is also storable; a second name for
   one thing is a second thing to keep in step.
2. **Both altitudes, one note.** A passing thought and a tracked commitment are the same file, and a
   note *shows* what it is rather than declaring it.
3. **Read-only outward.** The files are truth; no write ever leaves for Jira, GitHub, Trello or Slack.
4. **Propose, then stop.** Sweeps and triage present and wait. A confident wrong answer — a session
   filed against the wrong note, a note hidden in a column nobody looks in — is the failure that would
   make this useless.
5. **Agents are users.** Anything a person can do to a note, an agent must be able to do to the file,
   reliably, with nothing running.

## Accessibility & Inclusion

No standard was named and no product-specific requirement was established. The confirmed usage fact
that bears on it: the app is read at second-monitor distance for hours at a time, in whichever theme
the system is set to, so glanceable legibility and sustained contrast comfort in **both** themes are
requirements of the usage scene rather than compliance targets.
