import { test } from 'node:test';
import assert from 'node:assert/strict';
import { history } from '../src/agent/history.ts';
import { execFileSync } from 'node:child_process';
import { branchFor } from '../src/agent/worktree.ts';
import { workspacePath } from '../src/agent/workspaceName.ts';
import { noteContext } from '../src/agent/context.ts';
import { parseNoteAlias, aboutContext } from '../src/kernel/about.ts';
import { KernelFailed, NoNote, NotWorkable, startWork } from '../src/kernel/worktree.ts';
import type { Runner } from '../src/intake/kernel.ts';
import { sessionsUnder } from '../src/sources/claude.ts';
import { readAll } from '../src/index/indexer.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin, } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { settingsPath } from '../src/settings.ts';
import { place } from './fixture.ts';


/**
 * What an agent is handed: a note context, what projector tells the kernel about
 * a note when work starts, the workspace a note records, and git history.
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

test('every spelling of the id placeholder substitutes, and a typo is refused', () => {
  // `{note}` is what the manual documents; `{card}` and `{id}` predate the
  // card→note rename and templates in the wild still say them.
  assert.equal(branchFor('fix-kpow', { template: 'plat/{note}' }), 'plat/fix-kpow');
  assert.equal(branchFor('fix-kpow', { template: '{id}-wip' }), 'fix-kpow-wip');
  // An unknown placeholder would name a literal `{...}` branch shared by every
  // note in the project — the second note's work would collide with the first.
  assert.throws(() => branchFor('fix-kpow', { template: 'plat/{ntoe}' }), /\{ntoe\}/);
});

test('a legacy workspace name still makes a legal directory name from a branch with slashes', () => {
  assert.equal(
    workspacePath('/wt', 'keycloak', 'kc/fix-kpow'),
    '/wt/keycloak-wt-kc-fix-kpow',
  );
});

// ------------------------------------------------- starting work, through the kernel
//
// The act is the kernel's (`bin/kernel worktree`); projector answers its question
// about the note and asks it to start. Every kernel here is a `Runner` the test
// wrote: nothing reaches the owner's kernel.

const INTENT = 'aaaaaaaa-0000-4000-8000-000000000001';

const ON = 'kernel:\n  enabled: true\n  bin: /fake/kernel\n  db: ./kdb\n  vault: fake\n  commitments: { axis: status, open: [active] }\n';

/**
 * A vault with one project declaring a repo, a branch template and instructions,
 * and `ship-it`, an active note in it. `memory/AGENTS.md` too, so the preface
 * names it.
 */
function workVault(kernel: string | null = ON): string {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-work-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(
    paths(root).facets,
    'status: { label: Status, values: [planning, active, done], open: false, single: true }\n' +
      'project: { label: Project, type: ref, single: true }\n',
    'utf8',
  );
  writeFileSync(
    place(root, 'plat/README.md'),
    '---\ntitle: Platform\nproject:\n  repos:\n    - path: /src/plat-api\n      base: origin/main\n    - path: ~/src/plat-web\n  branch: plat/{note}\n---\n\nThe platform.\n',
    'utf8',
  );
  writeFileSync(place(root, 'plat/AGENTS.md'), 'Run the API tests before every commit.\n', 'utf8');
  writeFileSync(
    place(root, 'ship-it.md'),
    '---\nid: ship-it\ntitle: Ship it\nfacets: { status: [active], project: [plat] }\n---\n\nDone when the widget ships.\n',
    'utf8',
  );
  writeFileSync(place(root, 'memory/AGENTS.md'), 'How to read this vault.\n', 'utf8');
  if (kernel) writeFileSync(settingsPath(root), kernel, 'utf8');
  return root;
}

test('a note alias names its vault and its note', () => {
  assert.deepEqual(parseNoteAlias('vault:work:tos'), { vault: 'work', id: 'tos' });
  assert.deepEqual(parseNoteAlias('vault:work:plat/ship-it'), { vault: 'work', id: 'plat/ship-it' });
  assert.equal(parseNoteAlias('repo:projector'), null);
  assert.equal(parseNoteAlias('vault:work:'), null);
});

