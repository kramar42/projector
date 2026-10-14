# Check in

Short, and run as often as the user likes. The question it answers for the user: is the day still
the plan? One stop: run the loop in SKILL.md over what came in since the last run, then present.

## 1. Read today's note and today's theories

The day note's `Plan`, then `memory/theories/<today>.md`: its T-entries, `Said` and `Asked`. The
latest timestamp anywhere in the theories file is **since** (a `MM-DD HH:MM` stamp from a run past
midnight is later than every bare `HH:MM`): everything below looks only after it. If
there is no theories file for today, since is the day note's creation, and this run creates the file.
If the invocation says what the user worked on, log it under `Said` and follow it up (rule 3 in
SKILL.md).

## 2. Gather since <since>, then test

- Intake's freshness first (SKILL.md, *Intake*): a tick in the background if the newest is stale.
- `pj did today --json`, keeping activities after *since*.
- The calendar for the rest of today and tomorrow morning, and the notes of every meeting that
  ended after *since*.
- Once the tick (if any) is done: intake since *since* — the inbox cards no T-entry in today's
  theories file names (`rests on: inbox/<id>`). A card judged by an earlier run today and still in
  `inbox/` is not judged again; it is one count line in the stop. And the user's scratchpad, live,
  since *since*, if the workspace names one.

Then test (the loop in SKILL.md), only where something can have moved:

- **The Plan's theories**, against what came in: a re-test adds a `looked:` and an `outcome:`.
- **`Asked` entries still waiting**: a trace since *since* that settles one settles it — write the
  theory's outcome and mark the question settled by that trace, never ask it again.
- **One theory for the verdict: *the day is still the Plan*.** Its refuters: traces since *since*
  about work not in `Plan`, and a Plan outcome with no trace while the free time before the next
  meeting shrinks.

Write the new `looked:`/`outcome:` lines and any new T-entries now, before the stop.

## 3. Say where the day stands, then stop

One verdict, the outcome of *the day is still the Plan*, then only what supports it:

- **On track** — it survived: the outcomes have traces, or the user said so, and nothing since
  *since* is off the Plan. One line.
- **Diverged** — refuted by traces about something not in `Plan`. One line of inference with its
  evidence and its theory, not a question: "inferred: since 15:31 the traces are the EU-PROD
  maintenance and Loki, none on Plan 2 or 3 (T15)". If it looks set to hold, a swap of the Plan
  item goes under the proposals, for the user to take or ignore. Whose any follow-up is stays a
  theory (rule 5): a note for any of it only with ownership evidence, "mine?" only if it can't
  settle.
- **Stale** — an outcome has no trace and the free time before the next meeting is shrinking.
  Whether it still happens today can't be settled by a source: "Still today? yes / move to
  tomorrow / drop".

Add, when they apply: the stale-intake line, as at open; prep for the next meeting the user organises
(an agenda drawn from the notes it touches), a decision a meeting's notes recorded that touches one
of the user's notes, any theory refuted since *since*, with its edit (open.md's `Refuted` block),
and open.md's `Inbox` block for the new cards, with one line for the ones still waiting from
earlier ("2 more from 09:10, as proposed then"). A new card that cannot wait until tomorrow leads
the block. Three questions at most across all of it, each closed and each about a theory
that can't settle. End with the optional "worked on something this misses?" line.

Stop.

## 4. Write what was said

- Day note `Plan`: swap, add or drop items as agreed, one line plus a link each; tick an item the
  user confirms done.
- Today's theories file, which already holds this run's tests:
  - `Said`: the user's answers and anything they said they worked on, timestamped now — or
    `<time> check-in — nothing said`;
  - `Asked`: this run's questions; mark the ones answered with the time and the answer, and write
    the outcome each answer settles;
  - a T-entry for each Plan item added or swapped in, with its evidence.
- Any approved `pj` command and Inbox verdict, then `pj check`, read for what this run wrote
  (SKILL.md, *The day note*).
