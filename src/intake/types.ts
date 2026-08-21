import type { DatabaseSync } from 'node:sqlite';
import type { Rec } from '../schema/types.ts';

/**
 * Intake: what has happened elsewhere that the vault does not know about.
 *
 * The mirror image of enrichment. Enrichment is given a ref and returns how to
 * display it; intake is given a channel and a cursor and returns refs nobody has
 * filed yet. Neither imports the other, and they share only `src/sources/`.
 *
 * A channel **proposes and classifies; it never writes a card.** Everything a
 * channel emits is either deterministic fact or provenance — the judgement of
 * what deserves a card belongs to the `/capture` skill, and the judgement of
 * where it lives belongs to `/triage` (C8: what is computed is computed, what is
 * decided is decided by someone).
 */

/** A card this candidate might belong to, and the mechanical reason it might. */
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
  /** Cards already carrying this exact link. Non-empty means there is nothing to do. */
  linkedTo?: string[];
  /** Cards whose `source_fingerprint` is this candidate's. */
  capturedAs?: string[];
  /** Cards this might be more work on, most likely first. */
  matches?: Match[];
}

export interface Candidate {
  channel: string;
  /**
   * Derived from the thing itself, never from its wording, so a re-sweep
   * converges. `ck add --fingerprint` refuses a duplicate on the strength of it.
   */
  fingerprint: string;
  /** In his voice where the source gave one — a commit subject, an opening prompt. */
  title: string;
  /** Links to carry onto the card, provenance first. */
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
   * False when `ck` has no way to reach this channel — Slack and Gmail have no
   * credential here and are fetched by an agent through MCP. The cursor is still
   * ours: one store for "where we got to", whoever did the fetching.
   */
  fetched: boolean;
  /** Why it was not fetched, or what to do instead. */
  note?: string;
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
  records: Map<string, Rec>;
  /** `source_fingerprint` → card ids. */
  fingerprints: Map<string, string[]>;
  /** A link's raw text → card ids carrying it. */
  links: Map<string, string[]>;
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
