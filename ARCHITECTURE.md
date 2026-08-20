# Architecture

How cockpit works inside, and the invariants to preserve when changing it. For what the app *is* and
how to use it, see [README.md](README.md).

## Principles

These are decided. Most of the design is one of them being applied, and the source cites them by
number.

| | | |
|---|---|---|
| C1 | Markdown files are the source of truth | any index is derived and disposable |
| C2 | Everything external is read-only | no code path writes to Jira, GitHub, Trello or Slack |
| C3 | Cards stay agent-editable | an agent edits them with plain file writes — no API, no app running |
| C4 | Two record classes | `node` (a thought) and `card` (work), with explicit promotion |
| C5 | Every shape is equally first-class | all three are editable, not just viewable |
| C6 | The card body is free-form | description, links, files, images — no template |
| C7 | No freehand drawing | the canvas is structured nodes and typed edges. This is what settles the canvas library |
| C8 | Derived signals are deterministic | every count and badge is computed, never inferred by a model |
| C9 | A view is a query, not a place | `view = filter × focus × shape × face`. Everything derivable is a live control; everything hand-curated is a saved-view-only key |
| C10 | Structure is edited by gesture, content in the panel | facets, `parent` and edges by drag and bulk bar; title, body, links and `project:` only through `?card=` |

## The pipeline

```
cards/*.md, facets.yaml, views/**        ← source of truth. Git-tracked, agent-editable
        │
        ▼
   read → validate → node:sqlite index (.index.db)
        │                    derived and disposable; ck reindex is always correct
        ▼
   hono: /api/meta  /api/query  /api/card/:id  /api/view/:name
        │                    re-read whenever a file changes
        ▼
   React: the sidebar composes the query │ board │ canvas │ table │ card panel
```

The index is never authoritative — nothing in it survives a rebuild, and nothing needs to.

## Layout

| | |
|---|---|
| `src/schema/` | card and facet types, frontmatter read/write, validation |
| `src/index/` | the indexer, the query compiler, the index memo |
| `src/view/` | `ViewSpec` — the one description of a view, shared by URL, file and CLI flags |
| `src/server/` | hono routes, mutations, file watcher, SSE, vault seeding |
| `src/web/` | React: sidebar, three shapes, card panel |
| `src/cli/` | `ck` |
| `src/enrich/` | read-only link fetchers, each with a TTL |
| `src/agent/` | card context assembly, worktree workspaces, briefings |
| `src/import/` | one-time Trello and TODO.md importers |

## The query compiler

`src/index/query.ts` is the whole engine, and `src/view/spec.ts` is the one description of a view —
shared by the URL, a saved file and `ck` flags, so the three cannot drift. `ck ls --view unblocked` and
opening that view in the browser go through the same code.

**Filtering runs in memory** over the record map rather than in SQL. Not a performance trade — at this
scale both are free — it is what lets a pseudo-facet be indistinguishable from a real one. In SQL,
`blocked` and `triage` would each need their own expression in the filter, the grouping *and* the
histogram; in JS they need one function and the rest of the engine cannot tell them apart. SQLite keeps
the two jobs it is genuinely better at: full text (FTS5) and the recursive `blocks` closure.

**Universe vs. hits.** `universe` is what focus and search left; `hits` is that narrowed by the facet
filter. The distinction is load-bearing in two places: the sidebar reports `universe − total` as
"filtered out", so the number is exact rather than inferred from the histogram; and the facet panel
decides *which facets to offer* from the universe while computing *counts* from the filtered pool.

**Two questions, not one.** Which facets are offered is decided by the universe, so refining one facet
never removes another — otherwise narrowing hard sheds the panel down to the one axis you already used,
with no way to look sideways. What each value counts lifts that facet's own selection and applies every
other one, so an unselected value says what adding it would bring; counted against the fully filtered
set instead, every unselected value reads 0 and a selection can be narrowed but never widened.

A facet with no real value anywhere in the universe is dropped, which is what keeps a scoped facet out
of the panel without a UI rule for `scope:`. Values the universe holds stay listed at zero, and a
selected value always stays listed or it could never be unselected.

## The index memo

`load()` is memoised on an exact stamp of every file it reads — each mtime, plus how many files there
are. Rebuilding costs ~37ms at 159 cards; checking the stamp costs ~0.5ms.

Before the query became interactive the index was rebuilt on every request, which was right while a
request meant a click. A live search box makes that several rebuilds a second. The stamp is not a TTL
or a heuristic, so C1 is intact: if any of those bytes could have changed, the answer is rebuilt.
Mutating routes additionally call `invalidate` through `bump`, so our own writes never depend on mtime
resolution being finer than a burst of them.

The memo also disposes the superseded `DatabaseSync`, which the per-request version leaked once per
request.

**Callers must not `await` between `load()` and their last read of what it returns**, or a concurrent
request could rebuild and dispose it mid-handler. Every call site today is a GET handler that returns
without suspending.

## Invariants

Things that look like details and are not. Each of these was a bug at some point.

**Arrangement merges, never replaces.** The client sends only the nodes it currently renders, and that
is a filtered subset — replacing the `nodes` map would silently discard the position of everything the
filter happened to hide. Same for `order`, per column. An entry is dropped only when its card is
actually gone, and the live-id set is built at most once per save.

