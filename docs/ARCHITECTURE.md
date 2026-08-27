# Architecture

How projector works inside, and the invariants to preserve when changing it. For what the app *is*,
see [README.md](../README.md); for how to use it, [MANUAL.md](MANUAL.md).

## Principles

These are decided. Most of the design is one of them being applied, and the source cites them by
number.

| | | |
|---|---|---|
| C1 | Markdown files are the source of truth | any index is derived and disposable |
| C2 | Everything external is read-only | no code path writes to Jira, GitHub, Trello or Slack |
| C3 | Notes stay agent-editable | an agent edits them with plain file writes — no API, no app running |
| C4 | No facet is privileged | every axis, relations included, is stored, filtered, grouped and written the same way |
| C5 | Every shape is equally first-class | all three are editable, not just viewable |
| C6 | The note body is free-form | description, links, files, images — no template |
| C7 | No freehand drawing | the canvas is notes and their references. This is what settles the canvas library |
| C8 | Derived signals are deterministic | every count and badge is computed, never inferred by a model |
| C11 | Nothing derivable is also stored | one answer per question, so there is never a disagreement to arbitrate |
| C9 | A view is a query, not a place | `view = filter × search × focus × group × sort × shape × show`. Everything derivable is a live control; everything hand-curated is a saved-view-only key |
| C10 | Structure is edited by gesture, content in the panel | facets, `parent` and edges by drag and bulk bar; title, body, links and `project:` only through `?note=` |

## The shape of it

```mermaid
flowchart TB
  subgraph vault["The vault — your files, git-tracked, the source of truth (C1)"]
    direction LR
    notes["*.md at the root<br/>facets · links · body"]
    fac[".projector/facets.yaml<br/>type · values · single · buckets"]
    vw[".projector/views/*.yaml<br/>saved query + arrangement"]
  end

  you["You, in a browser"]
  agent["A Claude session<br/>/pj-capture · /pj-triage · /pj-work"]

  subgraph surfaces["Two surfaces — peers, not a stack"]
    direction LR
    ui["Web UI<br/>board · canvas · table · note panel"]
    pj["pj<br/>one command per question"]
  end

  idx[("index.db · enrich.db<br/>derived and disposable — delete them and nothing is lost.<br/>The index is memoised on an exact stamp of every file it read")]

  spec["ViewSpec — filter · search · focus · group · sort · shape · show<br/>a URL, a saved view and CLI flags all parse into this one object,<br/>which is why the two surfaces cannot drift"]

  subgraph engine["The engine"]
    direction LR
    q["query compiler<br/>runs in memory, so a computed axis is<br/>indistinguishable from a stored one"]
    refs["reference graph<br/>walk · chains · cycle refusal<br/>every relation is a reference facet"]
    proj["project resolution<br/>repos · jira · branch · instructions,<br/>inherited along the project facet"]
  end

  outside["Jira · GitHub · Claude transcripts · docs · git<br/>read-only, always (C2)"]

  you --> ui
  agent --> pj
  vault --> idx
  vw --> spec
  ui --> spec
  pj --> spec
  fac --> q
  spec --> q
  idx --> q
  q --> refs
  refs --> proj

  surfaces -.->|"writes: validated, atomic,<br/>409 only where a base is sent"| notes
  agent -.->|"or plain file writes — no API, no app running (C3)"| notes

  idx <-->|"links, resolved lazily and cached with a TTL"| outside
  proj -->|"pj work — a worktree per repo, plus a briefing"| outside
  pj -->|"pj log — what actually changed"| outside
```

Three things are worth reading off it.

**The vault is three kinds of file, and only three.** Notes are content, `facets.yaml` is the
vocabulary that constrains them, and a view is a saved query plus the arrangement that has nowhere
else to live. Everything below the vault box is derived: delete both caches and `pj reindex` is
always correct.

**Only one of the three is at the root.** The notes are the vault — a folder of markdown, at any
depth, with no `notes/` to put them in and no exempted filename. The other two live under
`.projector/` along with the databases, so removing that one directory leaves the folder of markdown
you started with. This is what lets a directory of notes that has never heard of projector be opened
rather than imported: a file with no frontmatter is a note whose id is its filename and whose title
is its leading heading, and nothing is written back until you change something.

**The two surfaces cannot drift, because `ViewSpec` is one object.** A URL, a view file and
a set of `pj` flags parse into the same thing, so `pj ls --view unblocked` and opening that view in
the browser are the same query by construction rather than by discipline.

**The file format is a public API.** The app writes through a gate that validates against the
vocabulary, writes a temp file and renames, and refuses a write whose file changed since it was read.
An agent writes the same bytes with Write/Edit and no gate at all (C3) — which is why the gate exists:
the two are expected to be editing the same note at the same time.

## Layout

| | |
|---|---|
| `src/schema/` | note and facet types, frontmatter read/write, validation, how notes fold together |
| `src/index/` | the indexer, the query compiler, the reference graph, the index memo |
| `src/view/` | `ViewSpec` — the one description of a view, shared by URL, file and CLI flags — `payload.ts`, the one answer to it, shared by `GET /api/query` and `pj ls --json` — `intents.ts`, the edits a control makes to a view, `dropOutcome.ts`, what a drag means, `keys.ts`, what a keystroke means and which letters a vault may not claim, and `undo.ts`, the write that puts a write back |
| `src/server/` | hono routes, mutations, file watcher, SSE, vault seeding, and `poll.ts` — the sweep on a timer |
| `src/web/` | React: sidebar, three shapes, note panel. `cursor.ts` is where the keyboard is and `views/motion.ts` is where it can go |
| `src/cli/` | `pj` |
| `src/sources/` | the read-only way out: subprocess transport, Jira credential + GET, Claude transcripts |
| `src/enrich/` | read-only link fetchers, each with a TTL |
| `src/intake/` | channels that discover refs the vault does not have, where each last got to, which were declined, `classify.ts` — which deserve a note — and `materialise.ts` — a candidate becoming one |
| `src/agent/` | note context assembly, worktree workspaces, briefings, git history — and `work.ts`, the plan-and-launch both `pj work` and `POST /api/note/:id/work` reach, so the CLI and the panel cannot disagree about which branch, which directory or which link |
| `src/scripts/` | maintenance run by hand, not by the app: `redate.mjs` moves the coverage vault's dates back to today |

## The query compiler

`src/index/query.ts` is the whole engine, and `src/view/spec.ts` is the one description of a view —
shared by the URL, a saved file and `pj` flags, so the three cannot drift. `src/view/payload.ts` is the
one *answer* to that description, shared by `GET /api/query` and `pj ls --json`: the request half could
not drift while the response half was assembled inside a hono handler the CLI could not reach.
`pj ls --view unblocked` and opening that view in the browser go through the same code, and now return
the same thing.

