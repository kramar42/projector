import { jiraBrowse, jiraGet, jqlDate } from '../sources/jira.ts';
import type { IntakeContext } from '../intake/types.ts';
import { within, type Day } from './day.ts';
import { notesFor } from './scope.ts';
import type { Activity, SourceReport } from './types.ts';

/**
 * What you did in Jira on the day: the changes, comments and worklogs you
 * authored, read off each issue's own history.
 *
 * The search only nominates. `updatedBy()` finds issues you touched, but "touched"
 * includes being the one who got assigned, and an issue's `updated` moves for
 * anyone's edit — so each nominee's changelog, comments and worklogs are read and
 * only entries **authored by you, inside the window** survive. An issue with none
 * is dropped: somebody else's work on your ticket is theirs.
 *
 * Only GET is ever issued (C2), through the same credential intake uses.
 */

interface Author {
  accountId?: string;
  displayName?: string;
}

interface SearchIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    created?: string;
    creator?: Author;
    reporter?: Author;
    parent?: { key?: string; fields?: { summary?: string } };
  };
}

interface History {
  created: string;
  author?: Author;
  items: { field: string; fromString?: string | null; toString?: string | null }[];
}

interface Comment {
  created: string;
  updated?: string;
  author?: Author;
  body?: unknown;
}

interface Worklog {
  started: string;
  author?: Author;
  timeSpent?: string;
  comment?: unknown;
}

const MAX_ISSUES = 60;
/**
 * Jira's own workflow field, which moving an issue changes. Jira's vocabulary,
 * not a vault's — the vault's axes are never named here (C4).
 */
const WORKFLOW_FIELD = /^status$/i;
const COMMENT_CHARS = 280;

/** Plain text out of Atlassian Document Format, or a string passed through. */
export function adfText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'mention') return n.attrs?.text ?? '';
  if (n.type === 'hardBreak') return ' ';
  // Runs inside a paragraph abut; blocks are separated.
  return (n.content ?? []).map(adfText).join(n.type === 'paragraph' || n.type === 'heading' ? '' : ' ');
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

const localTime = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

/** One changelog item as a line. Long-text fields say that they changed, not what to. */
export function changeLine(item: History['items'][number]): string {
  const long = /^(description|comment|environment)$/i.test(item.field);
  if (long) return `edited ${item.field}`;
  const from = item.fromString ?? '';
  const to = item.toString ?? '';
  return `${item.field}: ${from || '(none)'} → ${to || '(none)'}`;
}

async function search(root: string, jql: string) {
  const params = { jql, fields: 'summary,status,issuetype,created,creator,reporter,parent', maxResults: String(MAX_ISSUES) };
  const modern = await jiraGet<{ issues?: SearchIssue[] }>(root, '/rest/api/3/search/jql', params);
  if (modern.ok || (modern.status !== 404 && modern.status !== 410)) return modern;
  return jiraGet<{ issues?: SearchIssue[] }>(root, '/rest/api/3/search', params);
}

/**
 * The changelog entries on or after the day began. The endpoint pages oldest
 * first, so the last page is read and the walk goes backwards until it passes
 * the window's start.
 */
async function historiesSince(root: string, key: string, day: Day): Promise<History[]> {
  const path = `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`;
  const first = await jiraGet<{ total?: number; values?: History[] }>(root, path, { maxResults: '100' });
  if (!first.ok) return [];
  const total = first.data.total ?? first.data.values?.length ?? 0;
  if (total <= 100) return first.data.values ?? [];
  const out: History[] = [];
  for (let start = Math.max(0, total - 100); ; start = Math.max(0, start - 100)) {
    const page = await jiraGet<{ values?: History[] }>(root, path, { startAt: String(start), maxResults: '100' });
    if (!page.ok) break;
    const values = page.data.values ?? [];
    out.unshift(...values);
    const oldest = values[0]?.created;
    if (start === 0 || !oldest || Date.parse(oldest) < day.start.getTime()) break;
  }
  return out;
}

