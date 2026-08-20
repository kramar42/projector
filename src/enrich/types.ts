/**
 * Enrichment is strictly additive. Nothing in the card model, the index, the
 * boards or the canvas depends on it: a link renders as its raw ref, and an
 * enrichment — when one arrives — replaces that with something richer. If every
 * fetcher here were deleted the app would behave exactly as it did in P2.
 */

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

export interface Badge {
  label: string;
  tone: Tone;
}

/**
 * One generic display shape for every kind, so the client renders a Jira issue,
 * a pull request and a Claude session through the same component. A fetcher
 * decides what is worth showing; the UI stays ignorant of the source.
 */
export interface Enrichment {
  /** Short primary label — issue key, PR number, session name. */
  label: string;
  /** The human-readable line: summary, PR title, session opening prompt. */
  title?: string;
  badges?: Badge[];
  /** Small key/value details shown when a link is expanded. */
  fields?: { k: string; v: string }[];
  /** Where to open it, when there is somewhere to open. */
  url?: string;
  /** A shell command that continues or inspects it, shown for copying. */
  command?: string;
}

export interface Fetcher {
  /** Seconds before a cached value is considered stale. 0 means never refetch. */
  ttl: number;
  /**
   * Resolve a ref. Must be read-only and must not throw for an ordinary
   * failure — return `Unavailable` so the reason can be cached and shown.
   */
  fetch(ref: string): Promise<Enrichment | Unavailable>;
}

/** A fetch that could not produce data, with a reason worth showing the user. */
export interface Unavailable {
  unavailable: true;
  reason: string;
  /** True when the cause is missing configuration rather than a failure. */
  needsSetup?: boolean;
}

export function unavailable(reason: string, needsSetup = false): Unavailable {
  return { unavailable: true, reason, needsSetup };
}

export function isUnavailable(v: Enrichment | Unavailable): v is Unavailable {
  return (v as Unavailable).unavailable === true;
}