**Filtering runs in memory** over the note map rather than in SQL. Not a performance trade — at this
scale both are free — it is what lets a computed axis be indistinguishable from a real one. In SQL,
`blocked` and `triage` would each need their own expression in the filter, the grouping *and* the
histogram; in JS they need one function and the rest of the engine cannot tell them apart. SQLite keeps
the one job it is genuinely better at: full text (FTS5), which `search()` reads out of the `fts` table
joined to `notes`. `src/index/queries.ts` holds only that, plus `counts` — which reads which facets
are relations off the vocabulary, having once named three of them in the SQL. The blocking closure came
in-memory too — `unblocks()` in `src/index/blocking.ts` walks the adjacency `refs.ts` builds, because
the SQL version was depth-capped at 10 and kept self-references the note map drops. It used to also carry a general `listRecords`/`filterClause` pair — a
second filtering engine, which is what this whole section says should not exist — and that is exactly
where `pj next` went on filtering by `kind` for two days after P7 deleted it. It then spent a while as
one `runQuery` call in `cmdNext` — right engine, wrong place, since a query written in TypeScript is a
view that is a place rather than a query (C9). It is `views/unblocked.yaml` now, and `blocked: [clear]`
already means "no unfinished blocker and nobody waited on". `pj check` validates every axis a view
names, so the `kind` failure cannot recur in its new home: a filter naming an axis the vocabulary lost
is an error, not an empty answer.

**Every computed axis computes.** `kind` used to sit in `COMPUTED` and return a stored field. Moving it
into `facets.yaml` showed it asserted two things the note already said — carrying a `status` is what
makes it work, being named by **any** reference facet is what makes it a container — so it is gone
entirely (C11).
`type` and `is_project` are derived from the `project:` block, which is not a facet, so those earn
their place — and `type` also reads the reference graph, since its third value `node` is "some other
note names this one, through any reference facet". Five compute in all: `type`, `blocked`, `triage`, `staleness`, `linked`.

**Focus and filter are the same operation at two levels, deliberately.** A focus is a filter clause
whose test is transitive rather than one level deep, so in principle
`filter: { parent: { values: [project-a], depth: ∞ } }` would collapse them into one concept. The split is
kept because it is load-bearing for the facet panel: focus bounds the *universe* and filter refines
inside it, and the panel decides which facets to **offer** from the universe while computing **counts**
from the filtered pool. Collapse them and "38 filtered out" changes meaning. Worth revisiting only with
the histogram semantics settled first.

The one place they interact rather than compose is `type`, which is why `setFocus` empties a filter on
it. `type` is the only axis whose value states a note's *position in the reference graph*, and a focus
is a selection by position — so `type=[project]` under `focus via=project dir=in` deletes precisely
what the traversal was asked to find, and the seeded **Projects** view shipped in exactly that state.
`STRUCTURE_AXIS` in `schema/vocabulary.ts` is the name both ends read, keyed into `COMPUTED` so it
cannot drift; every other filter, computed or stored, is a preference and survives untouched.

**Universe vs. hits.** `universe` is what focus and search left; `hits` is that narrowed by the facet
filter. The distinction is load-bearing in two places: the sidebar reports `universe − total` as
"filtered out", so the number is exact rather than inferred from the histogram; and the facet panel
decides *which facets to offer* from the universe while computing *counts* from the filtered pool.

**Two questions, not one.** Which facets are offered is decided by the universe, so refining one facet
never removes another — otherwise narrowing hard sheds the panel down to the one axis you already used,
with no way to look sideways. What each value counts lifts that facet's own selection and applies every
other one, so an unselected value says what adding it would bring; counted against the fully filtered
set instead, every unselected value reads 0 and a selection can be narrowed but never widened.

A facet with no real value anywhere in the universe is dropped, which is what keeps a niche taxonomy
out of the panel — and is why a facet needs no scoping rule of its own. Values the universe holds stay
listed at zero, and a
selected value always stays listed or it could never be unselected.

## The index memo

`load()` is memoised on an exact stamp of every file it reads — each mtime, plus how many files there
are. Rebuilding costs tens of milliseconds at this vault's size; checking the stamp costs a fraction of
one. The ratio is the point — two orders of magnitude — and it is what makes the memo worth having
rather than the absolute numbers, which move with the machine and the note count.

Before the query became interactive the index was rebuilt on every request, which was right while a
request meant a click. A live search box makes that several rebuilds a second. The stamp is not a TTL
or a heuristic, so C1 is intact: if any of those bytes could have changed, the answer is rebuilt.
Mutating routes additionally call `invalidate` through `bump`, so our own writes never depend on mtime
resolution being finer than a burst of them.

The stamp skips dotfiles, because the index is the memo's own output and counting it would make
every rebuild invalidate itself. That leaves one gap the stamp cannot close by construction: the index
is *derived and disposable* (C1), so another process is entitled to delete it and write a new one
without touching a single source byte. `reindex` opens it `fresh`, which unlinks the file along with
its `-wal` and `-shm` — so a `pj reindex`, or a plain `pj ls` in another terminal, used to leave the
server holding a `DatabaseSync` on an unlinked inode. Every read through it failed with `disk I/O
error` until the process was restarted, and because only some routes touch the database, `/api/meta`
died while `/api/query` went on answering.

So an entry also records **which** index file it has open, by inode. Writes through our own handle do
not change it and a replacement always does, which is why it is the inode rather than the size, the
mtime or a checksum — all of those move under normal use, WAL checkpoints included, and would rebuild
on a request that changed nothing.

The memo also disposes the superseded `DatabaseSync`, which the per-request version leaked once per
request. That dispose is allowed to fail: the value being closed is sometimes the broken one this
rebuild exists to replace, and letting the failure out would turn one dead route into every route.

**Callers must not `await` between `load()` and their last read of what it returns**, or a concurrent
request could rebuild and dispose it mid-handler. Every call site today is a GET handler that returns
without suspending.

## Invariants

Things that look like details and are not. Each of these was a bug at some point.

**Arrangement merges, never replaces.** The client sends only the nodes it currently renders, and that
is a filtered subset — replacing the `nodes` map would silently discard the position of everything the
filter happened to hide. Same for `order`, per column. An entry is dropped only when its note is
actually gone, and the live-id set is built at most once per save.

**Saving a view keeps its arrangement.** *Save current as…* over an existing name replaces the query
wholesale and leaves `nodes` and `order` alone, so refining a saved view's filter does not
cost you its layout.

**Two sentinels, one reason.** The server merges a saved view's parameters *under* the URL's, so an
absent key means "inherit". Clearing something therefore needs an explicit empty value: `f.status=`
means "no status filter" over a saved view that had one, and `focus=` means "no focus". Deleting the key
instead lets the saved value come straight back.

**`(none)` travels as itself** in the URL and in a view file, never as a bare `none`, so a facet that
one day has a literal value `none` cannot collide with the absence refinement.

**Canvas layout follows the *first* relation shown,** not `parent` alone. A hierarchy can lay a graph
out and a cross-cutting relation cannot — a blocker pointing sideways distorts every rank it crosses —
but which is which is a property of the view, not of the relation: `parent` first gives a
decomposition tree with dependencies drawn over it, `project` first gives the portfolio. Laying a
membership canvas out by `parent` puts every node in one column with the hierarchy invisible.

