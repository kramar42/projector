import type { DatabaseSync } from 'node:sqlite';
import type { Note } from '../schema/types.ts';

/**
 * Intake: what has happened elsewhere that the vault does not know about — and,
 * since it became a sync, what has moved on the things it does know about.
 *
 * The mirror image of enrichment. Enrichment is given a ref and returns how to
 * display it; intake is given a channel and a cursor and returns refs nobody has
 * filed yet, plus refs somebody has filed whose source has changed since. Neither
 * imports the other, and they share only `src/sources/`.
 *
 * A channel **gathers; it never judges and never writes a note.** Everything a
 * channel emits is deterministic fact or provenance. Whether a candidate deserves
 * a note, and what the note says, belongs to `classify.ts`; whether it was right
 * belongs to whoever walks the queue (C8: what is computed is computed, what is
 * decided is decided by someone — and a model deciding what to file was always
 * the arrangement, only in a conversation instead of a pass).
 */

/** A note this candidate might belong to, and the mechanical reason it might. */
export interface Match {
  id: string;
  title: string;
  /** `cwd`, `worktree`, `branch`, `jira`, `text` or `tracked` — how it was matched, not how sure we are. */
  why: string;
}

/**
 * Everything mechanical that bears on "is this new work, or more of something
 * already tracked". No scores and no verdict: the caller decides, and this is
 * the evidence it decides from.
 */
export interface Evidence {
  /**
   * Notes that already track the thing this candidate is about — carrying its
   * link, or a message of the same conversation, or the issue it reports on.
   *
   * Non-empty means the candidate is an **update**, not a discovery: it may only
   * extend one of these notes or be dropped, never stand alone. That is the sync
   * half of intake. It used to mean "nothing to do", back when a sweep could only
   * discover.
   */
  linkedTo?: string[];
  /** Notes whose `source_fingerprint` is this candidate's. Nothing to do. */
  capturedAs?: string[];
  /** Notes this might be more work on, most likely first. */
  matches?: Match[];
}

/**
 * What a fetch or a judgement cost, when the transport can say.
 *
 * Recorded because an unattended tick that spends two minutes and forty thousand
 * tokens looks exactly like one that spent two seconds, and the poller is the one
 * thing here that runs whether or not anyone is watching the bill.
 */
export interface Cost {
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Agent turns — tool calls, for a relay. */
  turns?: number;
}

export interface Candidate {
  channel: string;
  /**
   * Derived from the thing itself, never from its wording, so a re-sweep
   * converges. `pj add --fingerprint` refuses a duplicate on the strength of it.
   */
  fingerprint: string;
  /** In the user's voice where the source gave one — a commit subject, an opening prompt. */
  title: string;
  /** Links to carry onto the note, provenance first. */
  links: string[];
  /** ISO, when the source has one. Drives the cursor and the display order. */
  when?: string;
  /** One line of context, shown under the title. */
  detail?: string;
  fields?: { k: string; v: string }[];
  evidence?: Evidence;
  /**
   * The source's state this candidate was examined in, for the `seen` table.
   *
   * `key` is the stable identity — `jira:KEY`, whatever the fingerprint says —
   * and `value` is what the channel compares next time to decide whether the
   * thing moved. Recorded by the automatic path only after the candidate was
   * judged, so a held tick never marks a change as seen.
   */
  state?: { key: string; value: string };
}

/** Something the channel saw and is deliberately not proposing, with the reason. */
export interface Skipped {
  fingerprint: string;
  title: string;
  why: string;
}

export interface ChannelReport {
  channel: string;
  /** The watermark this run started from, or null when there was none. */
  cursor: string | null;
  /** Where the cursor should move to once the proposal is resolved. */
  nextCursor: string | null;
  /**
   * False when `pj` has no way to reach this channel — an absent Slack MCP or an
   * unavailable Gmail CLI, for example. The cursor is still ours: one store for
   * "where we got to", whichever transport did the fetching.
   */
  fetched: boolean;
  /** Why it was not fetched, or what to do instead. */
  reason?: string;
  /**
   * True when the limit stopped the run before the window did, so there is more
   * behind the cursor this report does not show.
   *
   * Why channels work **oldest first**: the cursor is a single boundary, so a
   * truncated newest-first run would advance it past items it never examined.
   * Forward from the watermark, truncation means only "stopped early" — the next
   * sweep resumes exactly where this one stopped, and nothing is skipped.
   */
  truncated?: boolean;
  candidates: Candidate[];
  skipped: Skipped[];
  /** What fetching cost, when the transport says — an agent relay does, `git log` does not. */
  cost?: Cost;
}

/**
 * What every channel is handed. Built once per run: the index rebuild costs ~37ms
 * and three channels asking for it separately would each pay that.
 */
export interface IntakeContext {
  root: string;
  db: DatabaseSync;
  notes: Map<string, Note>;
  /** `source_fingerprint` → note ids. */
  fingerprints: Map<string, string[]>;
  /** A link's raw text → note ids carrying it. */
  links: Map<string, string[]>;
  /**
   * Fingerprints somebody already judged as "not a note".
   *
   * Handed to channels for completeness — `sweep` drops these centrally, so a
   * channel needs no code to honour it and cannot forget to. A channel that wants
   * to stop *fetching* something it knows is suppressed may still read it — and a
   * channel that counts candidates against a limit must, or the suppressed ones
   * fill the limit and the run truncates on nothing (see `claude.ts`).
   */
  suppressed: Set<string>;
  since: Date;
  cursor: string | null;
  limit: number;
}

export interface Channel {
  name: string;
  /** How far back to look when there is no watermark yet. */
  defaultDays: number;
  collect(ctx: IntakeContext): Promise<ChannelReport> | ChannelReport;
}
