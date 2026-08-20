---
name: work
description: Start work on a cockpit card — prepare a multi-repo git worktree workspace, write a briefing from the card's full context, and open a Claude session there. Use when asked to work on / start / pick up a card, or to set up a workspace or worktree for a piece of work. Also use to hand a card to a fresh session with its context intact.
---

# Work on a card

Prepare a workspace and hand the card to a session that starts with everything it needs. Read the
`cockpit` skill first.

## 1. Identify the card

If the user named one loosely, resolve it before doing anything:

```bash
ck search "<what they said>"
ck next                      # when they asked "what should I work on"
```

Confirm which card you landed on if there was any ambiguity. Never prepare a workspace for a guess.

## 2. Check it can actually be worked

```bash
ck context <id>
```

Stop and say so, rather than pressing on, if:

- **No project, or the project declares no repos.** There is nothing to lay out. Offer to add repos
  to the project record's frontmatter — `ck context` shows which project it resolves to, and the
  frontmatter tab in the app is the place to edit it.
- **It is blocked.** `blockedBy` lists unfinished blockers. Say which, and ask whether to proceed
  anyway or switch to a blocker.
- **It is a `node`, not a card.** Nodes are thoughts. Offer to promote it.

## 3. Dry run first when anything is unusual

```bash
ck work <id> --dry-run
```

This prints the workspace path, the branch, the repos and the whole briefing without touching the
filesystem. Worth doing when the card has several repos, an unfamiliar branch template, or when the
user has not used this before.

## 4. Launch

```bash
ck work <id>
```

Which does, in order: a workspace directory outside every repo; one `git worktree` per project repo
on a single branch; `AGENT_BRIEFING.md` at the root with the card's full context embedded; and a
Terminal running `claude "Read AGENT_BRIEFING.md and follow it exactly."`

Report the workspace path and which repos were prepared. **One repo failing does not stop the
others** — the result says which, and the briefing tells the new session that those are out of scope.

Add `--no-open` when the user wants the workspace without a terminal, and give them the command to
run themselves.

## 5. Close the loop

The briefing already instructs the new session to run `ck link-session <id>` as its last step, so the
card accumulates its own history. If you are *inside* a workspace and it has not happened yet:

```bash
ck link-session <id>
```

That finds the live session working in this directory and appends `claude:<uuid>` to the card, which
then renders on the board with its running state and last activity.

## What this does not do

- It does not commit, push, or open a pull request. The workspace is prepared; the work is the new
  session's, and the branch is left for the user.
- It does not modify the card beyond adding a session link.
- It does not touch the main checkouts. Every repo in the workspace is a worktree; if a change
  belongs somewhere not laid out, stop and say so.