**One edge per pair of notes,** whatever the relation. `parent` and `project` agreeing is the expected
shape for a note inside a project, so drawing both put two identical lines on top of each other. Collapsed, a
pair that agrees reads as one relationship and a pair that *disagrees* still shows as two edges pointing
at different notes — the case worth seeing. Edge labels need an explicit neutral fill, because a label
inherits the stroke colour otherwise.

**Every relation is a reference facet.** `type: ref` says a facet's values are note ids; the seeded
vault declares `parent` and `blocked_by`, `project` is built in, and a vault declares whatever else it
needs. There is no `edges:` block and no `edges` table: `src/index/refs.ts` is the one reader, and
focus, the canvas, the roll-ups, config inheritance and cycle refusal all walk the `src names dst`
pairs it returns.

**Every reference is stored on the note that depends**, pointing at what it depends on. That is a
modelling convention rather than a declaration, and it replaced one: while `blocks` was stored on the
blocker it pointed *away* from the root of its own dependency tree, so which relations to flip when
drawing had to be declared, shipped in the payload as `hierarchies` and threaded through four layout
functions. Inverting it to `blocked_by` turned a list of exceptions into a rule — a canvas flips every
edge, dagre gets every one the same way round, and nothing says which. A vault whose relation genuinely
points outward draws its arrows backwards on the canvas and is otherwise unaffected; `points: out` is
the escape hatch to add the day somebody needs it rather than in advance.

The gain is not symmetry, it is capability. An edge could be traversed but never filtered, grouped,
counted, dragged or bulk-edited; a facet could be all of those but never traversed. Making relations
facets means `f.parent=project-a`, `groupBy: [parent]`, `parent=(none)` and drag-between-parent-columns all
exist, none of which did before — and they work because a hierarchy concentrates: 26 distinct parents
over 134 references, 7 used once.

A project's key is its note **id** — there is no separate `key` field, because a second name for one
thing is a second thing to keep in step, and it would let a reference point at something that is not a
note id.

**Direction is mechanical, not spatial.** `out` follows a note's own references; `in` finds the
notes naming it. `up`/`down` only reads correctly for containment — on `blocked_by`, "up" would mean
toward the blocker, which is the same arrow as `parent`'s "down" — so the words would have meant
opposite tree-directions depending on the relation.

**A reference facet declares no vocabulary.** `values` on a `ref`, `date` or `number` facet is always a mistake — the vocabulary is
the vault — so `loadFacets` drops it rather than half-honouring it, and `open` is implied. A value
naming a note that does not exist is a **warning**, not an error: an agent may write a note before
the one it points at, and refusing that would make the order of two file writes matter.

**A relation carries no data of its own.** A reference facet value is a bare note id, so there is
nowhere to hang a label, a weight or a reason on a relationship. `Edge` was `{type, to}` and nothing
used more, and a reason for a blocker belongs in the body — accepted knowingly, since it is the one
thing the collapse gave up.

**Three SQLite files, three lifecycles.** `.projector/index.db` is derived from the note files and
rebuilt from scratch whenever they change — C1 means it can never be the authority, so it needs no
migration. `.projector/enrich.db` is a cache: TTL'd, clearable, and losing it costs one refetch of
data that took a second to fetch. `.projector/intake.db` is neither. Delete it and the next sweep re-proposes every message and commit of
the last three months, so it cannot be rebuilt from anything and cannot be thrown away casually.

It holds two tables, and they are the two halves of resolving a sweep: `watermark` is how far each
channel has been read, and `suppressed` is which candidates somebody judged not to deserve a note.
Same lifecycle, so the same file — both are answers a person gave that no note records, and both
degrade a sweep rather than breaking it when lost. It is in WAL mode, so it is three files on disk;
deleting the database and leaving the sidecars used to fail the next open outright, which is why
`openIntakeDb` clears an orphaned log before opening (see `dropOrphanedWal`). A property that only
holds when you delete the right three files is not the property the paragraph above claims.

Merging any two of them breaks whichever has the shorter life: enrichment in the index would be
discarded on every reindex, and watermarks in the enrichment cache would be discarded by
`clearEnrichment`.

**A watermark is not load-bearing, and that is what makes it safe to keep at all.** It is the one piece
of state projector holds that is not derived from the note files. Correctness does not rest on it:
`source_fingerprint` is what stops a duplicate, and it stops one whether or not a cursor knows the
item exists. So the watermark only decides how far back to *look* — losing it degrades a sweep to a
default window, which is noisier and never wrong. Nothing about the work has two answers, so C1 is
untouched.

**A cursor may only move to a boundary with nothing unexamined behind it.** A cursor is one value, so a
channel that returned the *newest* N items and then advanced would step over everything older it never
looked at. Channels therefore work **oldest-first from the cursor**, and a run truncated by its limit
holds its cursor where it was: the next sweep resumes at the same place, and the backlog drains through
fingerprint dedup rather than through the cursor. `pj intake` is also the only command that reads
external state and writes nothing of its own — it rebuilds the derived index the way every read does,
and advancing a cursor is a separate explicit step, because a run that fetched is not a run that was
resolved.

**A sweep has two answers, and only one of them used to have somewhere to go.** `pj add` records a
yes and leaves a note carrying the candidate's fingerprint, so no later sweep offers it again. A no
left nothing behind but a moved cursor — which made "seen and declined" indistinguishable from "never
fetched", except that the first could never come back, and it meant a rejection could not inform
anything afterwards. `pj intake suppress` is the missing half: a fingerprint, a reason, and a
timestamp, dropped from the candidates of every later sweep. `unsuppress` puts it back.

Only *judgements* are stored. A channel declining a merge commit or a session with no prompt re-derives
that answer identically on every run, so keeping it would be storing something derivable (C11). A
judgement about whether work matters is not reproducible — a different threshold or a different reader
answers differently — and that is exactly why it needs a home. A suppressed candidate is moved into
the run's `skipped` list rather than dropped silently, so the count still includes it and `--verbose`
still names it: a sweep that quietly discarded a third of what it fetched would read as a quiet
channel, and that reading must not be available.

**A sweep with nobody standing there writes the candidate down, and that is what earns the cursor.**
`pj intake` and the poller run the same channels through the same code; the difference is who is
available to answer. A person is right there, so a manual sweep proposes and stops. A timer is not, so
the poller materialises each candidate as a note carrying `intake: unjudged` and leaves the answer for
later.

That difference decides which of them may advance a watermark. The rule has always been that a cursor
may only pass a boundary with nothing unexamined behind it — and a proposing run cannot satisfy it,
because what it examined exists only in a terminal buffer. A materialising run can: everything behind
its new boundary is a file, or was already answered for. **So the queue now guarantees what the cursor
was being asked to**, and the cursor is demoted to what it should always have been — where to resume
fetching. A truncated run still holds, unchanged and for the original reason.

One channel failing is that channel's news. A thrown `collect` used to take the whole run with it, so a
lapsed token meant no git candidates either; it now lands as `fetched: false` with the reason, which is
the shape the report already had for Slack and Gmail. That matters more with nobody reading the output.

