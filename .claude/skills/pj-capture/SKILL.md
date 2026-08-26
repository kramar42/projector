---
name: pj-capture
description: Sweep Claude sessions, git branches, Jira, Slack and Gmail for things that should become projector notes — or links and new facts onto notes that already exist — then apply what is approved and move the watermarks. Use when asked to capture, sweep, do an inbox pass, collect what's outstanding, or check what has come in; and when the user dumps several things at once that should become notes. Do not use to fill in a note's missing project, priority or status; that is the pj-triage skill.
---

# Capture

Turn what has accumulated elsewhere into notes — or into links and new facts on the notes that already
cover it. Read the `pj-about` skill first.

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

Losing `.projector/intake.db` is not a disaster: a channel with no cursor falls back to its default window and
`source_fingerprint` still stops every duplicate. Wider sweep, never a wrong one.

`pj` fetches three of the five itself. Say which you covered and which you skipped.

| Channel | Fetched by | What counts |
|---|---|---|
| `claude` | `pj` — `~/.claude/projects` | sessions that moved: work in flight, often already on a note |
| `git` | `pj` — the project repos | the user's own branches and base-branch commits with nothing tracking them |
| `jira` | `pj` — JQL, needs `PROJECTOR_JIRA_*` | assigned to / reported by / watched by the user, updated since the cursor |
| `slack` | **you, through the Slack MCP** | `D01234567` (your own scratchpad DM) and `is:saved` |
| `gmail` | **you, through the Gmail MCP** | vendor threads, forwarded meeting notes — commitments made to other people |

For Slack and Gmail: take the `cursor` off their report in the sweep, fetch **only since it**, and treat
what you find exactly as `pj` treats the rest. Their fingerprints are `slack:<channel>/<ts>` and
`gmail:<message-id>`.

Every candidate arrives with a **fingerprint** derived from the thing itself, never from its wording,
and `pj` has already dropped the ones a note carries. **Check your own the same way** — the two
channels `pj` cannot fetch are the two that would otherwise be guessing:

```bash
pj intake known slack:D01234567/1784119823.993869 gmail:<message-id>
```

It prints the notes carrying each ref, or `—`. `pj add --fingerprint` refuses a duplicate regardless,
but checking first is what makes the proposal honest.

**A fingerprint is not enough on its own, and for Slack and Gmail it is all you have.** `pj` computes
`evidence.matches` for the three channels it fetches; the two you fetch yourself arrive with none. A
fingerprint is per-message, so a standing chore — an expense reminder, a recruiting queue, a weekly
report — emits a fresh id every time and can *never* collide with the note already tracking it. That
is where duplicates come from, and they come from these two channels. So before proposing a **new
note** from Slack or Gmail, search the vault by hand for what `pj` would have matched:

```bash
pj search pleo
pj search "overdue candidates"
```

Read the hits. If one of them already describes this standing thing, the answer is **extend**, below.

## 2. Four answers, not one

Most of what a sweep returns is not a new note. For each candidate:

| | when | do |
|---|---|---|
| **link** | it is more work on something already tracked | `pj link <note> <ref>` |
| **extend** | it says something a tracked note does not yet know | `pj link <note> <ref> --fingerprint <fp>`, plus the writes below |
| **note** | work nobody has filed | `pj add … --fingerprint` |
| **neither** | a question asked and answered, a status, something already done | list under "noticed, not captured" |

**Extend is the one that keeps the vault true.** A link records that a message exists; extending
records what it *said* — the deadline it named, the channel it came from, the paragraph worth keeping.
Without it the only two ways to capture a mail about existing work are a link that loses its content
or a second note that duplicates the first.

`pj` decides only what is decidable: a ref already on a note, a fingerprint already captured, a
session too short to be work. Everything else is yours, and the evidence is in `evidence.matches` —
each with the mechanical reason it matched:

- `cwd` / `worktree` / `worktree branch` — the session ran in that project's repo or workspace. Close
  to proof.
- `branch` / `branch names PROJ-303` / `mentions PROJ-303` — the name or the message says so. Strong.
- `text` — it shares vocabulary with that note. **Weak.** Two notes about Keycloak are not the same
  note. Never link on `text` alone; say what you think it is and let the user say.

When linking, say which reason you are relying on, so a wrong call is visible before it lands. A
session linked to the wrong note puts its history somewhere nobody will look for it — move it with
`pj link <wrong-note> --remove <ref>` then `pj link <right-note> <ref>`, rather than leaving it. When
the ref carried a fingerprint, move that too: `--fingerprint <fp> --remove`, then re-add it on the
right note, or the message stays consumed by a note that never mentioned it.

### What extend may write, and what it may only flag

The line is **facts against judgments**, not a list of safe fields. An external source is authoritative
about the world; it is never authoritative about what the user intends to do next.

