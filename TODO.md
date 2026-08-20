
## P5 — remaining

- canvas clustering by groupBy. A node has one position, so a card multi-valued on
  the grouped facet cannot be in two clusters: assign by first declared value and
  say so in the sidebar. Accepted-and-ignored until then, so switching shape never
  drops the parameter.
- validator warning when a project record's `parent` edge and `project` facet
  disagree. `resolveProject` reads the facet, so a parent edge dragged on a
  portfolio canvas changes the picture and not the inheritance.

## Data

- `energy` is set on 11 of 159 cards, so the Unblocked board groups 108 into
  (none). Either fill it in during triage or drop the facet.
- 11 research cards are still titled with a bare URL.
- 77 cards have no project, 34 no priority — the Triage view is the place to work
  through them.
