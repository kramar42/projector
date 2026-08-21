## P7 — done

All five steps shipped, plus the two items they left open: `connect` follows the relation a canvas is
laid out by, and `groupBy` draws bands. See [P7.md](P7.md).

`parent` is `single: true` — nothing had ever created a second parent and no record carried one, so it
states what was already true. Flip the flag if a card genuinely needs to be part of two things.

## Next

- **[P8](P8.md) — typed facets and declarable computed facets.** `ref: true` is one value of a `type:`
  slot; typing the rest absorbs `due` back into the facet system, along with `dueBucket`, the hardcoded
  date branches in the sort comparator, and range filters. The second half moves the five pseudo-facets
  out of `query.ts` into `facets.yaml` as expressions.
- **Per-column summaries**, after P8 and not before. Bases lets a view declare `summaries` per property
  — count, sum, average — over whatever the view selected, where ours has `projectRollups`: the same
  idea hardcoded for one entity type and four fixed numbers. It waits because both halves of it are
  P8's: a summary *is* an expression over a result set, and `sum`/`average` need `type: number` to mean
  anything. Built now it would be count-only — which `projectRollups` already does for the one table
  that shows it — and P8 would replace it immediately.
- **Item-level metadata**, so a checklist stops being a second decomposition mechanism. Sub-cards live
  in `parent`; sub-items live in body prose that nothing can count, query or roll up, so "what is left
  to do" has two answers and only one is addressable. Dataview solves it with inline fields
  (`Key:: Value` on a list item rather than the file) and a TASK query type that queries across files
  *and writes back*. Low priority at five cards using checklists, but it is the same class of defect as
  `edges` vs `facets` was: two mechanisms for one relation.