**Saving a view keeps its arrangement.** *Save current as…* over an existing name replaces the query
wholesale and leaves `nodes`, `order` and `layout` alone, so refining a saved view's filter does not
cost you its layout.

**Two sentinels, one reason.** The server merges a saved view's parameters *under* the URL's, so an
absent key means "inherit". Clearing something therefore needs an explicit empty value: `f.status=`
means "no status filter" over a saved view that had one, and `focus=` means "no focus". Deleting the key
instead lets the saved value come straight back.

**`(none)` travels as itself** in the URL and in a view file, never as a bare `none`, so a facet that
one day has a literal value `none` cannot collide with the absence refinement.

**Canvas layout follows the hierarchy edges that are *shown*,** not `parent` alone. `parent` is
decomposition and `member-of` is membership — either can lay a graph out, while `blocks` and `relates`
are drawn but never fed to dagre, since an edge pointing sideways across the tree distorts every rank it
crosses. Laying a `member-of` canvas out by `parent` puts every node in one column with the hierarchy
invisible.

**One edge per pair of records,** whatever the types. `parent` and `member-of` agreeing is the expected
shape for a project record, so drawing both put two identical lines on top of each other. Collapsed, a
pair that agrees reads as one relationship and a pair that *disagrees* still shows as two edges pointing
at different records — the case worth seeing. Edge labels need an explicit neutral fill, because a label
inherits the stroke colour otherwise.

**`member-of` is derived, never stored.** Membership *is* the `project` facet: `resolveProject` reads
the facet and nothing else, so drawing the project hierarchy from `parent` edges would show a picture
that inheritance does not follow.

**Conflicts are refused, not merged.** A card read into the panel carries its file mtime; a write sends
it back and a mismatch is a 409. This matters because an agent may be editing the same file in another
window (C3).

**Grouping is one function called twice.** A second axis is a position in `groupBy`, not a separate
`swimlanes` concept, which is why a matrix needed no new code path. A canvas cannot cluster yet because
a node has one position and a card multi-valued on the grouped facet cannot sit in two clusters —
`groupBy` is accepted and ignored there so switching shape never drops the parameter.

## What it writes

C2 says everything external is read-only. Concretely, every operation that writes anything:

| Operation | Writes | Never |
|---|---|---|
| `ck add` / `POST /api/card` | one new card file | never overwrites an existing file |
| `ck link`, `ck set`, `PATCH /api/card/:id` | one card's frontmatter, or its body when `body` is sent | a frontmatter change never touches body bytes |
| `PUT /api/card/:id/edges` | one card's `edges` | refuses an edge that would create a parent cycle |
| `PUT /api/card/:id/frontmatter` | one card's whole frontmatter block | never touches the body |
| `DELETE /api/card/:id`, `POST /api/bulk` | card files, and edges that pointed at a deleted card | nothing outside `cards/` |
| `PUT /api/view/:name` | one view file's query half | never touches its stored arrangement |
| `PATCH /api/view/:name/arrangement` | one view file's `nodes`/`order`, merged by id | never drops an entry whose card still exists |
| `DELETE /api/view/:name` | one view file | never touches the cards it selected |
| `POST /api/card/:id/asset` | one file under `cards/assets/<id>/` | never overwrites: the name is a content hash |
| `ck import …` | new card files; skips any id already present | never edits or deletes an existing card |
| everything else | `.index.db` and `.enrich.db` only | never touches a card file |

The only outbound calls are reads: `gh pr view`, `gh api` GETs, Jira GETs. Fetcher modules export no
mutation functions, so there is no code path to write back.

A mutating request is refused when it carries an `Origin` header that is not one of ours, since a
localhost server is reachable from any page open in the browser. Every frontmatter write goes through
`writeCardFile`, which writes a temp file and renames, so a concurrent reader never sees half a file.

## Vault seeding

`initVault` writes `cards/`, `facets.yaml`, four starter views, a `.gitignore`, and
**`cards/README.md`** — the per-vault conventions document, from `SEED_README` in `src/server/seed.ts`.
That file is where the card format is documented for whoever is editing files directly, so it travels
with the data rather than with the app. `listCardFiles` excludes it by name, so it is never mistaken
for a card.

Keep it in step with the format: it and `src/schema/card.ts` are the two places the card shape is
written down.

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
- **`node:sqlite`**, built in. Recursive CTEs and FTS5 both verified. No native rebuild, nothing to
  install.
- **`hono`** for the server — typed routing, a first-class SSE helper, static files: the three things
  this server does.
- **No client-side query cache.** The rendering rule is stale-while-revalidate, which is what TanStack
  Query is for, but the server already owns the cache and answers from localhost in under a millisecond.
  A second cache with a second staleness model in front of that is only something extra to reason about.

## Tests

`node --test test/*.test.ts`

| | |
|---|---|
| `model.test.ts` | frontmatter round-trips, link parsing, project resolution, drag semantics, worktrees |
| `query.test.ts` | the compiler: filters, `(none)`, pseudo-facets, focus traversals, grouping, counts, FTS |
| `spec.test.ts` | `ViewSpec` round-trips through URL params and files, including legacy view files |
| `arrangement.test.ts` | positions and card order merge rather than replace; save keeps arrangement |

The query tests build their own temp vault rather than reading the real one, so they assert the engine
and not whatever the cards happen to say today.
