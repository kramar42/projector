# Check in

Short, and run as often as the user likes. The question it answers: is the day still the plan?

## 1. Read today's note

`Plan`, `Told` and `Open`. The last timestamp in `Told` is **since**: everything below looks only
after it. No timestamp yet means since the note was created.

## 2. Ask, then stop

**"What's changed since <since> that I can't see?"** — plus any `Open` question whose answer would
change the plan. If the invocation already carries news, skip the question; that is the answer.

## 3. Gather since <since>

- `pj did today --json`, keeping activities after *since*.
- The calendar for the rest of today and tomorrow morning.
- New asks since *since*, by the same rules as open.md step 3 — and the user's scratchpad if the
  workspace names one.

## 4. Say where the day stands, then stop

One verdict, then only what supports it:

- **On track** — the outcomes have traces, or the user said so. One line; nothing to answer.
- **Diverged** — the traces since *since* are about something not in `Plan`. Name it with its
  evidence, then ask how it changes the plan. Whose any follow-up is stays a question (rule 3): ask
  "what of this is yours?" before proposing a note for any of it.
- **Stale** — an outcome has no trace and the free time before the next meeting is shrinking. Ask
  whether it is still the plan.

Add, when they apply: prep for the next meeting the user organises (an agenda drawn from the notes it
touches), and a new ask that cannot wait until tomorrow. Three questions at most across all of it.

Stop.

## 5. Write what was said

- `Told`: the user's answers, timestamped now — or `<time> check-in — nothing new`.
- `Plan`: swap, add or drop items as agreed; tick an item the user confirms done.
- `Open`: the questions still unanswered.
- Any approved `pj` command, then `pj check`.
