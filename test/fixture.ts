import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NOTE_PLACES } from '../src/schema/note.ts';
import { eventId } from '../src/kernel/query.ts';
import type { ConnectorEvent } from '../src/intake/connectors.ts';
import type { KernelBatch } from '../src/intake/kernel.ts';

/**
 * Where a fixture's file lives, from the name a test gives it.
 *
 * Tests name notes the way a person would — `a.md`, `platform/README.md`,
 * `mapping/sub.md` — and this puts each where the required layout keeps that kind
 * of file: a bare note in `notes/`, a folder in `projects/`, and anything already
 * naming a place left as it is. The vault's own `AGENTS.md` and `README.md` stay
 * at the root, because they describe the vault rather than being notes in it.
 *
 * The parent directory is created, so the result can be written to at once.
 */
export function place(root: string, ...segments: string[]): string {
  const rel = segments.join('/');
  const [top] = rel.split('/');
  const full =
    rel === 'AGENTS.md' || rel === 'CLAUDE.md' || rel === 'README.md'
      ? join(root, rel)
      : (NOTE_PLACES as readonly string[]).includes(top!) || top === 'assets' || top === 'memory' || top === '.projector'
        ? join(root, rel)
        : rel.includes('/')
          ? join(root, 'projects', rel)
          : join(root, 'notes', rel);
  mkdirSync(dirname(full), { recursive: true });
  return full;
}

/**
 * Connector events shaped like the kernel's real ones — each connector's key,
 * kind, `about` and payload as its `kernel/export.bb` writes them — for
 * `test/fake-kernel` to answer `projector/connector-events-since` with. Every
 * instant is relative to `base`, so a test can place them inside a window.
 *
 * A session in a declared repo and two that are not this vault's work, two
 * commits on one branch, a Jira issue that moved with its transition (whose key
 * names a changelog entry the payload omits), a Slack DM asked and answered, and
 * one mail.
 */
export const WORK_REPO = '/work/widget';

export interface FixtureEvent {
  key: string;
  kind: string;
  at: string;
  about: string[];
  payload: Record<string, unknown>;
}

