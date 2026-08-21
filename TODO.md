
## P7 — remaining

Steps 1 and 2 shipped: relations are reference facets, `edges:` and the `edges` table are gone. See
[P7.md](P7.md) for steps 3–5 — `kind` out, `chips`+`edges` → `show`, `connect` onto the shape, the
three CLI gaps, and the `linked` axis.

- **`connect: ancestors` still walks `parent` unconditionally** (`query.ts`), even when the canvas
  draws `project`. So a portfolio canvas pulls context from a different tree than the one it renders.
  P7 step 3 moves `connect` to the shape and points it at the layout relation.
- **`parent` is now `single: true`.** Nothing had ever created a second parent — every gesture replaced
  — and no record carried one, so this states what was already true. Flip the flag if a card genuinely
  needs to be part of two things.
- canvas clustering by groupBy. A node has one position, so a card multi-valued on the grouped facet
  cannot be in two clusters: assign by first declared value and say so in the sidebar. Accepted-and-
  ignored until then, so switching shape never drops the parameter.

## Ideas worth stealing

Both are Obsidian's, found while checking how much of this a Properties + Dataview + Bases setup could
replace. See P7's closing section for the full comparison.

- **Item-level metadata, so a checklist stops being a second decomposition mechanism.** Sub-cards live
  in `parent`; sub-items live in body prose that nothing can count, query or roll up — so "what is left
  to do" has two answers and only one of them is addressable. Dataview solves this with inline fields
  (`Key:: Value` attached to a list item, not the file) and a TASK query type that queries across files
  at item level *and writes back* — checking a box in a query result updates the source. Low priority
  at five cards using checklists, but it is the same class of defect as `edges` vs `facets`: two
  mechanisms for one relation.
- **Per-column summaries.** Bases lets a view declare `summaries` per property — count, sum, average —
  computed over whatever the view selected. Ours has `projectRollups`: the same idea, hardcoded for one
  entity type and four fixed numbers. A declared summary would give the table roll-ups for any grouping,
  not just projects. Natural companion to P8's declarable computed facets, since both are expressions
  over a result set.

## Open questions

- **Does `parent` survive P7?** 111 cards carry both a parent and a project, 27 a project only, 1 a
  parent only. Once both are reference facets it costs nothing to keep and nothing to drop, so this is
  a `facets.yaml` edit answerable by living with the clean structure rather than a design decision.
- **Unifying `focus` into `filter`.** A focus is a filter clause whose test is transitive rather than
  one level deep. The two-level split exists so the facet panel can offer facets from the *universe*
  while counting from the *filtered pool* — collapse them and "38 filtered out" changes meaning.
  Deferred out of P7 deliberately; settle the histogram semantics first.

## Data

- `energy` is set on a handful of cards, so the Unblocked board groups most of them into (none).
  Either fill it in during triage or drop the facet.
- `owner` is declared and used nowhere.
- Research cards still titled with a bare URL.
- Most cards have no project and many no priority — the Triage view is the place to work through them.
- Nothing carries a `due` yet, so the Due view is empty until triage starts setting one.
