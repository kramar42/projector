---
id: intake-extends
title: "Another go at the retry bug, on the same branch"
facets:
  intake: ["unjudged"]
  extends: ["every-facet"]
  source: ["git"]
  status: ["on-hold"]
  priority: ["month"]
  tech: ["kafka"]
created: 2025-07-22  # older
updated: 2025-07-22  # older
---

Renders a candidate that wants **folding into** another note rather than standing
alone. `extends` names its target, and the ✓ in the panel corner (`+`) opens the
fold dialog rather than merging outright.

Its facets are chosen to draw both rows the dialog has: `status` and `priority`
**disagree** with the target's, and `tech` is one the target does not carry at
all. A merge would silently drop all three — the survivor keeps its own labels,
by design — which is the whole reason the dialog exists.
