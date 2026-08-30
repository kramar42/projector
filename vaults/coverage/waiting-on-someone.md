---
id: waiting-on-someone
title: "Waiting on a person"
facets:
  status: ["active"]
  priority: ["now"]
  waiting_on: ["person-a", "person-b"]
  domain: ["workflow"]
created: 2025-07-26  # older
updated: 2026-08-26  # week
---

Renders: red `waiting_on` chips and `blocked: waiting_on` — the axis names the
blocking facet that is failing, computed from a non-empty facet rather than from
an edge.
