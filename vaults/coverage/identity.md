---
id: identity
title: "Identity and access"
facets:
  status: ["active"]
  priority: ["now"]
  project: ["platform"]
  tech: ["keycloak"]
  layer: ["layer-2"]
project:
  repos:
    - { path: "../identity", base: "main" }
  instructions: |
    - A nested project: this line should read *after* the platform one.
created: 2025-07-22  # older
updated: 2026-08-25  # fresh
---

Renders: a project that is itself a member of another project — so `▣` with a
status chip, repo union across two levels, and instructions concatenated
outermost-first.
