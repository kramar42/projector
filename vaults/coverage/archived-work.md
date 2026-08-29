---
id: archived-work
title: "Archived rather than deleted"
facets:
  status: ["archived"]
  priority: ["someday"]
  source: ["claude"]
source_fingerprint: "claude:00000000-0000-4000-8000-000000000000"
created: 2025-07-25  # older
updated: 2025-07-25  # older
---

Renders: `status: archived`, the fifth lifecycle value, and a note carrying a
`source_fingerprint`.

Archiving is for a rejection worth **keeping as a record** — the note stays, and
its fingerprint stays with it, so the next sweep does not recreate it. A rejection
not worth a file uses `pj intake suppress` instead, which records the fingerprint
and the reason without leaving a note behind. Deleting the file and doing neither
is the one option that loses the fingerprint and gets the candidate back.