**A tick judges before it writes, and describes what it keeps.** `src/intake/classify.ts` answers two
questions in one pass — does this candidate deserve a note, and what is the note — because the model
has to read the candidate to judge it and having read it can also say what to call it, what it is
about, and which axes it sits on. Asking only *keep or drop* wasted the call and produced cards nobody
wanted: a commit subject for a title, a provenance line for a body, one facet. The channels' `fields`
— repo, branch, cwd, turn count, session state, every commit subject — were being discarded, and they
are most of what makes a readable body possible.

Three decisions come back. `keep` becomes a note. `drop` becomes a `suppressed` row carrying the
model's reason. `extend` becomes a note pointing at an existing one through the `extends` axis, to be
merged rather than filed — which is what a sweep finds most of the time once a piece of work is already
tracked.

**The model proposes, the vocabulary disposes.** Every facet name, value and merge target is validated
against the vault before anything is written: an unknown axis or an undeclared value on a closed one is
dropped *individually*, because a card with two good facets and one invented one is still worth having
and a refused write is not. A target must be one of the mechanical `evidence.matches`, which is what
stops a model inventing a relationship — and costs nothing, since anything outside that set was never
a merge candidate. `intake` and `extends` are withheld from it entirely, being the pipeline's own
bookkeeping. On an open axis the model is shown the values the vault's notes already carry and asked to
prefer them, so a queue of cards cannot sprawl the vocabulary into `webhooks`, `webhook` and
`eventing`.

Which is what makes `intake: unjudged` mean something stronger than "new": **nothing on the note has
been confirmed by a human.** Title, body and facets are all proposals, and judging is accepting them or
fixing them first.

One call per run, not per candidate. A sweep's candidates arrive together and are frequently *one
thing* — an afternoon on a branch — and a model shown all of them can say so where a model shown each
alone cannot. The transport is a stripped `claude -p`: the default system prompt replaced, the tools
disallowed, MCP off. What is left is a classification rather than an agent, which is both cheaper and
more predictable, since a classifier able to read files would eventually read them.

**It fails closed.** A tick that cannot reach the classifier, or cannot parse what came back, writes
nothing and advances nothing; the next tick sees exactly what it saw. Materialising everything instead
would reach the bad outcome by accident, and no reading of "the judge is down" makes writing down
everything the right answer. `classify.enabled: false` is how a vault asks for that on purpose —
reachable by decision, never by omission. A candidate the model simply failed to mention is **kept**,
which is the safe direction of the two: keeping costs a glance and dropping costs the item.

`materialise` still judges nothing. It acts only on facts about the vault — already linked, already
captured — and the separation is worth keeping: one file decides what is *true*, another decides what
*matters*.

**The declined pile is a surface, not a view.** A declined candidate never became a file, so there is
nothing for the query compiler to answer about it and no shape to draw it in — C9 is about views over
notes, and this was never going to be one. It is reached with `?declined=1` over the single route, the
way `?note=` reaches the panel: no second route, still deep-linkable, back button still closes it.
`GET /api/intake/declined` reads it and `meta.declined` carries the count, which is what lets the
sidebar footer — *what is on screen, and why it is not more* — answer for the sweep as well as for the
filter. Without it an empty board has two meanings and no way to tell them apart, which is the whole
justification: it is the audit trail for a decision the app made on its own, and the only place a wrong
one can be put right.

**Deleting a note that came from a sweep is a decline**, so `deleteNote` records its fingerprint —
every fingerprint it answered for, absorbed ones included. Without that, deleting a candidate destroys
the only thing stopping the next sweep proposing it, so the card returns and the gesture that plainly
means *no* is the one that does not work. That trap was live from the moment candidates began landing
as notes.

**A suppression says who decided.** `decided_by` is `model` or `person`, and it is not decoration: a
model's decline is a prediction that may be wrong and a person's is the ground truth you would check it
against. Calibration cannot use a pile that does not distinguish them, and neither can a reader
deciding how much to trust an empty board.

**Who decides what deserves a note has never been the deterministic half.** C8 says a derived signal is
computed and never inferred by a model, and that governs *signals* — the counts and badges the UI draws
as fact. It has never governed the judgement of whether a candidate is worth filing: that belongs to
the `/pj-capture` skill and always has, which is a model making the call. So classifying candidates at
fetch time rather than in a conversation moves **when and where** the judgement runs, not who makes it,
and no principle moves with it.

What C8 does constrain is the residue. A relevance score may gate a candidate and order a queue; it may
not become a facet, and it may not render as a badge beside computed ones, because what C8 buys is that
a badge can be trusted. Its durable form is prose — a reason on a suppression, which is the shape
`Skipped.why` already had.

**Enrichment and intake are mirror images that share only the way out.** Enrichment is given a ref and
answers how to display it; intake is given a channel and a cursor and answers which refs nobody has
filed. Same Jira token, same `~/.claude/projects`, opposite question. `src/sources/` holds what is
genuinely common — the credential, the subprocess, the transcript parser — and neither directory
imports the other. Two of the five intake channels have no fetcher here at all: Slack and Gmail are
read by an agent through MCP, and `pj` keeps their cursors anyway, because a watermark is a property of
where the sweep got to and not of who did the fetching.

**Instructions are configuration, not prose.** They live in the `project:` block. They were once a
`## Instructions` heading in the body matched by regex — the only place where renaming a heading
silently changed behaviour, with nothing to validate against. The body is free-form again (C6): nothing in
it is configuration. It is still read — `progressOf` counts its task boxes, `excerptOf` picks its first
prose paragraph for the card face, and `reindex` puts it in FTS5 — but no heading or marker in it
changes how the app behaves.

**Cycles are refused on every reference facet**, through the one `wouldCycle` that also guards `parent`
edges. It takes the outward neighbours as a function rather than a note map, so the check is about
the shape of the graph rather than where it is stored. Before P7 a membership cycle was accepted and
`resolveProject` silently truncated the config chain.

**Being blocked is computed, never written.** A facet declared `blocking: true` puts its own name on
the `blocked` axis, and what *unsatisfied* means follows from the type: a reference blocks while
something it names is not `closed`, anything else blocks while it holds a value at all. The second rule
is not a shortcut — a person does not complete, you clear the axis rather than marking them closed — so
`waiting_on` behaves correctly as a label and a vault wanting the traversal can make it a reference
without changing what the axis means.

None of these is a `status` value; `status` is lifecycle only. Storing a state beside the thing it is
derived from gives two answers to one question and nothing to arbitrate between them (C11).

The axis had two hardcoded values, `blocked` and `waiting`, computed from two facets by name. Those
were always the same question asked of two facets — which is why blocking is *plural* and `project` is
not, and therefore why `blocked_by` is an ordinary facet while `project` is built in.

