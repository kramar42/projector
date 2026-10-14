# Open the day

From the pile to one to three outcomes the user agreed to, written down as today's note. One stop:
run the loop in SKILL.md — gather, form and test theories — then present the draft.

## 1. Read what the last days left behind

**The window** reaches back to the **last closed day** — the newest day note with a non-empty
`Did` — or seven days, whichever is nearer. Read every note in it that has a `day` facet or a plan
in its body, whatever its convention: day notes, older plan notes. From each take its plan items
with their checkboxes. A plan item is a claim by whoever wrote that plan, and agents write plans: an
item carried from an earlier day needs a trace to the user's own words (a message, a session prompt,
an assigned ticket). One that has none is an agent's idea, and is off the plan unless the user
claims it. Days before the window are not read: their unticked items are one count in `Carried`.

Then read `memory/theories/<day>.md` for each day in the window, and today's, where one exists:
its `Said` is what the user already said — never ask it again; its `Asked` entries still `waiting`
or `not asked` are what is still asked; its T-entries are why each plan item was there. Those are
dated claims like any note: a theory that survived then is a prior to re-test, not a fact. A day an
earlier run already reconciled after it ended — a `looked:` line there names its `pj did <day>` — is
not reconciled again (step 2): what that run found stands in its T-entries and `Asked`. Read
`memory/patterns/` too.

**The starting draft**, the first that applies:

- **An earlier open today** — today's theories file has its T-entries, and today's note its Plan if
  one was written. This is a second open: that Plan and those T-entries are the draft, re-tested
  against what came in since the latest stamp in today's file. A re-test appends a `looked:` and an
  `outcome:` under the existing T-entry; a new belief takes the next T-number.
- **Last night's close wrote today's note** — the Plan the user approved is the draft, and its
  T-entries (`rests on: tomorrow's Plan <n>`) and `## Tomorrow (approved …)` are in the last closed
  day's theories file.
- **Close drafted but the user didn't approve** — the draft is there under
  `## Tomorrow (draft, not approved)`: candidates to test like any other, not the user's plan.

Each line is re-tested (step 2) against what came in since it was written — the night's intake, mail
and calendar changes. **Before the day's first tick** (the first of `poll.hours` in the vault's
config) the server has brought nothing overnight: the draft's first line says so, the re-test uses
only this run's own reads, and the first check-in after that tick re-tests the Plan's load-bearing
theories ([checkin.md](checkin.md)).

If the invocation says what the user worked on, that goes under `Said` in today's theories file
(rule 3 in SKILL.md).

Done when you hold every plan item in the window, ticked or not, the starting draft if there is
one, and every question still waiting.

## 2. Gather, then test

Cheapest first, each source once:

0. **Intake's freshness** (SKILL.md, *Intake*): `pj intake status --json`, and if the newest tick
   is stale, `pj intake` in the background while steps 1–3 run.
1. **Reconcile the unclosed days.** `pj did <day> --json` for each day in the window that no earlier
   run reconciled (step 1), against that day's plan items:
   - an unticked item with a trace is a *seen* candidate for done;
   - an unticked item without one is *unknown*, not undone;
   - a **ticked** item whose note is still open is a *seen* candidate to close — the user's own tick
     is the evidence.
2. **Calendar**, today and tomorrow. Today's meetings set the shape and the free blocks. A meeting
   tomorrow that the user organises is a prep item; for one they only attend, a prep item needs a
   concrete anchor — a doc, a decision they will be asked for. Meetings in the window that no
   earlier run read: read their notes.
3. **Vault.** `pj ls --view week --json`, then the actionable view, then everything with a
   non-empty `waiting_on`, oldest first.
4. **Asks: the inbox, and the scratchpad.** Once the tick (if one started) has finished, every card
   in `inbox/` (SKILL.md, *Intake*): the asks, promises and changes intake brought. Intake never
   sees the user's own messages, so if the workspace names their scratchpad (a self-DM, a notes
   channel), read it live since the window's start, or since an earlier run read it, as things they
   told you, and log what bears on the plan under `Said`, sourced to the scratchpad.
5. **Form theories, then test them** (the loop in SKILL.md): one per candidate outcome or small
   thing, one per write you mean to propose, and one per inbox card. Most rest on one of three
   beliefs:
   - *it is still open* — refuted by a closing trace: a commit or session on it, a Jira change, the
     reply already in the thread;
   - *it is the user's* (rule 5) — settled only by ownership evidence; without it, it can't settle;
   - *it is today's* — refuted when its clock moved: the meeting cancelled or moved, the date
     changed.

   For each load-bearing one, name the refuter, then look for it in what steps 1–4 returned and in
   the vault (`pj context <id> --json`) before spending a live read; `memory/AGENTS.md` lists the
   cheap ones. Write the T-entries into today's theories file now, creating it if no run has, and
   each question you will ask under `Asked` as `waiting`.

A source that is not connected, and an intake channel that was not fetched, go into a one-line
**Gaps** at the end of the draft.