export async function jiraSource(ctx: IntakeContext, day: Day): Promise<SourceReport> {
  const root = ctx.root;
  const me = await jiraGet<{ accountId?: string }>(root, '/rest/api/3/myself');
  if (!me.ok) return { source: 'jira', fetched: false, reason: me.reason, activities: [] };
  const accountId = me.data.accountId;
  const mine = (a?: Author) => !!accountId && a?.accountId === accountId;

  const from = jqlDate(day.start);
  // `updatedBy()` would be the exact nominator, and not every site has it (this
  // author's refuses it with a 400). What every site has is the roles: an issue
  // you changed, commented on or logged time against almost always has you as
  // assignee, reporter or watcher — commenting watches by default — and the
  // per-issue filter below makes a wide net cost requests, not accuracy.
  const found = await search(
    root,
    `updated >= "${from}" AND (assignee = currentUser() OR assignee WAS currentUser() OR reporter = currentUser()` +
      ` OR creator = currentUser() OR watcher = currentUser() OR status CHANGED BY currentUser() AFTER "${from}")` +
      ' ORDER BY updated ASC',
  );
  let reason: string | undefined;
  if (!found.ok) return { source: 'jira', fetched: false, reason: found.reason, activities: [] };
  const issues = found.data.issues ?? [];
  if (issues.length >= MAX_ISSUES) reason = `stopped at ${MAX_ISSUES} issues; an issue you touched beyond them is missing`;

  // A handful at a time: four requests an issue, and sixty issues one after
  // another is a minute of waiting on a day that was busy.
  const rows: (Activity | null)[] = [];
  for (let i = 0; i < issues.length; i += 6) {
    rows.push(...(await Promise.all(issues.slice(i, i + 6).map((issue) => issueActivity(issue)))));
  }
  const activities = rows.filter((a): a is Activity => a !== null);
  activities.sort((a, b) => a.at.localeCompare(b.at));
  return { source: 'jira', fetched: true, reason, activities };

  async function issueActivity(issue: SearchIssue): Promise<Activity | null> {
    const key = issue.key;
    const f = issue.fields;
    const lines: { at: string; text: string }[] = [];
    const kinds = new Set<string>();

    if (within(f.created, day) && (mine(f.creator) || mine(f.reporter))) {
      lines.push({ at: f.created!, text: `created ${f.issuetype?.name ?? 'issue'}` });
      kinds.add('created');
    }
    for (const h of await historiesSince(root, key, day)) {
      if (!mine(h.author) || !within(h.created, day)) continue;
      for (const item of h.items) {
        lines.push({ at: h.created, text: changeLine(item) });
        kinds.add(WORKFLOW_FIELD.test(item.field) ? 'transition' : 'edit');
      }
    }
    const comments = await jiraGet<{ comments?: Comment[] }>(
      root,
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { orderBy: '-created', maxResults: '50' },
    );
    for (const c of comments.ok ? (comments.data.comments ?? []) : []) {
      if (!mine(c.author)) continue;
      const when = within(c.created, day) ? c.created : within(c.updated, day) ? c.updated! : null;
      if (!when) continue;
      lines.push({ at: when, text: `commented: ${clip(adfText(c.body), COMMENT_CHARS)}` });
      kinds.add('comment');
    }
    const worklogs = await jiraGet<{ worklogs?: Worklog[] }>(
      root,
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog`,
      { startedAfter: String(day.start.getTime()), startedBefore: String(day.end.getTime()) },
    );
    for (const w of worklogs.ok ? (worklogs.data.worklogs ?? []) : []) {
      if (!mine(w.author) || !within(w.started, day)) continue;
      const note = clip(adfText(w.comment), COMMENT_CHARS);
      lines.push({ at: w.started, text: `logged ${w.timeSpent ?? 'time'}${note ? `: ${note}` : ''}` });
      kinds.add('worklog');
    }

    if (!lines.length) return null;
    lines.sort((a, b) => a.at.localeCompare(b.at));
    // The strongest kind names the row; every line is still in `detail`.
    const kind = ['transition', 'created', 'comment', 'edit', 'worklog'].find((k) => kinds.has(k))!;
    const parent = f.parent?.key ? `parent: ${f.parent.key} ${f.parent.fields?.summary ?? ''}`.trim() : '';
    return {
      source: 'jira',
      at: lines[0]!.at,
      kind,
      title: `${key} ${f.summary ?? ''}`.trim(),
      ref: jiraBrowse(root, key) ?? `jira:${key}`,
      where: [f.issuetype?.name, f.status?.name ? `now ${f.status.name}` : ''].filter(Boolean).join(' · '),
      detail: [...(parent ? [parent] : []), ...lines.map((l) => `${localTime(l.at)} ${l.text}`)],
      notes: notesFor(ctx, { links: [`jira:${key}`], text: key }),
    };
  }
}
