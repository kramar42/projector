---
name: review-week
description: Work an attempt of projector's weekly-review spec over the kernel MCP server — draft one verdict per open intent with the week's events as evidence, judge the specs that ran, propose next week's intents. Use when the kernel's tick fired weekly-review on Sunday, when a brief carries this skill, or when asked to review the owner's week. Not for today's plan; that is plan-day.
---

# Review the week

The weekly review is projector's: the owner plans in projector, so projector publishes the spec
(`kernel/specs/weekly-review.edn`) and this skill is its procedure. The kernel's tick fires the
attempt on Sunday at 18:00 for the standing intent that owns the spec, and judges it when it ends.
You work it with the kernel's MCP tools alone (`attempts`, `brief`, `intents`, `emit`, `judge`,
`propose`, `end_attempt`); the tick's session has nothing else.

**The review reads every open intent in the ledger, not only the vault's.** The brief's open intents
are the kernel's query (`:status :open`): a vault note's commitment, an intent the owner captured in
the kernel, one another system proposed and the owner opened, standing intents too. Review them
all alike.

## The stance

The same discipline as the daily plan. Each verdict cites this week's events or says it has none.
Before drafting a verdict, name what would make it wrong and look for that first. No event about an
intent means unknown, not undone: `not-applicable` when the week gives no evidence, never `missed`
for silence. The owner accepts or overrules every draft, so cite what the owner needs to accept it in
one look.

## Procedure

1. `attempts`, then `brief` for the weekly-review attempt. Its `started` is "now": the week under
   review is the one ending then.
2. **The window.** Every `judge` passes `window`: `start` the Monday 00:00 of the attempt's week,
   `end` the attempt's `started`, both as full ISO instants copied from or built like the
   `attempts` output (not bare dates, which mean midnight). With that window, a verdict the owner
   recorded after the review fired stands, and the kernel refuses yours.
3. **One judgment per open intent**: `targets` the intent id, a `verdict`, `evidence` the ids of
   this week's events that support it, and a `note` of one or two sentences saying what would make
   it wrong.
   - An intent with a horizon: `met`, `partial`, `missed`, `dropped`, or `not-applicable` when the
     week gives no evidence. Your `met`, `missed` and `dropped` land as drafts: recorded with their
     evidence, leaving the intent open, listed on `today` and `week` under drafts until the owner
     accepts one or overrules it.
   - A standing intent (no horizon) recurs, so never close it: `partial` either way, saying in the
     note whether the week kept it, or `not-applicable` when the week gives no evidence.
   - When the brief lists events without ids, leave `evidence` empty and name the events in the
     note (kind, date, payload). Never cite your own events as evidence.
4. A refused `judge` means the owner already judged that target for the window: leave it, do not
   retry with another verdict or window, and count it as `refused`.
5. **Specs that ran more than twice this week** (count `attempts` with `all: true` started inside
   the window, by `spec`) get one `judge` each, `healthy` or `stale`. None ran more than twice:
   judge no spec. If `judge` will not take the spec as a target, `emit` `review/finding` with
   `{"spec", "verdict", "note"}` instead.
6. **Next week.** Propose new intents with `propose`, one call each: `statement`, `criterion`,
   `horizon` (`YYYY-MM-DD`), `about` what the intent they follow from is about, `evidence` the
   week's events that raise it, and a `note` naming the intent it follows from. Each starts
   `proposed` and waits for the owner's `opened` or `dropped`; you cannot open one. Propose only
   new work: an intent that stays open already carries into next week, so never open a copy,
   and never propose again what `intents` with `status: proposed` already lists. At most three
   questions the owner must settle, each a closed one, as in the daily plan. An open intent to drop
   gets verdict `dropped` with the reason in `note`.
7. `emit` one `review/summary` into the attempt, `{"judged": n, "refused": n, "proposed": n}`, then
   `end_attempt` as `done`. The owner's `bin/kernel week` finds the review by its `review/` events.

Done when every open intent in the brief has one judgment for the week (or was refused), the
specs that ran more than twice are judged, and the attempt has ended with its summary.
