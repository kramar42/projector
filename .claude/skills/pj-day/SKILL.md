---
name: pj-day
description: Retired; redirects to the kernel. Use when the user asks what today is, to plan or start their day, for a check-in or "where am I", to wrap up or close the day, or for a weekly review — the day now runs in the kernel (the kernel-tick skill, `bin/kernel today`, `bin/kernel week`), and this skill says how to reach it from here. Not for a recap of a past day; that is pj-did, also retired to `bin/kernel did`.
---

# The day: retired to the kernel

This skill no longer runs the day. The working day is a loop of the owner's kernel
(`~/Code/projects/kernel`), and the kernel holds the commitments, the evidence and the verdicts.
Do not plan the day from the vault here, and do not write a `daily/` note's `Plan` or `Did`.

| Was | Now |
| --- | --- |
| open (the morning plan) | the `kernel-tick` skill: `tick` fires the daily plan, the executor works it, `tick` again judges it; then `bin/kernel today` |
| check-in | `bin/kernel today`: the plan's proposals and flags, verdicts owed, running attempts, proposed intents awaiting the owner |
| close | the owner's verdicts, each line's own command on `today`: `bin/kernel observe <id> met\|missed\|partial\|dropped`, and `opened\|dropped` for a proposal |
| week reset | `bin/kernel week`; the weekly review fires on Sunday's tick and drafts a verdict per intent for the owner to confirm or overrule |
| what was done today | `bin/kernel did` (the `pj-did` skill's replacement) |

None of open, check-in or close needed new machinery: morning is a tick plus `today`, a check-in is
`today`, and close is the owner's verdicts. The scientist's discipline moved with it, into the
daily plan's procedure in the kernel's `kernel-executor` skill: every proposal cites events or says
`untested:`, its refuter is named before looking, a missing trace is unknown rather than undone, what
the owner says is captured verbatim, and at most three closed questions a run go to the owner as
proposed intents, answered with `opened` or `dropped`.

## Running the kernel from a projector workspace

- From the kernel checkout: start the session in `~/Code/projects/kernel`. Its `.mcp.json` gives
  the kernel's tools, and its `kernel-tick` and `kernel-executor` skills are there.
- From anywhere else: call the launcher by path, `~/Code/projects/kernel/bin/kernel today`. It uses
  the checkout's store unless `KERNEL_DB` names another; the vault's `.projector/config.yaml`
  `kernel:` block (`bin`, `db`) says which this vault's intake sends to, so use the same:
  `KERNEL_DB=<kernel.db> <kernel.bin> today`.

Inbox cards are unchanged: intake still writes them to `inbox/`, and they are judged with `pj accept`,
`pj merge` or `pj decline --reason`. With `kernel.enabled`, each card is also a proposed intent on
`bin/kernel today`, under awaiting.

The mode files beside this one (`open.md`, `checkin.md`, `close.md`, `week.md`, `seed/`) describe the
retired procedure; do not follow them. A vault's `memory/` stays where it is and is not written to.
