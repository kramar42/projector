import { ISSUE_FIELDS, jiraBrowse, jiraGet, type IssueJson } from '../sources/jira.ts';
import { ago } from '../sources/run.ts';
import { unavailable, type Enrichment, type Fetcher, type Tone } from './types.ts';

/**
 * A `jira:` ref, resolved for display.
 *
 * The credential and the GET are `src/sources/jira.ts`, shared with intake. What
 * is left here is the mapping to a chip — which is the part enrichment owns and
 * intake has no use for.
 */

/**
 * Colour a status without depending on workflow names.
 *
 * A Jira project may name its statuses anything at all, and most do, so matching
 * on names would mis-colour most of them. `statusCategory.key` is
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

export function jiraFetcher(root: string): Fetcher {
  return {
    ttl: 900,
    async fetch(ref) {
    const key = ref.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return unavailable(`"${ref}" is not an issue key`);

      const res = await jiraGet<IssueJson>(
        root,
        `/rest/api/3/issue/${key}`,
        { fields: ISSUE_FIELDS },
        12_000,
      );
    if (!res.ok) {
      if (res.status === 404) return unavailable(`${key} not found, or not visible to this account`);
      return unavailable(res.reason, res.needsSetup);
    }

    const issue = res.data;
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
        url: jiraBrowse(root, issue.key) ?? undefined,
      } satisfies Enrichment;
    },
  };
}