**A single-valued facet is a vocabulary constraint, not a storage one.** Every facet is a `string[]`
and the whole engine reads it that way; `single: true` says the *vocabulary* admits one value at a
time, which is why it lives in `facets.yaml` beside `open` and `values`. Without it the model cannot
reject `status: [planning, done]` — a note in no coherent state, which `buildCtx` reads as done while
a board draws it in planning. That matters because the primary writer is an agent making plain file
writes (C3): a model that cannot refuse an incoherent state accumulates them.

**A facet has a type, and storage is uniform anyway.** `label · ref · date · number` say what values
*are*; the file still holds strings and the engine still holds `string[]`. That is what keeps typing
cheap *in the compiler*: it interprets a type in exactly two places — `valuesOf` for what an axis
shows, `rankOf`/`ordered` for how it sorts. Outside the compiler the type is read at about two dozen
sites, through `isRef`/`isOrdered` in `src/schema/vocabulary.ts` or by comparing `def.type` directly in
the writer, the validator, the payload builder and the editing controls — so adding a type means
auditing those rather than one function.

**An ordered facet presents buckets and compares raw.** A date has as many values as there are days, so
filtering and grouping see the buckets it declares while sorting and range filters see the value.
`f.due=overdue` and `f.due=>2026-09-01` are lexically distinct, so there is nothing to disambiguate.
`orderValues` reads the bucket order from `buckets` — without that it fell through to alphabetical,
which put `later` first.

**`created` and `updated` stay fields.** A facet is *user-declared vocabulary*; those two are written
by the app on every save and belong in no filter panel. That line is why `due` could move out of the
frontmatter root and they cannot, and it is what leaves `staleness` a computed axis: it computes over
`updated`, which is not vocabulary. Computing over app-written metadata is `COMPUTED`'s residual role.

**One face, for every note**, and one list saying what it shows. `chips` and `edges.show` asked the
same question — *which facets does this view surface* — and how each is drawn follows from what it is:
a label is a chip and a column, a reference is those *and* a line, and the first reference in `show`
lays the canvas out. Two keys meant "why does my canvas draw nothing" was answered by the one you
forgot.

**`connect` follows the shape *and* the relation drawn.** Only a canvas honours it, so it is not a
query key — it is a run option carrying the relation to walk, decided by the shape and the vocabulary
together, which the query half knows nothing about. Passing the relation rather than a flag is what
stops a canvas laying out along one hierarchy and pulling context from another. `layoutRelation` is the
single answer to *which relation*, computed server-side and sent as `layout`, so the client never
recomputes it.

**Conflicts are refused where a base is sent, and narrowed everywhere else.** A note read into the
panel carries its file mtime; a write sends it back and a mismatch is a 409. This matters because an
agent may be editing the same file in another window (C3).

That sentence used to end there and read as a property of the product. It is a property of one surface.
`guard` returns immediately when no base arrives — an absent base is a caller *declining* the guard,
not an unguarded accident — and only three functions ever receive one. What every other path has
instead is **narrowness**: a write that names one axis cannot revert another, whatever else happened.

| Path | On a concurrent edit |
|---|---|
| panel facet `add` / `remove` | **merges** — the axis is re-read after the guard and the delta folded in |
| panel `set`, title, links, project block, body, frontmatter | **refuses**, outside the self-write window |
| board drag, canvas connect, bulk facet / parent | **narrows** — only the named axes travel; a concurrent edit to the same axis is lost silently |
| every `pj` write, the delete cascade, saved views, `vaults.json` | **replaces** the keys it touches, with no base and no report |
| an agent's `Write` / `Edit` | **cannot be guarded** — there is nowhere to put a base, and this is the primary writer |

The asymmetry in the last two rows is the honest shape of it: the panel's edit can be refused because
of the agent, and the agent's edit can never be refused because of the human. What makes that
survivable is not the gate. It is that a write derives its payload from a read taken *inside* the
write — `patchNote` has always done this, and since the per-record `facetsNow` read the bulk loops and
the delete cascade do too — so a writer that never saw an axis cannot revert it. **Narrowness protects
against writers you cannot see; a gate only reports on the one caller that opts in.**

**Grouping is one function called twice.** A second axis is a position in `groupBy`, not a separate
`swimlanes` concept, which is why a matrix needed no new code path. Every value the query *admits* gets
a group, empty or not — a board missing an admitted column reads as though it did not exist, and an
empty admitted column is somewhere to drag a note to.

**A filter on the axis you group by decides which columns exist, not just what lands in them.** It read
every declared value whatever the filter said, so `due` — grouped by `due`, filtered to three of its
four buckets — drew a `later` column no note could reach, and `triage` drew `complete` the same way. It
also dropped every *undeclared* value, so whether an excluded value survived came down to whether
somebody had written it in `facets.yaml`. `admitted` answers for both: the axis is the vocabulary
narrowed to the selection. Two consequences worth stating. A selection by *range* (`f.due=>2026-09-01`)
narrows nothing, because its tokens are expressions rather than value names — and because the property
that makes narrowing safe is that a note matching a name selection must carry one of those names, so it
always keeps a column; a range match need not. And on a multi-valued axis the narrowing drops
*placements*: filtering `tech` to `k8s` stops drawing the `aws` column those same notes also sit in.
That is the point rather than a cost — a column headed `aws` in a view that holds only `k8s` notes
invites the wrong reading — but it is why `placements` can now fall below what the vocabulary would
have shown.

A **table** draws groups as sections, and follows the canvas rather than the board: an empty declared
value gets no section. The board's case for keeping one is that it is somewhere to *drag to*, and a
table offers nothing to drag. It used to render a header with a `0` under it, which was a behaviour
rather than a decision — all three now go through one `groupsFor`, which takes the policy as an
argument precisely because it differs on purpose.

A canvas draws groups as **bands**. It cannot honour a multi-valued placement, because a note has one
position, so it draws the note in the first group the axis declares and the footer reports the count
rather than letting the two shapes disagree silently. An empty declared value gets no band: an empty
column is somewhere to *drag to*, and a canvas drag moves a position without changing a facet, so an
empty band would be decoration with no affordance. The bands are plain nodes behind the notes rather
than React Flow parents — a parent makes member positions relative, and a saved arrangement stores
absolute ones. Boxes are measured from where members finally are, so a dragged note grows its band and
clustering needs no agreement with the arrangement.

## What it writes

C2 says everything external is read-only. Concretely, every operation that writes anything:

