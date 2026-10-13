# Close the day

Every plan item leaves with an end state, `Did` gets written, the vault's notes are brought in line
with what the user actually finished, and tomorrow starts from a drafted Plan. One stop.

## 1. Read today's note and today's theories

Read the day note's `Plan`, then `memory/theories/<today>.md`: its T-entries, `Said` and `Asked`,
and `memory/patterns/`. If the invocation says what the user worked on, log it under `Said` and
follow it up (rule 3 in SKILL.md).

## 2. Draft `Did`

Follow the `pj-did` skill's steps 1 to 3 for the day — gather, merge into tasks, categorise — and
skip its step 4: the summary lands in this note's `Did` section, not in a note of its own. Read the
notes of the day's meetings too: a decision recorded there that touches one of the user's notes
belongs in `Did`, attributed to the meeting.

## 3. Reconcile the plan

Give every `Plan` item exactly one end state, with its tier:

| end state | evidence |
|---|---|
| **done** | a *seen* trace in `Did`, or the user's word under `Said` |
| **carried** | worked on, not finished — tomorrow's draft takes it |
| **dropped** | the user said so |
| **unknown** | nothing either way — one closed question if it is among the costliest, else under `Asked` as `not asked`; never assume undone |

Then draft:

- for each **done** item with a note: `pj set <id> --facet status=done` — but only when the note is
  the whole thing, not a larger note this item was one step of;
- the new title: `<YYYY-MM-DD Ddd> — <the day's two or three biggest outcomes>`, from `Did`, not
  from the plan.

## 4. The delta, into theories

The day note's unticked Plan beside its `Did` already shows the gap; why it opened is an inference,
and it goes only to today's theories file, under `## Delta`, never into a note. One line per gap
that has a cause the traces suggest, each with its evidence and the theory it touches:

```markdown
## Delta
- 18:40 inferred: web1 displaced the Loki review — Did is the rotation and the RCA, Plan 3 has no trace (T2)
- 18:40 inferred: the wait-node contract never started — refuted at 00:18 as not his (T4)
```

A gap with no visible cause gets no line: absence is unknown. Where a gap repeats an earlier day's
(the same kind of work displacing the plan again), say so on the line, citing that day's Delta —
the week reset counts it.

## 5. Draft tomorrow's Plan

Tomorrow is the next working day: Monday after a Friday close. Draft it the way open drafts a day
(open.md step 3's rules — the user's by rule 5, external clocks first, at most three outcomes,
then small things), from what this run already holds:

- **carried** items, each still traced to the user's own words (open.md step 1);
- theories that **survived** today and still bear on tomorrow — a promise someone holds them to, an
  ask waiting on them;
- **tomorrow's calendar**: what it fixes, and prep for a meeting the user organises;
- notes whose `due` is tomorrow, from `pj ls --view week --json`.

Each line gets a T-entry in today's theories file (`rests on: tomorrow's Plan <n>`) with its refuter
and what this run saw. No intake tick and no new live reads for this: open re-tests every line
against what comes in overnight. Write the draft into today's theories file now, under
`## Tomorrow (draft, not approved)`, as the Plan lines themselves, one line plus a link each, the
links written relative to `daily/` as the day note will hold them, so a yes copies them verbatim.

## 6. Stop

Present, together:

```markdown
**Did** — <the draft, pj-did's shape>

**Plan, end states**
1. <item> — done · seen: <trace> / carried / dropped / unknown → Q<n>

**Tomorrow, <Ddd DD Mon>** — <its shape: meetings, the free blocks> · write it as tomorrow's note? yes / edit / no
- [ ] <outcome> — <link target> · T<n> survived (<refuter looked for, not found>)
- [ ] <small thing>

**Asking** (one word each) — at most three, each about a theory that can't settle

**Proposed** (nothing runs until you say)
- `pj set <id> --facet status=done` — seen: <trace>
- today's note: `--title "<new title>"`, `status=done`, its projects and sources
- `pj add "<YYYY-MM-DD Ddd> — plan: <tomorrow's outcomes, short>" --id <tomorrow> …` (step 7)

Worked on something this misses? Say it and I'll follow it up.
```

The Tomorrow block is itself the ask, like open's Inbox block: it spends no question from the budget,
and no answer to it means no.

## 7. Write what was approved

1. **Today's note.** Body: tick done items in `Plan`, write `Did`. Nothing else goes into the note.
   Facets: `--facet status=done`, `project` = every project in `Did`, `source` = every source with
   traces, `--title` the new title, and `pj link` each Jira key and Claude session `Did` cites.
2. **Today's theories file.** The user's answers under `Said`, timestamped — or `<time> close —
   nothing said`; `Asked` marked with what was answered, every question still unanswered left
   `waiting`; an answer that settles a theory also becomes its `outcome:`.
3. **Tomorrow's note, only on a yes** (or a yes with edits):

   ```bash
   pj add "<YYYY-MM-DD Ddd> — plan: <the agreed outcomes, short>" --id <YYYY-MM-DD> \
     --facet day=<YYYY-MM-DD> --facet private=true --facet source=brain \
     --facet project=<id> --facet project=<id>
   ```

   One `--facet project=` per project the Plan's notes belong to; no `status`, no `priority`. Then
   write the body into the file `pj add` prints, with your file tools: `## Plan` as approved, one
   line plus a link each (links relative to `daily/`), and an empty `## Did`. If a note for that day
   already exists, don't add another: show its Plan beside the draft and ask which wins.
   In today's theories file the heading becomes `## Tomorrow (approved HH:MM → <YYYY-MM-DD>)`,
   and its lines match what was written.
4. **On a no, or no answer**, write no `daily/` file: the draft stays under
   `## Tomorrow (draft, not approved)`, and tomorrow's open reads it as a list of candidates, not as
   the user's plan.
5. The approved `pj set` commands, one per note, then `pj check` — it must report nothing against
   either day note.
6. Offer to commit the vault: name every file this run wrote — the day notes, the notes set,
   `memory/theories/<today>.md`, and any `memory/patterns/` or `memory/AGENTS.md` it changed — stage
   those paths and nothing else, and commit only on an explicit yes.

On a Friday, offer the week reset.
