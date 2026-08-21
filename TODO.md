## P7 — done

All five steps shipped, plus the two items they left open: `connect` follows the relation a canvas is
laid out by, and `groupBy` draws bands. See [P7.md](P7.md).

`parent` is `single: true` — nothing had ever created a second parent and no record carried one, so it
states what was already true. Flip the flag if a card genuinely needs to be part of two things.

## P8 — done

Facets are typed: `label · ref · date · number`, with `buckets` on the ordered ones. `due` is an
ordinary facet, range filters work on any ordered facet, and the type picks the editing control. See
[P8.md](P8.md).

## Next

- **The expression language**, deferred out of P8. Moving the four pseudo-facets — `type`, `blocked`,
  `triage`, `staleness` — into `facets.yaml` needs one, and its hardest case cannot be a per-record
  expression at all: `blocked` requires the aggregate pass that scans every record's `blocks`
  references, so it needs engine-backed built-ins whatever the syntax. Worth asking first whether it is
  wanted: four well-tested functions in `query.ts` are not obviously worse than four expressions in
  YAML for a single-user app whose author edits both.
- **Per-column summaries**, after the expression language and not before. Bases lets a view declare `summaries` per property
  — count, sum, average — over whatever the view selected, where ours has `projectRollups`: the same
  idea hardcoded for one entity type and four fixed numbers. Half of what it needs now exists —
  `type: number` makes `sum` and `average` mean something — and the other half is the expression
  language, since a summary *is* an expression over a result set. Built before that it would be
  count-only, which `projectRollups` already does for the one table that shows it.
