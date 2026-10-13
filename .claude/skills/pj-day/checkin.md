# Check in

Short, and run as often as the user likes. The question it answers for the user: is the day still
the plan? One stop: gather since the last run, then present.

## 1. Read today's note

`Plan`, `Told` and `Open`. The last timestamp in `Told` is **since**: everything below looks only
after it. If the invocation says what the user worked on, log it as `Told` and follow it up (rule 3
in SKILL.md).

## 2. Gather since <since>

- `pj did today --json`, keeping activities after *since*.
- The calendar for the rest of today and tomorrow morning, and the notes of every meeting that
  ended after *since*.
- New asks since *since*, by the same rules as open.md step 2 — and the user's scratchpad if the
  workspace names one.

## 3. Say where the day stands, then stop

One verdict, then only what supports it:

- **On track** — the outcomes have traces, or the user said so. One line.
- **Diverged** — the traces since *since* are about something not in `Plan`. Name it with its
  evidence and offer the swap as a closed question: "swap outcome 2 for <it>? yes / no".
  Whose any follow-up is stays a question (rule 5): "mine?" before proposing a note for any of it.
- **Stale** — an outcome has no trace and the free time before the next meeting is shrinking.
  "Still today? yes / move to tomorrow / drop".

Add, when they apply: prep for the next meeting the user organises (an agenda drawn from the notes it
touches), a decision a meeting's notes recorded that touches one of the user's notes, and a new ask
that cannot wait until tomorrow. Three questions at most across all of it, each closed. End with the
optional "worked on something this misses?" line.

Stop.

## 4. Write what was said

- `Told`: the user's answers and anything they said they worked on, timestamped now — or
  `<time> check-in — nothing told`.
- `Plan`: swap, add or drop items as agreed; tick an item the user confirms done.
- `Open`: the questions still unanswered.
- Any approved `pj` command, then `pj check`.
