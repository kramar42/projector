---
name: pj-work
description: Retired; redirects to the kernel. Use when asked to work on, start or pick up a projector note, to set up a workspace or worktree for one, or to hand a note to a fresh session — work on a note now starts in the owner's kernel as an attempt for the note's open intent (`bin/kernel worktree <intent>`, the kernel MCP tool `worktree`, or ▶ on the note in the app), worked under the kernel skill `kernel-worktree`. `pj work` is gone.
---

# Work on a note: retired to the kernel

Starting work on a note is the kernel's act: an attempt of its `worktree` spec for the note's
**open intent**. The kernel makes one git worktree per repository under `~/Code/wt`, installs hooks
that record every commit in the attempt, and writes `BRIEF.md`; the session that opens there works
it under the kernel's `kernel-worktree` skill. Projector only answers the kernel's question about the
note — `pj context --alias vault:<vault>:<id> --json-kernel`, the manifest's `context` command: its
context, its project's repos and the branch its project's template names.

## 1. Find the note and its intent

Resolve a loosely named note first (`pj search "<words>"`; `pj ls --view unblocked` for "what should
I work on"), and confirm it when there was any ambiguity. Then `pj kernel status` lists every intent
about the vault's notes: the note's id beside its intent's.

Stop and say so when:

- **It has no intent, or no open one.** Only an open intent is worked, and only the owner opens one:
  Add intent in the note's panel, or `pj kernel intent <id> --criterion <how to judge>`. A proposed
  intent waits for the owner to open it.
- **Its project declares no repos.** The kernel refuses with "named none". Offer to add `repos` to the
  project note's frontmatter (`pj context <id>` shows which project it resolves to).
- **It is blocked.** `pj context <id>` lists unfinished blockers; ask whether to proceed.

## 2. Start it

```bash
~/Code/projects/kernel/bin/kernel worktree <intent id> --dry-run   # the plan, nothing written
~/Code/projects/kernel/bin/kernel worktree <intent id>             # opens the desktop app on it
```

`--open none` prints the desktop link and the terminal command instead of opening; `--open headless`
runs `claude -p` there. Over MCP it is the kernel tool `worktree`. From the app, ▶ on the note (or
`!`) runs the same with a confirm first, records `workspace:<dir>` on the note and opens the link.

## 3. Then

The session in the workspace follows `BRIEF.md` and the `kernel-worktree` skill: read, ask before
building, change only the worktrees, commit (the hooks record each commit in the attempt), end the
attempt. Nothing commits, pushes or merges for the owner; the branch is theirs.
