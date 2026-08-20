---
name: capture
description: Sweep Slack, Jira, Gmail and recent git commits for things that should become cockpit cards, then create them after approval. Use when asked to capture, sweep, do an inbox pass, collect what's outstanding, or check what has come in; and when the user dumps several things at once that should become cards. Do not use to fill in facets on cards that already exist; that is the triage skill.
---

# Capture

Turn what has accumulated elsewhere into cards. Read the `cockpit` skill first — the fingerprint rule
below is what keeps this runnable more than once.

**You propose. You do not apply.** Present the candidates, stop, wait.

## 1. Sweep the sources

Cover these unless the user narrows it. Say which you covered and which you skipped.

| Source | Where | What counts |
|---|---|---|
| Slack self-DM | `D01234567` (his own scratchpad) | notes-to-self, saved links, decisions |
| Slack saved | `is:saved` | bookmarked messages |
| Jira | assigned to him, or mentioning him, updated recently | anything needing his reply or action |
| Gmail | vendor threads, forwarded meeting notes | commitments made to other people |
| git | `git log --oneline -20 --author=Oleksii` in the active repos | work in flight with no card |

Prefer the last sweep's boundary over a fixed window: `ck ls --filter source=slack --json` shows what
was already taken, and each card's `source_fingerprint` records exactly what it came from.

## 2. Deduplicate before proposing, not after

Every candidate needs a **stable fingerprint** derived from the thing itself, never from its wording:

- Slack: `slack:<channel>/<ts>` — the permalink's timestamp
- Jira: `jira:<KEY>`
- Gmail: `gmail:<message-id>`
- git: `git:<repo>@<sha>`

Then drop any candidate whose fingerprint already exists. `ck add --fingerprint` also refuses
duplicates, so the guarantee holds even if you miss one — but checking first keeps the proposal
honest. Without this the inbox refills on every sweep and stops being worth running.

## 3. Propose, then stop

One table:

| title | source | links | fingerprint | why it's a card |
|---|---|---|---|---|

Rules:

- **A card is something with an outcome.** A link worth reading is a card in `project: research`
  with `priority: someday`. A fact, a status update or a thing already done is not a card — list
  those separately as "noticed, not captured" so nothing looks silently dropped.
- **Title in his voice, imperative where it is an action.** Keep his phrasing when he wrote it; do
  not tidy `clean-up ecr` into `Clean up Amazon ECR`.
- **Carry the provenance as a link**, always: `slack:<permalink>`, `jira:KEY`, `gh:commit:...`. A
  card whose context is lost is the exact failure the old TODO file kept hitting.
- **Do not assign a project.** Capture gets it into the system; `triage` decides where it lives. Set
  `source` and, if obvious, `priority`.

Then **stop**.

## 4. Create what was approved

```bash
ck add "<title>" \
  --facet source=slack --facet status=planning \
  --link "slack:<permalink>" \
  --fingerprint "slack:<channel>/<ts>"
```

Then `ck check`, and report: created, skipped as duplicate, and left uncaptured.

## Credentials and sensitive content

If a swept message contains a secret — a token, an AWS key, a password — **do not put the value in a
card**. Create the card describing the rotation needed and reference the message; say plainly that
you withheld the value. His Slack scratchpad has had plaintext credentials in it before.
