import { test } from 'node:test';
import assert from 'node:assert/strict';
import { history } from '../src/agent/history.ts';
import { execFileSync } from 'node:child_process';
import {
  addWorktree,
  BRIEFING_PROMPT,
  branchFor,
  desktopLink,
  worktreeBase,
  shellQuote,
  workspacePath,
} from '../src/agent/worktree.ts';
import { buildBriefing } from '../src/agent/briefing.ts';
import { NotWorkable, openingFor, plannedBriefing, planWork, startWork } from '../src/agent/work.ts';
import { sessionsUnder } from '../src/sources/claude.ts';
import { readAll } from '../src/index/indexer.ts';
import type { NoteContext } from '../src/agent/context.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin, } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { settingsPath } from '../src/settings.ts';


/**
 * What an agent is handed: a note context, a briefing, a workspace, and git history.
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
  // note in the project — the second `pj work` would collide with the first.
  assert.throws(() => branchFor('fix-kpow', { template: 'plat/{ntoe}' }), /\{ntoe\}/);
});

test('a branch with slashes still makes a legal directory name', () => {
  assert.equal(
    workspacePath('/wt', 'keycloak', 'kc/fix-kpow'),
    '/wt/keycloak-wt-kc-fix-kpow',
  );
});

/**
 * The desktop link, which is what replaced two layers of shell-and-AppleScript
 * quoting. The tests that used to live here proved a path with a quote in it
 * survived both layers; a URL has one encoding, so what is worth proving now is
 * that the app is handed the route it actually implements.
 */
test('the desktop link names the app route, the workspace and the prompt', () => {
  const url = new URL(desktopLink('/wt/keycloak-wt-kc-fix', BRIEFING_PROMPT));
  // `claude://code/new` is the app's own route for a session that does not exist
  // yet. `claude://resume` mints a chat from a transcript and is a different act;
  // `enrich/claudeSession.ts` owns that one.
  assert.equal(url.protocol, 'claude:');
  assert.equal(url.host, 'code');
  assert.equal(url.pathname, '/new');
  assert.equal(url.searchParams.get('folder'), '/wt/keycloak-wt-kc-fix');
  assert.equal(url.searchParams.get('prompt'), BRIEFING_PROMPT);
});

test('the prompt names the file the briefing is written to', () => {
  // The two halves of one contract: `startWork` writes `AGENT_BRIEFING.md`, and
  // this sentence is the only thing that tells the new session to read it.
  assert.match(BRIEFING_PROMPT, /AGENT_BRIEFING\.md/);
});

test('a path a shell would mangle survives the link intact', () => {
  // One encoding layer instead of two. A quote, a space and an ampersand are the
  // three that ended the old AppleScript literal or split the old shell command.
  const path = `/wt/don't & "quote" me`;
  const url = new URL(desktopLink(path, BRIEFING_PROMPT));
  assert.equal(url.searchParams.get('folder'), path);
  // Percent-encoded on the wire, so nothing in it can be read as syntax.
  assert.ok(!desktopLink(path, BRIEFING_PROMPT).includes('"'));
});

test('shellQuote still covers the one place a shell command is printed', () => {
  // `pj work` prints `cd <ws> && claude <prompt>` when `open` fails, which is the
  // only shell string left in the launch path.
  assert.equal(shellQuote("/tmp/don't"), `'/tmp/don'\\''t'`);
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
  // The repo has to exist or addWorktree bails before pruning; the target must
  // not, or it takes the already-prepared path instead. A fresh temp dir is both.
  const repo = mkdtempSync(pathJoin(tmpdir(), 'projector-worktree-'));
  addWorktree({ path: repo }, repo, 'b', git); // <repo>/<basename repo> won't exist
  rmSync(repo, { recursive: true, force: true });
  assert.ok(calls.some((c) => c === 'worktree prune'), calls.join(' | '));
});

