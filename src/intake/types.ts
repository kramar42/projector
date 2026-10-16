import type { DatabaseSync } from 'node:sqlite';
import type { Note } from '../schema/types.ts';
import type { ConnectorEvent } from './connectors.ts';

/**
 * Intake: what has happened elsewhere that the vault does not know about — and
 * what has moved on the things it does know about.
 *
 * The mirror image of enrichment. Enrichment is given a ref and returns how to
 * display it; intake is given what the kernel's connectors gathered and returns
 * refs nobody has filed yet, plus refs somebody has filed whose source has
 * changed since. Neither imports the other.
 *
 * **Intake gathers nothing.** The connectors do (`bin/kernel sync <connector>`,
 * run by the owner), and intake reads their events back from the kernel
 * (`connectors.ts`), turns each into a candidate with the vault's evidence beside
 * it (`run.ts`), and judges it. Everything before the judge is deterministic fact
 * or provenance. Whether a candidate deserves a note, and what the note says,
 * belongs to `classify.ts`; whether it was right belongs to whoever walks the
 * queue (C8: what is computed is computed, what is decided is decided by someone).
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
 * What a judgment cost, when the transport can say.
 *
 * Recorded because an unattended pass that spends two minutes and forty thousand
 * tokens looks exactly like one that spent two seconds, and the poller is the one
 * thing here that runs whether or not anyone is watching the bill.
 */
export interface Cost {
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Agent turns, when the transport counts them. */
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
  /** ISO, when the source has one: when the connector event happened. */
  when?: string;
  /** One line of context, shown under the title. */
  detail?: string;
  fields?: { k: string; v: string }[];
  evidence?: Evidence;
  /**
   * The connector event this candidate is, as the kernel holds it: what its
   * judgment is recorded against (`intake:<its key>`) and carried, whole, as the
   * evidence of that intake event.
   */
  event?: ConnectorEvent;
}

/** Something the channel saw and is deliberately not proposing, with the reason. */
export interface Skipped {
  fingerprint: string;
  title: string;
  why: string;
  /** The connector event skipped, so the pass records that it looked. */
  event?: ConnectorEvent;
}

/**
 * The vault, read once for a whole pass: every channel wants the same things out
 * of it — which fingerprints exist, which links exist, and the full-text index.
 */
export interface IntakeContext {
  root: string;
  db: DatabaseSync;
  notes: Map<string, Note>;
  /** `source_fingerprint` → note ids. */
  fingerprints: Map<string, string[]>;
  /** A link's raw text → note ids carrying it. */
  links: Map<string, string[]>;
  /** Fingerprints somebody already judged as "not a note". */
  suppressed: Set<string>;
}
