---
name: pj-did
description: Summarise what the user actually did on one day, as a categorised list of tasks, from their own traces in the vault, git, Claude sessions, Jira and Slack. Use when asked what they did today, yesterday or on a date, for a daily recap or standup notes, or for "what did I get done". Not for what is left to do; that is the actionable view.
---

# What I did

Turn one day's traces into a short, categorised list of **tasks done**, each one backed by the traces
that prove it. You summarise and group. You do not investigate, and you add nothing the traces don't
show.

## 1. Gather

The day is `today` unless the user named one: `yesterday` or `YYYY-MM-DD`.

```bash
pj did <day> --json
```

Run it the way this workspace runs `pj` (its `AGENTS.md` gives the command and the `--vault`). The
report holds the vault, git, claude and jira sources. Each **activity** has a `ref` to cite and, where
one matched mechanically, the vault `notes` it belongs to. If a source says `fetched: false`, report
its `reason` under **Gaps** and carry on without it.

**Slack** is the one source the script can't reach. Fetch it yourself with the read-only Slack
search, `from:me on:<YYYY-MM-DD>`, sorted by timestamp, paging until there are no more results.
Leave out the user's self-DM, which is a scratchpad and not work. If Slack isn't connected, put that
under **Gaps**.

This step is done when every source has either returned results or appears under Gaps.

## 2. Merge into tasks

A **task** is one piece of work, however many sources recorded it. A branch's commits, the session
that wrote them, the Jira ticket that moved and the Slack "deployed to eu-test" can all be one task.
Merge by mechanical evidence first: the same vault note in `notes`, the same Jira key, a session's
`wrote:` files inside the commit's repo, or the same branch. Merge by topic only when the words
plainly name the same thing.

Record exactly one **outcome** per task, read from the traces:

- **done**: the traces show it finished. A note became `note-closed`, a Jira `transition` went to a
  done-like status, the user said in Slack that it was merged, deployed or shipped, or a session's
  last word reports it complete.
- **progressed**: work happened but nothing shows it finished. This is the default.
- **handled**: a question answered, a ticket reassigned, a review requested. The user did something
  real that produced nothing to build on.

Leave out traces that are not the user's work:

- chit-chat, thanks and emoji-only messages
- sessions that only asked a question and got an answer (no tool calls, nothing written, no follow-up
  in another source)
- meetings attended
- reviewing somebody else's work

This step is done when every activity and Slack message sits in exactly one task or in the
left-out count.

## 3. Categorise and answer in chat

Group tasks under the **vault project** their notes point at, using the project note's title. If a
task matches no note, group it by theme: *Support*, *Infra / DevOps*, *Coordination*, or a name the
traces make obvious. Put the busiest category first.

```markdown
## <day> — <n> tasks

### <Category>
- **<Task, as an outcome in past tense>** · done — <one line of what changed> · [refs]
- **<…>** · progressed — …

### Gaps
- <sources not fetched and why; anything ambiguous you left ungrouped>

<n> traces left out as not work (chit-chat, Q&A sessions, reviews).
```

- Write each task in the user's own words where a trace has them: a commit subject, a prompt, a
  ticket summary.
- Put refs in the brackets: a Jira key, a short sha, `claude:<uuid8>`, a Slack permalink. Two or three
  per task is enough.
- Every claim needs a trace behind it. A date, a status or a "done" with no trace becomes
  *progressed*, or goes under Gaps.

## 4. Offer to save, then stop

Ask one question: **"Save this as a vault note?"** Then wait.

Only if the user says yes, read the `pj-about` skill first, then create one note for the day:

```bash
pj add "Did — <day>" --id did-<day> --facet status=done --body "<the summary above>"
```

Give it whatever other facets the vault's triage rules require, so it doesn't land in triage. Add the Jira
keys and sessions it cites with `--link jira:<KEY>` and `--link claude:<uuid>`. If `did-<day>` already exists, show both versions and ask
whether to replace or append. Don't overwrite it silently.