| Operation | Writes | Never |
|---|---|---|
| `pj add` / `POST /api/note` | one new note file | never overwrites an existing file |
| `pj log` | nothing | reads `git log`; it is the one command with no write at all |
| `pj link`, `pj set`, `PATCH /api/note/:id` | one note's frontmatter, or its body when `body` is sent | a frontmatter change never touches body bytes |
| `pj set --set path=yaml` | only the top-level keys the paths touch | comments and formatting elsewhere in the file survive |
| `POST /api/bulk` ops `facet`, `move` | many notes' frontmatter — `facet` writes one axis uniformly, `move` writes one axis per grouping axis the drag crossed | one write per note whatever the op; the `delete` and `merge` ops are the rows below |
| `POST /api/bulk` op `merge`, `pj merge` | the survivor's frontmatter and body, the frontmatter of every note that referenced an absorbed one, and `assets/<absorbed>/` moved into the survivor's folder; then the absorbed files | never writes anything until every check has passed — a merge that would leave a note reaching itself is refused whole. The survivor's own labels are never rewritten |
| `PUT /api/note/:id/frontmatter` | one note's whole frontmatter block | never touches the body |
| `pj rm`, `DELETE /api/note/:id`, `POST /api/bulk` | note files, and every reference that pointed at them | nothing outside the vault |
| `PUT /api/view/:name` | one view file's query half | never touches its stored arrangement |
| `PATCH /api/view/:name/arrangement` | one view file's `nodes`/`order`, merged by id | never drops an entry whose note still exists |
| `DELETE /api/view/:name` | one view file | never touches the notes it selected |
| `POST /api/note/:id/asset` | one file under `assets/<id>/` | never overwrites: the name is a content hash |
| `POST`/`DELETE /api/vaults` | `vaults.json` beside the app — plus, when `create` is passed for a path that is not a vault yet, everything `initVault` seeds | never writes into a non-empty directory that is not already a vault, and never overwrites a file that exists |
| `pj intake` | `.projector/index.db`, because a sweep reads the vault through `reindex` like any other read | proposes; it writes no note and moves no cursor |
| `pj intake commit` | one row in `.projector/intake.db` | never a note, and never on its own initiative |
| `pj intake suppress` / `unsuppress` | one row in `.projector/intake.db`'s `suppressed` table | never a note; records a decline by fingerprint so a later sweep stops offering it |
| the poller (`src/server/poll.ts`) and `pj intake poll` | one note per kept candidate through `createNote`, one `suppressed` row per declined one, plus that channel's cursor | judges before it writes, and writes nothing at all when it cannot judge. Advances only channels it actually fetched. Off unless the vault asks |
| `POST /api/intake/declined/:fp/restore` | one row removed from `.projector/intake.db`'s `suppressed` table | never a note; the only write the declined surface makes |
| `pj work`, `POST /api/note/:id/work` | a workspace directory under `$PROJECTOR_WORKSPACES`, `AGENT_BRIEFING.md` in it, and a git worktree plus its branch in each declared repo | never modifies a tracked file in a declared repo, and never writes inside the vault — so it is the one write path carrying no base mtime, there being no note to conflict with. `{commit: false}` writes nothing at all: it is the plan the panel's confirm is built from |
| `pj vaults add` / `forget` | `vaults.json` beside the app — plus, with `--create`, everything `initVault` seeds | never writes into a non-empty directory that is not already a vault |
| everything else | the three databases under `.projector/` only | never touches a note file |

The only outbound calls are reads: `gh pr view`, `gh api` GETs, Jira GETs. Fetcher modules export no
mutation functions, so there is no code path to write back.

A mutating request is refused when it carries an `Origin` header that is not one of ours, since a
localhost server is reachable from any page open in the browser. Every frontmatter write goes through
`writeCardFile`, which writes a temp file and renames, so a concurrent reader never sees half a file.

## Everything it touches

The complete filesystem surface, audited. Nothing else on disk is read or written.

**Writes — inside a vault, plus two files of its own:**

| Path | What | When |
|---|---|---|
| `<vault>/**/*.md` | note files | you create or edit a note — or the poller materialises a candidate, when the vault turned it on |
| `<vault>/assets/<id>/` | images pasted into a body | you paste one |
| `<vault>/.projector/views/*.yaml` | saved views | you save a view or its arrangement |
| `<vault>/.projector/index.db`, `…/enrich.db` | the derived index and the enrichment cache | continuously; both are disposable and gitignored |
| `<vault>/.projector/intake.db` | where each intake channel last got to, and which candidates were declined | `pj intake commit` and `pj intake suppress`; gitignored |
| `<app>/vaults.json` | the list of vaults you have opened | you open or forget a vault |
| `$PROJECTOR_WORKSPACES/<project>-wt-<branch>/` (required; no default) | worktrees and `AGENT_BRIEFING.md` | `pj work`, and the panel's Start control through `POST /api/note/:id/work` |

Every note write goes through `writeCardFile` — temp file plus rename — so a concurrent reader never
sees half a file. The registry is written the same way.

**Reads outside a vault:**

| Path | Why | Surface |
|---|---|---|
| `~/.claude/projects/**`, `~/.claude/sessions` | resolving a `claude:` link, and discovering sessions that moved | read-only |
| `~/Library/Application Support/Claude/claude-code-sessions/<org>/<account>/*.json` | the Claude Desktop store — a different vendor surface with its own `local_` id space, for a `claude:` link whose session lives there | read-only |
| any absolute or `../` path in a `doc:` link | the link points there deliberately | read-only, one file |
| any directory, via `GET /api/vaults/browse` | the folder picker | directory *names* only, no file contents |
| a project's declared `repos` | starting work, through `git`; `pj intake` reading `git log` | `git worktree`, `git fetch`, `git log` |

`doc:` and the folder picker are the two places a path outside the vault is reachable, and both are
deliberate: a `doc:` ref is something you typed, and a picker that cannot leave one directory cannot
pick a folder. Neither reads anything you have not named.

**Subprocesses:** `git` (worktrees in declared repos, `log`/`cat-file` in the vault for `pj log`, and
`log`/`branch`/`config`/`remote` in declared repos for `pj intake git`),
`gh` (`pr view`, `api` GETs), `open` (handing one `claude://` deep link to the desktop app, `pj work`
only), and `ps` (one `ppid`
read per level, walking up the process tree to find which live Claude session is asking). No shell —
`execFile`/`execFileSync`/`spawnSync`, always with an argument array, so
nothing is interpolated into a command line. There is no quoting layer left in the launch path: the
workspace and the prompt travel as URL parameters, and the one shell string — the `cd … && claude …`
printed when `open` fails — is never executed by this code.

**Where configuration lives.** A vault's own `.projector/config.yaml` holds which channels it
sweeps, whether its links are enriched, and the credentials those need — read by `src/settings.ts`,
memoised per vault on the file's mtime *and* on the overriding variables, because one server process
holds several vaults open and none of them may answer with another's token. `pj setup`
(`src/setup.ts`) writes the file, adds it to the vault's `.gitignore`, and probes each channel by
making the request rather than checking that a value is present: configured-and-wrong and
never-configured look identical otherwise.

It also holds `poll:` and `classify:` — the keys that let the app write notes nobody asked for, and
the judgement that decides which. Polling is off unless a vault sets it; classification is on unless a
vault turns it off, which is the asymmetry the two failure modes deserve.

The registry beside the app stays what it was — a list of paths, holding nothing secret.

**Environment.** Every value below still wins over the file, which is the one-way escape hatch a test
or a one-off run needs:

