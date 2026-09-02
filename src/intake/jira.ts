import { ISSUE_FIELDS, jiraBrowse, jiraGet, jqlDate, type IssueJson } from '../sources/jira.ts';
import { ago } from '../sources/run.ts';
import { settingsFor } from '../settings.ts';
import { loadFacets } from '../schema/facets.ts';
import { paths } from '../config.ts';
import { isClosed } from '../index/blocking.ts';
import { seenState } from './db.ts';
import { evidenceFor } from './match.ts';
import type { Candidate, Channel, ChannelReport, Match, Skipped } from './types.ts';

/**
 * Issues that moved and have something to do with you.
 *
 * The discovery half of the same credential enrichment uses to resolve a key it
 * was handed. Note what is *not* filtered out: a Done issue assigned to you
 * often still needs something — verify it in prod, tell someone, close the loop —
 * so status arrives as a field and the skill decides. Filtering here would be
 * deciding, quietly.
 *
 * **An issue a note already tracks is not skipped; it is an update.** It used to
 * be, which left the vault unable to hear that a ticket it was waiting on had
 * moved to Done. Now the channel compares the issue's status and assignee with
 * the state it was last examined in (`seen`, in `db.ts`) and offers the change
 * as a candidate that can only extend the tracking note — the classifier decides
 * whether the move means anything for the note, and the fold dialog asks before
 * a facet changes. An issue tracked only by a closed note is skipped for good:
 * finished work does not reopen because Jira ticked.
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
async function searchIssues(root: string, jql: string, max: number) {
  const params = { jql, fields: ISSUE_FIELDS, maxResults: String(max) };
  const modern = await jiraGet<SearchJson>(root, '/rest/api/3/search/jql', params);
  if (modern.ok || (modern.status !== 404 && modern.status !== 410)) return modern;
  return jiraGet<SearchJson>(root, '/rest/api/3/search', params);
}

export const jiraChannel: Channel = {
  name: 'jira',
  defaultDays: 7,

  async collect(ctx): Promise<ChannelReport> {
    const jql = settingsFor(ctx.root).jql || defaultJql(ctx.since);
    const res = await searchIssues(ctx.root, jql, Math.max(ctx.limit * 2, 20));

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
    const defs = loadFacets(paths(ctx.root).facets);

    for (const issue of res.data.issues ?? []) {
      if (candidates.length >= ctx.limit) {
        truncated = true;
        break;
      }
      const key = issue.key;
      const fingerprint = `jira:${key}`;
      const updated = issue.fields.updated;
      if (updated && (!examinedTo || updated > examinedTo)) examinedTo = updated;

      const summary = issue.fields.summary ?? '';
      const status = issue.fields.status?.name ?? '';
      const assignee = issue.fields.assignee?.displayName ?? 'unassigned';
      // What "moved" means for an issue. Comments and description edits bump
      // `updated` too, and are not fetched, so they cannot count.
      const state = { key: fingerprint, value: `${status} · ${assignee}` };
      const evidence = evidenceFor(ctx, {
        fingerprint,
        links: [fingerprint],
        text: `${key} ${summary}`,
      });
      const fields = [
        { k: 'key', v: key },
        { k: 'status', v: status },
        { k: 'assignee', v: assignee },
        { k: 'updated', v: ago(updated) },
        { k: 'epic', v: issue.fields.parent?.key ?? '' },
        { k: 'url', v: jiraBrowse(ctx.root, key) ?? '' },
      ].filter((f) => f.v);

      const tracking = [...new Set([...(evidence.linkedTo ?? []), ...(evidence.capturedAs ?? [])])];
      const tracked = tracking.filter((id) => !isClosed(ctx.notes.get(id), defs));
      if (tracked.length) {
        const before = seenState(ctx.root, state.key);
        if (before === state.value) {
          skipped.push({
            fingerprint,
            title: `${key} ${summary}`.trim(),
            why: `already on ${tracked.join(', ')}; unchanged since last seen (${state.value})`,
          });
          continue;
        }
        const matches: Match[] = tracked.map((id) => ({ id, title: ctx.notes.get(id)?.title ?? id, why: 'tracked' }));
        for (const m of evidence.matches ?? []) if (!matches.some((x) => x.id === m.id)) matches.push(m);
        candidates.push({
          channel: 'jira',
          // Per update, so each move is its own offer and its own decline; the
          // stable key travels in `state` and as the link.
          fingerprint: `${fingerprint}@${updated ?? state.value}`,
          title: summary || key,
          links: [fingerprint],
          when: updated,
          detail:
            `${[key, status, issue.fields.issuetype?.name].filter(Boolean).join(' · ')} — tracked by ${tracked.join(', ')}` +
            (before ? `, was ${before}` : ', first look since it was filed'),
          fields: [
            ...fields,
            { k: 'tracked_as', v: tracked.join(', ') },
            ...(before ? [{ k: 'was', v: before }] : []),
          ],
          evidence: { linkedTo: tracked, matches },
          state,
        });
        continue;
      }
      if (tracking.length) {
        skipped.push({
          fingerprint,
          title: `${key} ${summary}`.trim(),
          why: `already on ${tracking.join(', ')}, which is closed`,
        });
        continue;
      }

      candidates.push({
        channel: 'jira',
        fingerprint,
        title: summary || key,
        links: [fingerprint],
        when: updated,
        detail: [key, status, issue.fields.issuetype?.name].filter(Boolean).join(' · '),
        fields,
        evidence,
        state,
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
