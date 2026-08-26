---
id: every-link-kind
title: "One link of every kind"
facets:
  status: ["active"]
  priority: ["month"]
  project: ["identity"]
  source: ["jira"]
links:
  - "jira:PROJ-303"
  - "gh:pr:Acme/platform#412"
  - "gh:branch:Acme/platform@main"
  - "gh:commit:Acme/platform@0000000000000000000000000000000000000000"
  - "claude:00000000-0000-4000-8000-000000000000"
  - "doc:docs/resolves.md"
  - "doc:docs/absent.md"
  - "slack:https://acme.slack.com/archives/C01234567/p1700000000000100"
  - "https://example.com/a/very/long/path/that/should/be/ellipsised/well/before/here"
created: 2025-07-22  # older
updated: 2026-08-25  # fresh
---

Renders: every `linked` computed axis value, and the two failure paths that matter —
`doc:docs/absent.md` points at nothing, and the `jira`, `gh` and `claude` refs
cannot resolve without credentials. Each should say why *once* and stay cached,
not retry on every render. The bare URL is long on purpose: the label ellipsises
at 130px.

Every kind here except `claude` and `doc` is clickable with no fetcher having
run — a fetcher adds a title and a status, never the ability to click. Those two
have nowhere on the web to go: a session on this machine, and a file in the vault.
