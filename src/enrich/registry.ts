import { branchFetcher, commitFetcher, prFetcher } from './github.ts';
import { sessionFetcher, workspaceFetcher } from './claudeSession.ts';
import { docFetcher } from './doc.ts';
import { jiraFetcher } from './jira.ts';
import { enrichEnabled } from '../settings.ts';
import type { Fetcher } from './types.ts';

/**
 * Which link kinds can be enriched.
 *
 * A kind absent from here simply renders as its raw ref, which is what every
 * kind did before P3 — so adding enrichment for one never changes another, and
 * removing this whole directory would leave the app working as it did in P2.
 *
 * A vault may also turn kinds off in `.projector/config.yaml`, and a kind it
 * withholds is dropped here rather than stubbed: the absent-kind path already
 * renders the raw ref, so switching one off reaches code that has always been
 * exercised instead of a second way of being unavailable.
 */
export function registry(dataRoot: string): Record<string, Fetcher> {
  const all: Record<string, Fetcher> = {
    jira: jiraFetcher(dataRoot),
    'gh:pr': prFetcher,
    'gh:branch': branchFetcher,
    'gh:commit': commitFetcher,
    claude: sessionFetcher,
    workspace: workspaceFetcher,
    doc: docFetcher(dataRoot),
    // `slack` and bare urls stay as parsed labels. Slack is the one kind kept
    // without a fetcher: it is common enough to be worth resolving one day, and
    // a slack: ref is not interchangeable with the permalink it wraps.
  };
  return Object.fromEntries(
    Object.entries(all).filter(([kind]) => enrichEnabled(dataRoot, kind)),
  );
}

/** Kinds with no fetcher, listed so the UI can say why rather than look broken. */
export const NOT_ENRICHED: Record<string, string> = {
  slack: 'Slack links open in Slack; no fetcher yet',
  url: 'plain link',
};

