import { ago } from './run.ts';
import { unavailable, type Enrichment, type Fetcher, type Tone } from './types.ts';

/**
 * Jira, read-only, via the REST API.
 *
 * Needs credentials the app cannot obtain for itself, so it degrades to a clear
 * "not configured" rather than failing: set `COCKPIT_JIRA_URL`,
 * `COCKPIT_JIRA_EMAIL` and `COCKPIT_JIRA_TOKEN` (an Atlassian API token) to turn
 * it on. Only GET is ever issued.
 */

interface JiraConfig {
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

/**
 * Colour a status without depending on workflow names.
 *
 * A Jira project may name its statuses anything — "in review", "Preparation", "Won't do" —
 * so matching on names would mis-colour most of them. `statusCategory.key` is
 * Jira's stable three-way split and travels across every project.
 *
 * One override on top of it: Jira files abandonment under `done`, so "Won't do"
 * would otherwise read as success. An abandoned issue is not a green one.
 */
const ABANDONED = /won'?t\s*do|wontfix|cancel|reject|duplicate|obsolete|invalid/i;

export function statusTone(name: string, category: string | undefined): Tone {
  if (ABANDONED.test(name)) return 'neutral';
  switch (category) {
    case 'done':
      return 'good';
    case 'indeterminate':
      return 'warn';
    case 'new':
      return 'neutral';
    default:
      return 'neutral';
  }
}

interface IssueJson {
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

export const jiraFetcher: Fetcher = {
  ttl: 900,
  async fetch(ref) {
    const cfg = jiraConfig();
    if (!cfg) {
      return unavailable(
        'Jira is not configured — set COCKPIT_JIRA_URL, COCKPIT_JIRA_EMAIL and COCKPIT_JIRA_TOKEN',
        true,
      );
    }
    const key = ref.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return unavailable(`"${ref}" is not an issue key`);

    const auth = Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
    const fields = 'summary,status,issuetype,priority,assignee,updated,parent';
    let res: Response;
    try {
      res = await fetch(`${cfg.url}/rest/api/3/issue/${key}?fields=${fields}`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (err) {
      return unavailable(`could not reach Jira: ${(err as Error).message}`);
    }
    if (res.status === 404) return unavailable(`${key} not found, or not visible to this account`);
    if (res.status === 401 || res.status === 403) {
      return unavailable('Jira rejected the credentials', true);
    }
    if (!res.ok) return unavailable(`Jira returned ${res.status}`);

    const issue = (await res.json()) as IssueJson;
    const status = issue.fields.status?.name ?? '';
    const badges = [];
    if (status) {
      badges.push({ label: status, tone: statusTone(status, issue.fields.status?.statusCategory?.key) });
    }
    if (issue.fields.issuetype?.name) {
      badges.push({ label: issue.fields.issuetype.name, tone: 'neutral' as Tone });
    }

    return {
      label: issue.key,
      title: issue.fields.summary ?? '',
      badges,
      fields: [
        { k: 'assignee', v: issue.fields.assignee?.displayName ?? 'unassigned' },
        { k: 'priority', v: issue.fields.priority?.name ?? '' },
        { k: 'updated', v: ago(issue.fields.updated) },
        {
          k: 'epic',
          v: issue.fields.parent?.key
            ? `${issue.fields.parent.key} ${issue.fields.parent.fields?.summary ?? ''}`.trim()
            : '',
        },
      ].filter((f) => f.v),
      url: `${cfg.url}/browse/${issue.key}`,
    } satisfies Enrichment;
  },
};
