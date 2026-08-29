---
id: intake-unjudged
title: "Retry logic on the webhook consumer keeps firing twice"
facets:
  intake: ["unjudged"]
  source: ["claude"]
source_fingerprint: "claude:00000000-0000-4000-8000-000000000001"
created: 2025-07-25  # older
updated: 2025-07-25  # older
---

Renders an **unjudged intake candidate**: the one state where a note carrying no
project, priority or status is correct rather than half-filed. It is why
every column of `views/triage.yaml` filters `intake: ['(none)']` — a candidate is
missing project, priority and status by construction, and a queue of these would
swamp the board that exists to find notes somebody started and left.

Judging it removes the axis. Declining it deletes the file and records the
fingerprint through `pj intake suppress`, so the next sweep does not offer it
again.
