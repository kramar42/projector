import { test } from 'node:test';
import assert from 'node:assert/strict';
import { history } from '../src/agent/history.ts';
import { execFileSync } from 'node:child_process';
import {
  addWorktree,
  appleScriptQuote,
  branchFor,
  worktreeBase,
  shellQuote,
  terminalScript,
  workspacePath,
} from '../src/agent/worktree.ts';
import { buildBriefing } from '../src/agent/briefing.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin, } from 'node:path';
import { tmpdir } from 'node:os';


/**
 * What an agent is handed: a card context, a briefing, a workspace, and git history.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

// ---------------------------------------------------------------- agent layer

test('branch name prefers the template, then a lone jira key, then the id', () => {
  assert.equal(branchFor('fix-kpow', { template: 'kc/{card}' }), 'kc/fix-kpow');
  assert.equal(branchFor('fix-kpow', { jiraKeys: ['PROJ-303'] }), 'PROJ-303');
  // Two keys is ambiguous, so fall back to something unambiguous.
  assert.equal(branchFor('fix-kpow', { jiraKeys: ['A-1', 'B-2'] }), 'fix-kpow');
  assert.equal(branchFor('fix-kpow', {}), 'fix-kpow');
});

test('a branch with slashes still makes a legal directory name', () => {
  assert.equal(
    workspacePath('/wt', 'keycloak', 'kc/fix-kpow'),
    '/wt/keycloak-wt-kc-fix-kpow',
  );
});

test('a path with a double quote produces a valid AppleScript literal', () => {
  // Unlike shlex, shellQuote uses the '\'' form and so never emits a double
  // quote of its own — but a path may contain one, and that must not end the
  // AppleScript string early.
  const script = terminalScript('/tmp/we"ird', 'go');
  const body = script.split('\n').find((l) => l.includes('do script'))!;
  const literal = body.slice(body.indexOf('"') + 1, body.lastIndexOf('"'));
  assert.ok(!/(^|[^\\])"/.test(literal), `unescaped quote in: ${literal}`);
  // Unescaping the literal must give back a shell command that quotes the path.
  const unescaped = literal.replace(/\\(["\\])/g, '$1');
  assert.ok(unescaped.includes(shellQuote('/tmp/we"ird')), unescaped);
});

test('an apostrophe round-trips through both quoting layers', () => {
  const script = terminalScript("/tmp/don't", 'go');
  const body = script.split('\n').find((l) => l.includes('do script'))!;
  const literal = body.slice(body.indexOf('"') + 1, body.lastIndexOf('"'));
  // AppleScript unescapes \\ to \, leaving exactly what the shell needs.
  const forShell = literal.replace(/\\\\/g, '\\');
  assert.equal(forShell, `cd ${shellQuote("/tmp/don't")} && claude ${shellQuote('go')}`);
});

test('appleScriptQuote escapes backslashes before quotes', () => {
  assert.equal(appleScriptQuote('a\\b"c'), 'a\\\\b\\"c');
});

test('base branch falls back from declared to origin/HEAD to HEAD', () => {
  const git = (out: Record<string, string>) => (args: string[]) => {
    const key = args.join(' ');
    const hit = Object.entries(out).find(([k]) => key.includes(k));
    return hit ? { ok: true, out: hit[1], err: '' } : { ok: false, out: '', err: 'no' };
  };
  assert.equal(worktreeBase({ path: '/r', base: 'dev' }, git({})), 'dev');
  assert.equal(worktreeBase({ path: '/r' }, git({ 'refs/remotes/origin/HEAD': 'origin/main\n' })), 'origin/main');
  assert.equal(worktreeBase({ path: '/r' }, git({ 'rev-parse --abbrev-ref': 'trunk\n' })), 'trunk');
});

test('a missing repo is reported per repo, never thrown', () => {
  const res = addWorktree({ path: '/definitely/not/here' }, '/wt', 'b', () => ({ ok: true, out: '', err: '' }));
  assert.equal(res.created, false);
  assert.match(res.error ?? '', /repo not found/);
  assert.equal(res.name, 'here');
});

test('worktree prune runs even when the folder already exists', () => {
  // Without the unconditional prune, reopening a hand-deleted workspace fails
  // with "missing but already registered worktree".
  const calls: string[] = [];
  const git = (args: string[]) => {
    calls.push(args.join(' '));
    return { ok: true, out: '', err: '' };
  };
  addWorktree({ path: '/Users' }, '/Users', 'b', git); // /Users/Users won't exist
  assert.ok(calls.some((c) => c === 'worktree prune'), calls.join(' | '));
});

test('the briefing names failed repos as out of scope and stops before building', () => {
  const ctx = {
    id: 'c1', title: 'T', isProject: false, file: 'cards/c1.md',
    facets: {}, body: '', project: null, blockedBy: [],
    refs: {}, inbound: {}, links: [], siblings: [],
  };
  const out = buildBriefing({
    ctx, workspace: '/wt/x', branch: 'b',
    repos: [
      { name: 'ok', path: '/wt/x/ok', created: true, error: null },
      { name: 'bad', path: '/wt/x/bad', created: false, error: 'boom' },
    ],
  });
  assert.match(out, /`ok\/`/);
  assert.match(out, /out of scope[\s\S]*bad.*boom/);
  assert.match(out, /STOP/);
  assert.match(out, /deliberately left out/);
  assert.match(out, /pj link c1 --session/);
});


// ---------------------------------------------------------------- history

test('pj log narrates every single-valued axis, and closed is what finishes', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    mkdirSync(pathJoin(root, 'cards'), { recursive: true });
    // The vocabulary decides what is watched and what "finished" means. Nothing
    // in the log names a facet or a value any more.
    writeFileSync(
      pathJoin(root, 'facets.yaml'),
      'status: { values: [planning, done], single: true, closed: [done] }\n' +
        'due: { type: date, single: true }\n' +
        'tech: { values: [], open: true }\n',
      'utf8',
    );
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 'T');

    const card = pathJoin(root, 'cards', 'ship.md');
    writeFileSync(card, '---\nid: ship\ntitle: Ship\nfacets: { status: [planning] }\n---\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'add ship');

    writeFileSync(
      card,
      '---\nid: ship\ntitle: Ship\nfacets: { status: [done], due: [2026-09-01], tech: [k8s] }\n---\n',
      'utf8',
    );
    git('add', '-A');
    git('commit', '-qm', 'finish ship');

    const r = history(root, '1 year ago');
    assert.deepEqual(r.created, ['ship']);
    // `done` is in `closed`, and that is the whole rule — no value is named here.
    assert.deepEqual(r.finished, ['ship']);
    assert.deepEqual(r.reopened, []);

    // Newest first, and the transition is read from the diff rather than from
    // `updated`, which only ever says that *something* changed.
    const moved = r.commits[0]!.changes.filter((c) => c.kind === 'facet');
    assert.deepEqual(
      moved.map((c) => [c.facet, c.from, c.to]),
      [
        ['status', 'planning', 'done'],
        ['due', null, '2026-09-01'],
      ],
      'both single-valued axes, in declaration order — and `tech` is not one',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

