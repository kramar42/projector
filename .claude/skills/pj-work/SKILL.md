---
name: pj-work
description: Start work on a projector note — prepare a multi-repo git worktree workspace, write a briefing from the note's full context, and open a Claude session there. Use when asked to work on / start / pick up a note, or to set up a workspace or worktree for a piece of work. Also use to hand a note to a fresh session with its context intact.
---

# Work on a note

Prepare a workspace and hand the note to a session that starts with everything it needs. Read the
`pj-about` skill first.

## 1. Identify the note

If the user named one loosely, resolve it before doing anything:

```bash
pj search "<what they said>"
pj ls --view unblocked       # when they asked "what should I work on"
```

Confirm which note you landed on if there was any ambiguity. Never prepare a workspace for a guess.

## 2. Check it can actually be worked

```bash
pj context <id>
```

Stop and say so, rather than pressing on, if:

- **No project, or the project declares no repos.** There is nothing to lay out. Offer to add repos
  to the project record's frontmatter — `pj context` shows which project it resolves to, and the
  frontmatter tab in the app is the place to edit it.
- **It is blocked.** `blockedBy` lists unfinished blockers. Say which, and ask whether to proceed
  anyway or switch to a blocker.
- **It carries no `status`.** Carrying a status is what makes a note work; without one it is a
  thought, not a commitment. Offer to triage it first.

## 3. Dry run first when anything is unusual

```bash
pj work <id> --dry-run
```

This prints the workspace path, the branch, the repos and the whole briefing without touching the
filesystem. Worth doing when the note has several repos, an unfamiliar branch template, or when the
user has not used this before.

## 4. Launch

```bash
pj work <id>
```

Which does, in order: a workspace directory outside every repo; one `git worktree` per project repo
on a single branch; `AGENT_BRIEFING.md` at the root with the note's full context embedded; and a
Terminal running `claude "Read AGENT_BRIEFING.md and follow it exactly."`

Report the workspace path and which repos were prepared. **One repo failing does not stop the
others** — the result says which, and the briefing tells the new session that those are out of scope.

Add `--no-open` when the user wants the workspace without a terminal, and give them the command to
run themselves.

## 5. Close the loop

The briefing already instructs the new session to run `pj link <id> --session` as its last step, so the
note accumulates its own history. If you are *inside* a workspace and it has not happened yet:

```bash
pj link <id> --session
```

That finds the live session working in this directory and appends `claude:<uuid>` to the note, which
then renders on the board with what it is doing — working, waiting on you, closed — and its last
activity.

## What this does not do

- It does not commit, push, or open a pull request. The workspace is prepared; the work is the new
  session's, and the branch is left for the user.
- It does not modify the note beyond adding a session link.
- It does not touch the main checkouts. Every repo in the workspace is a worktree; if a change
  belongs somewhere not laid out, stop and say so.
