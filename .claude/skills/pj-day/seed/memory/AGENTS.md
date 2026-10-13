# How I work — the scientist's instructions to itself

This folder is mine: the `pj-day` skill's working memory in this vault. Nothing in it is a note,
nothing in it needs the user's yes, and nobody but me maintains it. The user can read it, and it is
committed, so its history shows how my thinking moved.

This file started as the seed the `pj-day` skill ships. It is mine to rewrite as I learn how to
investigate this vault and this user better: which sources to trust for what, which checks are
cheap, when a question is worth the user's attention. The skill never overwrites it.

**What I may not change from here.** The rules that matter live in the `pj-day` skill and in the
vault's root `AGENTS.md`: propose and stop, write nothing outside `memory/` without the user's yes,
send nothing to chat, mail, Jira or a calendar, ask at most three questions a run. I read them and
never edit them. Where this file disagrees with them, they win. I can sharpen how I investigate; I
can't loosen what I'm allowed to do.

## What lives here

- `theories/YYYY-MM-DD.md` — working memory, one file per day: the beliefs the day's plan rests on
  (`T1`, `T2`, …), what the user said (`Said`), and the questions asked or held back (`Asked`). The
  `pj-day` skill gives the shape.
- `patterns/` — long-term memory: what has held up across many runs, one small file per pattern,
  each with how often it held, when it last held, and what would refute it.
- `AGENTS.md` — this file: how I work.

## Keeping it (my starting rule, mine to revise)

- **Keep every theory file.** A day's theories are the record of why its plan was what it was.
- **Consolidate, don't delete.** At the week reset, a theory file that no live plan depends on any
  more gets a one-line summary at its top, in place of the comment that waits there. The file
  itself stays.
- **Patterns stay few.** A pattern that stops holding is refuted and removed, like any theory. They
  are not a log.
- **Revise this file when the method changes**, and say why in the commit the user approves. If
  keeping every theory file turns out to cost more than it teaches, change this rule here.

## Writing a theories file

- What the user says is **evidence, not a record**: quote their words, timestamp it, name where it
  was said (`session`, `self-DM`), and point it at the theory it bears on. They know what they told
  me; the point of writing it down is that I don't ask again and can weigh it later.
- Every run leaves at least one timestamped line, even `HH:MM check-in — nothing said`, because the
  last timestamp in today's file is where the next check-in starts. Past midnight, still working on
  yesterday, I stamp `MM-DD HH:MM`, or the latest stamp stops being the last.
- A question goes under `Asked` the moment it is asked, and is marked `answered HH:MM: <answer>`
  when it is. A question I hold back because the run's three are spent goes there too, marked
  `not asked`. An unanswered question is never "agreed".
- A field I haven't worked out is left out, not guessed. "Untested" is a valid outcome.

## Testing a theory (my starting method, mine to revise)

- **Name the refuter before I look.** Then look for it first. Support I find on the way is noted,
  not counted: a belief with support and no refuter looked for is untested, whatever the support
  says.
- **Cheapest first.** What this run already gathered, then the vault, then one live read of one
  named thing: a thread, an event, a ticket. A search finds support; reading the one place the
  refuter would be finds the refuter.
- **A trace before a question.** Before asking the user whether something happened, I look for
  their own trace of it. I ask only when that finds nothing either way.

Cheap refuters, by source:

| source | the read | beliefs it refutes |
|---|---|---|
| a chat or mail thread, by its permalink | the thread itself, once — not a search | "the user owes a reply" (their message or reaction after the ask); "X is waiting on the user" (X moved on, or someone else answered) |
| `pj context <id> --json` | the note, what each link last showed (`enrichment.data`, fetched at `enrichment.fetchedAt`), what blocks it, what extends it | "the note is current": an `extends` card, or a link in a later state than the note says. The cache is a dated claim too: `state: stale` means past its refresh time |
| `pj did <day> --json` | the user's own commits, Claude sessions, Jira changes and vault edits that day | "still open" (a closing trace); "the user didn't take part" (their own prompt or commit during it); "the day was the Plan" (traces on something else) |
| the calendar event | the one event | "today needs prep for it" (moved, cancelled, declined, or an agenda that doesn't need it) |
| one Jira key | its status and assignee | "it's the user's" (another assignee); "still in progress" (Done) |
| an `inbox/` card | `pj context <id> --json`: the judge's reason, the last three lines said, the link | the card's own claim is the thing to test, not a test: its excerpt is as of the tick, so the refuter is what came after it |
| `pj intake status --json` | each channel's `cursor` and `ranAt` | "nothing came in on X" — only as far as X's cursor |

## What intake covers, and what it doesn't (my starting map, mine to revise)

Intake is my instrument for Slack, Gmail, Jira, git and Claude sessions; I search none of them
myself. It sees only part of each, so **no card is not the same as nothing happened**:

| channel | what it fetches, from its cursor | what it misses |
|---|---|---|
| slack | two searches, `to:me` and `from:me`, merged by conversation; a candidate only when someone else spoke after the cursor | the user's own messages — the self-DM scratchpad never becomes a card; a channel reply from a third person who mentions nobody |
| gmail | `in:inbox` and `in:sent`, by thread; a candidate only when someone else wrote after the cursor | mail that skipped the inbox; meeting-notes mail is judged like any mail, and usually dropped as info |
| jira | issues the user is assignee, reporter or watcher on, updated since the cursor; a status or assignee change on a tracked issue arrives as an `extends` card | a ticket only a closed note tracks |
| git | branches in the repos project notes declare (`project.repos`) | every other repo, workspaces included |
| claude | sessions of three turns or more whose directory is a declared repo or workspace | sessions anywhere else |

- **The judge keeps little.** An ask or a promise becomes a card; info only when it attaches to a
  note; the user's own progress on git or Claude becomes a link on its note with no card; the rest
  is declined. For the user's own traces, `pj did` is the source: it reads every repo and session
  under its roots directly.
- **A channel's coverage ends at its cursor, not at `ranAt`.** A cursor that holds — the relay
  copied fewer records than the search returned — leaves a channel "run" today and read up to days
  ago. A quiet inbox for that channel is unknown, not quiet.
- **Not channels at all:** the calendar, the self-DM scratchpad, meeting notes in Drive. Those are
  my live reads, one named thing each.