test('what projector tells the kernel about a note: its context, its repos, its branch', () => {
  const root = workVault();
  try {
    const ctx = noteContext('ship-it', root)!;
    const said = aboutContext(ctx, { root, vault: 'fake' });
    assert.equal(said.title, 'Ship it');
    // The project's template, applied to the note — the branch `pj work` used.
    assert.equal(said.branch, 'plat/ship-it');
    // Absolute, a `~` expanded, the declared base carried and none invented.
    assert.equal(said.repos[0]!.path, '/src/plat-api');
    assert.equal(said.repos[0]!.base, 'origin/main');
    assert.ok(said.repos[1]!.path.startsWith('/') && said.repos[1]!.path.endsWith('/src/plat-web'));
    assert.equal('base' in said.repos[1]!, false);
    // The rendered context, with the inherited instructions and the body in it…
    assert.match(said.text, /# Ship it/);
    assert.match(said.text, /Run the API tests before every commit\./);
    assert.match(said.text, /Done when the widget ships\./);
    // …after a preface saying where the note lives and naming the day agent's memory.
    assert.match(said.text, /^Projector note `ship-it` in the vault `fake`/);
    assert.ok(said.text.includes(pathJoin(root, 'memory', 'AGENTS.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A kernel that answers the intents query with `rows` and `worktree` with `worktree`, recording each call. */
function fakeKernel(
  rows: unknown[][],
  worktree: (args: string[]) => { code: number | null; stdout: string; stderr: string },
): { run: Runner; calls: { args: string[]; env: Record<string, string | undefined> }[] } {
  const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
  const run: Runner = async (_bin, args, _input, env) => {
    calls.push({ args, env });
    if (args[0] === 'query') {
      return {
        code: 0,
        stdout: JSON.stringify({
          columns: ['intent', 'alias', 'status', 'statement', 'horizon', 'verdict', 'by', 'at', 'note', 'evidence', 'proposer'],
          rows,
        }),
        stderr: '',
      };
    }
    return worktree(args);
  };
  return { run, calls };
}

const row = (status: string, id = INTENT, alias = 'vault:fake:ship-it') => [id, alias, status, 'Ship it', '', '', '', '', '', '', ''];

/** What `bin/kernel worktree --json` prints, planned or started. */
function worktreeAnswer(dryRun: boolean): string {
  return JSON.stringify({
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    short: 'bbbbbbbb',
    spec: 'worktree',
    intent: INTENT,
    dir: '/wt/plat-ship-it',
    branch: 'plat/ship-it',
    repos: [
      { name: 'plat-api', path: '/src/plat-api', worktree: '/wt/plat-ship-it/plat-api', base: 'origin/main', guide: '/src/plat-api/CLAUDE.md', ...(dryRun ? {} : { ok: true, 'base-sha': 'abc' }) },
      { name: 'plat-web', path: '/src/plat-web', worktree: '/wt/plat-ship-it/plat-web', base: 'HEAD', ...(dryRun ? {} : { error: 'git worktree add: locked' }) },
    ],
    context: { alias: 'vault:fake:ship-it', system: 'system:projector', text: '…' },
    problems: [],
    ...(dryRun
      ? { 'dry-run': true }
      : {
          attempt: 'bbbbbbbb-0000-4000-8000-000000000002',
          'brief-file': '/wt/plat-ship-it/BRIEF.md',
          opened: { open: 'none', link: 'claude://code/new?folder=%2Fwt%2Fplat-ship-it&prompt=Read', command: "cd '/wt/plat-ship-it' && claude 'Read'" },
        }),
  });
}

const linksOf = (root: string) => readAll(paths(root).notes).notes.get('ship-it')!.links.map((l) => l.raw);

test('the plan is the kernel’s dry run for the note’s open intent, and writes nothing', async () => {
  const root = workVault();
  try {
    const k = fakeKernel([row('open')], () => ({ code: 0, stdout: worktreeAnswer(true), stderr: '' }));
    const plan = await startWork(root, 'ship-it', { commit: false, run: k.run });
    const call = k.calls.find((c) => c.args[0] === 'worktree')!;
    assert.deepEqual(call.args, ['worktree', INTENT, '--open', 'none', '--json', '--dry-run']);
    assert.equal(call.env.KERNEL_DB, pathJoin(root, 'kdb'));
    // The intent was read through projector's saved query, for this vault's prefix.
    assert.deepEqual(k.calls[0]!.args.slice(0, 3), ['query', '--saved', 'projector/vault-intents']);
    assert.ok(k.calls[0]!.args.includes('prefix=vault:fake:'));

    assert.equal(plan.dryRun, true);
    assert.equal(plan.intent, INTENT);
    assert.equal(plan.dir, '/wt/plat-ship-it');
    assert.equal(plan.branch, 'plat/ship-it');
    assert.deepEqual(plan.repos.map((r) => [r.name, r.worktree, r.base]), [
      ['plat-api', '/wt/plat-ship-it/plat-api', 'origin/main'],
      ['plat-web', '/wt/plat-ship-it/plat-web', 'HEAD'],
    ]);
    assert.deepEqual(plan.context, { alias: 'vault:fake:ship-it', system: 'system:projector' });
    assert.equal(plan.attempt, null);
    assert.equal(plan.link, null);
    assert.deepEqual(linksOf(root), [], 'a plan records nothing on the note');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('starting work starts the attempt, hands back its link, and records the workspace once', async () => {
  const root = workVault();
  try {
    const k = fakeKernel([row('open')], () => ({ code: 0, stdout: 'a launcher line\n' + worktreeAnswer(false), stderr: '' }));
    const done = await startWork(root, 'ship-it', { commit: true, run: k.run });
    assert.deepEqual(k.calls.find((c) => c.args[0] === 'worktree')!.args, ['worktree', INTENT, '--open', 'none', '--json']);
    assert.equal(done.dryRun, false);
    assert.equal(done.attempt, 'bbbbbbbb-0000-4000-8000-000000000002');
    assert.match(done.link ?? '', /^claude:\/\/code\/new\?folder=/);
    // One repo the kernel could not make is reported, not fatal.
    assert.equal(done.repos[0]!.ok, true);
    assert.equal(done.repos[1]!.error, 'git worktree add: locked');
    assert.equal(done.recorded, true);
    assert.equal(done.recordError, null);
    assert.deepEqual(linksOf(root), ['workspace:/wt/plat-ship-it']);

    // The same workspace again is the same ref: nothing appended, `updated` untouched.
    const before = readFileSync(place(root, 'ship-it.md'), 'utf8');
    const again = await startWork(root, 'ship-it', { commit: true, run: k.run });
    assert.equal(again.recorded, false);
    assert.equal(readFileSync(place(root, 'ship-it.md'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a note without an open intent is refused before the kernel is asked to start anything', async () => {
  const root = workVault();
  const never = () => {
    throw new Error('worktree must not be called');
  };
  try {
    const none = fakeKernel([row('open', INTENT, 'vault:fake:another')], never);
    await assert.rejects(startWork(root, 'ship-it', { commit: false, run: none.run }), (e: Error) =>
      e instanceof NotWorkable && /give the note a status first \(status: active\)/.test(e.message) && /pj kernel import/.test(e.message));

    const met = fakeKernel([row('met')], never);
    await assert.rejects(startWork(root, 'ship-it', { commit: false, run: met.run }), (e: Error) =>
      e instanceof NotWorkable && /aaaaaaaa is met: only an open intent is worked/.test(e.message));

    const proposed = fakeKernel([row('proposed')], never);
    await assert.rejects(startWork(root, 'ship-it', { commit: false, run: proposed.run }), (e: Error) =>
      e instanceof NotWorkable && /still a proposal/.test(e.message));

    const unread = fakeKernel([], never);
    const broken: Runner = async () => ({ code: 1, stdout: '', stderr: 'error: store locked' });
    await assert.rejects(startWork(root, 'ship-it', { commit: false, run: broken }), KernelFailed);
    await assert.rejects(startWork(root, 'nope', { commit: false, run: unread.run }), NoNote);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a vault whose kernel block is off cannot start work, and says why', async () => {
  for (const kernel of [null, 'kernel:\n  enabled: false\n  bin: /fake/kernel\n']) {
    const root = workVault(kernel);
    try {
      const k = fakeKernel([row('open')], () => ({ code: 0, stdout: worktreeAnswer(true), stderr: '' }));
      await assert.rejects(startWork(root, 'ship-it', { commit: false, run: k.run }), (e: Error) =>
        e instanceof NotWorkable && /kernel block is off/.test(e.message));
      assert.equal(k.calls.length, 0, 'nothing is asked of a kernel the vault did not turn on');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the kernel’s refusal comes back in its own words, and nothing is recorded', async () => {
  const root = workVault();
  try {
    const k = fakeKernel([row('open')], () => ({
      code: 1,
      stdout: '',
      stderr: 'error: no worktree: no repositories: give --repo <path>; system:projector named none for vault:fake:ship-it {:worktree :refused}\n',
    }));
    await assert.rejects(startWork(root, 'ship-it', { commit: true, run: k.run }), (e: Error) =>
      e instanceof NotWorkable &&
      e.message === 'kernel worktree: no worktree: no repositories: give --repo <path>; system:projector named none for vault:fake:ship-it');
    assert.deepEqual(linksOf(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ------------------------------------------------- the workspace, and who is in it
//
// The mechanism that replaced `pj link --session` in the briefing. A session used
// to reach a note only by registering itself at the end of its work, so a note
// showed nothing while the work was happening and nothing at all if the agent
// never got that far. Starting work records the workspace instead, once, and
// every session that ever runs there is read back off the directory (C8, C11).

/** A `~/.claude` with the sessions and transcripts a test wants in it. */
function claudeHomeWith(
  sessions: { uuid: string; cwd: string; pid?: number; alive?: boolean }[],
): string {
  const home = mkdtempSync(pathJoin(tmpdir(), 'projector-claude-'));
  mkdirSync(pathJoin(home, 'sessions'), { recursive: true });
  for (const s of sessions) {
    // `alive` is decided by whether the pid exists, so this process's own pid is
    // the only one a test can be sure of either way.
    const pid = s.pid ?? (s.alive === false ? 2 ** 30 : process.pid);
    writeFileSync(
      pathJoin(home, 'sessions', `${s.uuid}.json`),
      JSON.stringify({ sessionId: s.uuid, pid, cwd: s.cwd }),
      'utf8',
    );
    const dir = pathJoin(home, 'projects', s.cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(
      pathJoin(dir, `${s.uuid}.jsonl`),
      [
        JSON.stringify({ type: 'user', cwd: s.cwd, timestamp: at, message: { content: `work in ${s.cwd}` } }),
        JSON.stringify({ type: 'assistant', cwd: s.cwd, timestamp: at, message: { stop_reason: 'end_turn' } }),
      ].join('\n') + '\n',
      'utf8',
    );
  }
  return home;
}

/** Run with `PROJECTOR_CLAUDE_HOME` pointed somewhere a test built. */
function withClaudeHome<T>(home: string, fn: () => T): T {
  const before = process.env.PROJECTOR_CLAUDE_HOME;
  const desktop = process.env.PROJECTOR_CLAUDE_DESKTOP;
  process.env.PROJECTOR_CLAUDE_HOME = home;
  // No desktop store, so nothing has a chat.
  process.env.PROJECTOR_CLAUDE_DESKTOP = pathJoin(home, 'no-desktop');
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.PROJECTOR_CLAUDE_HOME;
    else process.env.PROJECTOR_CLAUDE_HOME = before;
    if (desktop === undefined) delete process.env.PROJECTOR_CLAUDE_DESKTOP;
    else process.env.PROJECTOR_CLAUDE_DESKTOP = desktop;
  }
}

test('a workspace finds the sessions that worked in it, and only those', () => {
  // Two directories whose slugs are one character apart, plus a repo *inside*
  // the workspace — which is where a session actually sits, since the worktrees
  // are subdirectories.
  const home = claudeHomeWith([
    { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: '/wt/plat-wt-ship-it' },
    { uuid: 'aaaaaaaa-0000-4000-8000-000000000002', cwd: '/wt/plat-wt-ship-it/api' },
    { uuid: 'aaaaaaaa-0000-4000-8000-000000000003', cwd: '/wt/plat-wt-other' },
  ]);
  try {
    const found = withClaudeHome(home, () => sessionsUnder('/wt/plat-wt-ship-it'));
    assert.deepEqual(
      found.map((s) => s.uuid.slice(-1)).sort(),
      ['1', '2'],
      'the workspace and its worktrees, and nothing beside them',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a slug collision is settled by the cwd the transcript recorded', () => {
  // `/wt/a.b` and `/wt/a/b` flatten to the same directory name, so the slug
  // cannot tell them apart and the transcript has to.
  const home = claudeHomeWith([{ uuid: 'bbbbbbbb-0000-4000-8000-000000000001', cwd: '/wt/a.b' }]);
  try {
    assert.equal(withClaudeHome(home, () => sessionsUnder('/wt/a/b')).length, 0);
    assert.equal(withClaudeHome(home, () => sessionsUnder('/wt/a.b')).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------- history

test('pj log narrates every single-valued axis, and closed is what finishes', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    mkdirSync(paths(root).config, { recursive: true });
    // The vocabulary decides what is watched and what "finished" means. Nothing
    // in the log names a facet or a value any more.
    writeFileSync(
      paths(root).facets,
      'status: { values: [planning, done], single: true, closed: [done] }\n' +
        'due: { type: date, single: true }\n' +
        'tech: { values: [], open: true }\n',
      'utf8',
    );
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 'T');

    const card = place(root, 'ship.md');
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

test('a multi-byte note body does not derail the blob walk', () => {
  // `git cat-file --batch` sizes are bytes. The walk once decoded first and
  // sliced code units, so one em dash drifted the cursor into the next header:
  // later blobs were misread or lost, and a modified note whose `after` went
  // missing narrated as deleted. All-ASCII fixtures never caught it.
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    mkdirSync(paths(root).config, { recursive: true });
    writeFileSync(
      paths(root).facets,
      'status: { values: [planning, done], single: true, closed: [done] }\n',
      'utf8',
    );
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 'T');

    // The em dash sits in the first note the batch returns; the second note is
    // the one that goes missing when the walk drifts.
    const dashed = place(root, 'dashed.md');
    const plain = place(root, 'plain.md');
    writeFileSync(dashed, '---\nid: dashed\ntitle: Dashed\nfacets: { status: [planning] }\n---\n\nem — dash\n', 'utf8');
    writeFileSync(plain, '---\nid: plain\ntitle: Plain\nfacets: { status: [planning] }\n---\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'seed');

    writeFileSync(dashed, '---\nid: dashed\ntitle: Dashed\nfacets: { status: [done] }\n---\n\nem — dash\n', 'utf8');
    writeFileSync(plain, '---\nid: plain\ntitle: Plain\nfacets: { status: [done] }\n---\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'finish both');

    const r = history(root, '1 year ago');
    // Both edits are transitions — nothing was created or deleted by editing.
    assert.deepEqual(
      r.commits[0]!.changes.map((c) => [c.kind, c.id]),
      [
        ['facet', 'dashed'],
        ['facet', 'plain'],
      ],
    );
    assert.deepEqual([...r.finished].sort(), ['dashed', 'plain']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

