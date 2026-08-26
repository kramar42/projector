---
id: platform
title: "Platform"
facets:
  status: ["active"]
  priority: ["now"]
  domain: ["identity"]
  layer: ["layer-2"]
project:
  repos:
    - { path: "../services", base: "main" }
    - { path: "~/code/infra", base: "dev" }
  jira: PROJ
  branch: "plat/{note}"
  instructions: |
    - Never change a realm in eu-prod without a ticket and a rollback plan.
    - This is the outermost project, so this line should read *first* in an inherited chain.
created: 2025-07-22  # older
updated: 2026-08-25  # fresh
---

Renders: the `▣` project mark, a member count, a `project:` block in the panel,
and the outer end of an inheritance chain. `identity` is a member *and* a project,
so a table row here reads `direct / total` with total larger than direct.
