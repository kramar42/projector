---
name: pj-triage
description: Triage projector cards that are missing a project, priority or status — propose values for each, present them for approval, and apply only what is approved. Use when asked to triage, sort out, clean up or organise cards, when asked "what needs sorting", or after an import has left a pile of untriaged cards. Do not use for creating new cards from external sources; that is the pj-capture skill.
---

# Triage

Give incomplete cards a project, a priority and a status. Read the `projector` skill first if you have
not — the facet rules there are binding.

**You propose. You do not apply.** Present a table, stop, and wait. This exists because a wrong
project assignment is worse than an empty one: it hides a card in a column where its owner will not
look for it.

## 1. Get the worklist from `pj`, not from a guess

```bash
pj untriaged --json --limit 40
```

Each entry carries the reasons it surfaced. Work the list it gives you, most-incomplete first. Do
not scan the cards directory yourself and do not invent a worklist — the query is the definition of
untriaged.

If the user named a subset ("just the Trello ones", "only the research links"), filter that list;
say how many you filtered out.

## 2. Gather signal before proposing

For each card, in this order, stopping as soon as you have enough:

1. The **title** — usually decisive. `keycloak Jira issues` → `keycloak`. `clean-up ecr` → `infra`.
2. `pj context <id>` — the body, existing facets, links and any parent. A linked Jira issue's project
   key is strong evidence; an enriched link's title often says more than the card's own.
3. The **project vocabulary**: `pj ls --group project` shows the real ids and how many cards each
   holds. Prefer an existing key over a new one, every time.

For a card titled with a bare URL (the research import left several), fetch the page title and
propose that as the title too.

## 3. Propose, then stop

Present one table. Keep it scannable — id, then only what you are changing:

| card | project | priority | status | why |
|---|---|---|---|---|
| `clean-up-ecr` | infra | backlog | planning | title names ECR; infra owns AWS cleanup |

Rules for what you may propose:

- **Only project ids that already exist.** If a card clearly belongs to something with no project
  record, say so in a separate line and offer to create the record — do not quietly pick a neighbour.
- **`priority` and `status` are closed and single-valued.** Never propose a value outside them, and
  never two at once — `pj set` refuses both.
- **Never propose `status: blocked` or `waiting`.** Those are derived. A card held up by another card
  gets a `blocks` edge from the blocker; one held up by a person gets `waiting_on`.
- **Propose a `due` only when something external fixes the date** — a release, a meeting, a customer
  commitment. A deadline you invented is worse than none, because the Due board will believe it.
  It is an ordinary facet: `pj set <id> --facet due=2026-09-01`.
- **Leave a facet alone when the evidence is weak.** An honest blank beats a confident guess. Put
  those cards in a short "needs your brain" list under the table, with the one question that would
  settle each.
- **Never propose `done`** for something you cannot verify is done.

Then **stop**. Do not run a single write until the user answers. They may edit, drop or add rows.

## 4. Apply exactly what was approved

One command per card, so a failure is isolated and legible:

```bash
pj set <id> --facet project=infra --facet priority=backlog --facet status=planning
```

Then, once:

```bash
pj check
```

Report the counts: how many cards changed, how many were left for the user, and any `pj check`
warning your batch introduced. If `pj check` gained an error, fix it or revert that card — never
leave the data failing validation.

## What not to do

- Do not add a `parent` edge to "put a card in a project". Membership is the `project` facet; a
  parent means decomposition. Propose a parent only when the card genuinely is part of another card.
- Do not touch `source`, `source_fingerprint`, `created` or a card's body.
- Do not rename a card just to tidy it. Propose a rename only for a title that is broken — a bare
  URL, a truncated import like `AbstractApiModelResponseWriter for`, or an unbalanced bracket.
