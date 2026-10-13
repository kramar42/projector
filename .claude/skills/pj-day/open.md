# Open the day

From the pile to one to three outcomes the user agreed to, written down as today's note. One stop:
gather everything, then present the draft.

## 1. Read what the last days left behind

Find the **last closed day** — the newest day note with a non-empty `Did` — and read every note
since it that has a `day` facet or a plan in its body, whatever its convention: day notes, older
plan notes. From each take its plan items with their checkboxes.

Then read `memory/theories/<day>.md` for the last closed day and each day since, where one exists:
its `Said` is what the user already said — never ask it again; its `Asked` entries still `waiting`
or `not asked` are what is still asked; its T-entries are why each plan item was there.

If the invocation says what the user worked on, that goes under `Said` in today's theories file
(rule 3 in SKILL.md).

Done when you hold every plan item since the last closed day, ticked or not, and every question
still waiting.

## 2. Gather

Cheapest first, each source once:

1. **Reconcile the unclosed days.** `pj did <day> --json` for each day since the last closed one,
   against that day's plan items:
   - an unticked item with a trace is a *seen* candidate for done;
   - an unticked item without one is *unknown*, not undone;
   - a **ticked** item whose note is still open is a *seen* candidate to close — the user's own tick
     is the evidence.
2. **Calendar**, today and tomorrow. Today's meetings set the shape and the free blocks. A meeting
   tomorrow that the user organises is a prep item; for one they only attend, a prep item needs a
   concrete anchor — a doc, a decision they will be asked for. Meetings since the last closed day:
   read their notes.
3. **Vault.** `pj ls --view week --json`, then the actionable view, then everything with a
   non-empty `waiting_on`, oldest first.
4. **Asks.** Chat mentions and direct messages since the last closed day ending in a question the
   user has neither answered nor reacted to; mail threads where they were asked directly and have
   not replied. Open each thread once before keeping it: a reply or a reaction already there drops
   it. A group mention anyone could answer is not an ask. If the workspace names the user's own
   scratchpad (a self-DM, a notes channel), read it since the last closed day as things they told
   you, and log what bears on the plan under `Said`, sourced to the scratchpad.

A source that is not connected goes into a one-line **Gaps** at the end of the draft.

Done when every source has returned or is in Gaps, and every plan item from step 1 has a tier.

## 3. Draft the day, then stop

```markdown
**<Ddd DD Mon>** — <the day's shape in one line: meetings, the free blocks>

**Outcomes** (pick or replace — at most three)
1. <outcome> — <note id> · seen/inferred: <why today: the evidence>
2. …

**Small things** (≤15 min)
- <item> — <note id> or plain · <evidence>

**Asking** (one word each)
1. <closed question> — <evidence> · yes → <what you write> / no → <what you write>
2. …

**Proposed** (nothing runs until you say)
- `pj set <id> --facet status=done` — seen: <trace, or "ticked in <plan note>">
- …

**Carried** — <n> unknown from <day>, <n> from <day> … (names on request)

Gaps: <sources not reached>

Worked on something this misses? Say it and I'll follow it up.
```

- An outcome or small thing is the user's by rule 5: a note they captured, an assignment, their own
  promise, a meeting they run. Anything else is a question, never a candidate.
- Prefer what has an external clock (a meeting, a deploy window, a promise someone holds them to)
  over what is merely overdue.
- `Proposed` holds only writes with *seen* evidence or the user's own word. A past `due` is never
  moved without asking.
- `Carried` is one line of counts, never a list. An unknown item that has its own note stays on that
  note — the note already holds it, and the week reset asks about it. Only plain-text items, which
  live nowhere else, go under `Asked` in today's theories file, marked `not asked`: "still yours:
  <item> (from <day>)?".

Stop. The user picks, edits, drops, adds or answers.

## 4. Write what was agreed

1. Create the note, with no body yet:

   ```bash
   pj add "<YYYY-MM-DD Ddd> — plan: <the agreed outcomes, short>" --id day-<YYYY-MM-DD> \
     --facet day=<YYYY-MM-DD> --facet private=true --facet source=brain \
     --facet project=<id> …
   ```

   A note carrying `day` is written to `daily/`; `pj add` prints where. That is the file to edit.
2. Write the body into it with your file tools — the two sections, links relative to `daily/`.
   `Plan`: the agreed items, one line each plus the link to its note, nothing more. `Did`: empty.
3. Write today's theories file, `memory/theories/<YYYY-MM-DD>.md` (shape in SKILL.md, *Memory*):
   - a T-entry per Plan item, its evidence from the draft under `looked:`;
   - under `Said`, the user's answers and anything they said they worked on, timestamped —
     `<time> open — nothing said` if they only picked;
   - under `Asked`, every question in the stop with its answer or `waiting`, and the carried
     plain-text items as `not asked`.
4. Run each approved `pj` command, one per note, then `pj check` once — it must report nothing
   against the day note.
5. If the user named work the draft missed, follow it up now (rule 3), and add what it settles.

Report what was written in one line. On a Monday, offer the week reset.
