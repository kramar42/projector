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
created: 2025-07-22  # older
updated: 2026-08-25  # fresh
---

Renders: the `▣` project mark, a member count, a `project:` block in the panel,
and the outer end of an inheritance chain. `identity` is a member *and* a project,
so a table row here reads `direct / total` with total larger than direct.

This is also the folder shape: the note is `platform/README.md`, so the folder
name is the id, and `platform/AGENTS.md` beside it is what members inherit as
instructions.
