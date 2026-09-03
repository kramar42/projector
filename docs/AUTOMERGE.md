# Should Projector use Automerge?

Research date: 2026-08-31. Sources are limited to Projector's repository and first-party
Automerge documentation, specifications, source repositories, and maintainer statements.

Placement note: Projector has no research-note or ADR directory. Its documentation convention is
one document per question ([docs index](README.md)); this file is the single answer to the question
in its title. It is an evaluation, not an agreed implementation plan.

## Answer

**Not as a transparent replacement for the vault, and not yet as a dependency across the whole
stack. Automerge is a good candidate for the collaboration engine if Projector is willing to make
concurrent writers use CRDT-aware operations and to treat Markdown as a projection/export rather
than the sole authoritative state.**

That distinction is decisive. Projector currently promises that Markdown is the source of truth and
that an agent can edit it with ordinary file writes while no app is running
([Architecture, C1 and C3](ARCHITECTURE.md#principles)). Automerge, by contrast, can merge changes
because both replicas carry changes descended from shared document history; independently creating
the same-looking documents does not establish that ancestry
([Automerge data modeling](https://automerge.org/docs/cookbook/modeling-data/)). If two LLMs simply
replace the same filesystem bytes, the filesystem may lose one version before an Automerge watcher
ever observes it. Adding a CRDT sidecar after that cannot reconstruct the lost operation.

The practical recommendation is therefore:

1. **Do not replace the canonical Markdown vault with Automerge now.** That would reverse two of the
   product's load-bearing principles, make direct file-writing agents second-class, and add a binary
   database plus a Markdown projection.
2. **Prototype one note as one Automerge document** only when simultaneous multi-device editing of
   the same note is a demonstrated primary workflow. Start with body text in the existing CodeMirror
   panel, then title and carefully modeled facet/link deltas. Do not begin with a vault-sized
   document.
3. **Require collaborating LLMs to use an operation-aware `pj`/API/MCP path or separate working
   copies.** A plain write to a shared file remains last-writer-wins outside Automerge. Keep direct
   file writes only as an import path with explicit conflict handling, not as an equally safe live
   collaboration path.
4. **Keep Projector's domain validator and serialized commands.** CRDT convergence does not enforce
   unique note IDs, vocabulary constraints, acyclic references, or all-or-nothing rename/fold/merge
   operations.

If retaining “Markdown alone is authoritative and every agent may edit it directly” is non-negotiable,
the answer is simpler: **do not adopt Automerge.** Improve the current narrow mutation operations and
use explicit three-way merge/conflict UX for body edits instead.

## Why it is attractive for the intended multiplayer model

Automerge is a JSON-like CRDT. A document is a root map containing maps, lists, collaborative text,
and scalar values; the scalar set includes timestamps, counters, and byte arrays
([document model](https://automerge.org/docs/reference/documents/)). Every change becomes part of a
causal history, and replicas with common ancestry can make changes offline, later exchange only the
changes they lack, merge them deterministically, and converge
([concepts](https://automerge.org/docs/reference/concepts/),
[sync API](https://automerge.org/automerge/automerge/sync/index.html)). That directly addresses the
desired combination of one person, several devices, intermittent connectivity, and several writers.

For Projector it would provide concrete benefits:

- Two devices can edit offline and converge when they reconnect; clients that already loaded a
  document remain writable while the WebSocket is unavailable
  ([network sync tutorial](https://automerge.org/docs/tutorial/network-sync/)).
- Edits to different object properties combine. Concurrent list/text insertions are both preserved
  in a deterministic order rather than rejected by an mtime guard
  ([conflict semantics](https://automerge.org/docs/reference/documents/conflicts/)).
- A `DocHandle` persists local and remote changes, sends them through every attached network adapter,
  and emits live change events. This could replace much of Projector's current
  watcher → SSE → refetch loop for CRDT-managed content
  ([DocHandles](https://automerge.org/docs/reference/repositories/dochandles/)).
- Automerge Repo also has non-persistent, document-scoped messages suitable for cursors, selections,
  “agent is editing”, and other presence data
  ([ephemeral data](https://automerge.org/docs/reference/repositories/ephemeral/)).
- Each document retains history and exposes heads, historical views, diffs, forks, and changes made
  from an earlier set of heads
  ([DocHandle API](https://automerge.org/automerge-repo/classes/_automerge_automerge-repo.DocHandle.html)).

This improves availability and convergence, but it does not mean every merged result is semantically
correct.

## Merge semantics Projector would have to design around

Automerge automatically combines changes to distinct keys. Concurrent assignments to the same map
property or list element produce a deterministic visible winner; all concurrent values remain
inspectable through `getConflicts`, and assigning the property again resolves that conflict. The
winner is based on operation IDs, not wall-clock time
([conflicts](https://automerge.org/docs/reference/documents/conflicts/)). A concurrent delete and
update resolves to the update, for maps and lists
([merge rules](https://automerge.org/docs/reference/under-the-hood/merge-rules/)).

Consequences for Projector:

- `title`, `project` configuration, dates, and single-valued facets still need a conflict surface or
  a documented policy. “Automerge chose a stable value” is not the same as “the intended value won.”
- A multi-valued facet should not be modeled as one replaceable array property. Model membership as
  independently editable keys (for example `facetValues.priority.now = true`) or apply explicit
  add/remove operations, so two agents changing different memberships touch different keys. Projector
  already learned this lesson in its delta-based facet writes
  ([current write model](../src/web/panel/write.ts)).
- IDs and source fingerprints should be non-collaborative scalar values. Automerge's JavaScript model
  supplies `ImmutableString` for strings that should be replaced rather than character-merged
  ([JavaScript mapping](https://automerge.org/docs/reference/documents/)).
- Rename versus edit, delete versus edit, folding one note into another, and asset relocation need
  explicit application semantics. Projector currently performs these as semantic, multi-file commands
  ([mutation implementation](../src/server/mutate.ts)); a generic CRDT does not know those invariants.
- A document is Automerge's unit of change
  ([concepts](https://automerge.org/docs/reference/concepts/)). Therefore, with one document per note,
  a command spanning several notes has no documented cross-document atomic transaction. Projector
  should keep a coordinator/command log or serialize such commands on a trusted peer. This is an
  inference from the documented per-document change and sync model, not a claim that Automerge loses
  convergence.

The CRDT removes many transport-level conflicts. It does not remove the need for domain conflict
resolution.

## The best places for it in this stack

### 1. Note body editor: highest-value fit

Projector already uses CodeMirror and currently freezes the body's base mtime while the editor is
dirty, refuses to adopt a foreign update, and returns a 409 on save rather than overwrite it
([editor state](../src/web/components/useDocumentEditor.ts),
[write planning](../src/web/panel/write.ts)). That protects data but requires a human to copy/reload
and reconcile.

Automerge text is character-oriented collaborative text. Fine-grained `splice` operations merge
best; `updateText` can diff a whole new string into splices, but the official docs recommend calling
it frequently and warn that large changes between calls merge less well
([text editing](https://automerge.org/docs/reference/documents/text/)). The first-party
[`@automerge/automerge-codemirror`](https://github.com/automerge/automerge-codemirror) plugin binds a
CodeMirror editor to an Automerge Repo `DocHandle`. This is the cleanest pilot seam because both sides
already exist in Projector.

For Markdown, keep the body as plain collaborative text. Automerge's rich-text marks/block schema is
not needed unless Projector changes from source Markdown editing to a structured rich-text editor;
the rich-text API is Peritext-based and has separate mark/block reconciliation constraints
([rich text](https://automerge.org/docs/reference/documents/rich-text/)).

### 2. Title, facets, and links: useful only with operation-aware modeling

Independent object keys merge naturally, so title/body/facet/link changes made concurrently can
compose. Facet add/remove is particularly compatible with Projector's existing narrow mutation
language. Same-property replacement conflicts remain visible and need policy.

This layer should still run Projector's Zod/vocabulary validation before accepting local changes and
again after receiving remote ones. Otherwise every replica can converge on a structurally valid CRDT
that violates Projector's model. Rejecting or compensating for an already-replicated invalid change is
itself a collaborative workflow; Automerge's current JavaScript core exposes history/diff primitives,
but generic undo/revert is still an open feature request
([Automerge issue #985](https://github.com/automerge/automerge/issues/985)).

### 3. Saved-view arrangement: plausible, lower value

Node positions and ordering in `.projector/views/*.yaml` are map/list-like and would converge better
than concurrent whole-file writes. Contention is probably much lower than note bodies, so this should
follow rather than lead a pilot. Query results and the SQLite index remain derived and should not be
CRDT state.

### 4. Presence and agent coordination: useful complement

Ephemeral messages can carry cursor/selection/presence without adding these high-frequency values to
history ([ephemeral data](https://automerge.org/docs/reference/repositories/ephemeral/)). They could
show which device or agent is working on a note and discourage redundant work. They are not durable
locks and do not prevent a disconnected agent from editing, so correctness cannot depend on them.

### 5. Whole vault, files, assets, and derived databases: poor fits

- **One giant vault document:** it makes cross-note changes easier to place in one Automerge change,
  but every client then loads/synchronizes a much larger history and one corrupted/hot document has a
  larger blast radius. Official guidance says hundreds of documents have been practical, thousands
  can have significant synchronization overhead, and fewer loaded documents improve startup and sync
  time; it explicitly recommends workload-specific measurement
  ([modeling and performance](https://automerge.org/docs/cookbook/modeling-data/)). A vault-sized
  document should not be the default.
- **SQLite index and enrich cache:** these are already deterministic, disposable projections from the
  files ([Architecture](ARCHITECTURE.md#the-shape-of-it)). Replicating them would create redundant
  truths and unnecessary history.
- **Assets:** Automerge can store byte arrays, but putting images into change history couples large
  blobs to document synchronization. Keep Projector's content-addressed asset files outside the CRDT
  and replicate them with a blob/file mechanism; keep only their references in the document. This is
  an architectural recommendation, not an Automerge limitation.
- **Arbitrary filesystem trees:** Automerge Repo's NodeFS adapter stores its internal snapshot and
  incremental binary chunks in a directory; it does not turn an existing Markdown directory into a
  collaborative filesystem
  ([storage adapters](https://automerge.org/docs/reference/repositories/storage/),
  [storage internals](https://automerge.org/docs/reference/under-the-hood/storage/)). There is no
  first-party Markdown/filesystem bridge in the documented adapter set.

## A technically coherent Automerge shape

If Projector accepts the product change, use this as the starting hypothesis, not as a final design:

```text
browser/device Repo
  IndexedDB storage
  BroadcastChannel for same-browser peers
  authenticated WSS to a self-hosted peer
          │
          ▼
Projector sync/server peer
  NodeFS Automerge storage under .projector/
  domain validation + serialized multi-note commands
  deterministic Markdown materializer/importer
          │
          ├── one Automerge document per note
          ├── one vocabulary/config document
          ├── one document per saved view
          └── external assets remain files/blobs
```

Automerge Repo officially supplies IndexedDB and concurrent-safe NodeFS storage adapters, and
WebSocket, MessageChannel, and BroadcastChannel network adapters
([storage](https://automerge.org/docs/reference/repositories/storage/),
[networking](https://automerge.org/docs/reference/repositories/networking/)). The point-to-point sync
protocol can operate client/server, peer-to-peer, or server-to-server over a reliable, in-order stream
([Rust sync API](https://automerge.org/automerge/automerge/sync/index.html)).

Use one document per note initially because a note is the natural collaboration, loading, history,
and access-control unit. Keep a small manifest mapping stable note IDs to Automerge URLs and filenames.
Do not infer document identity independently on each device: replicas must share the initialized
history, even when their visible content is identical
([initialization guidance](https://automerge.org/docs/cookbook/modeling-data/)).

This shape has one unresolved product decision: which representation is authoritative?

- **Automerge authoritative, Markdown projected:** coherent CRDT behavior, durable offline history,
  and reliable sync. It breaks current C1/C3: an external plain file write must be imported and can no
  longer be considered equivalent to a structured change.
- **Markdown authoritative, Automerge derived:** preserves the product promise, but a restart or an
  unobserved replacement can destroy the causal information required for high-quality merges. The
  sidecar is then a best-effort live-session cache, not a reliable offline collaboration system.
- **Both authoritative:** reject this. It creates feedback loops, ambiguous recovery after a crash,
  and two answers when Markdown and Automerge disagree—the exact class of disagreement C11 excludes.

There is no implementation trick that removes this choice.

## Storage, persistence, and performance

Automerge's compact binary format retains a document's change history. Automerge Repo writes
incremental changes and occasionally compacts them into snapshots; its storage layout is designed so
concurrent repositories can compact without overwriting changes they have not incorporated
([storage internals](https://automerge.org/docs/reference/under-the-hood/storage/)). A Repo without a
storage adapter is transient and must reload from peers after restart; IndexedDB and NodeFS are the two
documented built-ins, and custom key/value adapters are supported
([storage adapters](https://automerge.org/docs/reference/repositories/storage/)).

Tradeoffs:

- Durable CRDT state adds binary files that Git and ordinary editors cannot meaningfully diff.
  Keeping Markdown snapshots preserves readable diffs, but makes the materializer and recovery rules
  critical infrastructure.
- Full history is valuable for auditing, branches, and comparing heads, but it grows with changes.
  Official guidance says history truncation/garbage collection has not been prioritized and tells
  applications to benchmark their real workload and document partitioning
  ([performance guidance](https://automerge.org/docs/cookbook/modeling-data/)).
- The Automerge 3 core reports roughly a tenfold memory reduction over Automerge 2, while the project
  still recommends measurement rather than a general size promise
  ([core repository status](https://github.com/automerge/automerge),
  [Automerge 3 migration](https://automerge.org/docs/guides/migrating-from-automerge-2-to-automerge-3/)).
- The current JavaScript `automerge-repo` TypeDoc identifies itself as `2.6.0-alpha.3`, while the core
  JavaScript package is described as stable. Treat Repo integration APIs as a moving dependency and
  pin/test upgrades
  ([Repo TypeDoc](https://automerge.org/automerge-repo/interfaces/_automerge_automerge-repo.RepoConfig.html),
  [core status](https://github.com/automerge/automerge)).
- Vite integration requires WebAssembly loading support and, in the documented setup, the WASM and
  top-level-await plugins
  ([library initialization](https://automerge.org/docs/reference/library-initialization/)). That is a
  modest but real build/runtime addition to Projector.

Before adoption, benchmark at least: cold load of 100/1,000/representative notes, one year of body
keystrokes, agent-sized replacements, initial sync, reconnect after a week offline, memory with the
largest note open, compaction, and Markdown projection throughput.

## History and undo

Automerge history is stronger than Projector's current 50-entry, in-memory facet undo stack: heads can
identify historical states, `history()` traverses changes, `diff()` compares states, and `changeAt()`
can create a concurrent change from earlier heads
([DocHandle API](https://automerge.org/automerge-repo/classes/_automerge_automerge-repo.DocHandle.html)).
It also complements Git rather than making Git unnecessary: Git remains the readable, human-controlled
history of projected Markdown.

However, retained history is not a ready-made collaborative Ctrl-Z. The current JavaScript feature
request for generic undo/revert remains open, and applying the inverse of one actor's change while
preserving later concurrent work requires application policy
([issue #985](https://github.com/automerge/automerge/issues/985)). Keep CodeMirror's editor undo for
local typing and Projector's semantic inverse operations for facets. Consider persistent, labeled
compensating changes only after their behavior under remote edits is tested.

## Schema evolution and interoperability

Automerge has a flexible JSON-like model rather than an enforced schema. Applications can store a
version and write migrations, but the official guide warns that the same migration may run
concurrently on several replicas. Its suggested safe pattern is a deterministic precomputed change
with shared ancestry for each migration, and it warns about old app versions continuing to edit
documents; more advanced schema migration ideas are not built into Automerge
([versioning](https://automerge.org/docs/cookbook/modeling-data/)).

Projector would therefore need:

- a version field in every document type;
- deterministic, idempotent migrations tested under duplicate/concurrent application;
- compatibility windows for older devices and agents;
- post-merge domain validation; and
- an explicit policy for unknown facet definitions and unknown document fields.

The core is Rust exposed to JavaScript/WASM and C; the official API page also links Python, R, Rust,
and Swift implementations or bindings
([core repository](https://github.com/automerge/automerge),
[API index](https://automerge.org/docs/reference/api/)). This gives the binary format and core CRDT a
credible cross-language path. Do not assume Automerge **Repo** has identical maturity everywhere: the
official concepts page notes that the repository abstraction is JavaScript-specific in parts, while
the Swift Repo is a separate library tested for JavaScript interoperability
([concepts](https://automerge.org/docs/reference/concepts/),
[Automerge Swift](https://github.com/automerge/automerge-swift)). Projector's Bun/Node/React stack is
on the best-supported path.

## Security and trust

Automerge supplies convergence, content-addressed history, storage, and sync plumbing; it is not a
complete identity, authorization, or encryption system.

- The reference sync server describes itself as an **unsecured Express app** suitable for demos or a
  public server
  ([sync server README](https://github.com/automerge/automerge-repo-sync-server)). The community
  server has no reliability or data-safety guarantee and should not be used for production data
  ([network tutorial](https://automerge.org/docs/tutorial/network-sync/)).
- Repo has per-peer/per-document sharing policy hooks, but its default is broad sharing and the newer
  share configuration is marked experimental
  ([Repo configuration](https://automerge.org/automerge-repo/interfaces/_automerge_automerge-repo.RepoConfig.html)).
  A peer ID supplied to a policy is not, by itself, a user identity or proof of authentication.
- A core maintainer states that the standard sync protocol operates on unencrypted document data and
  that end-to-end encryption/key management is not integrated with Automerge Repo; encrypted changes
  require a custom transport/flow
  ([maintainer discussion](https://github.com/automerge/automerge/discussions/867)).

For personal notes, self-host behind authenticated TLS, authorize every document request, encrypt the
storage volume/backups, and threat-model every device and LLM agent as a writer. If the sync server
must be unable to read note content, Automerge Repo's standard stack is not sufficient as documented;
that requirement should block adoption until a reviewed E2EE design exists.

## LLM-specific consequences

Automerge's page titled “Using Automerge with LLMs” only documents its `llms.txt` documentation feed;
it does not provide agent-editing semantics or a filesystem integration
([LLM guide](https://automerge.org/docs/guides/using-automerge-with-llms/)). Projector must define those.

There are three viable agent modes:

1. **Structured agent:** the agent uses `pj`/MCP/API operations—patch title, splice body, add/remove one
   facet, add/remove one link. This gives Automerge the intent needed for good merges and is the best
   multiplayer mode.
2. **Isolated file agent:** each agent works in its own snapshot/worktree; Projector imports the final
   textual diff as one change and shows conflicts before materializing. This keeps ordinary editor
   ergonomics but does not provide keystroke-level merging.
3. **Shared-file replacement agent:** several agents overwrite the same pathname. Automerge cannot
   make this reliable because a replacement can be lost by the filesystem before it enters any
   Automerge document. A watcher reduces the race window but does not remove it.

Projector currently permits mode 3 as a first-class path and uses mtime refusal only for browser writes;
CLI/bulk paths can decline the guard and agents bypass the app entirely
([Architecture write model](ARCHITECTURE.md#the-shape-of-it),
[mutation guard](../src/server/mutate.ts)). Making Automerge valuable to “many LLM models” therefore
requires changing the agent contract, not merely adding a library.

## Adoption gates and pilot

Proceed only if all of these become true:

- simultaneous/offline editing of the same note is common enough that 409/reload or manual merges are
  a product problem;
- Projector is willing to designate Automerge or a server command log as authoritative during
  collaboration;
- participating LLMs can be routed through structured operations or isolated workspaces;
- a self-hosted authenticated sync topology and backup/recovery story are acceptable; and
- the representative benchmark stays within startup, memory, and sync budgets.

A bounded pilot should answer the decision without committing the vault:

1. Build a throwaway one-note `DocHandle<{ body: string }>` behind the existing CodeMirror editor,
   with two browsers, IndexedDB, BroadcastChannel, and a local WebSocket/NodeFS peer.
2. Test concurrent insert/insert, insert/delete, whole-paragraph replacement, offline edits, reconnect,
   crash during projection, and an external direct Markdown edit.
3. Record the exact Markdown-authority rule and surface `getConflicts` rather than silently accepting
   same-property winners.
4. Add structured facet membership and one LLM patch client only if text succeeds.
5. Measure with representative vault/document histories. Stop if preserving direct arbitrary writes
   requires a bidirectional sidecar whose recovery rules cannot name one authority.

The likely successful end state is **Automerge for live note collaboration, Projector commands for
domain operations, files/blobs for assets, and Markdown as a readable projection/export**. The likely
successful end state under the current immutable product principles is **no Automerge**.
