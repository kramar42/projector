# Passive intake: a queue that fills itself

## The task

A personal work tracker holds notes. Things that ought to become notes happen elsewhere all day — in
tickets, mail, chat, commits, coding sessions. Today a person starts a sweep, an assistant proposes what
it found, the person answers each one, and a watermark moves.

Replace that with something that runs on its own: it fetches continuously, decides what is worth
keeping, writes the keepers into the tracker already filled in, and leaves a queue for the person to
walk when they feel like it.

What follows is the reasoning that should shape the design. It is not a component list. Where it names
a behaviour, that behaviour matters; where it doesn't, decide for yourself.

## The point

**The queue is the artifact, not the sweep.** In the old shape the sweep is an event: it happens inside
a conversation, its results live in that conversation, and when the conversation ends they are gone.
Recall is therefore a function of somebody remembering to start one — which is the discipline the tool
was supposed to replace.

Move the work off the conversation and onto a durable queue. Fetching becomes unattended. Deciding
happens once per item, at the moment it arrives, with no conversation around it. The person becomes the
*last* step rather than the driver: they walk a queue that is already sorted out, instead of
commissioning a search.

Everything below follows from taking that seriously.

## Volume is the problem, and it is not a matter of taste

Most of what a sweep finds is the person's own activity. Their commits. Their coding sessions. They did
all of it on purpose and do not need telling.

Mechanical signals cannot fix this, and it is worth understanding why before reaching for them.
Evidence — this branch matches that note, this link is already on one — answers *is this already
tracked*. It does not answer *does this matter*. A commit by the configured author in a declared repo
has flawless mechanical provenance and is still, usually, nothing. Rank by evidence strength and you
put the person's own busywork at the top of their queue.

So something has to make a judgement about relevance, and that means a model. Which is the crux:

**A queue that fills itself without judging is worse than no queue.** Not a milder version of the
problem — the whole of it. The person opens it, sees their own afternoon written back at them, and never
opens it again. If the judging half cannot be built, do not build the fetching half either.

## Saying no has to be as durable as saying yes

This is the defect that motivates the redesign, and the easiest one to rebuild by accident.

Capturing something leaves a record — a note, marked with where it came from — so no later sweep offers
it twice. Declining something typically leaves nothing at all: the watermark moves past it and that is
the entire trace. Which means *seen and rejected* is indistinguishable from *never fetched*, except that
the first can never come back. Nothing learns from it, and nothing stops the same rejection being asked
for again in a slightly different form.

So a decline is a written thing, with its reason, keyed on whatever identifies the item. Consequences
worth designing for:

- **Deleting is declining.** If a person deletes one of these notes, that is the plainest possible "no",
  and it must stick. Where deletion destroys the only record that stopped the item returning, the
  gesture that obviously means no becomes the one gesture that does not work.
- **Record who decided.** A machine's decline is a prediction that may be wrong; a person's is not.
  Anything that cannot distinguish them can neither be learned from nor trusted.
- **It must be reversible**, for the reason in the next section.

## Which way to fail

The two errors are not symmetric, and almost every judgement call in this design is an application of
that:

> Keeping something that did not deserve it costs a glance. Dropping something that did costs the thing
> itself.

From which:

- Ambiguity inside a successful judgement resolves toward keeping. An item the model failed to mention
  is kept, not dropped.
- What was hidden stays readable, searchable, and restorable. Once something is deciding on the person's
  behalf, an empty screen has two meanings — *nothing happened* and *everything was hidden* — and with no
  way to tell them apart, the sensible reader stops trusting it. Call this the audit trail for a decision
  the app made on its own; it is not a convenience feature.

**But when the judge itself is unavailable, fail closed.** Write nothing, advance nothing, try again
later. Falling back to writing everything down reaches the exact failure the judgement exists to prevent,
and reaches it silently. There should be a way to ask for the unjudged pile deliberately — and no way to
arrive at it by omission.

## Judging and describing are one act

Once a model is reading the item to decide about it, it has already done the expensive part. Asking it
only *keep or drop* wastes the call and produces cards nobody wants to read — a raw commit subject as a
title, a provenance string as a body, no context.

The same pass should say what the thing *is*: a title a person would use out loud, a short body saying
where the work got to and what is unresolved, and the tracker's own categories filled in. Cheap, because
the reading is already paid for; and it is most of what makes the queue worth walking.

