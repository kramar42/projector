---
id: waiting-on-someone
title: "Waiting on a person"
facets:
  status: ["active"]
  priority: ["now"]
  waiting_on: ["person-a", "person-b"]
  domain: ["workflow"]
created: 2025-07-22  # older
updated: 2026-08-22  # week
---

Renders: red `waiting_on` chips and `blocked: waiting` — the third value on that
axis, computed from a non-empty facet rather than from an edge.
