# Close the day

Every plan item leaves with an end state, `Did` gets written, and the vault's notes are brought in
line with what the user actually finished.

## 1. Read today's note, then ask

Read `Plan`, `Told`, `Open`. Ask: **"Anything decided, done or dropped today that I can't see?"**
Stop and wait.

## 2. Write `Did`

Follow the `pj-did` skill's steps 1 to 3 for the day — gather, merge into tasks, categorise — and
skip its step 4: the summary lands in this note's `Did` section, not in a note of its own.

## 3. Reconcile the plan, then stop

Give every `Plan` item exactly one end state, with its tier:

| end state | evidence |
|---|---|
| **done** | a *seen* trace in `Did`, or the user's word in `Told` |
| **carried** | worked on, not finished — tomorrow's open reads it |
| **dropped** | the user said so |
| **unknown** | nothing either way — ask; never assume undone |

Then draft:

- for each **done** item with a note: `pj set <id> --facet status=done` — but only when the note is
  the whole thing, not a larger note this item was one step of;
- for each still-unanswered question: a line in `Open`;
- the new title: `<YYYY-MM-DD Ddd> — <the day's two or three biggest outcomes>`, from `Did`, not
  from the plan.

Present the end states and the commands together. Stop.

## 4. Write what was approved

1. Body: tick done items in `Plan`, write `Did`, add the user's answers to `Told`, update `Open`.
2. Facets on the day note: `--facet status=done`, `project` = every project in `Did`, `source` =
   every source with traces, `--title` the new title, and `pj link` each Jira key and Claude session
   `Did` cites.
3. The approved `pj set` commands, one per note, then `pj check`.
4. Offer to commit the vault: name the files this run wrote, stage those paths and nothing else,
   and commit only on an explicit yes.

On a Friday, offer the week reset.