Then two more questions belong in the same pass, because they are the same reading:

- **Is this a new thing, or more of a thing already tracked?** Most of what a sweep finds, once a piece of
  work exists, is more of that work. Those should join what they extend rather than accumulating beside
  it. Accepting one is a different gesture from accepting a new item, and it should be one gesture, not a
  manual reconciliation.
- **Does this need to interrupt?** A note is something you find when you look. An interruption is
  something you cannot decline. "Deserves a note" is the wrong threshold for it — so make it a separate,
  higher one, and let almost everything fail it. A notification nobody wanted is how people turn
  notifications off for good.

## The model proposes; the system disposes

A model will invent a category, a value, a reference to something that does not exist. Treat everything
it returns as a *proposal in need of validation against what actually exists* — before anything is
written, never after.

Validate each part on its own. A card with two good categories and one invented one is worth having; a
rejected write is not, so drop the invented part and keep the card. Reject an invented reference by
demoting the item to a plain new one rather than discarding it.

Two things follow that are easy to miss:

- **A model must not widen the vocabulary by accident.** Where a category accepts new values, show it the
  values already in use and ask it to prefer them, or a queue of new items will quietly turn one concept
  into three synonyms.
- **A model must not write the pipeline's own bookkeeping.** Whatever marks an item as unjudged, or
  records what it extends, belongs to the system. Withhold those.

This is also what makes the queue honest. An item in it is one where *nothing has been confirmed by a
human* — its title, its body and its categories are all proposals. Judging it is accepting them, or
fixing them first. That is a more useful meaning than "new", and worth encoding as such.

## Reuse the surface; do not invent a place

If the queue's contents are the same kind of object the tracker already displays, then the queue is a
saved query and everything already built works on it — the views, the editing, the keyboard, the command
line, the ability of another tool to edit the files directly. This is worth contorting the data model to
achieve, and it is usually available if the item is written as a real object with a flag rather than held
in a side table waiting for approval.

The corollary: what genuinely *isn't* one of those objects should not pretend to be. Declined items never
became notes; they need their own small surface, and that is fine — a surface is not a view, and knowing
which you are building keeps both honest.

## What it learns from

The corrections, not the agreements.

A decline the person leaves alone only says they agreed with it. A decline they *take back* says the
judgement was wrong in the direction that costs them something, and is worth more than a great many
confirmations. If reversals are not recorded when they happen — if restoring an item simply deletes the
record of it having been hidden — the most valuable signal in the system is thrown away at the exact
moment it is generated.

Feed recent decisions back into the judgement as examples, weighted that way. Keep the ordering stable so
the same inputs produce the same prompt. Don't attach invented scores to the examples; a model shown two
numbers will learn two buckets.

## What must not happen

- **Nothing writes where somebody else reads.** The sources are read-only. This matters most where an
  agent is given tools in a shared channel to do the fetching: a tool cannot be known to be read-only from
  its name, so the tools it may use are listed explicitly and everything else is refused. No wildcards —
  a wildcard over a service's tools is a wildcard over its write tools. The default is no tools, so the
  failure of omission is *does not fetch*, never *might post*.
- **Notifications stay local.** Telling the person on their own machine involves no service and no
  account, and cannot be read by anyone else. That is a different act from sending them a message, and
  the easy version of this feature quietly becomes the second one.
- **The unattended path may not lose things.** Whatever bounds how far back it looks may only move past
  items that were actually resolved — into a note, or into a recorded decline. Note that the durable queue
  is what earns this: a run that merely *proposed* has resolved nothing, and must not move it.
- **The judgement must never masquerade as a fact.** If the system elsewhere guarantees that its
  indicators are computed rather than guessed, a model's opinion cannot be rendered as one of them. It may
  gate, it may order, it may explain itself in prose. It should not become a stored category or a badge
  that looks like the computed ones.

## Done looks like

A person opens the tracker in the morning. There are four things in the queue and they are all real. Each
one is titled the way they would describe it to a colleague, says what state it was left in, and is
already filed. One of them is more of something they started last week and offers to join it. The forty
other things that happened yesterday are not there — and there is one place to look that says what those
were and why, if they want to check.

They accept three, fix a category on the fourth and accept it, and get on with their day.
