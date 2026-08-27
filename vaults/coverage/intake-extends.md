---
id: intake-extends
title: "Another go at the retry bug, on the same branch"
facets:
  intake: ["unjudged"]
  extends: ["intake-unjudged"]
  source: ["git"]
source_fingerprint: "git:coverage@0000000000000000000000000000000000000002"
created: 2025-07-22  # older
updated: 2025-07-22  # older
---

Renders a candidate that wants **folding into** another note rather than standing
alone: `extends` names its target, and the panel draws a ✓ that merges it there
(`+`). Nothing walks `extends`, so sitting here perturbs no count on the target.
