## P7 — done

All five steps shipped, plus the two items they left open: `connect` follows the relation a canvas is
laid out by, and `groupBy` draws bands. See [P7.md](P7.md).

`parent` is `single: true` — nothing had ever created a second parent and no record carried one, so it
states what was already true. Flip the flag if a card genuinely needs to be part of two things.

## P8 — done

Facets are typed: `label · ref · date · number`, with `buckets` on the ordered ones. `due` is an
ordinary facet, range filters work on any ordered facet, and the type picks the editing control. See
[P8.md](P8.md).

## Not now

- **The expression language.** Moving the four remaining pseudo-facets — `type`, `blocked`, `triage`,
  `staleness` — into `facets.yaml` needs one, and its hardest case cannot be a per-record expression at
  all: `blocked` requires the aggregate pass over every record's `blocks` references. Since P8 the case
  is weaker anyway: each of the four computes over something a facet *cannot* describe — a `project:`
  block, the reference graph, an absence, the app-written `updated` — so `PSEUDO` has a coherent
  residual job rather than being a holding pen.
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
changing it — 10 `ck check` warnings left, `energy` set on a handful of records, `owner` declared and
unused, no deadlines set anywhere.
