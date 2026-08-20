
## P6 — remaining

- **Membership cycles are unrefused.** `setEdges` refuses a `parent` cycle, but a `project` facet
  naming a record that transitively belongs back is accepted. `resolveProject` has a trail guard so it
  degrades rather than hangs — it silently truncates the config chain instead of saying so.
- **`connect: ancestors` walks `parent` unconditionally** (`query.ts`), even when the canvas is drawing
  `member-of`. So a portfolio canvas pulls in context from a different tree than the one it renders.
  It should follow the shown hierarchy, the way `layoutTypes` already does.
- **Validator warning when a project record's `parent` edge and `project` facet disagree.**
  `resolveProject` reads the facet, so a parent dragged on a portfolio canvas changes the picture and
  not the inheritance. Worth doing whichever way the project modelling lands.
- canvas clustering by groupBy. A node has one position, so a card multi-valued on the grouped facet
  cannot be in two clusters: assign by first declared value and say so in the sidebar. Accepted-and-
  ignored until then, so switching shape never drops the parameter.

## Open questions

- **Membership: facet or edge.** `project` is a facet — it classifies, so it groups a board and drags
  through the one code path, and multi-project is free. But it is also *traversed* transitively, for
  config inheritance and roll-ups, which is what edges are for — so `member-of` has to be synthesised
  on every query, cycles go unchecked, and there are two gestures for one relation. Both readings are
  defensible; the trade is one editing path against one traversal engine.

## Data

- `energy` is set on a handful of cards, so the Unblocked board groups most of them into (none).
  Either fill it in during triage or drop the facet.
- `owner` is declared and used nowhere.
- Research cards still titled with a bare URL.
- Most cards have no project and many no priority — the Triage view is the place to work through them.
- Nothing carries a `due` yet, so the Due view is empty until triage starts setting one.
