---
id: needs-status
title: "Has a priority, no status"
facets:
  priority: ["someday"]
  project: ["platform"]
  parent: ["ideas"]
created: 2025-07-26  # older
updated: 2026-08-10  # month
---

Renders: the *Needs status* column of `views/triage.yaml` — the one rule that
needs a `type:` condition, because a note is work only by carrying a status, so
"no status" would otherwise match every project and every container in the vault.
This one is filtered off every status-filtered board while still being a member of
a project.
