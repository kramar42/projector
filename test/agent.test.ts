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
import { NotWorkable, plannedBriefing, planWork, startWork } from '../src/agent/work.ts';
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
  assert.match(out, /pj link c1 --session/);
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
      () => startWork(ctx, plan),
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

