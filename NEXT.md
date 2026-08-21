## Where the model landed

Relations became reference facets and `edges:` left the file format; `kind` went, since carrying a
`status` is what makes a record work and being named as a `parent` is what makes it a container;
`chips` and `edges.show` became one `show`; `connect` moved onto the shape; `groupBy` draws bands on a
canvas. Then facets got a `type` — `label · ref · date · number` — so `due` is an ordinary facet, range
filters work on any ordered one, the type picks the editing control, and project instructions moved out
of the body into the `project:` block.

All of it is described in [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md). The phase
documents it was designed in are gone: the design is the code now, and a second place saying so would
only drift.

One decision worth remembering: **`parent` is `single: true`.** Nothing had ever created a second
parent and no record carried one, so it states what was already true. Flip the flag if a card genuinely
needs to be part of two things.

## Not now

- **The expression language.** Moving the five remaining pseudo-facets — `type`, `blocked`, `triage`,
  `staleness`, `linked` — into `facets.yaml` needs one, and its hardest case cannot be a per-record
  expression at all: `blocked` requires the aggregate pass over every record's `blocks` references.
  Since P8 the case is weaker anyway: each of the five computes over something a facet *cannot*
  describe — a `project:` block, the reference graph, an absence, a record's links, the app-written
  `updated` — so `PSEUDO` has a coherent residual job rather than being a holding pen.
- **Per-column summaries.** Not blocked on the expression language, which was the wrong reason: a
  built-in summary is a *named aggregate* — count, sum, average, min, max — and needs no parser, and
  `type: number` now exists so the arithmetic ones would mean something.

  Two better reasons to wait. **It would not retire `projectRollups`**: `direct`/`total` is a
  transitive walk over the membership graph, not an aggregate over the visible result set, so a summary
  mechanism sits beside the special case instead of absorbing it — the opposite of what P6–P8 each did.
  And **there is nothing to aggregate**: one ordered facet, no record carrying it, no numeric facet, so
  the arithmetic summaries would ship with zero users. What is left — count with a predicate — mostly
  duplicates the counts already on a board column, a table section and the project table.

  Revisit when a numeric facet exists or deadlines are in use, i.e. when there is a question on screen
  that cannot be answered.

## The model is done for now

P6 removed what was stored twice, P7 collapsed relations into facets, P8 typed them. Nothing in the
model is presently known to be wrong, and the next useful work is likely to be *using* it rather than
changing it — 7 `pj check` warnings left, `energy` set on a handful of records, `owner` declared and
unused, no deadlines set anywhere.

Two things the audit of 2026-08-21 turned up that belong here rather than in the model. **`blocks`
carries one value across 191 records**, and `pj next`, the `blocked` axis, the recursive closure, cycle
refusal and the `unblocked` view are all built on it — the mechanism is finished and idle, the same way
`due` and `owner` are. That is also how `pj next` could filter on a deleted facet unnoticed for two
days: with no blocker data, an empty answer looked plausible. And **three of the seven `pj check`
warnings are structural** — `inbox`, `projects` and `jira-triage` are top-level containers that belong
to no project by construction, so the count cannot reach zero until the check exempts records nothing
names as a parent.
