# Reset the week

Two jobs. Memory first, which needs no one: the week's theory files are consolidated and the
patterns recounted, so that what held becomes something you know rather than something you ask.
Then the pile gets judged again — which promises are still promises — and every item there is a
question, because a date or a `week` priority set a week ago may never have been a commitment.

## 1. Read

- `memory/AGENTS.md` (its rule for keeping patterns), every file in `memory/patterns/`, and every
  theories file in `memory/theories/` whose first line under the heading is still the summary
  comment — the ones no reset has consolidated yet, oldest first. Their `Said` is settled and stays
  settled; what is still waiting under `Asked` is asked here only if it bears on a row below.
- `pj ls --view week --json`: the overdue column first.
- `pj ls --view actionable --json`: the `week` pile.
- Every note with a non-empty `waiting_on`, with how long since it last changed (`pj log`).

## 2. Consolidate memory

Everything here is yours to write without asking (SKILL.md, *Memory*); do it before the first
batch, so the batches ask only what memory couldn't answer.

1. **Recount every pattern.** For each, the week's T-entries whose outcome cites it, or that it
   applied to: each one that held adds to `held` and moves `last held`; the latest few go into
   `evidence`, replacing older ones, so the file stays one screen. A T-entry where its **refuter**
   turned up refutes it: remove the file, or, if only part failed, narrow its `so:` to what still
   held and say why in `evidence`. A pattern nothing touched stays as it is — untested is not false.
2. **Promote what held.** A belief about how to read the user or the sources — not about the state
   of the world — that held in theory files of two or more days, with the same refuter looked for
   and not found, becomes a pattern (the shape in SKILL.md). So does a `## Delta` cause that
   repeats across days ("web1-style incidents displace the plan"), as a pattern about how the
   user's days go. "The rotation is Thursday" stays a theory; "Gemini notes assign the team's
   actions to him" is a pattern. Before writing a new file, look for one it extends: patterns stay
   few.
3. **Summarise the theory files no live plan depends on**: a closed day whose Plan items all have
   end states, none carried into a day still open, and nothing under `Asked` still `waiting`. Its
   summary comment becomes one line — `Summary (week reset YYYY-MM-DD): <the plan, what happened,
   what was learned and into which pattern>` — and the rest of the file is left exactly as it was.
   Never delete a theories file. A file something still depends on waits for the next reset.
4. **Revise `memory/AGENTS.md`** where the week showed the method was wrong: a refuter that kept
   being cheap, a source that misled, a question that a pattern could have answered.

Log it in today's theories file as one T-entry per pattern promoted, recounted past a refuter, or
refuted (`rests on: patterns/<slug>.md`), and say it in one line at the top of the first batch:
"memory: <n> theory files summarised, <p> patterns promoted, <r> refuted".

## 3. Ask, in batches

Present one batch at a time, at most ten rows, so an answer can be one line ("1 keep, 2 drop, 3
→ 10-20"). A row a pattern answers (an owner, a source known to file stale asks) isn't asked: it
goes in the batch as already settled, with the pattern named, for the user to overrule.

1. **Overdue** — per note: *still this date, a new date, or no date?*
2. **Waiting on, untouched for 7+ days** — per note: *chase, wait, or let go?* For a chase, offer to
   draft the message; the user sends it.
3. **The `week` pile** — per note: *still this week?* Anything not → `month`, `backlog` or
   `archived`, as the user says.

Stop after each batch.

## 4. Write

Each answer as its `pj set` command, one per note, then `pj check`. Log the decisions in today's
theories file under `Said`, one timestamped line per batch ("week reset: 6 dates moved, 4 dropped
to month"); an answer that overruled a pattern is evidence against it — note it on the pattern's
`evidence` line. The day note gets nothing. Offer to commit the vault, naming the files written —
`memory/` included — and staging only those.
