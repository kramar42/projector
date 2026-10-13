---
id: due-overdue
title: "A deadline that has passed"
facets:
  status: ["active"]
  priority: ["now"]
  due: ["2026-08-21"]  # overdue
  project: ["platform"]
created: 2025-07-26  # older
updated: 2026-08-29  # fresh
---

Renders: the filled overdue chip — the bucket's own `hue: red` drawn
`is-filled`. This is the rule that shipped with
`color: var(--ink)` on `background: var(--bad)` — 1.92:1 in light, 1.94:1 in dark —
and went unseen for as long as it did because the vault it shipped against carried no
`due` dates at all. The chip shows the date and *wears* the bucket.