Done when every source has returned or is in Gaps, the tick (if one started) has finished, every
inbox card has a verdict, every load-bearing theory has a named refuter, a `looked:` line and an
outcome, and the rest are carried untested with their as-of date.

## 3. Draft the day, then stop

```markdown
<only before the day's first tick: before the first tick (<HH:00>) — nothing in from overnight; re-tested on this run's own reads>
<only when intake was stale: intake last ran <MM-DD HH:MM>, the server is probably down — ran a tick now>

**<Ddd DD Mon>** — <the day's shape in one line: meetings, the free blocks>

<only when a starting draft exists:>
**Since <last night, or HH:MM on a second open>** — <"nothing moved; the Plan stands", or one line per line that moved:>
- Plan <n> <item> — T<n> refuted overnight: <what was found> → off / swapped for <…>

**Outcomes** (pick or replace — at most three)
1. <outcome> — <note id> · T<n> survived (<refuter looked for, not found>)
2. …

**Small things** (≤15 min)
- <item> — <note id> or plain · T<n> <outcome>

**Refuted since the notes were written**
- T<n> <belief> — <what was found> → `pj set …` / off the plan

**Inbox** — <n> cards (accept <a> · fold <f> · decline <d> · yours <y>)
1. accept  <card title> — T<n> survived (<refuter looked for, not found>) · `pj accept <id>`
2. fold    <card> → <target> — T<n> survived · `pj accept <id>` (or `--only <axis>,<axis>`)
3. decline <card> — T<n> refuted: <what was found> · `pj decline <id> --reason "<what was found>"`
4. yours   <card> — T<n> can't settle: <what was looked for>

**Asking** (one word each)
1. <closed question> — T<n>: <what was looked for, where> · yes → <what you write> / no → <what you write>
2. …

**Proposed** (nothing runs until you say)
- `pj set <id> --facet status=done` — seen: <trace, or "ticked in <plan note>">
- …

**Carried** — <n> untested from <day>, <n> from <day> … · <n> unticked before <the window's first day>, unread (names on request)

Gaps: <sources not reached>

Worked on something this misses? Say it and I'll follow it up.
```

- An outcome or small thing is the user's by rule 5: a note they captured, an assignment, their own
  promise, a meeting they run. Anything else is a question, never a candidate.
- Prefer what has an external clock (a meeting, a deploy window, a promise someone holds them to)
  over what is merely overdue.
- An outcome rests on a theory that survived its refuter. One whose theory couldn't settle is
  offered beside its question, never as seen.
- `Refuted` lists every theory a refuter disproved, with what was found: a reply already sent, a
  ticket already Done. A refuted belief never becomes a plan line; where a note still claims it, the
  edit that brings the note in line goes on the same row.
- `Proposed` holds only writes with *seen* evidence or the user's own word. A past `due` is never
  moved without asking.
- `Inbox` has a row for every card, so "inbox as proposed" is a whole answer. An accepted card
  that is an ask for today can also be an outcome or a small thing; a "yours" card waits on the
  board. No cards: `**Inbox** — empty`. A fold row for a card of its own proposes
  `pj merge <id> --into <target>` instead of `pj accept`.
- When the user has said they will judge the inbox themselves — under `Said`, or in the vault's or
  `memory/` instructions — the block is the count line plus your verdicts marked `suggested`, with
  no command on any row.
- `Carried` is one line of counts, never a list. An unknown item that has its own note stays on that
  note — the note already holds it, and the week reset asks about it. Only plain-text items, which
  live nowhere else, go under `Asked` in today's theories file, marked `not asked`: "still yours:
  <item> (from <day>)?".

Stop. The user picks, edits, drops, adds or answers.

## 4. Write what was agreed

1. Create the note, with no body yet:

   ```bash
   pj add "<YYYY-MM-DD Ddd> — plan: <the agreed outcomes, short>" --id <YYYY-MM-DD> \
     --facet day=<YYYY-MM-DD> --facet private=true --facet source=brain \
     --facet project=<id> --facet project=<id>
   ```

   A note carrying `day` is written to `daily/`; `pj add` prints where. That is the file to edit.
   If last night's close or an earlier open already wrote it, don't add it again: edit its Plan, and
   `pj set` its `--title` and `project` facets only where the agreed Plan changed them.
2. Write the body into it with your file tools — the two sections, links relative to `daily/`.
   `Plan`: the agreed items, one line each plus the link to its note, nothing more. `Did`: empty.
3. Today's theories file already holds this run's T-entries and questions. Add to it:
   - a T-entry for any Plan item the user added, with what is known under `looked:`;
   - under `Said`, `<time> open — plan agreed` (what makes the next run a check-in), then the
     user's answers and anything they said they worked on, timestamped;
   - under `Asked`, each question's answer, or `waiting`, and the carried plain-text items as
     `not asked`. An answer that settles a theory also becomes its `outcome:`.
4. Run each approved `pj` command, one per note, and each approved Inbox verdict, then `pj check`
   once, read for what this run wrote (SKILL.md, *The day note*).
5. If the user named work the draft missed, follow it up now (rule 3), and add what it settles.

Report what was written in one line. On a Monday, offer the week reset.
