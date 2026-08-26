---
id: due-overdue
title: "A deadline that has passed"
facets:
  status: ["active"]
  priority: ["now"]
  due: ["2026-08-17"]  # overdue
  project: ["platform"]
created: 2025-07-22  # older
updated: 2026-08-25  # fresh
---

Renders: the filled `is-overdue` chip. This is the rule that shipped with
`color: var(--ink)` on `background: var(--bad)` — 1.92:1 in light, 1.94:1 in dark —
and went unseen for as long as it did because the vault it shipped against carried no
`due` dates at all. The chip shows the date and *wears* the bucket.
