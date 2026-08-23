import { ISSUE_FIELDS, jiraBrowse, jiraGet, jqlDate, type IssueJson } from '../sources/jira.ts';
import { ago } from '../sources/run.ts';
import { evidenceFor } from './match.ts';
import type { Candidate, Channel, ChannelReport, Skipped } from './types.ts';

/**
 * Issues that moved and have something to do with him.
 *
 * The discovery half of the same credential enrichment uses to resolve a key it
 * was handed. Note what is *not* filtered out: a Done issue assigned to him
 * often still needs something — verify it in prod, tell someone, close the loop —
 * so status arrives as a field and the skill decides. Filtering here would be
 * deciding, quietly.
 */

/**
 * `watcher` rather than anything about mentions: JQL has no "mentions me" field,
 * and being mentioned in Jira makes you a watcher in practice. `ORDER BY updated
 * ASC` because the cursor must advance forward through the window.
 */
function defaultJql(since: Date): string {
  return (
    '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())' +
    ` AND updated >= "${jqlDate(since)}" ORDER BY updated ASC`
  );
}

interface SearchJson {
  issues?: IssueJson[];
}

/**
 * `/search/jql` is the current endpoint; `/search` is the one it replaced and
 * still the only one on Jira Server. Trying the new one first and falling back on
 * a 404 or 410 costs one request in the case that will not happen twice, and
 * saves the sweep going dark on whichever deployment this turns out to be.
 */
async function searchIssues(jql: string, max: number) {
  const params = { jql, fields: ISSUE_FIELDS, maxResults: String(max) };
  const modern = await jiraGet<SearchJson>('/rest/api/3/search/jql', params);
  if (modern.ok || (modern.status !== 404 && modern.status !== 410)) return modern;
  return jiraGet<SearchJson>('/rest/api/3/search', params);
}

export const jiraChannel: Channel = {
  name: 'jira',
  defaultDays: 7,

  async collect(ctx): Promise<ChannelReport> {
    const jql = process.env.PROJECTOR_INTAKE_JQL || defaultJql(ctx.since);
    const res = await searchIssues(jql, Math.max(ctx.limit * 2, 20));

    if (!res.ok) {
      // A cursor is never advanced on a failed fetch: nothing was looked at.
      return {
        channel: 'jira',
        cursor: ctx.cursor,
        nextCursor: null,
        fetched: false,
        reason: res.reason,
        candidates: [],
        skipped: [],
      };
    }

    const candidates: Candidate[] = [];
    const skipped: Skipped[] = [];
    let examinedTo: string | null = null;
    let truncated = false;

    for (const issue of res.data.issues ?? []) {
      if (candidates.length >= ctx.limit) {
        truncated = true;
        break;
      }
      const key = issue.key;
      const fingerprint = `jira:${key}`;
      const updated = issue.fields.updated;
      if (updated && (!examinedTo || updated > examinedTo)) examinedTo = updated;

      const evidence = evidenceFor(ctx, {
        fingerprint,
        links: [fingerprint],
        text: `${key} ${issue.fields.summary ?? ''}`,
      });
      const already = evidence.linkedTo ?? evidence.capturedAs;
      if (already?.length) {
        skipped.push({
          fingerprint,
          title: `${key} ${issue.fields.summary ?? ''}`.trim(),
          why: `already on ${already.join(', ')}`,
        });
        continue;
      }

      candidates.push({
        channel: 'jira',
        fingerprint,
        title: issue.fields.summary ?? key,
        links: [fingerprint],
        when: updated,
        detail: [key, issue.fields.status?.name, issue.fields.issuetype?.name]
          .filter(Boolean)
          .join(' · '),
        fields: [
          { k: 'key', v: key },
          { k: 'status', v: issue.fields.status?.name ?? '' },
          { k: 'assignee', v: issue.fields.assignee?.displayName ?? 'unassigned' },
          { k: 'updated', v: ago(updated) },
          { k: 'epic', v: issue.fields.parent?.key ?? '' },
          { k: 'url', v: jiraBrowse(key) ?? '' },
        ].filter((f) => f.v),
        evidence,
      });
    }

    return {
      channel: 'jira',
      cursor: ctx.cursor,
      nextCursor: examinedTo,
      fetched: true,
      truncated,
      candidates,
      skipped,
    };
  },
};
