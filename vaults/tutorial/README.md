---
id: read-me
title: Read me — this vault is an example
facets:
  status: [active]
  priority: [now]
  energy: [shallow]
created: 2026-08-26
updated: 2026-08-26
---

You are looking at a **projector vault**: a folder of markdown files. Everything in this
folder is a card, this file included — there is no exempted filename, and no `notes/`
subdirectory to put things in.

The only thing projector adds is `.projector/`:

```
.projector/
  facets.yaml     the vocabulary — which axes exist, in what order
  views/*.yaml    saved queries, each with a shape
  index.db …      derived, disposable, gitignored
```

Delete `.projector/` and you still have your notes. That is the point.

## Try it

- Press `?` for the key map. The letters in its This-vault section come from `facets.yaml`.
- Drag a card between columns — that writes one facet to one file.
- Open [getting-started.md](getting-started.md), which carries no frontmatter at all.
