import { branchFetcher, commitFetcher, prFetcher } from './github.ts';
import { sessionFetcher } from './claudeSession.ts';
import { docFetcher } from './doc.ts';
import { jiraFetcher } from './jira.ts';
import { unavailable, type Fetcher } from './types.ts';

/**
 * Which link kinds can be enriched.
 *
 * A kind absent from here simply renders as its raw ref, which is what every
 * kind did before P3 — so adding enrichment for one never changes another, and
 * removing this whole directory would leave the app working as it did in P2.
 */
export function registry(dataRoot: string): Record<string, Fetcher> {
  return {
    jira: jiraFetcher,
    'gh:pr': prFetcher,
    'gh:branch': branchFetcher,
    'gh:commit': commitFetcher,
    claude: sessionFetcher,
    doc: docFetcher(dataRoot),
    // `slack` and bare urls stay as parsed labels. Slack is the one kind kept
    // without a fetcher: it is common enough to be worth resolving one day, and
    // a slack: ref is not interchangeable with the permalink it wraps.
  };
}

/** Kinds with no fetcher, listed so the UI can say why rather than look broken. */
export const NOT_ENRICHED: Record<string, string> = {
  slack: 'Slack links open in Slack; no fetcher yet',
  url: 'plain link',
};

export const unknownKind = (kind: string) => unavailable(`no fetcher for "${kind}"`);