test('the briefing names failed repos as out of scope and stops before building', () => {
  const ctx = {
    id: 'c1', title: 'T', isProject: false, file: 'notes/c1.md',
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
  // The briefing no longer asks the session to register itself. `pj work` records
  // the workspace on the note and the sessions are read back off that, so a step
  // the agent could forget is a step that must not be here.
  assert.ok(!out.includes('--session'), out);
});


// ---------------------------------------------------------------- starting work
//
// `planWork` is the half both `pj work` and `POST /api/note/:id/work` reach, so
// what is worth holding is that it decides and touches nothing, and that both of
// its refusals are refusals rather than crashes.

/** A context with just enough on it for the work path. */
const workCtx = (project: NoteContext['project']): NoteContext => ({
  id: 'ship-it', title: 'Ship it', isProject: false, file: 'notes/ship-it.md',
  facets: {}, body: '', project, blockedBy: [],
  refs: {}, inbound: {}, links: [], siblings: [],
});

/** A resolved project, with the two derived fields a briefing reads. */
const project = (o: { repos: string[]; branch?: string }): NoteContext['project'] => ({
  key: 'plat',
  repos: o.repos.map((path) => ({ path })),
  ...(o.branch ? { branch: o.branch } : {}),
  instructions: [],
  chain: ['plat'],
});

/** A vault whose only interesting property is where it says worktrees go. */
function vaultSaying(workspaces: string | null): string {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-work-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(paths(root).facets, '{}\n', 'utf8');
  if (workspaces) writeFileSync(settingsPath(root), `workspaces: ${workspaces}\n`, 'utf8');
  return root;
}

test('with nowhere to put worktrees, work refuses instead of guessing', () => {
  const root = vaultSaying(null);
  try {
    // No fallback on purpose: a guessed parent directory puts real worktrees
    // somewhere the user did not choose and will not think to look.
    assert.throws(
      () => planWork(workCtx(project({ repos: ['/r'] })), root),
      (err: unknown) => err instanceof NotWorkable && /PROJECTOR_WORKSPACES/.test((err as Error).message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a note whose project declares no repos has nothing to lay out', () => {
  const root = vaultSaying('/wt');
  try {
    for (const p of [null, project({ repos: [] })]) {
      assert.throws(
        () => planWork(workCtx(p), root),
        (err: unknown) => err instanceof NotWorkable && /has no repos/.test((err as Error).message),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the plan names the workspace and the branch, and creates neither', () => {
  const root = vaultSaying('/wt');
  try {
    const ctx = workCtx(project({ repos: ['/repos/api'], branch: 'kc/{note}' }));
    const plan = planWork(ctx, root);
    assert.equal(plan.branch, 'kc/ship-it');
    assert.equal(plan.workspace, '/wt/plat-wt-kc-ship-it');
    // Nothing on disk: this is what the panel's confirm is built from, and it
    // runs before the user has agreed to anything.
    assert.equal(existsSync(plan.workspace), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dry-run briefing shows worktree paths, not the source checkouts', () => {
  const root = vaultSaying('/wt');
  try {
    const ctx = workCtx(project({ repos: ['/repos/api'] }));
    const out = plannedBriefing(ctx, planWork(ctx, root));
    // The *workspace list* is the part that must show worktrees. The checkout is
    // the one path the briefing tells the session never to touch, so naming it
    // there made the dry run contradict its own text — while the project-config
    // echo further down is meant to show the declared repo, and still does.
    const listed = out.slice(out.indexOf('## Repositories'), out.indexOf('These are git worktrees'));
    assert.match(listed, /`api\/` → \/wt\/plat-wt-ship-it\/api/);
    assert.ok(!listed.includes('/repos/api'), listed);
    assert.match(out, /repo: `\/repos\/api`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every repo failing is a refusal, so no briefing is written and nothing opens', () => {
  const root = vaultSaying('/wt');
  const parent = mkdtempSync(pathJoin(tmpdir(), 'projector-wt-'));
  try {
    const ctx = workCtx(project({ repos: ['/definitely/not/here'] }));
    const plan = { ...planWork(ctx, root), workspace: pathJoin(parent, 'plat-wt-x') };
    assert.throws(
      () => startWork(ctx, plan, root),
      (err: unknown) => err instanceof NotWorkable && /no worktree could be created/.test((err as Error).message),
    );
    // One repo failing does not stop the others; all of them failing leaves
    // nothing to work in, so the briefing is the thing that must not exist.
    assert.equal(existsSync(pathJoin(plan.workspace, 'AGENT_BRIEFING.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});


// ------------------------------------------------- the workspace, and who is in it
//
// The mechanism that replaced `pj link --session` in the briefing. A session used
// to reach a note only by registering itself at the end of its work, so a note
// showed nothing while the work was happening and nothing at all if the agent
// never got that far. `pj work` records the workspace instead, once, and every
// session that ever runs there is read back off the directory (C8, C11).

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
  // No desktop store, so nothing has a chat: `openingFor` lands on `running`
  // unless a test says otherwise, which is the interesting half anyway.
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

test('a workspace with a live session is reopened, not doubled — unless asked', () => {
  const home = claudeHomeWith([{ uuid: 'cccccccc-0000-4000-8000-000000000001', cwd: '/wt/plat-wt-ship-it' }]);
  try {
    withClaudeHome(home, () => {
      // Live, but no desktop chat to point at: nothing is opened, and saying so
      // is the answer. Opening a second session beside it is the bug.
      const busy = openingFor('/wt/plat-wt-ship-it');
      assert.equal(busy.how, 'running');
      assert.ok(!('link' in busy));

      // `--new` is how you ask for the second one.
      assert.equal(openingFor('/wt/plat-wt-ship-it', true).how, 'new');
      // A workspace nobody is in starts one, which is what it always did.
      assert.equal(openingFor('/wt/plat-wt-nobody').how, 'new');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a finished session in the workspace is history, not something to reopen', () => {
  const home = claudeHomeWith([
    { uuid: 'dddddddd-0000-4000-8000-000000000001', cwd: '/wt/plat-wt-ship-it', alive: false },
  ]);
  try {
    withClaudeHome(home, () => {
      // It still shows on the note — `sessionsUnder` returns it — but `pj work`
      // starts a new one rather than resuming work somebody finished.
      assert.equal(sessionsUnder('/wt/plat-wt-ship-it').length, 1);
      assert.equal(openingFor('/wt/plat-wt-ship-it').how, 'new');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('starting work records the workspace on the note, once', () => {
  const parent = mkdtempSync(pathJoin(tmpdir(), 'projector-wt-'));
  const repo = mkdtempSync(pathJoin(tmpdir(), 'projector-repo-'));
  const home = claudeHomeWith([]);
  const root = vaultSaying(parent);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'A');
    writeFileSync(pathJoin(repo, 'f.txt'), 'x\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'first');

    writeFileSync(pathJoin(root, 'ship-it.md'), '---\ntitle: Ship it\n---\n\nbody\n', 'utf8');
    const ctx = workCtx(project({ repos: [repo] }));
    const plan = planWork(ctx, root);

    const first = withClaudeHome(home, () => startWork(ctx, plan, root));
    assert.equal(first.recorded, true);
    assert.equal(first.recordError, null);
    const links = () => readAll(paths(root).notes).notes.get('ship-it')!.links.map((l) => l.raw);
    assert.deepEqual(links(), [`workspace:${plan.workspace}`]);

    // Reopening is the same act, so it must not append a second copy — nor bump
    // `updated` on a note nothing changed about.
    const again = withClaudeHome(home, () => startWork(ctx, plan, root));
    assert.equal(again.recorded, false);
    assert.deepEqual(links(), [`workspace:${plan.workspace}`]);
  } finally {
    for (const d of [parent, repo, home, root]) rmSync(d, { recursive: true, force: true });
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

    const card = pathJoin(paths(root).notes, 'ship.md');
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
    const dashed = pathJoin(paths(root).notes, 'dashed.md');
    const plain = pathJoin(paths(root).notes, 'plain.md');
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

