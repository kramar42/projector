# Close the day

Every plan item leaves with an end state, `Did` gets written, and the vault's notes are brought in
line with what the user actually finished.

## 1. Read today's note and today's theories

Read the day note's `Plan`, then `memory/theories/<today>.md`: its T-entries, `Said` and `Asked`.
If the invocation says what the user worked on, log it under `Said` and follow it up (rule 3 in
SKILL.md).

## 2. Draft `Did`

Follow the `pj-did` skill's steps 1 to 3 for the day — gather, merge into tasks, categorise — and
skip its step 4: the summary lands in this note's `Did` section, not in a note of its own. Read the
notes of the day's meetings too: a decision recorded there that touches one of the user's notes
belongs in `Did`, attributed to the meeting.

## 3. Reconcile the plan, then stop

Give every `Plan` item exactly one end state, with its tier:

| end state | evidence |
|---|---|
| **done** | a *seen* trace in `Did`, or the user's word under `Said` |
| **carried** | worked on, not finished — tomorrow's open reads it |
| **dropped** | the user said so |
| **unknown** | nothing either way — one closed question if it is among the costliest, else under `Asked` as `not asked`; never assume undone |

Then draft:

- for each **done** item with a note: `pj set <id> --facet status=done` — but only when the note is
  the whole thing, not a larger note this item was one step of;
- the new title: `<YYYY-MM-DD Ddd> — <the day's two or three biggest outcomes>`, from `Did`, not
  from the plan.

Present the draft `Did`, the end states, at most three closed questions and the commands together,
ending with the optional "worked on something this misses?" line. Stop.

## 4. Write what was approved

1. Day note body: tick done items in `Plan`, write `Did`. Nothing else goes into the note.
   Today's theories file: the user's answers under `Said`, timestamped; `Asked` marked with what
   was answered, and every question still unanswered left `waiting`.
2. Facets on the day note: `--facet status=done`, `project` = every project in `Did`, `source` =
   every source with traces, `--title` the new title, and `pj link` each Jira key and Claude session
   `Did` cites.
3. The approved `pj set` commands, one per note, then `pj check`.
4. Offer to commit the vault: name the files this run wrote, stage those paths and nothing else,
   and commit only on an explicit yes.

On a Friday, offer the week reset.