export function connectorEvents(base: Date): FixtureEvent[] {
  const at = (minutesBefore: number) => new Date(base.getTime() - minutesBefore * 60_000).toISOString();
  const ts = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;
  const session = (uuid: string, project: string, turns: number, ended: string, title: string): FixtureEvent => ({
    key: `claude:${uuid}@${ended}`,
    kind: 'claude/session',
    at: ended,
    about: [`claude:project:${project}`],
    payload: { session: uuid, turns, ended, project, branch: 'feature/webhooks', started: at(180), title },
  });
  const commit = (sha: string, minutes: number, subject: string): FixtureEvent => ({
    key: `git:widget:${sha}`,
    kind: 'git/commit',
    at: at(minutes),
    about: ['repo:widget'],
    payload: { sha, subject, files: ['src/webhooks.ts'], insertions: 12, deletions: 3, branch: 'feature/webhooks' },
  });
  const asked = at(20);
  const answered = at(10);
  return [
    session('c0ffee00-1111-4222-8333-444455556666', WORK_REPO, 12, at(70), 'Wire the webhook retries'),
    session('c0ffee00-2222-4222-8333-444455556666', '/Users/someone/personal/blog', 5, at(65), 'Fix my blog theme'),
    session('c0ffee00-3333-4222-8333-444455556666', WORK_REPO, 1, at(60), 'what time is it in Lisbon'),
    commit('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 50, 'Retry webhooks with backoff'),
    commit('b1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 40, 'Cap webhook retries at five'),
    {
      key: 'jira:WID-7@In Progress · Olena',
      kind: 'jira/issue',
      at: at(30),
      about: ['jira:WID-7'],
      payload: { key: 'WID-7', summary: 'Rotate the webhook signing secret', status: 'In Progress', assignee: 'Olena', updated: at(30), type: 'Task', url: 'https://example.atlassian.net/browse/WID-7' },
    },
    {
      key: 'jira:WID-7/changelog/10001',
      kind: 'jira/transition',
      at: at(30),
      about: ['jira:WID-7', 'kernel:owner'],
      payload: { key: 'WID-7', from: 'To Do', to: 'In Progress', by: 'kernel:owner' },
    },
    {
      key: `slack:D0123ABCD/${ts(asked)}`,
      kind: 'slack/message',
      at: asked,
      about: ['slack:channel:D0123ABCD'],
      payload: {
        channel: 'D0123ABCD',
        channel_name: 'Vivek',
        ts: ts(asked),
        author: 'Vivek',
        author_id: 'U0VIVEK',
        text: 'Can you review the webhook PR today? Release is tomorrow.',
        to_owner: true,
        mentions_owner: false,
        permalink: `https://acme.slack.com/archives/D0123ABCD/p${ts(asked).replace('.', '')}`,
      },
    },
    {
      key: `slack:D0123ABCD/${ts(answered)}`,
      kind: 'slack/message',
      at: answered,
      about: ['slack:channel:D0123ABCD', 'kernel:owner'],
      payload: { channel: 'D0123ABCD', channel_name: 'Vivek', ts: ts(answered), author: 'kernel:owner', text: 'Will do after lunch', to_owner: false, mentions_owner: false },
    },
    {
      key: 'gmail:18f2a3b4c5d6e7f8@18f2a3b4c5d6e7f9',
      kind: 'gmail/message',
      at: at(5),
      about: ['gmail:thread:18f2a3b4c5d6e7f8'],
      payload: {
        thread: '18f2a3b4c5d6e7f8',
        subject: 'Your October invoice',
        from: 'billing@vendor.example',
        snippet: 'Your invoice for October is attached.',
        labels: ['INBOX'],
        url: 'https://mail.google.com/mail/u/0/#all/18f2a3b4c5d6e7f8',
        message: '18f2a3b4c5d6e7f9',
      },
    },
  ];
}

/**
 * What the kernel answers `connector-events-since` (or `connector-event`) with
 * for these events: one row per event and alias, its id derived from its key as
 * the kernel derives it, its kind a keyword, its instant without milliseconds
 * when they are zero, as the kernel prints them.
 */
export function connectorAnswer(events: FixtureEvent[], query = 'projector/connector-events-since') {
  const rows: unknown[][] = [];
  for (const e of events) {
    const at = e.at.replace(/\.000Z$/, 'Z');
    for (const a of e.about.length ? e.about : ['']) rows.push([eventId(e.key), `:${e.kind}`, at, a, e.payload]);
  }
  return { columns: ['event', 'kind', 'at', 'about', 'payload'], rows, count: rows.length, query };
}

/** The instant the shipped fixture, `test/kernel-queries/connector-events-since.json`, is placed against. */
export const FIXTURE_BASE = new Date('2026-10-16T08:00:00.000Z');

/** One fixture event as projector reads it back: its kernel id derived from its key. */
export function asConnectorEvent(e: FixtureEvent): ConnectorEvent {
  return { id: eventId(e.key), kind: e.kind, key: e.kind === 'jira/transition' ? null : e.key, at: e.at, about: [...e.about].sort(), payload: e.payload };
}

/** `test/fake-kernel`, the stand-in for the owner's kernel CLI. */
export const FAKE_KERNEL = fileURLToPath(new URL('./fake-kernel', import.meta.url));

/**
 * Runs `body` with `test/fake-kernel` logging every call and batch, and hands
 * both back. `events`, when given, is what the fake answers
 * `connector-events-since` with instead of the shipped fixture.
 */
export async function againstFake(
  body: (read: () => { calls: string[]; batches: KernelBatch[] }) => Promise<void>,
  env: Record<string, string> = {},
  events?: FixtureEvent[],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pj-fake-kernel-'));
  const log = join(dir, 'log');
  const batches = join(dir, 'batches');
  const keys = ['FAKE_KERNEL_LOG', 'FAKE_KERNEL_BATCHES', 'FAKE_KERNEL_ATTEMPT_FAIL', 'FAKE_KERNEL_FAIL', 'FAKE_KERNEL_QUERIES', 'FAKE_KERNEL_QUERY_FAIL'];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  if (events) {
    mkdirSync(join(dir, 'queries'));
    writeFileSync(join(dir, 'queries', 'connector-events-since.json'), JSON.stringify(connectorAnswer(events)), 'utf8');
  }
  Object.assign(process.env, {
    FAKE_KERNEL_LOG: log,
    FAKE_KERNEL_BATCHES: batches,
    ...(events ? { FAKE_KERNEL_QUERIES: join(dir, 'queries') } : {}),
    ...env,
  });
  const lines = (f: string) => {
    try {
      return readFileSync(f, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  try {
    await body(() => ({ calls: lines(log).map((l) => l.slice(l.indexOf('|') + 1)), batches: lines(batches).map((l) => JSON.parse(l) as KernelBatch) }));
  } finally {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
