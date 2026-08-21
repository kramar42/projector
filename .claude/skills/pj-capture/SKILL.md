---
name: pj-capture
description: Sweep Claude sessions, git branches, Jira, Slack and Gmail for things that should become projector cards — or links onto cards that already exist — then apply what is approved and move the watermarks. Use when asked to capture, sweep, do an inbox pass, collect what's outstanding, or check what has come in; and when the user dumps several things at once that should become cards. Do not use to fill in facets on cards that already exist; that is the pj-triage skill.
---

# Capture

Turn what has accumulated elsewhere into cards — or into links on the cards that already cover it.
Read the `projector` skill first.

**You propose. You do not apply.** Present the candidates, stop, wait.

## 1. Sweep

```bash
pj intake --json            # every channel, each from its own cursor
pj intake claude git        # or name them
pj intake --since 2026-08-01 --limit 40
```

Every channel's report carries the `cursor` it started from, Slack and Gmail included, so this is also
where you read the cursor you fetch those two from. **The cursor is why this is worth running more than
once** — without it you are the thing deciding what counts as new, from a fixed window, every time.
`pj intake status` answers the same question without fetching, if you want the state and nothing else.

Losing `.intake.db` is not a disaster: a channel with no cursor falls back to its default window and
`source_fingerprint` still stops every duplicate. Wider sweep, never a wrong one.

`pj` fetches three of the five itself. Say which you covered and which you skipped.

| Channel | Fetched by | What counts |
|---|---|---|
| `claude` | `pj` — `~/.claude/projects` | sessions that moved: work in flight, often already on a card |
| `git` | `pj` — the project repos | his own branches and base-branch commits with nothing tracking them |
| `jira` | `pj` — JQL, needs `PROJECTOR_JIRA_*` | assigned to / reported by / watched by him, updated since the cursor |
| `slack` | **you, through the Slack MCP** | `D01234567` (his scratchpad) and `is:saved` |
| `gmail` | **you, through the Gmail MCP** | vendor threads, forwarded meeting notes — commitments made to other people |

For Slack and Gmail: take the `cursor` off their report in the sweep, fetch **only since it**, and treat
what you find exactly as `pj` treats the rest. Their fingerprints are `slack:<channel>/<ts>` and
`gmail:<message-id>`.

Every candidate arrives with a **fingerprint** derived from the thing itself, never from its wording,
and `pj` has already dropped the ones a card carries. **Check your own the same way** — the two
channels `pj` cannot fetch are the two that would otherwise be guessing:

```bash
pj intake known slack:D01234567/1784119823.993869 gmail:<message-id>
```

It prints the cards carrying each ref, or `—`. `pj add --fingerprint` refuses a duplicate regardless,
but checking first is what makes the proposal honest.

## 2. Three answers, not one

Most of what a sweep returns is not a new card. For each candidate:

| | when | do |
|---|---|---|
| **link** | it is more work on something already tracked | `pj link <card> <ref>` |
| **card** | work nobody has filed | `pj add … --fingerprint` |
| **neither** | a question asked and answered, a status, something already done | list under "noticed, not captured" |

`pj` decides only what is decidable: a ref already on a card, a fingerprint already captured, a
session too short to be work. Everything else is yours, and the evidence is in `evidence.matches` —
each with the mechanical reason it matched:

- `cwd` / `worktree` / `worktree branch` — the session ran in that project's repo or workspace. Close
  to proof.
- `branch` / `branch names PROJ-303` / `mentions PROJ-303` — the name or the message says so. Strong.
- `text` — it shares vocabulary with that card. **Weak.** Two cards about Keycloak are not the same
  card. Never link on `text` alone; say what you think it is and let him say.

When linking, say which reason you are relying on, so a wrong call is visible before it lands. A
session linked to the wrong card puts its history somewhere nobody will look for it — move it with
`pj link <wrong-card> --remove <ref>` then `pj link <right-card> <ref>`, rather than leaving it.

## 3. Propose, then stop

One table:

| do | title | channel | ref / fingerprint | why, and on what evidence |
|---|---|---|---|---|

Rules:

- **A card is something with an outcome.** A link worth reading is a card in `project: research` with
  `priority: someday`. A fact, a status update or a thing already done is not a card — those go under
  "noticed, not captured" so nothing looks silently dropped.
- **Title in his voice, imperative where it is an action.** Keep his phrasing when he wrote it; do not
  tidy `clean-up ecr` into `Clean up Amazon ECR`. A Claude session's title is its opening prompt; a
  branch's is its first commit subject. Both are already his words.
- **Carry the provenance as a link**, always. `pj` supplies them: `claude:<uuid>`,
  `gh:branch:ORG/repo@name`, `gh:commit:ORG/repo@sha`, `jira:KEY`. Add `slack:<permalink>` yourself.
- **Do not assign a project.** Capture gets it into the system; `triage` decides where it lives. Set
  `source` and, if obvious, `priority`.

Then **stop**.

## 4. Apply, then move the cursors

```bash
pj add "<title>" \
  --facet source=claude --facet status=planning \
  --link "claude:<uuid>" \
  --fingerprint "claude:<uuid>"

pj link <existing-card> "claude:<uuid>"
```

Then, **and only once the proposal is resolved** — approved, or explicitly declined:

```bash
pj intake commit --advance --captured 2
```

That promotes what the sweep already recorded, for every channel it swept: the cursor it proposed and
the number of items it examined were both `pj`'s own, and it kept them so you would not have to carry
them between two processes. `--captured` is the one number it cannot know, because capture happened in
between. Add `--channel <c>` to promote one deliberately.

For Slack and Gmail, `pj` recorded the cursor it was given, which is the one it handed you — so if you
read *past* it, say where you actually got to:
`pj intake commit --channel slack --cursor <newest-ts-you-read>`.

Three things to get right here:

- **A held cursor is not a failure.** A truncated run — more behind the cursor than the limit showed —
  deliberately keeps its place so the next sweep resumes there, and `--advance` reports it as held.
- **Commit after, never before.** A sweep abandoned halfway must not swallow what it had listed. A
  sweep records where it *would* go; nothing reads that until you promote it.
- **Committing forgets the declines.** Once the cursor passes something you called "not a card", there
  is no record it was ever considered. If a rejection is worth keeping, make the card and set
  `status: archived` — that keeps the fingerprint, and the next sweep leaves it alone.

Finish with `pj check`, and report: created, linked, skipped as duplicate, left uncaptured, and which
cursors moved.

## Credentials and sensitive content

If a swept message contains a secret — a token, an AWS key, a password — **do not put the value in a
card**. Create the card describing the rotation needed and reference the message; say plainly that you
withheld the value. His Slack scratchpad has had plaintext credentials in it before.

Everything intake touches is read-only (C2). Nothing here writes to Slack, Jira, GitHub or Gmail.
