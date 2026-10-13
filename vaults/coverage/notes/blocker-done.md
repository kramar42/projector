---
id: blocker-done
title: "A blocker that is finished"
facets:
  status: ["done"]
  priority: ["month"]
created: 2025-07-26  # older
updated: 2026-08-10  # month
---

Renders: `status: done`, and the *absence* of an effect. A finished blocker blocks
nothing, so whatever names it must read `clear` — the one rule in `isClosed` that a
naive implementation gets wrong by counting edges instead of reading them.
