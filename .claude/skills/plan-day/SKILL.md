---
name: plan-day
description: Work an attempt of projector's daily-plan spec over the kernel MCP server — plan today's attempts for the owner's open intents, flag the stalled ones, ask at most three closed questions. Use when the kernel's tick fired daily-plan, when a brief carries this skill, or when asked to plan the owner's day. Not for the week's verdicts; that is review-week.
---

# Plan the day

The daily plan is projector's: the owner plans in projector, so projector publishes the spec
(`kernel/specs/daily-plan.edn`) and this skill is its procedure. The kernel only keeps the clock: its
tick fires the attempt at 07:00 for the standing intent that owns the spec, and judges it when it
ends. You work it with the kernel's MCP tools alone (`attempts`, `brief`, `intents`, `emit`,
`judge`, `propose`, `capture`, `end_attempt`); the tick's session has nothing else, so nothing
here needs a shell or `pj`.

**The plan reads every open intent in the ledger, not only the vault's.** The brief's open intents
are the kernel's query (`:status :open`, a horizon within 14 days, not standing): an intent the
owner opened about a vault note, one captured in the kernel, one another system proposed and the
owner opened. Plan them all alike; an intent that is not about a vault note is no less the owner's.

## The stance: a scientist, not an autocomplete

You are testing beliefs about the owner's day, not completing a list. Every line you emit rests on
evidence the kernel holds, or says it does not.

- **Evidence or untested.** Each step cites the brief's event ids it rests on in `evidence`.
  When there are none, leave `evidence` empty and begin `note` with `untested:`. Untested is not
  false: plan with it.
- **Name the refuter first.** Before you look at an intent's events, name what would refute the
  step: an event showing it already done, someone else's, or blocked. Look for that first in
  the brief's events and in `attempts`. Support you find on the way is not a test, and a belief
  with support but no refuter looked for is untested.
- **Absence is unknown.** No event about an intent means unknown, not undone. A past horizon may be
  a stale guess, not a broken promise. Never read silence as a miss.
- **At most three closed questions.** Only the owner can settle some things: an ownership call, a
  decision, sources that disagree. A question an event could settle is yours to settle, not the
  owner's.

## Procedure

1. `attempts`, then `brief` for the daily-plan attempt. Its `started` is "now": plan for that day,
   not the system clock's. Horizons are local dates; read them from the brief (`by ...`).
2. The intents under "Pursuing" are the reason the attempt runs (the standing intent that owns the
   plan): never plan an attempt for them and never flag them. Only the brief's open intents are
   planned.
3. For each open intent, `emit` one `plan/step` into the attempt, `about` the intent, payload
   `{"intent": "<id>", "spec": "<spec name or none>", "note": "<why today>", "evidence": ["<event id>", ...]}`.
   `spec` is a spec name from `orient` (`develop`, `worktree`, ...) or the literal `none`; the
   reasoning goes in `note`. At most one attempt per intent, and the whole list short enough to
   finish today.
4. `attempts` with `all: true`. An intent no attempt started in the 7 days before this attempt
   lists in its `intents` (this attempt does not count) also gets a `plan/flag`, payload
   `{"intent": "<id>", "reason": "<what stalled>"}`.
5. **Recognise done.** When the brief's events show an intent's criterion satisfied (a commit that
   lands what the criterion names, a task.done, a message saying it shipped), `judge` it `met`,
   those event ids as `evidence`, a window from `started` minus one day to `started`, and a note
   naming the criterion met. It is a draft: the owner accepts or overrules it on `today`.
6. **Questions.** The ones only the owner can settle become proposals, at most three per run, the
   most costly to get wrong first. Each is one closed question the owner answers with `opened`
   (yes) or `dropped` (no): `propose` with `statement`, `criterion` and `horizon` phrased as the
   intent it becomes when opened, `evidence` the events that raised it, and the question in `note`.
   Never propose again what `intents` with `status: proposed` already lists. Nothing in this
   attempt waits on the answer.
7. What the owner tells you during the run is the owner's: record it with `capture`, verbatim, so the
   next run reads it as evidence instead of asking again. Never `capture` your own words.
8. `end_attempt` as `done`. Emit at least one event, even on a quiet day: an attempt with nothing
   beyond start and end is judged `partial`.

`judge` only for those drafts, and `propose` only for those questions, never another verdict on an
intent: the plan suggests, the owner decides. The owner reads the result with `bin/kernel today`,
which finds the plan by its `plan/step` and `plan/flag` events.

Done when every open intent in the brief has one `plan/step`, every stalled one a `plan/flag`,
at most three questions are open, and the attempt has ended.
