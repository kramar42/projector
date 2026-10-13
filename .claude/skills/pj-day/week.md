# Reset the week

The pile gets judged again: which promises are still promises. Every item is a question, because a
date or a `week` priority set a week ago may never have been a commitment.

## 1. Read

- The last five days' theories files in `memory/theories/` — their `Said` and `Asked`: what the
  user already settled stays settled, and what is still waiting is asked here only if it bears on
  a row below.
- `pj ls --view week --json`: the overdue column first.
- `pj ls --view actionable --json`: the `week` pile.
- Every note with a non-empty `waiting_on`, with how long since it last changed (`pj log`).

## 2. Ask, in batches

Present one batch at a time, at most ten rows, so an answer can be one line ("1 keep, 2 drop, 3
→ 10-20"):

1. **Overdue** — per note: *still this date, a new date, or no date?*
2. **Waiting on, untouched for 7+ days** — per note: *chase, wait, or let go?* For a chase, offer to
   draft the message; the user sends it.
3. **The `week` pile** — per note: *still this week?* Anything not → `month`, `backlog` or
   `archived`, as the user says.

Stop after each batch.

## 3. Write

Each answer as its `pj set` command, one per note, then `pj check`. Log the decisions in today's
theories file under `Said`, one timestamped line per batch ("week reset: 6 dates moved, 4 dropped
to month"). The day note gets nothing.