| | |
|---|---|
| `PROJECTOR_DATA` | the vault, for the CLI |
| `PROJECTOR_PORT` | server port (default 8092) |
| `PROJECTOR_WORKSPACES` | where worktrees go. **Required** — starting work refuses rather than guessing a directory to create real worktrees in, from the CLI and from the panel alike |
| `PROJECTOR_JIRA_URL`, `PROJECTOR_JIRA_EMAIL`, `PROJECTOR_JIRA_TOKEN` | Jira, for both enrichment and intake; absent means Jira links show their key and nothing more |
| `PROJECTOR_INTAKE_JQL` | overrides the JQL `pj intake jira` searches with |
| `PROJECTOR_GIT_AUTHOR` | whose commits `pj intake git` looks for (default: each repo's own `user.email`) |
| `PROJECTOR_VAULTS` | where the registry file lives (default: `vaults.json` beside the app — the qualifier on *Why the registry is a file*) |
| `PROJECTOR_CLAUDE_HOME` | where `~/.claude` is, for transcripts and live sessions |
| `PROJECTOR_CLAUDE_DESKTOP` | where the Claude Desktop session store is |
| `PROJECTOR_DOC_URL` | an editor URL template for `doc:` links (`cursor://file{path}`); absent means a copyable command instead |

A credential is read from the vault's config or the environment and from nowhere else, and none
reaches the browser: enrichment responses carry the resolved fields, never the token.

## Why the registry is a file

`vaults.json` cannot be `localStorage`, because the **server** is the party that needs it. A request
names its vault in an `X-Projector-Vault` header, and the server refuses a path that is not registered —
so the header is a reference to a folder you chose rather than an arbitrary path a page can name.
`localStorage` is browser-side; the server cannot read it.

It sits next to the app rather than in `~/.projector`, so an install carries its own list: nothing is
written to your home directory, and two installs cannot fight over one file. It is gitignored, because
it holds local paths and belongs to the install rather than the code.

Verified behaviour: an unregistered path gets 428, and a cross-origin request is refused twice over —
the custom header forces a CORS preflight that no origin of ours answers, and a mutating request with a
foreign `Origin` is rejected outright.

The CLI does not depend on the registry to *find* a vault: `vaultAbove` walks up from the working
directory the way git finds a repository, so `pj` works inside any vault whether or not the app has ever
opened it. It reads the registry for one thing only — `--vault` resolves a registered name before it
resolves a path, so `-v work` means the vault you called `work` rather than `./work`. Delete the
registry and you lose the list and that spelling; every other route to a vault is unaffected.

Name-before-path is the fix for a failure that had no symptom. `--vault` was a path only, so `-v work`
run from the *parent* of that vault's folder resolved to a directory that did not exist — and a missing
folder reads as an empty one to everything downstream, so `reindex` walked no files and `ls` and
`search` reported zero matches and exited 0. The registry already held the name, and the CLI was the one
party not consulting it. The second half is `vaultOrExit` refusing a resolved root that is not on disk:
existence is the only test it applies, since an empty folder is a legitimate target for a first note.

The walk-up reads `.projector/` and nothing else, and that strictness is load-bearing. `looksLikeVault`
answers *could this be opened* and says yes to any folder holding markdown; `isConfigured` answers
*which vault am I standing in* and says yes only to one somebody has opened. If the walk-up used the
loose test, `pj set` run anywhere inside a source repository would take that repository for its vault
and write frontmatter into its documentation.

`vaults.json` is never committed, and cannot usefully be: entries hold absolute paths, so one checked
into the repository would name the machine it was committed from. Instead an absent registry *means*
`vaults/tutorial`, resolved against `appRoot` at read time — a synthesised row, not a
seeded file, so nothing is written until you open something and `pj vaults forget` works on it like any
other entry. `PROJECTOR_VAULTS` opts out, which is what keeps the tests from having to know what the
repository ships with.

## Vault seeding

`initVault` writes `.projector/facets.yaml`, `.projector/views/` with five starter views — `home`,
`due`, `projects`, `unblocked`, `everything` — and a `.gitignore`. **No prose, and nothing at the
root.**

Three folders arrive and get three answers. One that already has a `.projector/` is left alone: an
absent `facets.yaml` is a vault carrying the built-ins and nothing else, and a deleted `home.yaml` is a
view somebody deleted, so re-running `--create` must not quietly restore either. One holding markdown
gets the config and nothing else — the notes are already there, and none of them is touched or moved.
An empty one gets the same config and starts bare. Anything else is somebody's documents and is
refused.

The starter views are not optional garnish: a vault with no board opens onto nothing, which is why a
folder of somebody's existing notes is seeded too. The whole point of opening one is to see it
arranged.

It used to also write `notes/README.md`, a per-vault conventions document from `SEED_README`. That was
a near-verbatim copy of the `pj-about` skill, and its only audience — an agent editing note files
directly — already loads the skill. Two documents stating the note format is one document to drift, so
the format is now written down in exactly two places that cannot disagree: `src/schema/note.ts`, which
parses it, and the skill, which explains it.

`README.md` used to be excluded from the note walk by name, on the grounds that a folder full of
markdown attracts one. That exclusion is gone: the folder full of markdown *is* the vault now, so the
same observation is the reason a README should be a note. `listNoteFiles` skips two directories and no
filenames — anything dotted, and `assets`, which is the one tree the app deletes from wholesale.

## The two vaults that ship

Both live under `vaults/`, both are committed, and they have different jobs — which is also the rule
for what may mention them. **Prose describes the tutorial; tests reference either; nothing anywhere
describes the author's own vault**, because a private folder is not evidence a reader can check and
counting what is in it is a number that goes stale by working.

**`vaults/tutorial`** is what a fresh clone opens onto, with no configuration — see *Why the registry
is a file*. Eleven notes chosen as a tour: a project with members, a blocked note and its blocker, a
note waiting on a person, one deliberately overdue, a note that is not work at all, a note in a
subfolder, a `README.md` that is both the folder's readme and a note, and one file with no frontmatter
whose id and title are derived. Its `facets.yaml` is one of the two vocabularies the key checker must
pass — the other is `SEED_FACETS`, which is what created it.

**`vaults/coverage`** carries every state the app can draw: every declared facet value, both ends of
every bucket, a blocking chain and one whose blocker is finished, a link of every kind including two
that cannot resolve. A real vault only exercises the states real work happens to produce, which is how
`.chip.is-overdue` shipped with its text the same colour as its background — no note carried a `due`
date, so the rule had never rendered once.

Its notes are committed markdown, but **its dates are derived**. `due` and `staleness` are computed
against today, so a fixed date stops meaning what it was chosen to mean: the `today` column empties
tomorrow, and within seven weeks every dated note is overdue and four columns have collapsed into one.
Each date therefore names the band it demonstrates in a comment beside it — `due: ["2026-08-17"]  #
overdue` — and `bun run redate` moves them all back to today. That is the whole of what the script
does; the 690-line generator it replaced held every note as a JavaScript string literal, so adding a
state meant editing code rather than writing a note. Two tests guard the arrangement: every date must
carry a band, and the bands must be exactly the buckets the vault's own `facets.yaml` declares.

## Stack

- **`@xyflow/react`** for the canvas. The requirement that settles it: a node must contain arbitrary
  React, because a card face renders live Jira/PR/session chips. `tldraw` needs a commercial licence and
  is shape-model-first; `excalidraw` is sketch-first; `cytoscape` and `konva` cannot host a React
  component inside a node. C7 makes the "but no freehand" trade-off a non-issue.
- **`@dagrejs/dagre`** for auto-layout. `rankdir: LR` reproduces a mind-map directly.
- **`@atlaskit/pragmatic-drag-and-drop`** for the board. What Trello and Jira run on, under 5KB, built
  on native drag events so React StrictMode is a non-issue.
- **CodeMirror 6** for the body, and the reasoning matters more than the library. A ProseMirror-based
  WYSIWYG round-trips content through a document model and *re-serialises* markdown on save. Under
  C1+C3 that is actively harmful: it silently reformats agent-authored files, churns git diffs, and can
  drop constructs it does not model. CodeMirror edits the text itself.
- **`yaml`** for writes. Its Document API patches surgically, preserving comments, key order and
  formatting, so a file the app wrote is indistinguishable from a hand-edited one. `gray-matter`
  re-serialises the whole block.
- **`node:sqlite`**, built in. FTS5 verified and in use; recursive CTEs are headroom nothing currently
  needs. No native rebuild, nothing to install.
- **`hono`** for the server — typed routing, a first-class SSE helper, static files: the three things
  this server does.
- **No client-side query cache.** The rendering rule is stale-while-revalidate, which is what TanStack
  Query is for, but the server already owns the cache and answers from localhost in under a millisecond.
  A second cache with a second staleness model in front of that is only something extra to reason about.

## Tests

`node --test test/*.test.ts`

| | |
|---|---|
| `agent.test.ts` | branch naming — every placeholder spelling substitutes and a typo is refused — the desktop deep link and the one shell string left beside it, base-branch fallback, worktree preparation, both of `planWork`'s refusals, a dry run naming worktrees rather than checkouts, and `pj log` reading every single-valued axis out of git diffs, with the blob walk counting bytes so a multi-byte body cannot derail it |
| `arrangement.test.ts` | positions and note order merge rather than replace; save keeps arrangement |
| `cache.test.ts` | the index memo: a hit when nothing moved, a rebuild when a note lands, a rebuild when another process replaces the index under an open handle, and a dispose that throws not taking the rebuild with it |
| `canvas.test.ts` | nested `--set` and its validation against the result, deleting a note's inbound references, clusters, bands, the layout following only the relation shown, a brood of childless members wrapping into a grid, and faces sized by their content so ranked rows cannot overlap |
| `note.test.ts` | frontmatter round-trips byte-for-byte, surgical key patching, link parsing and hrefs, typed and single-valued facets, and the leniency an adopted vault depends on — a foreign date stamp and an unusable `id:` costing their field rather than the note, with writes still validated |
| `cli.test.ts` | every command refusing an unknown flag, a flag shortening to any prefix that names one — with an ambiguous prefix naming the candidates rather than choosing, and `-v` the vault even on a command carrying `--view` and `--via` — `--vault` taking a registered name ahead of a path and refusing a vault that is not on disk rather than reporting an empty one, `--json` being the payload the app receives, the registry, exit codes |
| `client.test.ts` | body sanitising, asset path rewriting, edge collapse and direction, clearing a URL-only override |
| `enrich.test.ts` | the fetch coalescer: awaited refreshes, cached errors, borrowed fetches, a thrower that still settles |
| `fetchers.test.ts` | each fetcher's parse-and-explain half, with nothing reaching the network |
| `gesture.test.ts` | drag semantics: replace / ⌥ add / ⇧ remove, `(none)`, reorder, matrix diagonals, connect |
| `intake.test.ts` | the watermark discipline: an opaque cursor round-trips, a null commit leaves it, a truncated run holds it, a sweep writes nothing, dedup works with no cursor at all; plus evidence reasons, worktree path parsing, and an FTS query built from a prompt full of operators |
| `keys.test.ts` | the keyboard grammar: the reserved set, whose key a stroke is, the prefix state machine and its fallbacks, a bare digit expanding to the grouped axis, a bare *shifted* axis letter reaching the other end while an undeclared one stays unbound, ⌥ read off the physical key, and the cheatsheet listing nothing the dispatcher ignores |
| `mutate.test.ts` | the write gate: per-note moves, bulk modes, vocabulary enforcement, cycle refusal, mtime conflicts, assets |
| `panel.test.ts` | the panel's write plans, which base mtime each carries, and how a conflict is reported |
| `project.test.ts` | project resolution and inheritance, reference chains, cycles terminating rather than hanging, and multi-project order being topological — every project ahead of anything that names it, ties broken by declaration order |
| `query.test.ts` | the compiler: filters, `(none)`, ranges, computed axes, buckets, references, focus traversals, grouping, counts, FTS |
| `selection.test.ts` | cmd-click, shift-click runs, and a selection never mutated in place |
| `settings.test.ts` | per-vault settings: an absent file behaving exactly as no file did, `false` meaning none, `gh` covering its three ref kinds, the environment overriding the file, and `--init` refusing to overwrite a config holding credentials |
| `source.test.ts` | no source file hides a control byte from grep |
| `spec.test.ts` | `ViewSpec` round-trips through URL params and files; which relation lays a canvas out; every key the writer emits being one `VIEW_KEYS` knows; and a focus emptying the structural filter that would cancel it while leaving every preference filter alone |
| `theme.test.ts` | the design system's invariants: the size and radius scales, token declare/use symmetry, DESIGN.md naming the same tokens and every `components:` reference resolving — plus the rules that were prose until they drifted, namely uppercase only at the Label step, `appearance: none` on the shared field rule, no keyframes and no transition over 140ms, one `@media`, every hue a vocabulary names being a family the stylesheet defines, every `className` resolving to a rule, and this table naming the tests that exist |
| `vault.test.ts` | vault detection and path normalisation, `doc:` resolution, every seeded file parsing as what it claims to be, the seeded view set pinned by name because the manual counts it in prose, an existing `.gitignore` appended to rather than skipped or clobbered, seeding a fresh vault not being the same act as adopting one, and the shipped tutorial passing `pj check` with no warnings — every shape in it is a recommendation whether it was meant as one or not |
| `view.test.ts` | a view file patched in place, an unknown axis refused in every position, an unknown *key* refused too, the empty-group policy |
| `vocabulary.test.ts` | the constraint the model rests on, from both ends: no facet a vault declares is named anywhere in `src/`, and a vault with notes, views and an empty `facets.yaml` loads, validates and answers a query; plus the one asymmetry it allows — the built-in relation carries its own `inverse`, a vault may rename it, and declaring the axis for any other reason does not erase it |

The query tests build their own temp vault rather than reading the real one, so they assert the engine
and not whatever the notes happen to say today. `tsconfig` runs with `noUnusedLocals` and
`noUnusedParameters`: a function that outlives the field it read is a compile error rather than
something a later reader has to notice.
