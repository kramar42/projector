---
id: personal-site
title: Personal site
facets:
  status: [active]
  domain: [writing]
project: {}
created: 2026-08-26
updated: 2026-08-26
---

A project note. It is a project because it carries a `project:` block — nothing declares a
"kind" anywhere, and no facet says `type: project`.

Other notes join it with the `project` facet, and the **Projects** table rolls up what they
say — the panel lists them here under **Members**. Membership and decomposition are separate
questions, so a note that belongs here can also sit under another note with `parent:`, the way
*Pick a CSS approach* sits under the redesign. What it should not do is point both axes at this
note: `project` already records that edge, and `pj check` warns about the copy.
