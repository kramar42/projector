import type { DatabaseSync } from 'node:sqlite';
import type { Note } from '../schema/types.ts';

/**
 * Intake: what has happened elsewhere that the vault does not know about.
 *
 * The mirror image of enrichment. Enrichment is given a ref and returns how to
 * display it; intake is given a channel and a cursor and returns refs nobody has
 * filed yet. Neither imports the other, and they share only `src/sources/`.
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
  /** `cwd`, `worktree`, `branch`, `jira` or `text` — how it was matched, not how sure we are. */
  why: string;
}

/**
 * Everything mechanical that bears on "is this new work, or more of something
 * already tracked". No scores and no verdict: the caller decides, and this is
 * the evidence it decides from.
 */
export interface Evidence {
  /** Notes already carrying this exact link. Non-empty means there is nothing to do. */
  linkedTo?: string[];
  /** Notes whose `source_fingerprint` is this candidate's. */
  capturedAs?: string[];
  /** Notes this might be more work on, most likely first. */
  matches?: Match[];
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
   * to stop *fetching* something it knows is suppressed may still read it.
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
