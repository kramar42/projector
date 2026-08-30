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
  - "gh:pr:acme/platform#412"
  - "gh:branch:acme/platform@main"
  - "gh:commit:acme/platform@0000000000000000000000000000000000000000"
  - "claude:00000000-0000-4000-8000-000000000000"
  - "workspace:/nonexistent/coverage-wt-every-link-kind"
  - "doc:docs/resolves.md"
  - "doc:docs/absent.md"
  - "slack:https://acme.slack.com/archives/C01234567/p1700000000000100"
  - "https://example.com/a/very/long/path/that/should/be/ellipsised/well/before/here"
created: 2025-07-26  # older
updated: 2026-08-29  # fresh
---

Renders: every `linked` computed axis value, and the failure paths that matter —
`doc:docs/absent.md` points at nothing, `workspace:` names a directory that is
not there, and the `jira`, `gh` and `claude` refs cannot resolve without
credentials. Each should say why *once* and stay cached,
not retry on every render. The bare URL is long on purpose: the label ellipsises
at 130px.

Every kind here except `claude`, `workspace`, `doc` and `jira` is clickable with
no fetcher having run — a fetcher adds a title and a status, never the ability to
click. `jira` joins the clickable ones once a base URL is configured
(`PROJECTOR_JIRA_URL`, or `jira.url` in config.yaml); the other three have
nowhere on the web to go: a session on this machine, the directory one worked in,
and a file in the vault.
