
## P7 — done

All five steps shipped. See [P7.md](P7.md).

## Remaining

- **`connect: ancestors` still walks `parent` unconditionally** (`query.ts`), even when the canvas
  draws `project` — so a portfolio canvas pulls context from a different tree than the one it renders.
  `connect` moved onto the shape in step 3, but the *relation* it walks is still hardcoded; it should
  follow the layout relation, which `layoutTypes` already computes.
- **`parent` is `single: true`.** Nothing had ever created a second parent — every gesture replaced —
  and no record carried one, so this states what was already true. Flip the flag if a card genuinely
  needs to be part of two things.
- canvas clustering by groupBy. A node has one position, so a card multi-valued on the grouped facet
  cannot be in two clusters: assign by first declared value and say so in the sidebar. Accepted-and-
  ignored until then, so switching shape never drops the parameter.

## Ideas worth stealing

- **Per-column summaries.** Bases lets a view declare `summaries` per property — count, sum, average —
  computed over whatever the view selected. Ours has `projectRollups`: the same idea, hardcoded for one
  entity type and four fixed numbers. A declared summary would give the table roll-ups for any grouping,
  not just projects. Natural companion to P8's declarable computed facets, since both are expressions
  over a result set.

## Open questions

- **Does `parent` survive P7?** 111 cards carry both a parent and a project, 27 a project only, 1 a
  parent only. Once both are reference facets it costs nothing to keep and nothing to drop, so this is
  a `facets.yaml` edit answerable by living with the clean structure rather than a design decision.

## Data

- `energy` is set on a handful of cards, so the Unblocked board groups most of them into (none).
  Either fill it in during triage or drop the facet.
- `owner` is declared and used nowhere.
- Research cards still titled with a bare URL.
- Most cards have no project and many no priority — the Triage view is the place to work through them.
- Nothing carries a `due` yet, so the Due view is empty until triage starts setting one.
