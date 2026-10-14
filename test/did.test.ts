import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { parseDay, within } from '../src/did/day.ts';
import { branchOf, parseCommits } from '../src/did/git.ts';
import { daySession, typed } from '../src/did/claude.ts';
import { adfText, changeLine } from '../src/did/jira.ts';
import { inScope, reposUnder } from '../src/did/scope.ts';
import { did } from '../src/did/run.ts';
import { place } from './fixture.ts';

/**
 * `pj did` is a fixed window over sources that are already there, so what is
 * worth pinning is the window and the identity: the right day, your work and
 * nobody else's, and one piece of work counted once however many clones reach it.
 */

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

function commitAs(repo: string, email: string, when: Date, message: string): void {
  const file = join(repo, `f${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(file, message, 'utf8');
  git(repo, ['add', file]);
  const iso = when.toISOString();
  git(repo, ['-c', `user.email=${email}`, '-c', 'user.name=X', 'commit', '-qm', message], {
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  });
}

function repoAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

test('a day is local, half-open, and refuses what the calendar does not have', () => {
  const now = new Date(2026, 8, 25, 14, 0);
  const today = parseDay('today', now);
  assert.ok(!('error' in today));
  assert.equal(today.day, '2026-09-25');
  assert.equal(today.start.getHours(), 0);
  const y = parseDay('yesterday', now);
  assert.ok(!('error' in y) && y.day === '2026-09-24');
  const first = parseDay('2026-03-01', now);
  assert.ok(!('error' in first) && first.end.getDate() === 2);
  assert.ok('error' in parseDay('2026-02-30', now));
  assert.ok('error' in parseDay('last tuesday', now));
  // End exclusive: midnight belongs to the next day.
  assert.equal(within(today.end.toISOString(), today), false);
  assert.equal(within(today.start.toISOString(), today), true);
});

test('commit records survive bodies with blank lines, and a source ref names its branch', () => {
  const out =
    '\u001eabc\u001f2026-09-25T10:00:00+02:00\u001ffeat: x\u001fline one\n\nSigned-off-by: A\n\u001frefs/remotes/origin/feat/x\n' +
    '\u001edef\u001f2026-09-25T11:00:00+02:00\u001ffix: y\u001f\u001frefs/heads/main\n';
  const commits = parseCommits(out);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.body, 'line one\n\nSigned-off-by: A');
  assert.equal(branchOf(commits[0]!.ref), 'feat/x');
  assert.equal(branchOf(commits[1]!.ref), 'main');
});

test('repos are found under a root without descending into one or into build output', () => {
  const root = mkdtempSync(join(tmpdir(), 'pj-did-scope-'));
  try {
    repoAt(join(root, 'a'));
    repoAt(join(root, 'a', 'nested'));
    repoAt(join(root, 'group', 'b'));
    repoAt(join(root, 'node_modules', 'dep'));
    assert.deepEqual(reposUnder(root).map((p) => p.slice(root.length + 1)).sort(), ['a', 'group/b']);
    const scope = { roots: [root], repos: [] };
    assert.equal(inScope(scope, join(root, 'group')), true);
    assert.equal(inScope(scope, tmpdir()), false);
    // The app's own headless sessions are not anybody's work.
    assert.equal(inScope(scope, join(root, 'vault', '.projector', 'x')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git: your commits on the day, once, however many clones and cherry-picks reach them', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pj-did-git-'));
  try {
    const work = join(base, 'work');
    const vault = join(base, 'vault');
    mkdirSync(paths(vault).config, { recursive: true });
    writeFileSync(
      join(paths(vault).config, 'config.yaml'),
      `git: { author: me@x }\ndid: { roots: [${work}] }\n`,
      'utf8',
    );
    const day = parseDay('today');
    assert.ok(!('error' in day));
    const noon = new Date(day.start.getTime() + 12 * 3600_000);
    const before = new Date(day.start.getTime() - 3600_000);

    const repo = repoAt(join(work, 'svc'));
    commitAs(repo, 'me@x', before, 'yesterday, not today');
    commitAs(repo, 'me@x', noon, 'feat: mine today');
    commitAs(repo, 'them@x', noon, 'theirs today');
    git(repo, ['checkout', '-qb', 'release']);
    git(repo, ['reset', '-q', '--hard', 'HEAD~2']);
    const sha = git(repo, ['rev-parse', 'main~1']).trim();
    git(repo, ['-c', 'user.email=me@x', '-c', 'user.name=X', 'cherry-pick', sha], { GIT_COMMITTER_DATE: new Date().toISOString() });
    // A second clone reaches the same shas through its remote.
    execFileSync('git', ['clone', '-q', repo, join(work, 'svc-twin')]);

    const r = await did(vault, day, ['git']);
    const titles = r.sources[0]!.activities.map((a) => a.title);
    assert.deepEqual(titles, ['feat: mine today']);
    assert.equal(r.scope.repos.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('git: a repo that cannot be opened says so by its path, not as a missing user.email', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pj-did-git-'));
  try {
    const work = join(base, 'work');
    const vault = join(base, 'vault');
    mkdirSync(paths(vault).config, { recursive: true });
    // No `git.author`: each repo's own user.email is the author.
    writeFileSync(join(paths(vault).config, 'config.yaml'), `did: { roots: [${work}] }\n`, 'utf8');
    const day = parseDay('today');
    assert.ok(!('error' in day));

    const repo = repoAt(join(work, 'infra'));
    git(repo, ['config', 'user.email', 'me@x']);
    commitAs(repo, 'me@x', new Date(day.start.getTime() + 12 * 3600_000), 'fix: mine today');
    // A submodule moved out of its superproject: `.git` is a file pointing nowhere.
    const orphan = join(work, 'archive', 'old', 'infra');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, '.git'), 'gitdir: ../.git/modules/bluerock-infra\n', 'utf8');

    const r = await did(vault, day, ['git']);
    const source = r.sources[0]!;
    assert.deepEqual(source.activities.map((a) => a.title), ['fix: mine today']);
    assert.equal(source.reason, 'could not read archive/old/infra (not a git repository)');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('vault: a note closed today reads as closed against its last commit, even uncommitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pj-did-vault-'));
  try {
    mkdirSync(paths(root).config, { recursive: true });
    writeFileSync(paths(root).facets, 'status: { values: [active, done], single: true, closed: [done] }\n', 'utf8');
    git(root, ['init', '-q']);
    const day = parseDay('today');
    assert.ok(!('error' in day));
    const note = (id: string, status: string, stamps: string) =>
      writeFileSync(
        place(root, `${id}.md`),
        `---\nid: ${id}\ntitle: ${id} title\nfacets: { status: [${status}] }\n${stamps}---\n`,
        'utf8',
      );
    note('ship', 'active', 'created: 2026-01-01\nupdated: 2026-01-01\n');
    note('idle', 'active', 'created: 2026-01-01\nupdated: 2026-01-01\n');
    git(root, ['add', '-A']);
    const before = new Date(day.start.getTime() - 3600_000).toISOString();
    git(root, ['-c', 'user.email=me@x', '-c', 'user.name=X', 'commit', '-qm', 'seed'], {
      GIT_AUTHOR_DATE: before,
      GIT_COMMITTER_DATE: before,
    });
    note('ship', 'done', `created: 2026-01-01\nupdated: ${day.day}\n`);
    note('fresh', 'active', `created: ${day.day}\nupdated: ${day.day}\n`);
    // Written before today and never committed: edited today, not created today.
    note('draft', 'active', `created: 2026-01-02\nupdated: ${day.day}\n`);

    const r = await did(root, day, ['vault']);
    const got = r.sources[0]!.activities.map((a) => [a.kind, a.ref]);
    assert.deepEqual(got, [
      ['note-closed', 'ship'],
      ['note-created', 'fresh'],
      ['note-edited', 'draft'],
    ]);
    assert.deepEqual(r.sources[0]!.activities[0]!.detail, ['status: active → done']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session prompt is what a person typed, never the harness', () => {
  assert.equal(typed('fix the build'), 'fix the build');
  assert.equal(typed('<command-name>/pj-did</command-name><command-args></command-args>'), '/pj-did');
  assert.equal(typed('<command-name>/compact</command-name>'), null);
  assert.equal(typed('/compact'), null);
  assert.equal(typed('<bash-input>git push</bash-input><bash-stdout>ok</bash-stdout>'), '$ git push');
  assert.equal(typed('<task-notification><task-id>x</task-id></task-notification>'), null);
  assert.equal(typed('This session is being continued from a previous conversation that ran out of context.'), null);
});

test('claude: only the day’s turns of a session count, and only sessions in scope', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pj-did-claude-'));
  const prior = process.env.PROJECTOR_CLAUDE_HOME;
  try {
    const work = join(base, 'work');
    mkdirSync(join(work, 'svc'), { recursive: true });
    const vault = join(base, 'vault');
    mkdirSync(paths(vault).config, { recursive: true });
    writeFileSync(join(paths(vault).config, 'config.yaml'), `did: { roots: [${work}] }\n`, 'utf8');
    const home = join(base, 'claude');
    mkdirSync(join(home, 'projects', 'p'), { recursive: true });
    process.env.PROJECTOR_CLAUDE_HOME = home;

    const day = parseDay('today');
    assert.ok(!('error' in day));
    const at = (h: number) => new Date(day.start.getTime() + h * 3600_000).toISOString();
    const cwd = join(work, 'svc');
    const user = (h: number, content: unknown, extra: object = {}) =>
      JSON.stringify({ type: 'user', timestamp: at(h), cwd, gitBranch: 'feat/x', message: { content }, ...extra });
    const lines = [
      user(-3, 'yesterday\'s ask'),
      JSON.stringify({ type: 'custom-title', customTitle: 'Fix the build' }),
      user(9, 'fix the build'),
      user(9.1, [{ type: 'tool_result', content: 'ok' }]),
      user(9.2, 'Caveat: harness text', { isMeta: true }),
      user(9.3, 'a subagent prompt', { isSidechain: true }),
      JSON.stringify({
        type: 'assistant',
        timestamp: at(9.4),
        cwd,
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/w/svc/a.ts' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            { type: 'text', text: 'Fixed: the build passes.' },
          ],
        },
      }),
    ];
    writeFileSync(join(home, 'projects', 'p', 's1.jsonl'), lines.join('\n') + '\n', 'utf8');
    const elsewhere = JSON.stringify({ type: 'user', timestamp: at(10), cwd: tmpdir(), message: { content: 'personal' } });
    writeFileSync(join(home, 'projects', 'p', 's2.jsonl'), elsewhere + '\n', 'utf8');

    const s = daySession(join(home, 'projects', 'p', 's1.jsonl'), day);
    assert.deepEqual(s.prompts, ['fix the build']);
    assert.deepEqual(s.files, ['/w/svc/a.ts']);
    assert.equal(s.toolCalls, 2);
    assert.equal(s.lastWord, 'Fixed: the build passes.');

    const r = await did(vault, day, ['claude']);
    const src = r.sources[0]!;
    assert.deepEqual(src.activities.map((a) => [a.title, a.ref]), [['Fix the build', 'claude:s1']]);
    assert.match(src.reason ?? '', /1 session\(s\) outside/);
  } finally {
    if (prior === undefined) delete process.env.PROJECTOR_CLAUDE_HOME;
    else process.env.PROJECTOR_CLAUDE_HOME = prior;
    rmSync(base, { recursive: true, force: true });
  }
});

test('jira text: document format flattens to a sentence, long fields say only that they changed', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Ann' } }, { type: 'text', text: ' is it ' }, { type: 'text', text: 'fixed?' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
    ],
  };
  assert.equal(adfText(doc), '@Ann is it fixed? second');
  assert.equal(changeLine({ field: 'status', fromString: 'Open', toString: 'Done' }), 'status: Open → Done');
  assert.equal(changeLine({ field: 'description', fromString: 'a', toString: 'b' }), 'edited description');
});

test('jira: only what you authored inside the day survives the nomination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pj-did-jira-'));
  mkdirSync(paths(root).config, { recursive: true });
  const env = { PROJECTOR_JIRA_URL: 'https://j.example', PROJECTOR_JIRA_EMAIL: 'me@x', PROJECTOR_JIRA_TOKEN: 't' };
  const prior = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const realFetch = globalThis.fetch;
  const day = parseDay('today');
  assert.ok(!('error' in day));
  const at = (h: number) => new Date(day.start.getTime() + h * 3600_000).toISOString();
  const me = { accountId: 'me' };
  const them = { accountId: 'them' };
  const asked: string[] = [];
  const routes: Record<string, unknown> = {
    '/rest/api/3/myself': me,
    '/rest/api/3/search/jql': {
      issues: [
        { key: 'A-1', fields: { summary: 'Fix it', status: { name: 'Done' }, created: at(-48) } },
        { key: 'B-2', fields: { summary: 'Theirs', status: { name: 'Open' }, created: at(-48) } },
        { key: 'C-3', fields: { summary: 'New one', issuetype: { name: 'Bug' }, created: at(8), creator: me } },
      ],
    },
    '/rest/api/3/issue/A-1/changelog': {
      total: 2,
      values: [
        { created: at(-20), author: me, items: [{ field: 'status', fromString: 'Open', toString: 'In Progress' }] },
        { created: at(10), author: me, items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] },
      ],
    },
    '/rest/api/3/issue/A-1/comment': {
      comments: [
        { created: at(11), author: them, body: 'thanks' },
        { created: at(-10), author: me, body: 'yesterday' },
      ],
    },
    '/rest/api/3/issue/B-2/changelog': { total: 1, values: [{ created: at(9), author: them, items: [{ field: 'status' }] }] },
  };
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    const body = routes[url.pathname] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const r = await did(root, day, ['jira']);
    const rows = r.sources[0]!.activities;
    assert.deepEqual(rows.map((a) => [a.kind, a.title]), [
      ['created', 'C-3 New one'],
      ['transition', 'A-1 Fix it'],
    ]);
    assert.deepEqual(rows[1]!.detail!.map((d) => d.slice(6)), ['status: In Progress → Done']);
    assert.equal(rows[1]!.ref, 'https://j.example/browse/A-1');
    assert.ok(asked.every((p) => p.startsWith('/rest/api/3/')), 'only reads');
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
