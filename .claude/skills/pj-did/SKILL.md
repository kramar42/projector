---
name: pj-did
description: Retired; redirects to the kernel's day recap. Use when asked what the user did today, yesterday or on a date, for a daily recap or standup notes, or for "what did I get done" — the recap is now `bin/kernel did [today|yesterday|YYYY-MM-DD]` in the owner's kernel, and this skill says how to run it. `pj did` remains as the source-level report. Not for what is left to do; that is the actionable view, or `bin/kernel today`.
---

# What I did: retired to the kernel

The day recap is the kernel's: `bin/kernel did [today|yesterday|YYYY-MM-DD] [--json]` reads the
day's events in the owner's kernel, mechanically and with no model, and prints one task per entity
the events are about (a repo, a note, a task) or else per kind. Each task carries its title in the
events' own words, an outcome (`done` when an intent about it was met that day or a did task was
marked done, `handled` when it was only messages or sessions with no artifact, `progressed`
otherwise) and its refs (event ids, a sha, a Jira key, links). A Gaps line names the sources that
wrote nothing that day. Answer from that output; do not regroup it or add tasks it does not show.

`pj did` the command still exists: it is the source-level report of one day's vault notes, commits,
Claude sessions and Jira changes, gathered straight from those sources and never judged. Use it when
the question is about a source the kernel does not receive yet, and say which.

Neither writes a `daily/` note. Planning and closing the day are retired too; `pj-day` says where
they went (the `kernel-tick` skill, `bin/kernel today`, `bin/kernel week` for the week reset).

## Running the kernel from a projector workspace

- From the kernel checkout, `~/Code/projects/kernel`: `bin/kernel did yesterday`.
- From anywhere else, by path: `~/Code/projects/kernel/bin/kernel did`. It uses the checkout's store
  unless `KERNEL_DB` names another; the vault's `.projector/config.yaml` `kernel:` block (`bin`, `db`)
  says which this vault's intake sends to: `KERNEL_DB=<kernel.db> <kernel.bin> did --json`.
