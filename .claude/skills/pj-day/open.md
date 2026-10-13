# Open the day

From the pile to one to three outcomes the user agreed to, written down as today's note.

## 1. Read what the last days left behind

Read the most recent three day notes, newest first: their `Told` and `Open` sections, and yesterday's
`Plan` beside its `Did`. `Told` is what the user already said — never ask it again. `Open` is
what is still asked — carry the items forward rather than re-deriving them.

Done when you hold yesterday's unfinished plan items and every still-open question.

## 2. Ask, then stop

One message, short:

- the open question: **"What's on your mind today, and what changed since <yesterday's last
  timestamp> that I can't see?"**
- under it, yesterday's open questions, so one answer can settle them too.

Stop and wait for the answer. Log what it settles into today's `Told` once the note exists (step 5).

## 3. Gather against the answer

Cheapest first, each source once:

1. **Yesterday's reconcile.** `pj did yesterday --json` against yesterday's `Plan`. A plan item
   with a trace is a *seen* candidate for done; one without is *unknown*, not undone.
2. **Calendar**, today and tomorrow. Today's meetings set the shape and the free blocks. A meeting
   tomorrow that the user organises is a prep item; for one they only attend, a prep item needs a
   concrete anchor — a doc, a decision they will be asked for.
3. **Vault.** `pj ls --view week --json`, then the actionable view, then everything with a
   non-empty `waiting_on`, oldest first.
4. **Asks.** Chat mentions and direct messages from the last two working days ending in a
   question the user has neither answered nor reacted to; mail threads where they were asked
   directly and have not replied. Open each thread once before keeping it: a reply or a reaction
   already there drops it. A group mention anyone could answer is not an ask. If the workspace names
   the user's own scratchpad (a self-DM, a notes channel), read it since yesterday as things they
   told you.

A source that is not connected goes into a one-line **Gaps** at the end of the draft.

Done when every source has returned or is in Gaps.

## 4. Draft the day, then stop

```markdown
**<Ddd DD Mon>** — <the day's shape in one line: meetings, the free blocks>

**Outcomes** (pick or replace — at most three)
1. <outcome> — [[note-id]] · seen/inferred: <why today: the evidence>
2. …

**Small things** (≤15 min)
- <item> — [[note-id]] or plain · <evidence>

**Asking**
1. <the costliest-to-get-wrong question>
2. …

**Proposed** (nothing runs until you say)
- `pj set <id> --facet status=done` — seen: <trace>
- …

Gaps: <sources not reached>
```

- An outcome or small thing is the user's by rule 3: a note they captured, an assignment, their own
  promise, a meeting they run. Anything else is a question, never a candidate.
- Prefer what has an external clock (a meeting, a deploy window, a promise someone holds them to)
  over what is merely overdue.
- `Proposed` holds only writes with *seen* evidence or the user's own word. A past `due` is never
  moved without asking; overdue items become questions.

Stop. The user picks, edits, drops or adds.

## 5. Write what was agreed

1. Create the note, with no body yet:

   ```bash
   pj add "<YYYY-MM-DD Ddd> — plan: <the agreed outcomes, short>" --id day-<YYYY-MM-DD> \
     --facet day=<YYYY-MM-DD> --facet private=true --facet source=brain \
     --facet project=<id> …
   ```

   `pj add` writes it at the vault root; move it into the day-note folder with `mv`. The id lives in
   its frontmatter, so the move changes nothing else.
2. Write the body into the moved file with your file tools — the four sections, links relative to
   its folder. `Plan`: the agreed items. `Told`: every answer from step 2 and step 4, timestamped.
   `Did`: empty. `Open`: every question still unanswered.
3. Run each approved `pj` command, one per note, then `pj check` once — it must report nothing
   against the day note.

Report what was written in one line. On a Monday, offer the week reset.
