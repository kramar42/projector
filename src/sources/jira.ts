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
 * Set `COCKPIT_JIRA_URL`, `COCKPIT_JIRA_EMAIL` and `COCKPIT_JIRA_TOKEN` (an
 * Atlassian API token) to turn it on. Only GET is ever issued (C2).
 */

export interface JiraConfig {
  url: string;
  email: string;
  token: string;
}

export function jiraConfig(): JiraConfig | null {
  const url = process.env.COCKPIT_JIRA_URL?.replace(/\/+$/, '');
  const email = process.env.COCKPIT_JIRA_EMAIL;
  const token = process.env.COCKPIT_JIRA_TOKEN;
  return url && email && token ? { url, email, token } : null;
}

export const JIRA_UNCONFIGURED =
  'Jira is not configured — set COCKPIT_JIRA_URL, COCKPIT_JIRA_EMAIL and COCKPIT_JIRA_TOKEN';

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
  path: string,
  params: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<JiraResult<T>> {
  const cfg = jiraConfig();
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

/** The base of a browse URL, for links. Null when unconfigured. */
export function jiraBrowse(key: string): string | null {
  const cfg = jiraConfig();
  return cfg ? `${cfg.url}/browse/${key}` : null;
}