| capture may write | capture may only flag |
|---|---|
| links, refs, fingerprints | `priority`, `status`, `energy` |
| the body — **appended**, dated, never rewritten | `project`, `parent` |
| `source` — add the channel that just spoke, keep the ones already there | `blocked_by`, `waiting_on` |
| `due` — **only onto a note that has none** | |

`due` sits on the left for the reason the `pj-about` skill gives: "`priority` says what you intend to
do next; `due` says what the world expects regardless of intent." A mail saying AWS stops the instance
on 5 Sep *is* the world speaking, and it knows the date better than the vault does. But **fill an empty
`due`, never overwrite a set one** — a stored deadline that disagrees with a message is a flag, not
something to resolve. Silently moving a date is exactly the failure `pj-triage` warns about: the Due
board will believe it.

`project` stays on the right even when it looks obvious. Capture's whole seam is that it does not
decide where work lives, and on a note that already exists the project is nearly always set — if it is
not, the triage view catches it the same day.

`waiting_on` is the tempting one. "I mailed Person D and they have not replied" reads like a fact; it is an
inference about whether they are actually blocked. Flag it.

### Flags

A flag is an observation about a note, never a write. Give them their own section in the proposal —
they are not candidates, so they do not belong in the candidate table:

| note | facet | holds | the evidence says | source |
|---|---|---|---|---|
| `ship-the-thing` | status | `active` | Person E's mail of 22 Aug thanks you for shipping it | `gmail:<id>` |

**Every flag ships with a link.** This is not politeness, it is the only thing that makes a flag
durable: committing forgets the declines, and unlike a declined note a declined flag leaves no
fingerprint behind either. Put the evidence on the note first, then flag it. If the user does nothing, the
mail is still on the note and the next person to open it can see why somebody thought it was done.

## 3. Propose, then stop

One table — `do` is one of link, extend, note, neither:

| do | title | channel | ref / fingerprint | why, and on what evidence |
|---|---|---|---|---|

Then the flag table, if anything earned one, and then "noticed, not captured".

Rules:

- **A new note is something with an outcome.** A link worth reading is a note in `project: research`
  with `priority: someday`. A fact, a status update or a thing already done earns no note of its own —
  those go under "noticed, not captured" so nothing looks silently dropped.
- **Title in the user's voice, imperative where it is an action.** Keep their phrasing when they wrote it; do not
  tidy `clean-up ecr` into `Clean up Amazon ECR`. A Claude session's title is its opening prompt; a
  branch's is its first commit subject. Both are already their words.
- **Never put a moving number in a title.** "Review the 29 overdue candidates" and "the 2 flagged
  expenses" are wrong by next week, and worse, they read as *different work* from the note already
  tracking them — which is how a duplicate gets proposed with a straight face. Name the thing, put the
  count in the body where a later sweep can update it.
- **Carry the provenance as a link**, always. `pj` supplies them: `claude:<uuid>`,
  `gh:branch:ORG/repo@name`, `gh:commit:ORG/repo@sha`, `jira:KEY`. Add `slack:<permalink>` yourself.
- **Do not assign a project.** Capture gets it into the system; `triage` decides where it lives. Set
  `source` and, if obvious, `priority`.

Then **stop**.

## 4. Apply, then move the cursors

```bash
# note
pj add "<title>" \
  --facet source=claude --facet status=planning \
  --link "claude:<uuid>" \
  --fingerprint "claude:<uuid>"

# link
pj link <existing-note> "claude:<uuid>"

# extend — the fingerprint is what stops the message coming back for ever
pj link <existing-note> "gmail:<id>" --fingerprint "gmail:<message-id>"
pj set  <existing-note> --add source=gmail --facet due=2026-09-05
```

The fingerprint lands in `absorbed_fingerprints`, never on `source_fingerprint`: the note did not come
from this message, it merely answers for it now. `pj` refuses a fingerprint another note already holds
and names the holder — if that fires, you are looking at the duplicate you were about to create.

Appending to a body has no flag; edit the note's file in the vault, adding to the end and leaving
what is there alone.

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
- **Committing forgets the declines.** Once the cursor passes something you called **neither**, there
  is no record it was ever considered. If a rejection is worth keeping, make the note and set
  `status: archived` — that keeps the fingerprint, and the next sweep leaves it alone.

Finish with `pj check`, and report: created, linked, skipped as duplicate, left uncaptured, and which
cursors moved.

## Credentials and sensitive content

If a swept message contains a secret — a token, an AWS key, a password — **do not put the value in a
note**. Create the note describing the rotation needed and reference the message; say plainly that you
withheld the value. A scratchpad DM is exactly where plaintext credentials tend to end up.

Everything intake touches is read-only (C2). Nothing here writes to Slack, Jira, GitHub or Gmail.
