import { settingsFor } from '../settings.ts';
/**
 * Jira, read-only: the credential and the GET, with no opinion about what is
 * being asked.
 *
 * Two consumers with opposite questions share exactly this much. Enrichment
 * resolves a key it was handed (`/issue/PROJ-303`); intake discovers keys it was
 * not (`/search/jql`). Both need the same token, the same Basic header and the
 * same failure vocabulary — and neither should own the other's store, so what is
 * shared stops here.
 *
 * The credential is the vault's — `.projector/config.yaml`, or the matching
 * `PROJECTOR_JIRA_*` variables, which win. Every entry point therefore takes the
 * vault it is acting for: one server process holds several open, and the wrong
 * token is worse than none. Only GET is ever issued (C2).
 */

export interface JiraConfig {
  url: string;
  email: string;
  token: string;
}

export function jiraConfig(root: string): JiraConfig | null {
  return settingsFor(root).jira;
}

export const JIRA_UNCONFIGURED =
  'Jira is not configured — run `pj setup`, or set PROJECTOR_JIRA_URL, PROJECTOR_JIRA_EMAIL and PROJECTOR_JIRA_TOKEN';

/**
 * A GET that never throws. Callers specialise the message where a status means
 * something particular to them — a 404 on an issue names the key, a 404 on a
 * search means the endpoint moved — so `status` is carried out rather than
 * flattened into prose here.
 */
export type JiraResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; reason: string; needsSetup?: boolean };

export async function jiraGet<T>(
  root: string,
  path: string,
  params: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<JiraResult<T>> {
  const cfg = jiraConfig(root);
  if (!cfg) return { ok: false, reason: JIRA_UNCONFIGURED, needsSetup: true };

  const url = new URL(`${cfg.url}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const auth = Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: `could not reach Jira: ${(err as Error).message}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, reason: 'Jira rejected the credentials', needsSetup: true };
  }
  if (!res.ok) return { ok: false, status: res.status, reason: `Jira returned ${res.status}` };

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: res.status, reason: 'Jira returned something that was not JSON' };
  }
}

/**
 * The fields both consumers read, and the shape they come back in.
 *
 * Here rather than in `enrich/jira.ts` because it describes what a Jira issue
 * *is*, not how one looks on a card — and because intake asking enrichment for
 * the type would be the two importing each other, which is the thing this split
 * exists to prevent.
 */
export const ISSUE_FIELDS = 'summary,status,issuetype,priority,assignee,updated,parent';

export interface IssueJson {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string };
    updated?: string;
    parent?: { key?: string; fields?: { summary?: string } };
  };
}

/**
 * A JQL date literal. Jira reads it in the *account's* timezone, so this formats
 * local time: an ISO string with a Z would silently shift the window by the
 * offset, which on a cursor means either re-proposing or skipping an hour of
 * issues every sweep.
 */
export function jqlDate(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/** The base of a browse URL, for links. Null when unconfigured. */
export function jiraBrowse(root: string, key: string): string | null {
  const cfg = jiraConfig(root);
  return cfg ? `${cfg.url}/browse/${key}` : null;
}
