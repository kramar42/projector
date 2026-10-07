---
id: every-body-ref
title: "Every kind of reference a body can carry"
facets:
  status: ["active"]
  priority: ["month"]
  project: ["platform"]
  source: ["brain"]
created: 2025-07-26  # older
updated: 2026-08-29  # fresh
---

A body reference is plain markdown — `[text](note.md)` — resolved relative to this
file, which is what a reader outside this app resolves too. Every state the check
can report is below, so the four warnings and the several silences are all
reachable from one note.

**Resolves, and reads as its target is titled**, so nothing is reported:
[Nothing but the two required fields](bare.md). A folder note is reached the same
way, by its `README.md`: [Platform](platform/README.md).

**Resolves under a shortened title**, which is silent: prose refers to
[Nothing but the two](bare.md) and the sentence has to read, so sharing the
title's words is enough.

**Resolves, but the text has drifted** — sharing nothing with the title, which is
what a rename leaves behind. Reported and not corrected, because only the author
knows which of the two a difference is: [the everything note](every-facet.md).

**Points at nothing.** A relative link into the vault whose path has no file at
the end of it, which is the one a rename or a delete used to leave behind:
[a note that is not there](absent-note.md).

**A bare bracket that names a note** — [bare] — is the convention that predates
the parser: it renders as literal brackets, so it is a link that was never wired
up, and `check` says so with the link it should have been. A bracket that names
nothing is prose and stays silent — `[NOT STARTED]`, `[api]` and
`[Owner: Not defined]` are markers somebody wrote in a sentence, and a check that
fought them would be a check nobody could satisfy.

**Silences worth pinning.** A link into `assets/` points at a file rather than a
note — the walk skips that folder — which is prose doing something reasonable:
[the handout](assets/every-body-ref/handout.md). A link inside code is a sample of
a link:

```md
[not a real link](bare.md)
```

And an indented sample is one too:

    [also not a link](bare.md)

So is `[an inline one](bare.md)` in a code span. An image points at a file, not a
note: ![nothing](docs/absent.png). A task box is a control rather than a
reference:

- [ ] not a bracket reference
- [x] nor this one
