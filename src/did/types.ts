/**
 * `pj did`: what you actually did on one day, gathered from the places work
 * leaves a trace.
 *
 * Intake read backwards. Intake asks what happened elsewhere that the vault
 * does not know about yet; this asks what *you* did between two midnights. So
 * there is no cursor, no watermark and nothing written — a day is a fixed
 * window, and asking about it twice gives the same answer.
 *
 * **Sources gather; they never judge** (C8, the same split intake keeps). Every
 * field here is a fact copied or computed from a source. Which facts amount to
 * one task, what the task was, and whether it finished belongs to whoever reads
 * the report — the `pj-did` skill, in practice — and it cites these rows.
 */

/** One trace of your own work. */
export interface Activity {
  source: string;
  /** ISO. When it happened, in the source's own clock. */
  at: string;
  /** What sort of trace: `commit`, `session`, `transition`, `comment`… — per source. */
  kind: string;
  /** In your words where the source has them: a commit subject, a prompt, an issue summary. */
  title: string;
  /** A link a reader can follow back to the source, in the vault's link syntax. */
  ref?: string;
  /** The container: a repo, a working directory, an issue key. */
  where?: string;
  /** Anything else worth reading, as short lines. */
  detail?: string[];
  /** Vault notes this is mechanically about, strongest reason first. */
  notes?: { id: string; why: string }[];
}

export interface SourceReport {
  source: string;
  /** False when the source could not be reached; `reason` says why. */
  fetched: boolean;
  reason?: string;
  activities: Activity[];
}

export interface DidReport {
  /** `YYYY-MM-DD`, local. */
  day: string;
  /** ISO bounds of the local day, end exclusive. */
  start: string;
  end: string;
  /** Where "work" was looked for — stated, so a missing repo is visible rather than silent. */
  scope: { roots: string[]; repos: string[] };
  sources: SourceReport[];
}
