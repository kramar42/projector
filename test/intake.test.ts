import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { reindex } from '../src/index/indexer.ts';
import { closeIntakeDb, openIntakeDb, rescues, suppress, suppressedFingerprints, suppressions, unsuppress } from '../src/intake/db.ts';
import { evidenceFor, ftsOverlapQuery, matchBranch, matchCwd, repoIndex } from '../src/intake/match.ts';
import { fromWorkspacePath, workspacePath } from '../src/agent/workspaceName.ts';
import { CHANNELS, channelNames, mapEvents, pending, placeOf, readVault, renderPreview, startOf } from '../src/intake/run.ts';
import { materialise, SOURCE_EXCERPT } from '../src/intake/materialise.ts';
import { rejudge } from '../src/intake/rejudge.ts';
import {
  conversationsFrom,
  knownFor,
  linkFor,
  slackPermalinkParts,
  trackedBy,
  transcript as exchangeOf,
  withPermalinks,
  type Message,
} from '../src/intake/conversation.ts';
import { costFromEnvelope, renderCost } from '../src/intake/cost.ts';
import { eventId } from '../src/kernel/query.ts';
import { parseLink } from '../src/schema/links.ts';
import { deleteNote, discard } from '../src/server/mutate.ts';
import { channelLine, isBehind, pollAtStartup, pollOnce, startPolling, stopPolling, withinHours } from '../src/server/poll.ts';
import { logTo } from '../src/server/log.ts';
import { classify, ollamaAsk, type Ask, type Verdict } from '../src/intake/classify.ts';
import { settingsFor, settingsPath } from '../src/settings.ts';
import { listTranscripts, pickSession, describeTranscript, type LiveSession } from '../src/sources/claude.ts';
import { jqlDate } from '../src/sources/jira.ts';
import { lastTurn, sessionState, type Turn } from '../src/sources/claude.ts';
import type { ConnectorEvent } from '../src/intake/connectors.ts';
import type { Candidate, IntakeContext } from '../src/intake/types.ts';
import { paths } from '../src/config.ts';
import { BUILTIN_FACETS, loadFacets } from '../src/schema/facets.ts';
import { againstFake, asConnectorEvent, connectorAnswer as connectorAnswerOf, FAKE_KERNEL, place, type FixtureEvent } from './fixture.ts';

/**
 * Intake triages what the kernel's connectors gathered. What is worth testing
 * here is everything between the connector event and the card: what is decided
 * mechanically and what is left to the judge, the evidence beside it, the
 * judgment's contract, the write, and the declines that make it converge. The
 * kernel's half — the cursor read back, the attempt recorded — is
 * `kernel.test.ts`.
 */

function vault(cards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pj-intake-'));
  mkdirSync(paths(root).config, { recursive: true });
  for (const [name, body] of Object.entries(cards)) {
    // A card is unjudged by being in the inbox; a fixture that says so in its
    // frontmatter is filed there, the way intake would have written it.
    const file = /intake: \[unjudged\]/.test(body) ? place(root, 'inbox', `${name}.md`) : place(root, `${name}.md`);
    writeFileSync(file, body, 'utf8');
  }
  return root;
}

function context(root: string, over: Partial<IntakeContext> = {}): IntakeContext {
  return { ...readVault(root), ...over };
}

/** A connector event as the kernel holds it, its id derived from its key. */
const ev = (key: string, kind: string, at: string, about: string[], payload: Record<string, unknown>): ConnectorEvent =>
  asConnectorEvent({ key, kind, at, about, payload });

/** A vault with the kernel block on, pointed at `test/fake-kernel`. */
const kernelOn = (extra = '') => `kernel:\n  enabled: true\n  bin: ${FAKE_KERNEL}\n${extra}`;

/** A fixture event an hour old, inside every channel's window. */
const recent = (minutes = 60) => new Date(Date.now() - minutes * 60_000).toISOString();
const gitEvent = (repo: string, sha: string, subject: string, branch = 'feature/x', at = recent()): FixtureEvent => ({
  key: `git:${repo}:${sha}`,
  kind: 'git/commit',
  at,
  about: [`repo:${repo}`],
  payload: { sha, subject, files: [], insertions: 1, deletions: 0, branch },
});

const card = (id: string, extra = '') => `---\nid: ${id}\ntitle: ${id}\n${extra}---\n\nbody\n`;

// ------------------------------------------------------------------ watermarks

// ------------------------------------------------------------------ the sweep

test('an unknown channel is named rather than silently read away', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(settingsPath(root), kernelOn(), 'utf8');
  try {
    const p = await pending(root, { only: ['sms'] });
    assert.deepEqual(p.unknown, ['sms']);
    assert.ok(p.ok && p.reports.length === 0);
    assert.match(renderPreview(p), /unknown channel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every channel in the registry is named in channelNames, with the connector that gathers it', () => {
  assert.deepEqual(channelNames(), ['claude', 'git', 'jira', 'slack', 'gmail']);
  assert.deepEqual(CHANNELS.map((c) => [c.name, c.connector, c.kinds]), [
    ['claude', 'claude-code', ['claude/session']],
    ['git', 'git', ['git/commit']],
    ['jira', 'jira', ['jira/issue', 'jira/transition']],
    ['slack', 'slack', ['slack/message']],
    ['gmail', 'gmail', ['gmail/message']],
  ]);
});

// ------------------------------------------------------------------- dedup

test('a fingerprint already on a note is what makes a re-sweep converge', () => {
  const root = vault({
    known: `---\nid: known\ntitle: known\nsource_fingerprint: claude:abc-123\n---\n\nb\n`,
  });
  try {
    const ctx = context(root);
    const ev = evidenceFor(ctx, { fingerprint: 'claude:abc-123' });
    assert.deepEqual(ev.capturedAs, ['known']);
    // And it holds with nothing of intake's own on disk, which is the property
    // that makes losing .intake.db safe rather than merely inconvenient.
    assert.deepEqual(context(root).fingerprints.get('claude:abc-123'), ['known']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a link already on a note is reported as linked, not as a candidate', () => {
  const root = vault({
    tracked: `---\nid: tracked\ntitle: tracked\nlinks:\n  - claude:abc-123\n---\n\nb\n`,
  });
  try {
    const ev = evidenceFor(context(root), {
      fingerprint: 'claude:abc-123',
      links: ['claude:abc-123'],
    });
    assert.deepEqual(ev.linkedTo, ['tracked']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- evidence

test('evidence is a reason, never a score', () => {
  const root = vault({
    p: `---\nid: p\ntitle: p\nproject:\n  repos:\n    - path: /tmp/some-repo\n---\n\nb\n`,
  });
  try {
    const ctx = context(root);
    const m = matchCwd(ctx, '/tmp/some-repo/src');
    assert.deepEqual(m, [{ id: 'p', title: 'p', why: 'cwd' }]);
    // No confidence field to be wrong about: the caller argues with the reason.
    assert.ok(!Object.keys(m[0]!).includes('score'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo declared by two projects is reported once per project', () => {
  const root = vault({
    one: `---\nid: one\ntitle: one\nproject:\n  repos:\n    - path: /tmp/shared\n---\n\nb\n`,
    two: `---\nid: two\ntitle: two\nproject:\n  repos:\n    - path: /tmp/shared\n---\n\nb\n`,
  });
  try {
    const repos = repoIndex(context(root));
    assert.equal(repos.length, 2);
    assert.deepEqual(new Set(repos.map((r) => r.project)), new Set(['one', 'two']));
    // Which is why the git channel dedupes by path before scanning.
    assert.equal(new Set(repos.map((r) => r.path)).size, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a worktree path names the project and the branch it was made for', () => {
  const ws = workspacePath('/Users/x/Code/wt', 'project-a', 'feature/PROJ-303');
  const parsed = fromWorkspacePath(join(ws, 'some-repo'));
  assert.equal(parsed?.project, 'project-a');
  // The branch was slugified on the way in, so it is compared slugified.
  assert.equal(parsed?.branchSlug, 'feature-PROJ-303');
});

test('a workspace recorded on a note is the strongest reason a cwd can give', () => {
  const root = vault({
    ship: `---\nid: ship\ntitle: ship\nlinks:\n  - workspace:/wt/plat-wt-tos-ship\n---\n\nb\n`,
    tos: `---\nid: tos\ntitle: tos\nlinks:\n  - workspace:/wt/plat-tos\n---\n\nb\n`,
  });
  try {
    const ctx = context(root);
    // The session sits in a worktree *inside* the workspace, which is where
    // every repo goes — so containment, not equality.
    assert.deepEqual(matchCwd(ctx, '/wt/plat-wt-tos-ship/api'), [
      { id: 'ship', title: 'ship', why: 'workspace' },
    ]);
    assert.deepEqual(matchCwd(ctx, '/wt/plat-wt-tos-other'), []);
    // A workspace the kernel prepared is named for its branch alone, so only the
    // link the app recorded on the note says whose it is — and that is enough.
    assert.deepEqual(matchCwd(ctx, '/wt/plat-tos/plat-api'), [{ id: 'tos', title: 'tos', why: 'workspace' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree branch finds its note through the project's own template", () => {
  // The bug this pins: the comparison was against the note id, which is
  // `branchFor`'s *fallback*. A project declaring a template never matched, so
  // every note in one was invisible to a sweep that had its workspace in hand.
  const root = vault({
    plat: `---\nid: plat\ntitle: plat\nproject:\n  branch: tos/{note}\n---\n\nb\n`,
    ship: `---\nid: ship\ntitle: ship\nfacets:\n  project:\n    - plat\n---\n\nb\n`,
  });
  try {
    const m = matchCwd(context(root), workspacePath('/wt', 'plat', 'tos/ship'));
    assert.deepEqual(
      m,
      [
        { id: 'plat', title: 'plat', why: 'worktree' },
        { id: 'ship', title: 'ship', why: 'worktree branch' },
      ],
      'the project and the note, not the project alone',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a branch naming a Jira key finds the note carrying that key', () => {
  const root = vault({
    c: `---\nid: c\ntitle: c\nlinks:\n  - jira:PROJ-303\n---\n\nb\n`,
  });
  try {
    const ctx = context(root);
    assert.deepEqual(matchBranch(ctx, 'feature/PROJ-303'), [
      { id: 'c', title: 'c', why: 'branch names PROJ-303' },
    ]);
    assert.deepEqual(matchBranch(ctx, 'unrelated'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a branch named after a note matches it, at any path segment', () => {
  const root = vault({ 'clean-up-ecr': card('clean-up-ecr') });
  try {
    const ctx = context(root);
    assert.equal(matchBranch(ctx, 'clean-up-ecr')[0]?.id, 'clean-up-ecr');
    assert.equal(matchBranch(ctx, 'okr/clean-up-ecr')[0]?.id, 'clean-up-ecr');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- mtime is not activity

// ------------------------------------------------------------------ FTS safety

test('an opening prompt full of FTS operators produces a query, not a syntax error', () => {
  const q = ftsOverlapQuery('fix the "keycloak" logout (NEAR: token) AND cookie -- please');
  assert.ok(q);
  // Every token quoted, so nothing in a prompt can be read as an operator.
  assert.match(q!, /^"[a-z0-9]+"( OR "[a-z0-9]+")*$/);
  assert.ok(q!.includes('"keycloak"'));
});

test('a prompt with nothing distinctive left produces no query at all', () => {
  // A query of pure noise matches everything, which is worse than no match.
  assert.equal(ftsOverlapQuery('can you please just fix this for me'), null);
  assert.equal(ftsOverlapQuery('hi'), null);
});

// -------------------------------------------------------------------- jira

test('a JQL date is local, because Jira reads it in the account timezone', () => {
  const d = new Date(2026, 7, 14, 9, 5);
  assert.equal(jqlDate(d), '2026-08-14 09:05');
  // Not the ISO form, which would shift the window by the UTC offset — an hour
  // of issues re-proposed or skipped on every sweep.
  assert.notEqual(jqlDate(d), d.toISOString());
});

// ------------------------------------------------------------------ rendering

/**
 * A session's state is read from the tail of its transcript, because the thing
 * that is easy to read — a live process — is not the thing worth knowing. The
 * desktop app keeps a process per open chat, so `alive` marks every chat as
 * running; only the last conversation note says whether work is happening.
 */
function transcript(...notes: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pj-turn-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, notes.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

const at = '2026-08-21T12:00:00.000Z';
const assistant = (stop: string) => ({ type: 'assistant', timestamp: at, message: { role: 'assistant', stop_reason: stop } });
const user = (content: unknown) => ({ type: 'user', timestamp: at, message: { role: 'user', content } });

test('a turn that stopped to call a tool is still the model working', () => {
  assert.equal(lastTurn(transcript(user('go'), assistant('tool_use')))?.waitingOn, 'model');
});

test('a tool result hands the move back to the model', () => {
  const result = user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
  assert.equal(lastTurn(transcript(assistant('tool_use'), result))?.waitingOn, 'model');
});

test('a finished turn is waiting on the human', () => {
  assert.equal(lastTurn(transcript(user('go'), assistant('end_turn')))?.waitingOn, 'human');
});

test('an interrupt is the human taking the move back, not a prompt', () => {
  const stop = user([{ type: 'text', text: '[Request interrupted by user]' }]);
  assert.equal(lastTurn(transcript(assistant('tool_use'), stop))?.waitingOn, 'human');
});

test('bookkeeping the session rewrites while idle is not activity', () => {
  const t = transcript(
    user('go'),
    assistant('end_turn'),
    { type: 'last-prompt', lastPrompt: 'go' },
    { type: 'mode', mode: 'normal' },
    { type: 'atis-latch', atis: '' },
  );
  assert.equal(lastTurn(t)?.waitingOn, 'human');
});

test("a subagent's notes say what it is doing, not what the session waits on", () => {
  const t = transcript(user('go'), assistant('tool_use'), { ...assistant('end_turn'), isSidechain: true });
  assert.equal(lastTurn(t)?.waitingOn, 'model');
});

test('a tail read that lands mid-note drops the half it cannot parse', () => {
  const big = user('x'.repeat(4096));
  const t = transcript(big, big, big, assistant('end_turn'));
  // The read ends at EOF, so the last note is whole and the leading half goes.
  assert.equal(lastTurn(t, 512)?.waitingOn, 'human');
  // A window too small to hold even that says nothing rather than something wrong.
  assert.equal(lastTurn(t, 40), null);
});

test('a process without a turn to work on is waiting, and none at all is closed', () => {
  const now = new Date().toISOString();
  const state = (alive: boolean, turn: Turn | null) => sessionState(alive, turn, now);
  assert.equal(state(true, { waitingOn: 'model', at: now }), 'working');
  assert.equal(state(true, { waitingOn: 'human', at: now }), 'waiting');
  assert.equal(state(true, null), 'waiting');
  assert.equal(state(false, { waitingOn: 'model', at: now }), 'closed');
  // Owing a move it has not made for a quarter of an hour is not work.
  const stale = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  assert.equal(state(true, { waitingOn: 'model', at: stale }), 'stalled');
});

/** A store written before the pending columns existed gains them, keeping its cursors. */
/**
 * The seam that was worked around instead of taken.
 *
 * Four `join(homedir(), …)` constants were computed at import, which pinned six
 * exports to a real home directory — `src/intake/claude.ts` says so in a comment
 * defending a per-rule extraction: *"the channel reads the real `~/.claude`, which
 * a unit test has no business constructing."* It can now, so these are the first
 * tests to reach `listTranscripts`, `describeTranscript` and `pickSession` at all.
 */
test('a transcript store can be pointed somewhere a test built', () => {
  const home = mkdtempSync(join(tmpdir(), 'pj-claude-'));
  const prev = process.env.PROJECTOR_CLAUDE_HOME;
  process.env.PROJECTOR_CLAUDE_HOME = home;
  try {
    mkdirSync(join(home, 'projects', '-Users-x-repo'), { recursive: true });
    const file = join(home, 'projects', '-Users-x-repo', 'aaaabbbb-1111-2222-3333-444455556666.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'add a due facet' }, cwd: '/Users/x/repo', gitBranch: 'feat/due', timestamp: '2026-08-20T10:00:00Z' }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' }, timestamp: '2026-08-20T10:01:00Z' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const found = listTranscripts({ since: new Date('2026-01-01') });
    assert.equal(found.length, 1, 'the store the env var names is the store that is read');
    assert.equal(found[0]!.uuid, 'aaaabbbb-1111-2222-3333-444455556666');

    // And the assembly both consumers used to write out themselves.
    const st = describeTranscript(found[0]!, null);
    assert.equal(st.state, 'closed', 'no live process means closed, whatever the transcript says');
    assert.equal(st.summary.opening, 'add a due facet');
    assert.equal(st.summary.branch, 'feat/due');
    assert.equal(st.lastAt, '2026-08-20T10:01:00Z', 'the transcript’s own time, not the file’s mtime');
  } finally {
    if (prev === undefined) delete process.env.PROJECTOR_CLAUDE_HOME;
    else process.env.PROJECTOR_CLAUDE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Which session a command means: three tiers, and the middle one refuses to guess.
 *
 * `sessionForCwd` used to answer this from the directory alone, taking the first
 * match in a list sorted newest-started-first — so three sessions in one directory
 * resolved to whichever started last, silently. A wrong answer here puts a
 * session's history on the wrong note and looks fine, so the cwd tier now requires
 * an unambiguous match and reports the candidates when it cannot get one.
 */
const S = (sessionId: string, pid: number, cwd: string, alive = true): LiveSession => ({
  sessionId,
  pid,
  cwd,
  alive,
});

test('the session that ran the command wins, whatever the directory says', () => {
  const sessions = [
    S('caller', 900, '/somewhere/else'),
    S('here', 901, '/Users/x/repo'),
  ];
  // The process tree reaches pid 900 two levels up; its cwd is irrelevant.
  const pick = pickSession({ sessions, parents: [42, 900], cwd: undefined });
  assert.ok(pick.found);
  assert.equal(pick.found.sessionId, 'caller');
  assert.equal(pick.how, 'caller');
});

test('a named id is authoritative and needs no search', () => {
  const sessions = [S('a', 900, '/x'), S('b', 901, '/y')];
  for (const id of ['b', 'claude:b']) {
    const pick = pickSession({ id, sessions, parents: [900] });
    assert.ok(pick.found, id);
    assert.equal(pick.found.sessionId, 'b');
    assert.equal(pick.how, 'id');
  }
  // An id naming nothing live is a plain miss, not a fallback to searching.
  assert.deepEqual(pickSession({ id: 'ghost', sessions, parents: [900] }), {
    found: null,
    reason: 'none',
  });
});

test('--cwd opts out of the process tree, so it answers about that directory', () => {
  const sessions = [S('caller', 900, '/elsewhere'), S('there', 901, '/Users/x/repo')];
  const pick = pickSession({ cwd: '/Users/x/repo', sessions, parents: [900] });
  assert.ok(pick.found);
  assert.equal(pick.found.sessionId, 'there', 'not the caller');
  assert.equal(pick.how, 'cwd');
});

test('the cwd tier prefers the deepest containing directory', () => {
  const sessions = [
    S('outer', 901, '/Users/x'),
    S('inner', 902, '/Users/x/repo'),
    S('dead', 903, '/Users/x/repo/deep', false),
  ];
  const pick = pickSession({ cwd: '/Users/x/repo/deep/deeper', sessions, parents: [] });
  assert.ok(pick.found);
  assert.equal(pick.found.sessionId, 'inner', 'the deepest live container, not the newest');
});

test('the cwd tier refuses to guess between siblings', () => {
  // Three sessions in one directory — the state that used to resolve silently.
  const sessions = [S('one', 901, '/Users/x/repo'), S('two', 902, '/Users/x/repo'), S('three', 903, '/Users/x/repo')];
  const pick = pickSession({ cwd: '/Users/x/repo', sessions, parents: [] });
  assert.equal(pick.found, null);
  assert.ok(pick.found === null && pick.reason === 'ambiguous');
  assert.deepEqual(
    pick.found === null && pick.reason === 'ambiguous' ? pick.candidates.map((c) => c.sessionId).sort() : [],
    ['one', 'three', 'two'],
    'and says which, so a caller can name one',
  );
});

test('a dead session never wins, and nothing containing it is nothing', () => {
  const sessions = [S('dead', 901, '/Users/x/repo', false)];
  assert.deepEqual(pickSession({ cwd: '/Users/x/repo', sessions, parents: [] }), {
    found: null,
    reason: 'none',
  });
  assert.deepEqual(pickSession({ cwd: '/elsewhere', sessions: [S('a', 901, '/Users/x')], parents: [] }), {
    found: null,
    reason: 'none',
  });
});

test('the asking process excludes itself', () => {
  const sessions = [S('me', 901, '/Users/x/repo'), S('other', 902, '/Users/x/repo')];
  const pick = pickSession({ cwd: '/Users/x/repo', self: 901, sessions, parents: [] });
  assert.ok(pick.found);
  assert.equal(pick.found.sessionId, 'other', 'excluding one sibling leaves the other unambiguous');
});

/**
 * Suppression: the half of resolving a sweep that used to have nowhere to go.
 *
 * `pj add` records a yes and leaves a note behind. A no left nothing but a moved
 * cursor, so "seen and declined" was indistinguishable from "never fetched" —
 * except that the first could never come back. These pin the properties that make
 * the table safe to rely on and safe to lose.
 */

test('suppressing again replaces the reason rather than failing', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:abc', reason: 'first answer' });
    suppress(root, { fingerprint: 'git:abc', reason: 'second answer' });
    const rows = suppressions(root).rows;
    assert.equal(rows.length, 1, 'one row per fingerprint');
    assert.equal(rows[0]!.reason, 'second answer', 'the current judgment wins');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a suppression is reversible, because suppressing wrongly costs the item', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:abc', reason: 'noise' });
    assert.ok(suppressedFingerprints(root).has('git:abc'));
    assert.ok(unsuppress(root, 'git:abc'));
    assert.equal(suppressedFingerprints(root).size, 0);
    assert.equal(unsuppress(root, 'git:abc'), null, 'and un-suppressing twice is not an error');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('losing the suppression table is noisier, never wrong', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:abc', reason: 'noise' });
    assert.equal(suppressions(root).rows.length, 1);

    // Same argument the watermark makes about itself: what stops a duplicate note
    // is `source_fingerprint` on the notes, not this table. Dropping it re-opens
    // the proposal and creates nothing.
    closeIntakeDb(root);
    rmSync(paths(root).intakeDb, { force: true });
    assert.equal(suppressions(root).rows.length, 0);
    assert.equal(suppressedFingerprints(root).size, 0);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the intake axis is built in, so a vault cannot strand the sweep', () => {
  const root = vault({ a: card('a') });
  try {
    const defs = loadFacets(paths(root).facets);

    /**
     * The set, pinned. Which axes the app owns changes by *deciding* rather than
     * by working, and MANUAL.md names them in three places — so a built-in added
     * or dropped without the document following fails here.
     */
    assert.deepEqual(
      Object.keys(BUILTIN_FACETS).sort(),
      ['extends', 'intake', 'project'],
      'a built-in was added or removed — MANUAL.md’s "The built-ins" names them',
    );
    assert.equal(defs.intake?.builtin, true);
    assert.deepEqual(defs.intake?.values, ['unjudged']);
    assert.equal(defs.intake?.single, true);
    assert.equal(defs.intake?.open, false, 'a vault may not add a second meaning to it');

    // `extends` points at a note, so the vault is its vocabulary — and nothing
    // walks it, which is the reason it is not `parent`.
    assert.equal(defs.extends?.builtin, true);
    assert.equal(defs.extends?.type, 'ref');
    assert.equal(defs.extends?.single, true);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Candidates paired with a bare "keep" verdict — for the materialise tests, whose
 * subject is the write and not the judgment.
 */
const asKept = (candidates: Candidate[], over: Partial<Verdict> = {}) =>
  candidates.map((candidate) => ({
    candidate,
    verdict: { fingerprint: candidate.fingerprint, decision: 'keep' as const, reason: '', ...over },
  }));

const candidate = (fp: string, title: string, over: Partial<Candidate> = {}): Candidate => ({
  channel: 'git',
  fingerprint: fp,
  title,
  links: [],
  ...over,
});

test('a materialised candidate is an ordinary note carrying the intake axis', () => {
  const root = vault({ a: card('a') });
  try {
    const res = materialise(root, 'git', asKept([candidate('git:1', 'A thing that happened')]));
    assert.equal(res.created.length, 1);

    const rec = [...reindex(root).notes.values()].find((n) => n.id === res.created[0]);
    assert.ok(rec, 'the note exists');
    assert.deepEqual(rec!.facets.intake, ['unjudged']);
    assert.equal(rec!.source_fingerprint, 'git:1', 'and it carries what it came from');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a card from a conversation keeps the last of what was said, not only the judge’s account of it', async () => {
  const root = vault({ a: card('a') });
  const said = [
    '(4 earlier message(s) not shown)',
    '10-13 14:47 Sander: shall we call in a bit to handle the key rotation?',
    '10-13 14:50 you: okay to do so after 30 min lunch break?',
    '10-13 14:51 Sander: just ping when you are ready! ```code```',
    '10-13 15:18 Slava: one more item for the rotation list',
  ].join('\n');
  try {
    const res = materialise(
      root,
      'slack',
      asKept(
        [
          candidate('slack:D0AAAAAAA/1791900000.000001', 'Key rotation call', { channel: 'slack', fields: [{ k: 'conversation', v: said }] }),
          candidate('git:2', 'A commit'),
        ],
        { reason: 'ask: a call is waiting on you', body: 'Sander wants to rotate the keys together.' },
      ),
    );
    const notes = reindex(root).notes;
    const slack = notes.get(res.created[0]!)!.body;
    assert.match(slack, /^\n?> ask: a call is waiting on you\n\nSander wants to rotate the keys together\./, 'the judgment still leads');
    assert.match(slack, new RegExp(`${SOURCE_EXCERPT}\\n\\n\`\`\`text\\n10-13 14:50 you: okay`), 'then the last three lines, newest last');
    assert.match(slack, /Slava: one more item for the rotation list\n```/);
    assert.doesNotMatch(slack, /14:47 Sander|earlier message/, 'three lines, not the whole exchange');
    assert.doesNotMatch(slack, /```code```/, 'a fence inside a message cannot close the excerpt');
    assert.doesNotMatch(notes.get(res.created[1]!)!.body, new RegExp(SOURCE_EXCERPT), 'a commit has no conversation to quote');

    // The judge's half is the model's to rewrite; what was said is not.
    const id = res.created[0]!;
    const judge: Ask = async (_s, user) =>
      JSON.stringify((JSON.parse(user) as { fp: string }[]).map((c) => ({ fp: c.fp, decision: 'keep', reason: 'ask: still waiting', body: 'Rewritten.' })));
    await rejudge(root, { ask: judge });
    const after = reindex(root).notes.get(id)!.body;
    assert.match(after, /Rewritten\./);
    assert.match(after, /Slava: one more item for the rotation list/, 'a rejudge keeps the excerpt');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('materialising the same report twice creates nothing the second time', () => {
  const root = vault({ a: card('a') });
  try {
    const r = asKept([candidate('git:1', 'A thing that happened')]);
    assert.equal(materialise(root, 'git', r).created.length, 1);

    // Convergence is a property of the write, not of the caller remembering.
    // A poller on a timer re-fetches the same window constantly.
    const second = materialise(root, 'git', r);
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped, 1);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate the vault already answers for is not written again', () => {
  const root = vault({ a: card('a') });
  try {
    const res = materialise(
      root,
      'git',
      asKept([
        candidate('git:1', 'Already linked', { evidence: { linkedTo: ['a'] } }),
        candidate('git:2', 'Already captured', { evidence: { capturedAs: ['a'] } }),
      ]),
    );
    // Both are mechanical facts about the vault rather than judgments about
    // whether the work matters, which is why acting on them here is allowed.
    assert.deepEqual(res.created, []);
    assert.equal(res.skipped, 2);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a suppressed candidate never reaches materialisation', async () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:1', reason: 'noise' });
    // `sweep` drops it, so the report handed to `materialise` cannot contain it —
    // the poller needs no code of its own to honour a suppression.
    const hidden = suppressedFingerprints(root);
    const survivors = asKept([candidate('git:1', 'noise')]).filter(
      (k) => !hidden.has(k.candidate.fingerprint),
    );
    assert.deepEqual(materialise(root, 'git', survivors).created, []);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('polling is off unless the vault asks for it, and has a kernel to read', () => {
  const root = vault({ a: card('a') });
  try {
    assert.equal(startPolling(root), false, 'a vault with no config is not polled');
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: 120\n', 'utf8');
    assert.equal(startPolling(root), false, 'nor is one whose kernel block is off: a pass would have nothing to read');
    writeFileSync(settingsPath(root), `poll:\n  enabled: true\n  every: 120\nkernel:\n  enabled: true\n  bin: ${join(tmpdir(), 'no-such-kernel')}\n`, 'utf8');
    assert.equal(startPolling(root), true);
    assert.equal(startPolling(root), true, 'and starting twice does not double the rate');
  } finally {
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the server starts every vault that asked to be polled, and says so for each', () => {
  const on = vault({ a: card('a') });
  const off = vault({ a: card('a') });
  const bare = vault({ a: card('a') });
  writeFileSync(settingsPath(on), `poll:\n  enabled: true\n  every: 120\n  hours: [8, 20]\nchannels: [git]\nkernel:\n  enabled: true\n  bin: ${join(tmpdir(), 'no-such-kernel')}\n`, 'utf8');
  writeFileSync(settingsPath(bare), 'poll:\n  enabled: true\n', 'utf8');
  const lines: string[] = [];
  logTo((l) => lines.push(l));
  try {
    pollAtStartup([on, off, bare]);
    const said = (root: string) => lines.filter((l) => l.includes(` ${basename(root)} `));
    assert.equal(said(on).length, 1, 'one line for the polled vault');
    assert.match(said(on)[0]!, /polling every 120s, 8–20 local time — triaging what the kernel’s connectors gathered; next tick now/);
    assert.equal(said(off).length, 1, 'and one for the vault that did not ask');
    assert.match(said(off)[0]!, /not polling — poll\.enabled is off/);
    assert.match(said(bare)[0]!, /not polling — the kernel block is off, so there is nothing to triage/);
    assert.equal(startPolling(on), true, 'the loop it started is the one a request finds');
    assert.equal(startPolling(off), false);
  } finally {
    logTo(null);
    stopPolling(on);
    for (const root of [on, off, bare]) {
      closeIntakeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a poll interval is floored, so a typo cannot spin', () => {
  const root = vault({ a: card('a') });
  try {
    // A small positive number is somebody meaning it, and gets the floor.
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: 5\n', 'utf8');
    assert.equal(settingsFor(root).poll.everySeconds, 60);

    // Zero or nonsense is nobody meaning anything, and gets the default — which
    // is the safer of the two readings: a floor would honour half a typo.
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: 0\n', 'utf8');
    assert.equal(settingsFor(root).poll.everySeconds, 900);
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: soon\n', 'utf8');
    assert.equal(settingsFor(root).poll.everySeconds, 900);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The classifier: the one place a model decides anything.
 *
 * What is worth pinning is not whether it judges well — that is the prompt's
 * business and a model's — but that every way it can go wrong fails in the
 * direction that loses nothing.
 */

test('a declined candidate is recorded with its reason, not dropped', async () => {
  const root = vault({ a: card('a') });
  const judge: Ask = async () =>
    '[{"fp":"git:1","decision":"drop","reason":"own routine commit"},{"fp":"jira:9","decision":"keep","reason":"needs a reply"}]';
  try {
    const res = await classify(
      root,
      [candidate('git:1', 'refactor: tidy'), candidate('jira:9', 'Ben asked about the cutover')],
      judge,
    );
    assert.ok(res);
    assert.deepEqual(res!.keep.map((k) => k.candidate.fingerprint), ['jira:9']);
    assert.equal(res!.drop.length, 1);
    assert.equal(res!.drop[0]!.reason, 'own routine commit', 'the reason survives to be read back');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate the model forgot to mention is not kept by default', async () => {
  const root = vault({ a: card('a') });
  // Silence used to mean keep — keeping costs a glance, dropping costs the item —
  // and it wrote raw cards. The pile made that argument obsolete: the second ask
  // is here, and what it still does not answer for is handed back unjudged.
  const forgetful: Ask = async () => '[{"fp":"git:1","decision":"drop","reason":"noise"}]';
  try {
    const res = await classify(root, [candidate('git:1', 'a'), candidate('git:2', 'b')], forgetful);
    assert.deepEqual(res!.keep, []);
    assert.deepEqual(res!.unjudged.map((c) => c.fingerprint), ['git:2']);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fenced reply is still a reply', async () => {
  const root = vault({ a: card('a') });
  // Failing closed over three backticks would hold a whole sweep on punctuation.
  const fenced: Ask = async () =>
    'Here you go:\n```json\n[{"fp":"git:1","decision":"drop","reason":"noise"}]\n```\n';
  try {
    const res = await classify(root, [candidate('git:1', 'a')], fenced);
    assert.equal(res!.drop.length, 1);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreachable or unparseable classifier holds the whole tick', async () => {
  const root = vault({ a: card('a') });
  try {
    assert.equal(await classify(root, [candidate('git:1', 'a')], async () => null), null);
    assert.equal(await classify(root, [candidate('git:1', 'a')], async () => 'I refuse'), null);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the local classifier uses Ollama without exposing tools', async () => {
  const original = globalThis.fetch;
  let request: { url: string; body: Record<string, unknown> } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = {
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(
      JSON.stringify({
        message: { content: '[{"fp":"x","decision":"keep","reason":"wanted"}]' },
        prompt_eval_count: 1200,
        eval_count: 40,
        total_duration: 2_500_000_000,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const reply = await ollamaAsk('http://127.0.0.1:11434/', 'local-model')('rules', '[{"fp":"x"}]');
    assert.ok(reply && typeof reply === 'object', 'the answer carries what it cost');
    assert.match(reply.text, /"decision":"keep"/);
    // Ollama's own clock and counts, so a tick can say what judging cost.
    assert.deepEqual(reply.cost, { ms: 2500, inputTokens: 1200, outputTokens: 40 });
    assert.ok(request);
    const seen = request as unknown as { url: string; body: Record<string, unknown> };
    assert.equal(seen.url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(seen.body.model, 'local-model');
    assert.equal(seen.body.think, false);
    assert.equal(seen.body.format, 'json');
    assert.equal('tools' in seen.body, false, 'classification has no tool surface');
  } finally {
    globalThis.fetch = original;
  }
});

test('a vault may override the judgment without editing the app', () => {
  const root = vault({ a: card('a') });
  try {
    let seen = '';
    const spy: Ask = async (system) => {
      seen = system;
      return '[]';
    };
    writeFileSync(join(paths(root).config, 'classify.md'), 'Only keep things about badgers.', 'utf8');
    return classify(root, [candidate('git:1', 'a')], spy).then(() => {
      assert.match(seen, /badgers/, 'the vault’s own instructions are what the model is given');
    });
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the prompt that reaches a model carries the secrets rule', async () => {
  const root = vault({ a: card('a') });
  try {
    // The pipeline writes notes from swept text with nobody watching, and a
    // scratchpad DM is exactly where a plaintext credential ends up. Pinned as
    // wording because the rule lives in prompts: a later edit must not drop it
    // silently.
    let seen = '';
    const spy: Ask = async (system) => {
      seen = system;
      return '[]';
    };
    await classify(root, [candidate('git:1', 'a')], spy);
    assert.match(seen, /value was withheld/, 'the classifier is told to withhold a secret’s value');
    // The copying half of the rule is the connectors' now: they redact known
    // credential shapes in code before anything reaches the kernel
    // (`kernel/connectors/connector.bb`, `scrub`), so the judge only ever reads
    // what is left.
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The two channels an agent fetches are the two that had no ref of their own, so
 * they wrote the dedup key into `links` and the panel drew a Slack channel/ts
 * pair as dead text under a `slack` chip. A fingerprint is not a link; `git` is
 * the channel that always knew that.
 */
test('a fetched message links its permalink, never its fingerprint', () => {
  const permalink = 'https://acme.slack.com/archives/C01234567/p1700000000000100';
  assert.deepEqual(linkFor('slack', permalink), [`slack:${permalink}`]);
  // Every one of these reaches `fallbackHref` as `null` — an unclickable link is
  // worse than none, because it looks like the app failed rather than like the
  // channel having nothing to point at.
  for (const notAUrl of ['C01234567/1700000000.000100', '1700000000.000100', '', 'slack:x']) {
    assert.deepEqual(linkFor('slack', notAUrl), [], notAUrl || '(empty)');
  }

  // Gmail stays out of the kind vocabulary: nothing fetches a thread, so a
  // `gmail:` prefix would be a `url` with extra words — and `parseLink` would
  // read it as no kind at all, which is how those rows drew an empty chip.
  const thread = 'https://mail.google.com/mail/u/0/#inbox/18f2c0a1b2c3d4e5';
  assert.deepEqual(linkFor('gmail', thread), [thread]);
  assert.equal(parseLink(linkFor('gmail', thread)[0]!).kind, 'url');
  assert.deepEqual(linkFor('gmail', '18f2c0a1b2c3d4e5'), []);
});

test('deleting a card on the board is a decline, so the sweep stops offering it', () => {
  const root = vault({ a: card('a') });
  try {
    const res = materialise(root, 'git', asKept([candidate('git:1', 'A thing')]));
    const id = res.created[0]!;

    // The gesture that obviously means no. Before this it destroyed the one thing
    // stopping the next sweep re-proposing the card. `⌫` on a card is `discard`,
    // which declines it; `pj rm` only deletes, and `pj decline` is the shell's no.
    discard(root, id);
    const rows = suppressions(root).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.fingerprint, 'git:1');
    assert.equal(rows[0]!.decidedBy, 'person', 'deleting a file is a person deciding');

    /*
     * The reason names the act; the title names the note. They used to say the
     * same thing — the reason appended `(was "A thing")` beside a `title` column
     * already holding it — and a reason that restates its neighbour is a column
     * of the declined pile, and a line of the classifier's calibration block,
     * spent saying nothing.
     */
    assert.equal(rows[0]!.title, 'A thing');
    assert.equal(rows[0]!.reason, 'declined from the queue');
    assert.ok(!rows[0]!.reason.includes('A thing'), 'the reason does not restate the title');

    // And it holds: materialising the same candidate again writes nothing,
    // because the sweep would never hand it over in the first place.
    assert.ok(suppressedFingerprints(root).has('git:1'));
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a model decline and a person decline are told apart', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:1', reason: 'routine', by: 'model' });
    suppress(root, { fingerprint: 'git:2', reason: 'not interested' });
    const by = new Map(suppressions(root).rows.map((s) => [s.fingerprint, s.decidedBy]));
    assert.equal(by.get('git:1'), 'model');
    assert.equal(by.get('git:2'), 'person');

    // A person overruling the model is the later decision, and the pile says so.
    suppress(root, { fingerprint: 'git:1', reason: 'agreed, actually', by: 'person' });
    assert.equal(
      suppressions(root).rows.find((s) => s.fingerprint === 'git:1')?.decidedBy,
      'person',
    );
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate that extends a match lands pointing at it, ready to merge', async () => {
  const root = vault({ a: card('a') });
  const judge: Ask = async () =>
    '[{"fp":"git:1","decision":"extend","target":"a","reason":"more of the same work","title":"More on the retry bug","body":"Another commit on the same branch."}]';
  try {
    const res = await classify(
      root,
      [candidate('git:1', 'fix: another go', { evidence: { matches: [{ id: 'a', title: 'A', why: 'branch' }] } })],
      judge,
    );
    const kept = res!.keep;
    assert.equal(kept[0]!.verdict.decision, 'extend');
    assert.equal(kept[0]!.verdict.target, 'a');

    const out = materialise(root, 'git', kept);
    assert.equal(out.extending, 1);
    const rec = [...reindex(root).notes.values()].find((n) => n.id === out.created[0]);
    assert.deepEqual(rec!.facets.extends, ['a'], 'it points at what it wants folding into');
    assert.equal(rec!.title, 'More on the retry bug', 'and carries a title a person would use');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invented merge target is refused, and the candidate stands alone', async () => {
  const root = vault({ a: card('a') });
  // A target must be one of the mechanical matches. Anything else is a model
  // inventing a relationship, and demoting to `keep` loses nothing.
  const inventive: Ask = async () =>
    '[{"fp":"git:1","decision":"extend","target":"a-note-that-does-not-exist","reason":"x"}]';
  try {
    const res = await classify(root, [candidate('git:1', 'a')], inventive);
    assert.equal(res!.keep[0]!.verdict.decision, 'keep');
    assert.equal(res!.keep[0]!.verdict.target, undefined);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invented facet value is dropped, and the rest of the card survives', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(
    paths(root).facets,
    'priority:\n  values: [now, month]\n  single: true\n  open: false\n',
    'utf8',
  );
  const generous: Ask = async () =>
    '[{"fp":"git:1","decision":"keep","reason":"x","title":"A real title","facets":{"priority":["urgent-ish"],"nonsense":["x"]}}]';
  try {
    const res = await classify(root, [candidate('git:1', 'a')], generous);
    const v = res!.keep[0]!.verdict;
    // A card with a good title and one invented facet is still worth having; a
    // refused write is not.
    assert.deepEqual(v.facets, {}, 'the undeclared value and the unknown axis both go');
    assert.equal(v.title, 'A real title');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a model may not set the app’s own axes', async () => {
  const root = vault({ a: card('a') });
  const overreaching: Ask = async () =>
    '[{"fp":"git:1","decision":"keep","reason":"x","facets":{"intake":[],"extends":["a"]}}]';
  try {
    const res = await classify(root, [candidate('git:1', 'a')], overreaching);
    assert.deepEqual(res!.keep[0]!.verdict.facets, {}, 'intake and extends are the pipeline’s');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The declined pile only grows, so reading it is a paged, searchable question
 * rather than "give me the table".
 */

test('a page stops, says there is more, and resumes without repeating', () => {
  const root = vault({ a: card('a') });
  try {
    for (let i = 0; i < 7; i++) {
      suppress(root, { fingerprint: `git:${i}`, reason: `reason ${i}`, title: `thing ${i}` });
    }
    const first = suppressions(root, { limit: 3 });
    assert.equal(first.rows.length, 3);
    assert.equal(first.more, true);
    assert.equal(first.total, 7, 'the total ignores the page');
    assert.equal(first.matching, 7, 'and so does what matches, with nothing to match on');

    // Paged on the row, not an offset: a suppression landing between two reads
    // must not shift a row into a page that has already gone past.
    const second = suppressions(root, { limit: 3, before: cursorOf(first.rows.at(-1)!) });
    const seen = new Set([...first.rows, ...second.rows].map((r) => r.fingerprint));
    assert.equal(seen.size, first.rows.length + second.rows.length, 'no row read twice');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Where the next page starts: the previous one's last row, both halves. */
const cursorOf = (row: { at: string; fingerprint: string }) => ({
  at: row.at,
  fingerprint: row.fingerprint,
});

/**
 * The pile is written by a sweep, and a sweep declines in a synchronous loop —
 * so `at` is a millisecond several rows can share, and `at DESC` alone is not an
 * order. Walking a pile of ties used to lose every row that shared the boundary
 * instant with the one a page ended on.
 */
test('a page walks a pile whose rows share an instant', () => {
  const root = vault({ a: card('a') });
  try {
    for (let i = 0; i < 9; i++) suppress(root, { fingerprint: `git:${i}`, reason: 'one sweep' });
    // Every row to the same instant, which is what a fast sweep produces anyway.
    openIntakeDb(root).exec("UPDATE suppressed SET at = '2026-08-30T09:00:00.000Z'");

    const seen: string[] = [];
    let page = suppressions(root, { limit: 4 });
    for (;;) {
      seen.push(...page.rows.map((r) => r.fingerprint));
      if (!page.more) break;
      page = suppressions(root, { limit: 4, before: cursorOf(page.rows.at(-1)!) });
    }

    assert.equal(new Set(seen).size, 9, 'every row is reached exactly once');
    assert.deepEqual(
      [...seen].sort(),
      Array.from({ length: 9 }, (_, i) => `git:${i}`).sort(),
    );
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('search reaches the reason, not only the title', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:1', title: 'tidy the imports', reason: 'own routine commit' });
    suppress(root, { fingerprint: 'git:2', title: 'bump eslint', reason: 'dependency bump' });

    // Someone hunting a card they half-remember may remember how the refusal was
    // worded rather than what the thing was called.
    assert.deepEqual(suppressions(root, { q: 'routine' }).rows.map((r) => r.fingerprint), ['git:1']);
    assert.deepEqual(suppressions(root, { q: 'eslint' }).rows.map((r) => r.fingerprint), ['git:2']);
    assert.equal(suppressions(root, { q: 'nothing like this' }).rows.length, 0);

    // And the total stays the whole pile, because it is what the footer counts,
    // while `matching` honours the search, because it is what a pager counts:
    // "1 of 2 declined" is one sentence about one population either way round.
    assert.equal(suppressions(root, { q: 'routine' }).total, 2);
    assert.equal(suppressions(root, { q: 'routine' }).matching, 1);
    assert.equal(suppressions(root, { q: 'nothing like this' }).matching, 0);

    // A page of a filtered pile counts the filter, not the page: this is the
    // number a "page 1 of N" is divided out of, and reading it off `total` would
    // promise pages that do not exist.
    const paged = suppressions(root, { q: 'bump', limit: 1 });
    assert.equal(paged.matching, 1);
    assert.equal(paged.more, false, 'and there is nothing behind a page that holds all of the matches');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The spike: fetching what `pj` has no credential for, learning from what was
 * decided, and interrupting for the little that cannot wait.
 */

test('a rescue is kept after the decline it corrects is gone', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:1', reason: 'routine commit', title: 'tidy', by: 'model' });
    assert.ok(unsuppress(root, 'git:1'));

    // The suppression is gone and the correction is not. This is the signal that
    // says the judgment was wrong the expensive way, and it existed nowhere
    // before — the row it corrects was simply deleted.
    assert.equal(suppressions(root).rows.length, 0);
    const back = rescues(root);
    assert.equal(back.length, 1);
    assert.equal(back[0]!.fingerprint, 'git:1');
    assert.equal(back[0]!.reason, 'routine commit', 'and it remembers what it was declined for');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Taking a decline back has to bring the item within reach, or the pile's one
 * repair is a no-op. The connector event was judged, so it sits behind the
 * channel's cursor; the decline carried its kernel id, the rescue carries it on,
 * and the next pass reads it back (`projector/connector-event`) and offers it
 * to the judge once more — once, whatever the judge says.
 */
test('taking a decline back offers its connector event to the judge again, once', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(settingsPath(root), kernelOn(), 'utf8');
  const commit = gitEvent('r', 'd1', 'Rotate the signing key', 'main');
  const asked: string[][] = [];
  const judgeWith = (decision: string): Ask => async (_s, user) => {
    const fps = (JSON.parse(user) as { fp: string }[]).map((c) => c.fp);
    asked.push(fps);
    return JSON.stringify(fps.map((fp) => ({ fp, decision, reason: decision === 'drop' ? 'routine' : 'a key to rotate', title: 'Rotate the signing key' })));
  };
  try {
    await againstFake(
      async () => {
        writeFileSync(join(process.env.FAKE_KERNEL_QUERIES!, 'connector-event.json'), JSON.stringify(connectorAnswerOf([commit])), 'utf8');
        await pollOnce(root, judgeWith('drop'));
        const row = openIntakeDb(root).prepare('SELECT event FROM suppressed WHERE fingerprint = ?').get('git:r@d1') as { event: string };
        assert.equal(row.event, eventId(commit.key), 'the model’s decline carries the connector event it was of');

        assert.deepEqual(unsuppress(root, 'git:r@d1'), { fingerprint: 'git:r@d1', event: eventId(commit.key) });
        const back = await pollOnce(root, judgeWith('area'));
        assert.deepEqual(asked.at(-1), ['git:r@d1'], 'offered again, though the cursor has passed it');
        assert.equal(back.created.length, 1, 'and kept this time');

        await pollOnce(root, judgeWith('area'));
        assert.equal(asked.length, 2, 'and offered once: the next pass asks nothing');
      },
      {},
      [commit],
    );
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('declining an offer teaches the classifier; discarding a note you kept does not', async () => {
  const root = vault({
    a: card('a'),
    offered: card('offered', 'source_fingerprint: git:1\nfacets: { intake: [unjudged] }\n'),
    mine: card('mine', 'source_fingerprint: git:2\n'),
  });
  try {
    discard(root, 'offered');
    deleteNote(root, 'mine');

    // Both stop a later sweep re-proposing the thing. That half is the same act.
    assert.equal(suppressedFingerprints(root).size, 2);
    const rows = suppressions(root).rows;
    assert.deepEqual(
      rows.map((r) => [r.fingerprint, r.wasJudged]).sort(),
      [
        ['git:1', false],
        ['git:2', true],
      ],
    );

    let seen = '';
    await classify(root, [candidate('git:9', 'x')], async (system) => {
      seen = system;
      return '[]';
    });

    assert.match(seen, /offered/, 'a card turned down is a verdict on the offer');
    assert.doesNotMatch(
      seen,
      /mine/,
      'a note you accepted and then let go says the work is finished, not that it should never have been shown',
    );
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('rescues, declines and kept notes all reach the prompt, rescues first', async () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:1', reason: 'looked routine', title: 'the one it got wrong' });
    unsuppress(root, 'git:1');
    suppress(root, { fingerprint: 'git:2', reason: 'genuinely noise', title: 'the one it got right' });

    let seen = '';
    await classify(root, [candidate('git:9', 'x')], async (system) => {
      seen = system;
      return '[]';
    });

    assert.match(seen, /the one it got wrong/, 'the rescue is shown');
    assert.match(seen, /the one it got right/, 'and so is the decline that stood');
    assert.ok(
      seen.indexOf('RESCUED') < seen.indexOf('  NO   '),
      'the rescue leads: getting one of those wrong costs the item',
    );
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the calibration block is absent when nothing has been decided', async () => {
  const root = vault({ a: card('a') });
  try {
    let seen = '';
    await classify(root, [candidate('git:1', 'x')], async (system) => {
      seen = system;
      return '[]';
    });
    // A heading with nothing under it teaches a model that this reader decides
    // nothing, which is worse than saying nothing at all.
    assert.doesNotMatch(seen, /What this reader has actually decided/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('interrupting is a second, higher bar than deserving a note', async () => {
  const root = vault({ a: card('a') });
  const judge: Ask = async () =>
    '[{"fp":"git:1","decision":"keep","reason":"a","title":"Ordinary","notify":false},' +
    ' {"fp":"git:2","decision":"keep","reason":"b","title":"Someone is blocked","notify":true}]';
  try {
    const res = await classify(root, [candidate('git:1', 'a'), candidate('git:2', 'b')], judge);
    const out = materialise(root, 'git', res!.keep);
    assert.equal(out.created.length, 2, 'both deserve a note');
    assert.deepEqual(
      out.notify.map((n) => n.title),
      ['Someone is blocked'],
      'and only one is worth interrupting for',
    );
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate that was not written cannot interrupt anyone', async () => {
  const root = vault({ a: card('a') });
  const judge: Ask = async () =>
    '[{"fp":"git:1","decision":"keep","reason":"a","title":"Urgent","notify":true}]';
  try {
    const kept = (await classify(root, [candidate('git:1', 'a')], judge))!.keep;
    assert.equal(materialise(root, 'git', kept).notify.length, 1);

    // Second time it is a duplicate and nothing is written — so nothing fires.
    // Being interrupted about something that turned out to already exist is the
    // fastest way to have notifications turned off.
    assert.equal(materialise(root, 'git', kept).notify.length, 0);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Rejudging: the only operation that overwrites a note rather than creating one,
 * so what it may touch is the whole of what is worth pinning.
 */

test('rejudge rewrites an unjudged card and leaves a judged one alone', async () => {
  const root = vault({
    raw: `---\nid: raw\ntitle: "ok so the thing is broken can you look"\nfacets: { intake: [unjudged] }\n---\nsome cwd @ some branch\n`,
    mine: `---\nid: mine\ntitle: "A title I chose"\nfacets: { }\n---\nmy own words\n`,
  });
  const judge: Ask = async (_s, user) =>
    JSON.stringify(
      (JSON.parse(user) as { fp: string }[]).map((c) => ({
        fp: c.fp,
        decision: 'keep',
        reason: 'x',
        title: 'The thing is broken',
        body: 'Rewritten.',
      })),
    );
  try {
    const res = await rejudge(root, { ask: judge });
    assert.deepEqual(res.changed.map((c) => c.id), ['raw']);

    const after = reindex(root).notes;
    assert.equal(after.get('raw')!.title, 'The thing is broken');
    assert.deepEqual(after.get('raw')!.facets.intake, ['unjudged'], 'it is still unjudged');

    // Accepting is what makes a card yours, and this one has been accepted —
    // there is no `intake` on it, so the pass is not entitled to an opinion.
    assert.equal(after.get('mine')!.title, 'A title I chose');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejudge never deletes, however sure the pass is', async () => {
  const root = vault({
    raw: `---\nid: raw\ntitle: "routine commit"\nfacets: { intake: [unjudged] }\n---\nbody\n`,
  });
  const judge: Ask = async (_s, user) =>
    JSON.stringify(
      (JSON.parse(user) as { fp: string }[]).map((c) => ({
        fp: c.fp,
        decision: 'drop',
        reason: 'own routine progress',
      })),
    );
  try {
    const res = await rejudge(root, { ask: judge });
    // Named, not removed. The card may have a body somebody has written on since,
    // and the asymmetry that governs intake governs this harder.
    assert.deepEqual(res.wouldDrop.map((w) => w.id), ['raw']);
    assert.equal(res.changed.length, 0);
    assert.ok(reindex(root).notes.has('raw'), 'the file is still there');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejudge that cannot reach the classifier rewrites nothing', async () => {
  const root = vault({
    raw: `---\nid: raw\ntitle: "original"\nfacets: { intake: [unjudged] }\n---\nbody\n`,
  });
  try {
    const res = await rejudge(root, { ask: async () => null });
    assert.ok(res.held);
    assert.equal(res.changed.length, 0);
    assert.equal(reindex(root).notes.get('raw')!.title, 'original');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a card the pass agrees with is counted, not rewritten', async () => {
  // Carrying the quoted reason, because that is what the pass writes — a card
  // materialised by this version leads with why it was kept.
  const root = vault({
    raw: `---\nid: raw\ntitle: "Already right"\nfacets: { intake: [unjudged] }\n---\n> x\n\nAlready said.\n`,
  });
  const judge: Ask = async (_s, user) =>
    JSON.stringify(
      (JSON.parse(user) as { fp: string }[]).map((c) => ({
        fp: c.fp,
        decision: 'keep',
        reason: 'x',
        title: 'Already right',
        body: 'Already said.',
      })),
    );
  try {
    // A write that changes nothing still moves the file's `updated` stamp, which
    // would make every rejudge look like a day's work on the whole queue.
    const res = await rejudge(root, { ask: judge });
    assert.equal(res.same, 1);
    assert.equal(res.changed.length, 0);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * And the other half of the same rule: a card from before the reason was written
 * down *is* rewritten, once. That is what the pass is for — the same catch-up a
 * changed `classify.md` gets — and the second run then agrees with itself.
 */
test('a card written before the reason was carried catches up, then settles', async () => {
  const root = vault({
    raw: `---\nid: raw\ntitle: "Already right"\nfacets: { intake: [unjudged] }\n---\nAlready said.\n`,
  });
  const judge: Ask = async (_s, user) =>
    JSON.stringify(
      (JSON.parse(user) as { fp: string }[]).map((c) => ({
        fp: c.fp,
        decision: 'keep',
        reason: 'x',
        title: 'Already right',
        body: 'Already said.',
      })),
    );
  try {
    assert.equal((await rejudge(root, { ask: judge })).changed.length, 1);
    assert.match(readFileSync(place(root, 'inbox', 'raw.md'), 'utf8'), /---\n\n> x\n\nAlready said\.\n$/);
    assert.equal((await rejudge(root, { ask: judge })).same, 1, 'and it stops moving');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a date axis is described by what it accepts, not by what notes carry', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(
    paths(root).facets,
    'due:\n  label: Due\n  type: date\n  single: true\nstatus:\n  values: [active, done]\n',
    'utf8',
  );
  try {
    let seen = '';
    await classify(root, [candidate('slack:1', 'x')], async (system) => {
      seen = system;
      return '[]';
    });
    // Listing the dates other notes happen to hold tells a model nothing about
    // the shape to write, and it will offer "Friday".
    assert.match(seen, /due \(single value; a date, YYYY-MM-DD\)/);
    assert.match(seen, /status.*active, done/, 'a label axis still lists its values');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rewritten body keeps the blank line the file format wants', async () => {
  const root = vault({
    raw: `---\nid: raw\ntitle: "before"\nfacets: { intake: [unjudged] }\n---\n\nold body\n`,
  });
  const judge: Ask = async (_s, user) =>
    JSON.stringify(
      (JSON.parse(user) as { fp: string }[]).map((c) => ({
        fp: c.fp,
        decision: 'keep',
        reason: 'x',
        title: 'after',
        body: 'A new body.',
      })),
    );
  try {
    await rejudge(root, { ask: judge });
    const text = readFileSync(place(root, 'inbox', 'raw.md'), 'utf8');

    // `patchNote` writes a body verbatim on purpose — the panel hands back the
    // bytes it read — so a model's bare prose arrives welded to the closing
    // fence unless the caller does what `createNote` does.
    assert.match(text, /---\n\n> x\n\nA new body\.\n$/);
    assert.doesNotMatch(text, /---\n>/, 'no blank line is a malformed note');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejudge that keeps the body does not grow it a line at a time', async () => {
  const root = vault({
    raw: `---\nid: raw\ntitle: "before"\nfacets: { intake: [unjudged] }\n---\n\nkeep me\n`,
  });
  // No body in the verdict: the note's own bytes are already normalised, and
  // normalising them again would add a line on every pass.
  const judge: Ask = async (_s, user) =>
    JSON.stringify(
      (JSON.parse(user) as { fp: string }[]).map((c) => ({
        fp: c.fp,
        decision: 'keep',
        reason: 'x',
        title: 'after',
      })),
    );
  try {
    await rejudge(root, { ask: judge });
    await rejudge(root, { ask: judge });
    const text = readFileSync(place(root, 'inbox', 'raw.md'), 'utf8');
    assert.match(text, /---\n\nkeep me\n$/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});


// ------------------------------------------------------------ conversations

/**
 * The connectors write one event per message; a pass groups them into the
 * conversations they belong to, marks the owner's own lines, and finds the open
 * note that tracks each. These are the tests of that computing half, on events
 * shaped the way the slack and gmail connectors write them.
 */

const P = (channel: string, ts: string) => `https://acme.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
const slackTsToIso = (ts: string) => new Date(Number(ts) * 1000).toISOString();
const slackEvent = (channel: string, ts: string, author: string, text: string, over: Record<string, unknown> = {}): ConnectorEvent =>
  ev(`slack:${channel}/${ts}`, 'slack/message', slackTsToIso(ts), [`slack:channel:${channel}`, ...(author === 'kernel:owner' ? ['kernel:owner'] : [])], {
    channel,
    channel_name: author === 'kernel:owner' ? 'Someone' : author,
    ts,
    author,
    text,
    to_owner: author !== 'kernel:owner',
    mentions_owner: false,
    permalink: P(channel, ts),
    ...over,
  });
const gmailEvent = (thread: string, message: string, at: string, from: string, snippet: string, subject = 'Weekly report'): ConnectorEvent =>
  ev(`gmail:${thread}@${message}`, 'gmail/message', at, [`gmail:thread:${thread}`, ...(from === 'kernel:owner' ? ['kernel:owner'] : [])], {
    thread,
    subject,
    from,
    snippet,
    labels: from === 'kernel:owner' ? ['SENT'] : ['INBOX'],
    url: `https://mail.google.com/mail/u/0/#all/${thread}`,
    message,
  });

test('Slack messages become conversations that say whose move it is', () => {
  const root = vault({ a: card('a') });
  try {
    const { candidates, skipped } = mapEvents('slack', context(root), [
      // An ask nobody answered.
      slackEvent('D0AAAAAAA', '1788344704.998749', 'Marthe', 'do you have time this week to check the submissions?'),
      // An ask, answered eleven minutes later — the case a summariser could not see.
      slackEvent('D0BBBBBBB', '1788340111.790849', 'Vivek', 'can you help me pull the AWS contract?'),
      slackEvent('D0BBBBBBB', '1788340789.000001', 'kernel:owner', 'never seen one, finance maybe?'),
      // Only the owner spoke: nothing to react to.
      slackEvent('D0CCCCCCC', '1788340000.000001', 'kernel:owner', 'sent you the link'),
      // A reply in a thread is its own conversation.
      slackEvent('C0DDDDDDD', '1788350000.000002', 'Gerard', 'metadata on each definition?', { thread: '1788349000.000001', channel_name: 'data' }),
    ]);
    const byFp = new Map(candidates.map((c) => [c.fingerprint, c]));
    assert.deepEqual([...byFp.keys()].sort(), [
      'slack:C0DDDDDDD/1788350000.000002',
      'slack:D0AAAAAAA/1788344704.998749',
      'slack:D0BBBBBBB/1788340111.790849',
    ]);
    const field = (fp: string, k: string) => byFp.get(fp)!.fields!.find((f) => f.k === k)?.v ?? '';
    assert.match(field('slack:D0AAAAAAA/1788344704.998749', 'ball'), /it is with you/, 'she spoke last');
    assert.match(field('slack:D0BBBBBBB/1788340111.790849', 'ball'), /you had the last word/, 'the owner answered');
    assert.match(
      field('slack:D0BBBBBBB/1788340111.790849', 'conversation'),
      /Vivek: can you help.*\n.*you: never seen one/s,
      'the exchange, oldest first, the owner marked — the classifier reads it and decides',
    );
    assert.deepEqual(
      skipped.map((s) => s.why),
      ['your own message', 'your own message'],
      'the owner’s own words are not news to them; they are skipped, and recorded',
    );
    const marthe = byFp.get('slack:D0AAAAAAA/1788344704.998749')!;
    assert.deepEqual(marthe.links, [`slack:${P('D0AAAAAAA', '1788344704.998749')}`], 'the permalink, never the fingerprint');
    assert.equal(marthe.event?.key, 'slack:D0AAAAAAA/1788344704.998749', 'the connector event it is');
    assert.deepEqual(slackPermalinkParts(P('D0AAAAAAA', '1788344704.998749')), { channel: 'D0AAAAAAA', ts: '1788344704.998749' });
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('several asks in one conversation are one candidate, the rest folded into it', () => {
  const root = vault({ a: card('a') });
  try {
    const { candidates, skipped } = mapEvents('slack', context(root), [
      slackEvent('D0AAAAAAA', '1788344704.000001', 'Marthe', 'are you there?'),
      slackEvent('D0AAAAAAA', '1788344705.000001', 'Marthe', 'can you check the submissions?'),
    ]);
    assert.deepEqual(candidates.map((c) => c.fingerprint), ['slack:D0AAAAAAA/1788344704.000001'], 'a discovery is keyed by its first ask');
    assert.deepEqual(skipped.map((s) => s.why), ['folded into slack:D0AAAAAAA/1788344704.000001']);
    assert.match(candidates[0]!.detail ?? '', /2 new message\(s\)/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Slack message the connector copied no permalink for still links back, on the workspace the vault already uses', () => {
  const msg = (channel: string, ts: string, over: Partial<Message> = {}): Message => ({
    event: 'e',
    channel,
    channelName: 'Ruud',
    id: ts,
    at: slackTsToIso(ts),
    from: 'Ruud',
    mine: false,
    text: 'how much time can you spend on TOS?',
    ...over,
  });
  const bare = [msg('D0AAAAAAA', '1788344704.998749'), msg('C0DDDDDDD', '1788350000.000002', { thread: '1788349000.000001' })];
  // Off a permalink this pass has…
  const fromRun = withPermalinks([...bare, msg('D0BBBBBBB', '1788340111.790849', { url: P('D0BBBBBBB', '1788340111.790849') })], []);
  assert.equal(fromRun[0]!.url, P('D0AAAAAAA', '1788344704.998749'));
  assert.equal(
    fromRun[1]!.url,
    `${P('C0DDDDDDD', '1788350000.000002')}?thread_ts=1788349000.000001&cid=C0DDDDDDD`,
    'a reply opens in its thread, as Slack writes the link',
  );
  // …or off one a note already carries.
  const fromVault = withPermalinks(bare, [`slack:${P('D0ZZZZZZZ', '1788000000.000001')}`]);
  assert.deepEqual(slackPermalinkParts(fromVault[0]!.url!), { channel: 'D0AAAAAAA', ts: '1788344704.998749' });
  assert.deepEqual(withPermalinks(bare, []), bare, 'with no host anywhere, nothing is invented');
});

test('a conversation on an open note is an update; on a closed one, or none, it is not', () => {
  const root = vault({
    open: `---\nid: open\ntitle: Check the submissions\nfacets: { status: [active] }\nlinks: ['slack:${P('D0AAAAAAA', '1788000000.000001')}']\n---\n\nb\n`,
    closed: `---\nid: closed\ntitle: Old AWS thing\nfacets: { status: [done] }\nlinks: ['slack:${P('D0BBBBBBB', '1788000000.000002')}']\n---\n\nb\n`,
    swept: `---\nid: swept\ntitle: A swept thread reply\nsource_fingerprint: slack:C0DDDDDDD/1788349000.000001\n---\n\nb\n`,
  });
  writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n  closed: [done]\n  single: true\n', 'utf8');
  try {
    const { candidates } = mapEvents('slack', context(root), [
      slackEvent('D0AAAAAAA', '1788344704.998749', 'Marthe', 'any news?'),
      slackEvent('D0AAAAAAA', '1788344705.000001', 'Marthe', 'and the deadline?'),
      slackEvent('D0BBBBBBB', '1788340111.790849', 'Vivek', 'one more thing'),
      slackEvent('C0DDDDDDD', '1788350000.000002', 'Gerard', 'and the sequence?', { thread: '1788349000.000001' }),
      slackEvent('D0EEEEEEE', '1788350000.000003', 'Oliver', 'got an issue with the thing'),
    ]);
    const of = (channel: string) => candidates.find((c) => c.fingerprint.startsWith(`slack:${channel}/`))!;

    // Same DM as a message an open note links: tracked, by container.
    const update = of('D0AAAAAAA');
    assert.equal(update.fingerprint, 'slack:D0AAAAAAA/1788344705.000001', 'keyed by the newest ask, so each exchange is its own offer');
    assert.deepEqual(update.evidence?.linkedTo, ['open'], 'and it says which note it is news about');
    assert.equal(update.evidence?.matches?.[0]?.why, 'tracked', 'first among its matches, so extend may name it');
    assert.match(update.detail ?? '', /already on open/);

    // Same DM as a message a *closed* note links: not tracked — finished work
    // does not hear about later chatter.
    assert.equal(of('D0BBBBBBB').evidence?.linkedTo, undefined);
    // A thread whose root a swept note answers for, by fingerprint.
    assert.deepEqual(of('C0DDDDDDD').evidence?.linkedTo, ['swept']);
    // Nothing tracks Oliver: a discovery, fingerprinted by its first ask.
    const fresh = of('D0EEEEEEE');
    assert.equal(fresh.fingerprint, 'slack:D0EEEEEEE/1788350000.000003');
    assert.equal(fresh.evidence?.linkedTo, undefined);
    assert.ok(fresh.fields?.some((f) => f.k === 'conversation'), 'the classifier is handed the exchange');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gmail messages become threads, and the owner’s own mail is marked', () => {
  const root = vault({ a: card('a') });
  try {
    const { candidates, skipped } = mapEvents('gmail', context(root), [
      gmailEvent('1a05c9cf17367981', '1a05c9cf17367981', '2026-09-01T10:56:12.000Z', 't@example.com', 'could you help with the weekly report'),
      gmailEvent('1a060d74b08da162', '1a060d74b08da162', '2026-09-02T06:38:36.000Z', 's@example.com', 'please create the product version', 'Product version'),
      gmailEvent('1a060d74b08da162', '1a060d74b08da163', '2026-09-02T07:00:00.000Z', 'kernel:owner', 'done, see the release page', 'Product version'),
    ]);
    const report = candidates.find((c) => c.fingerprint === 'gmail:1a05c9cf17367981')!;
    assert.ok(report, 'a discovery is the thread');
    assert.deepEqual(report.links, ['https://mail.google.com/mail/u/0/#all/1a05c9cf17367981'], 'the thread URL, as a plain url');
    assert.equal(parseLink(report.links[0]!).kind, 'url');
    assert.match(report.fields!.find((f) => f.k === 'ball')!.v, /with you/);
    const version = candidates.find((c) => c.fingerprint === 'gmail:1a060d74b08da162')!;
    assert.match(version.fields!.find((f) => f.k === 'ball')!.v, /you had the last word/, 'SENT says the owner answered');
    assert.deepEqual(skipped.map((s) => s.why), ['your own message']);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Gmail thread an open note links is an update keyed by the new message', () => {
  const root = vault({
    a: `---\nid: a\ntitle: Weekly report\nfacets: { status: [active] }\nlinks: ['https://mail.google.com/mail/u/0/#inbox/1a05c9cf17367981']\n---\n\nb\n`,
  });
  try {
    const { candidates } = mapEvents('gmail', context(root), [
      gmailEvent('1a05c9cf17367981', '1a05c9cf17367999', '2026-09-03T10:00:00.000Z', 't@example.com', 'any update?'),
    ]);
    assert.deepEqual(candidates.map((c) => c.fingerprint), ['gmail:1a05c9cf17367981@1a05c9cf17367999'], 'either URL shape a note carries names the thread');
    assert.deepEqual(candidates[0]!.evidence?.linkedTo, ['a']);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a `claude -p` envelope’s cost is read defensively', () => {
  assert.deepEqual(costFromEnvelope({}, 1500), { ms: 1500 }, 'nothing but the caller’s clock');
  assert.deepEqual(
    costFromEnvelope({ duration_ms: 20, num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 7 } }, 99),
    { ms: 20, inputTokens: 5, outputTokens: 7, costUsd: 0.001, turns: 1 },
  );
  assert.equal(renderCost(undefined), '');
  assert.equal(renderCost({ ms: 2500 }), '2.5s');
});

// -------------------------------------------------------------------- the sync

test('a tracked candidate can only extend or drop, whatever the verdict says', async () => {
  const root = vault({ a: `---\nid: a\ntitle: The tracked note\nfacets: { status: [active] }\n---\n\nwhere it got to\n` });
  let payload = '';
  const judge: Ask = async (_system, user) => {
    payload = user;
    return '[{"fp":"slack:D1/1","decision":"keep","reason":"a new ask on the thread","title":"They asked again","facets":{"status":["active"]}}]';
  };
  try {
    const res = await classify(
      root,
      [
        candidate('slack:D1/1', 'any news?', {
          evidence: { linkedTo: ['a'], matches: [{ id: 'a', title: 'The tracked note', why: 'tracked' }] },
        }),
      ],
      judge,
    );
    const v = res!.keep[0]!.verdict;
    assert.equal(v.decision, 'extend', 'the older `keep` on tracked news is coerced');
    assert.equal(v.target, 'a', 'onto the note that tracks it');
    // The model was shown the note as it stands, so what it proposes is a delta.
    assert.match(payload, /"tracked":\[\{"id":"a","title":"The tracked note"/);
    assert.match(payload, /"body":"where it got to"/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an update lands as an extension of the note that tracks it, never beside it', () => {
  const root = vault({ a: card('a') });
  try {
    const tracked = candidate('slack:D1/2', 'Any news?', { evidence: { linkedTo: ['a'] } });
    // With a target: a delta card pointing at the note, counted as an update.
    const withTarget = materialise(root, 'slack', [
      { candidate: tracked, verdict: { fingerprint: tracked.fingerprint, decision: 'extend', reason: 'moved', target: 'a', title: 'They asked again' } },
    ]);
    assert.equal(withTarget.created.length, 1);
    assert.equal(withTarget.updates, 1);
    const rec = reindex(root).notes.get(withTarget.created[0]!)!;
    assert.deepEqual(rec.facets.extends, ['a']);
    assert.deepEqual(rec.facets.intake, ['unjudged']);

    // Without one — the classifier switched off — nothing is written: a second
    // note about tracked work is the duplicate the tracking exists to prevent.
    const bare = candidate('slack:D1/3', 'And again?', { evidence: { linkedTo: ['a'] } });
    const without = materialise(root, 'slack', asKept([bare]));
    assert.deepEqual(without.created, []);
    assert.equal(without.skipped, 1);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tracked Jira issue that moved is an update; a closed note hears nothing; a queued card has it already', () => {
  const root = vault({
    a: `---\nid: a\ntitle: Fix the thing\nfacets: { status: [active] }\nlinks: ['jira:PROJ-1']\n---\n\nb\n`,
    z: `---\nid: z\ntitle: Old thing\nfacets: { status: [done] }\nlinks: ['jira:PROJ-2']\n---\n\nb\n`,
    q: `---\nid: q\ntitle: A queued card\nintake: [unjudged]\nsource_fingerprint: jira:PROJ-4\nlinks: ['jira:PROJ-4']\n---\n\nb\n`,
  });
  writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n  closed: [done]\n  single: true\n', 'utf8');
  const issue = (key: string, summary: string, status: string, at: string) =>
    ev(`jira:${key}@${status} · unassigned`, 'jira/issue', at, [`jira:${key}`], { key, summary, status, assignee: 'unassigned', updated: at, type: 'Bug' });
  try {
    const { candidates, skipped } = mapEvents('jira', context(root), [
      issue('PROJ-1', 'Fix the thing', 'Done', '2026-09-01T10:00:00.000Z'),
      ev('jira:PROJ-1/changelog/1', 'jira/transition', '2026-09-01T10:00:00.000Z', ['jira:PROJ-1'], { key: 'PROJ-1', from: 'In Progress', to: 'Done', by: 'Olena' }),
      issue('PROJ-2', 'Old thing', 'Done', '2026-09-01T11:00:00.000Z'),
      issue('PROJ-3', 'Brand new', 'Open', '2026-09-01T12:00:00.000Z'),
      issue('PROJ-4', 'Already queued', 'Open', '2026-09-01T13:00:00.000Z'),
    ]);
    // The connector writes an issue event only when its status or assignee is
    // new, so every one is a move: an update is keyed per move, a discovery by the issue.
    assert.deepEqual(candidates.map((c) => c.fingerprint), ['jira:PROJ-1@2026-09-01T10:00:00.000Z', 'jira:PROJ-3']);
    const update = candidates[0]!;
    assert.deepEqual(update.evidence?.linkedTo, ['a']);
    assert.match(update.fields!.find((f) => f.k === 'moves')!.v, /In Progress → Done by Olena/, 'its transition folds into it');
    assert.ok(skipped.some((s) => /folded into PROJ-1/.test(s.why)));
    assert.ok(skipped.some((s) => s.fingerprint === 'jira:PROJ-2' && /closed/.test(s.why)), 'an issue only a finished note tracks is skipped, and says why');
    assert.ok(skipped.some((s) => s.fingerprint === 'jira:PROJ-4' && /still in the queue/.test(s.why)), 'a card is a proposal, and does not collect another');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});


test('a channel’s candidates are judged in batches, and the verdicts and cost merge', async () => {
  const root = vault({ a: card('a') });
  const calls: number[] = [];
  const judge: Ask = async (_system, user) => {
    const batch = JSON.parse(user) as { fp: string }[];
    calls.push(batch.length);
    return {
      text: JSON.stringify(batch.map((c) => ({ fp: c.fp, decision: c.fp.endsWith('0') ? 'drop' : 'keep', reason: 'r', title: `T ${c.fp}` }))),
      cost: { ms: 100, inputTokens: 50, outputTokens: 10 },
    };
  };
  try {
    const many = Array.from({ length: 20 }, (_, i) => candidate(`git:${i}`, `thing ${i}`));
    const res = await classify(root, many, judge, 8);
    // A slow local model cannot answer for twenty in one breath; three calls of
    // eight, eight and four, and nothing about the verdicts says which call.
    assert.deepEqual(calls, [8, 8, 4]);
    assert.equal(res!.keep.length + res!.drop.length, 20);
    assert.deepEqual(res!.drop.map((d) => d.candidate.fingerprint), ['git:0', 'git:10']);
    assert.deepEqual(res!.cost, { ms: 300, inputTokens: 150, outputTokens: 30 }, 'summed across the calls');

    // One batch the model cannot answer holds the whole channel: a half-judged
    // channel would advance its cursor past candidates nobody judged.
    let n = 0;
    const flaky: Ask = async () => (++n === 2 ? null : '[]');
    assert.equal(await classify(root, many, flaky, 8), null);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a channel judged before a hold keeps its cards and its record', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(settingsPath(root), kernelOn(), 'utf8');
  const events: FixtureEvent[] = [
    gitEvent('other', 'c1', 'Teach the widget to count'),
    { key: 'jira:PROJ-9@Open · Olena', kind: 'jira/issue', at: recent(30), about: ['jira:PROJ-9'], payload: { key: 'PROJ-9', summary: 'Review the API', status: 'Open', assignee: 'Olena' } },
  ];
  try {
    await againstFake(
      async (read) => {
        // The judge answers for git and dies on jira: what git earned stands.
        const judge: Ask = async (_s, user) =>
          user.includes('jira:PROJ-9') ? null : '[{"fp":"git:other@feature/x","decision":"area","reason":"new work","title":"Counting"}]';
        const res = await pollOnce(root, judge);
        assert.match(res.held ?? '', /jira/, 'the hold names the channel');
        assert.equal(res.created.length, 1, 'git’s card was written');
        const keys = read().batches.flatMap((b) => b.events.map((e) => e.key));
        assert.deepEqual(keys, ['intake:git:other:c1'], 'and recorded; jira was not, so the next pass reads it again');
      },
      {},
      events,
    );
  } finally {
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});




test('an unjudged card tracks nothing itself; one that extends a note stands in for it', () => {
  const root = vault({
    real: `---\nid: real\ntitle: The real note\nfacets: { status: [active] }\n---\n\nb\n`,
    // Last pass's card: a proposal pointing at the note, still in the queue.
    card: `---\nid: card\ntitle: A delta card\nfacets: { status: [active], intake: [unjudged], extends: [real] }\nlinks: ['slack:${P('D0AAAAAAA', '1788000000.000001')}']\nsource_fingerprint: slack:D0AAAAAAA/1788000000.000001\n---\n\nb\n`,
    // A proposal extending nothing, in another DM.
    loose: `---\nid: loose\ntitle: A loose card\nfacets: { status: [active], intake: [unjudged] }\nlinks: ['slack:${P('D0BBBBBBB', '1788000000.000002')}']\n---\n\nb\n`,
  });
  writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n  closed: [done]\n  single: true\n', 'utf8');
  try {
    const known = knownFor('slack', context(root));
    const m = (channel: string, ts: string, from: string): Message => ({ event: ts, channel, channelName: from, id: ts, at: slackTsToIso(ts), from, mine: false, text: 'and now?' });
    const convs = new Map(conversationsFrom('slack', [m('D0AAAAAAA', '1788344704.998749', 'Marthe'), m('D0BBBBBBB', '1788344704.998750', 'Vivek')]).map((c) => [c.key, c]));
    // The conversation the card came from is news about the *note*, not about
    // the card: an update onto a proposal would chain proposals.
    assert.deepEqual(trackedBy(convs.get('D0AAAAAAA')!, known), ['real']);
    // A proposal that extends nothing tracks nothing until somebody accepts it.
    assert.deepEqual(trackedBy(convs.get('D0BBBBBBB')!, known), []);
    assert.match(exchangeOf(convs.get('D0AAAAAAA')!), /Marthe: and now\?/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});


test('a tick outside the polling hours stays home, and the timer keeps its cadence', async () => {
  // The window arithmetic, including the one that wraps midnight.
  assert.equal(withinHours(9, { from: 8, until: 20 }), true);
  assert.equal(withinHours(20, { from: 8, until: 20 }), false, 'until is exclusive');
  assert.equal(withinHours(7, { from: 8, until: 20 }), false);
  assert.equal(withinHours(23, { from: 22, until: 6 }), true);
  assert.equal(withinHours(3, { from: 22, until: 6 }), true);
  assert.equal(withinHours(12, { from: 22, until: 6 }), false);
  assert.equal(withinHours(3, null), true, 'no window means always');

  // A vault whose window excludes this very hour: the loop starts, the first
  // tick is skipped, and the kernel is not even asked.
  const root = vault({ a: card('a') });
  const h = new Date().getHours();
  writeFileSync(settingsPath(root), `poll:\n  enabled: true\n  hours: [${(h + 1) % 24}, ${(h + 2) % 24}]\n${kernelOn()}`, 'utf8');
  try {
    await againstFake(async (read) => {
      assert.equal(startPolling(root), true, 'the loop is running');
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(read().calls, [], 'but the tick did not run');
      assert.deepEqual([...reindex(root).notes.keys()].filter((id) => id !== 'a'), [], 'and wrote nothing');
    });
  } finally {
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});


// ------------------------------------------------------------------ the window

/**
 * Where a channel reads from: its cursor — the newest connector event it judged
 * — bounded by its window. Intake is for current asks, so a cursor weeks old is
 * not followed back through asks settled since; the read starts at the window
 * and says what it stepped over.
 */
test('a channel reads from its cursor, or its window when it has none or the cursor is older', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const week = { defaultDays: 7 };
  assert.deepEqual(startOf(week, null, undefined, now), { since: '2026-10-09T12:00:00.000Z' }, 'never judged: the window');
  assert.deepEqual(startOf(week, '2026-10-15T08:00:00.000Z', undefined, now), { since: '2026-10-15T08:00:00.000Z' }, 'the cursor');
  const old = startOf(week, '2026-09-23T08:00:00.000Z', undefined, now);
  assert.equal(old.since, '2026-10-09T12:00:00.000Z', 'a cursor older than the window reads from the window');
  assert.match(old.note!, /cursor 2026-09-23 is older than the 7-day window: read from 2026-10-09/);
  assert.deepEqual(startOf(week, '2026-10-15T08:00:00.000Z', new Date('2026-01-01T00:00:00.000Z'), now), { since: '2026-01-01T00:00:00.000Z' }, '--since wins');
});

test('a backlog is judged a slice of candidates at a time, never cut between two events of one instant', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(settingsPath(root), kernelOn(), 'utf8');
  const at = recent(30);
  const events = [
    gitEvent('r', 's1', 'one', 'b1', recent(40)),
    gitEvent('r', 's2', 'two', 'b2', at),
    gitEvent('r', 's3', 'three', 'b3', at),
    gitEvent('r', 's4', 'four', 'b4', recent(20)),
  ];
  try {
    await againstFake(
      async () => {
        // Four branches, four candidates; two share an instant.
        const three = await pending(root, { only: ['git'], limit: 3 });
        assert.ok(three.ok);
        assert.equal(three.reports[0]!.read, 3, 'three candidates fit');
        assert.equal(three.reports[0]!.truncated, true, 'and it says more waits');
        assert.match(renderPreview(three), /more behind this slice/);
        const two = await pending(root, { only: ['git'], limit: 2 });
        assert.ok(two.ok);
        assert.equal(two.reports[0]!.read, 1, 'an instant is not split to fill a slice');
        // Skips cost the judge nothing, so they never fill one.
        writeFileSync(join(root, 'notes', 'r.md'), '---\nid: r\ntitle: r\nsource_fingerprint: git:r@b1\n---\n\nb\n', 'utf8');
        const skipping = await pending(root, { only: ['git'], limit: 3 });
        assert.ok(skipping.ok);
        assert.equal(skipping.reports[0]!.read, 4, 'a captured branch is a skip, and the slice takes all four');
      },
      {},
      events,
    );
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a catch-up interval defaults to ten minutes, is floored, and never exceeds the interval', () => {
  const root = vault({ a: card('a') });
  try {
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: 7200\n', 'utf8');
    assert.equal(settingsFor(root).poll.catchUpSeconds, 600);
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: 7200\n  catchUpSeconds: 5\n', 'utf8');
    assert.equal(settingsFor(root).poll.catchUpSeconds, 60);
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: 7200\n  catchUpSeconds: soon\n', 'utf8');
    assert.equal(settingsFor(root).poll.catchUpSeconds, 600);
    // A catch-up slower than the normal cadence would be a slow-down.
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: 300\n', 'utf8');
    assert.equal(settingsFor(root).poll.catchUpSeconds, 300);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tick that leaves a channel behind brings the next one forward, and says so', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(settingsPath(root), `poll:\n  enabled: true\n  every: 7200\n  catchUpSeconds: 60\nclassify:\n  enabled: false\n${kernelOn()}`, 'utf8');
  const events = Array.from({ length: 45 }, (_, i) => gitEvent('r', `sha${i}`, `commit ${i}`, `b${i}`, recent(100 - i)));
  const lines: string[] = [];
  logTo((l) => lines.push(l));
  try {
    await againstFake(
      async () => {
        // The loop's first tick reads one slice of the backlog and says it is behind.
        assert.equal(startPolling(root), true);
        let tick: string | undefined;
        for (let i = 0; i < 50 && !tick; i++) {
          await new Promise((r) => setTimeout(r, 100));
          tick = lines.find((l) => l.includes(` ${basename(root)} tick in `));
        }
        assert.match(tick ?? '', /behind — next tick in 60s/);
        const line = lines.find((l) => l.includes(`${basename(root)}/git `));
        assert.match(line ?? '', /read 25, judged 25 .*more behind this slice/);
        stopPolling(root);

        // The rest, a pass later: nothing behind it.
        const res = await pollOnce(root);
        const git = res.channels.find((c) => c.channel === 'git')!;
        assert.equal(git.read, 20);
        assert.equal(isBehind(res), false);
        assert.doesNotMatch(channelLine(git), /more behind/);
      },
      {},
      events,
    );
  } finally {
    logTo(null);
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------- the contract

/**
 * The model names what a candidate *is*; the code decides the write from the
 * kind and the evidence. These pin the mapping, case by case, because the whole
 * complaint it answers was cards that narrated activity or duplicated what the
 * source already showed.
 */
const judgeSaying = (rows: Record<string, unknown>[]): Ask => async () => JSON.stringify(rows);
const firm = (id: string, why = 'branch') => ({ id, title: id, why });
const loose = (id: string) => ({ id, title: id, why: 'text' });

test('an ask or a promise becomes a card, carrying who waits or when', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(paths(root).facets, 'waiting_on:\n  values: []\n  open: true\ndue:\n  type: date\n  single: true\n', 'utf8');
  try {
    const res = await classify(
      root,
      [candidate('slack:D1/1', 'can you review?'), candidate('slack:D2/1', 'will do tomorrow')],
      judgeSaying([
        { fp: 'slack:D1/1', decision: 'ask', reason: 'review wanted', title: 'Review the PR for X', body: 'Y asked.', facets: { waiting_on: ['y'] } },
        { fp: 'slack:D2/1', decision: 'promise', reason: 'owner committed', title: 'Send the summary', body: 'Promised for tomorrow.', facets: { due: ['2026-09-04'] } },
      ]),
    );
    const [ask, promise] = res!.keep.map((k) => k.verdict);
    assert.equal(ask!.decision, 'keep');
    assert.equal(ask!.kind, 'ask');
    assert.deepEqual(ask!.facets, { waiting_on: ['y'] });
    assert.match(ask!.reason, /^ask: review wanted/, 'the kind leads the reason, so the card says what it is');
    assert.equal(promise!.decision, 'keep');
    assert.deepEqual(promise!.facets, { due: ['2026-09-04'] });
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('information attaches to a note or a project, or it is not information', async () => {
  const root = vault({
    a: card('a'),
    proj: `---\nid: proj\ntitle: A project\nproject: {}\n---\n\nb\n`,
  });
  try {
    const res = await classify(
      root,
      [
        candidate('gmail:1', 'a finding', { evidence: { matches: [firm('a')] } }),
        candidate('gmail:2', 'a filed finding'),
        candidate('gmail:3', 'a finding about nothing'),
      ],
      judgeSaying([
        { fp: 'gmail:1', decision: 'info', reason: 'decision recorded', title: 'T', body: 'B', target: 'a' },
        { fp: 'gmail:2', decision: 'info', reason: 'decision recorded', title: 'T', body: 'B', facets: { project: ['proj'] } },
        { fp: 'gmail:3', decision: 'info', reason: 'decision recorded', title: 'T', body: 'B' },
      ]),
    );
    const by = new Map(res!.keep.map((k) => [k.candidate.fingerprint, k.verdict]));
    assert.equal(by.get('gmail:1')!.decision, 'extend', 'onto the note it names');
    assert.equal(by.get('gmail:1')!.target, 'a');
    assert.equal(by.get('gmail:2')!.decision, 'keep', 'filed under a project is attached');
    assert.deepEqual(res!.drop.map((d) => d.candidate.fingerprint), ['gmail:3']);
    assert.match(res!.drop[0]!.reason, /attaches to no note or project/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the owner’s own progress is a link onto the note it belongs to, never a card', async () => {
  const root = vault({ a: card('a') });
  try {
    const res = await classify(
      root,
      [
        // A branch whose directory and name resolve to a note: link it there.
        candidate('git:repo@feat', '52 commits', { channel: 'git', evidence: { matches: [firm('a', 'cwd'), loose('zzz')] } }),
        // A branch that only shares words with a note: a guess, so a drop.
        candidate('git:repo@other', 'fix: things', { channel: 'git', evidence: { matches: [loose('a')] } }),
        // Progress in a Slack thread the note already links: the note has the
        // thread; a link per message would be noise.
        candidate('slack:D1/9', 'pushed it', { channel: 'slack', evidence: { linkedTo: ['a'], matches: [firm('a', 'tracked')] } }),
        // "A new area" that a directory already maps is progress, not an area.
        candidate('claude:s1', 'a big session', { channel: 'claude', evidence: { matches: [firm('a', 'workspace')] } }),
        // A new area nothing maps: a card.
        candidate('claude:s2', 'a new thing', { channel: 'claude' }),
      ],
      judgeSaying([
        { fp: 'git:repo@feat', decision: 'progress', reason: 'own commits', title: 'T' },
        { fp: 'git:repo@other', decision: 'progress', reason: 'own commits' },
        { fp: 'slack:D1/9', decision: 'progress', reason: 'owner reporting' },
        { fp: 'claude:s1', decision: 'area', reason: 'looks new', title: 'T', body: 'B' },
        { fp: 'claude:s2', decision: 'area', reason: 'new work', title: 'A new area', body: 'Substantial.' },
      ]),
    );
    const by = new Map(res!.keep.map((k) => [k.candidate.fingerprint, k.verdict]));
    assert.equal(by.get('git:repo@feat')!.decision, 'link');
    assert.equal(by.get('git:repo@feat')!.target, 'a');
    assert.equal(by.get('claude:s1')!.decision, 'link', 'mapped after all, so a link');
    assert.equal(by.get('claude:s2')!.decision, 'keep', 'unmapped, so a card');
    const dropped = new Map(res!.drop.map((d) => [d.candidate.fingerprint, d.reason]));
    assert.match(dropped.get('git:repo@other')!, /own progress/);
    assert.match(dropped.get('slack:D1/9')!, /already tracked; nothing to add/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a change has to change something, and a tracked ask still lands as an extension', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n  single: true\n', 'utf8');
  try {
    const res = await classify(
      root,
      [
        candidate('jira:X-1@t', 'moved', { evidence: { linkedTo: ['a'], matches: [firm('a', 'tracked')] } }),
        candidate('jira:X-2@t', 'edited', { evidence: { linkedTo: ['a'], matches: [firm('a', 'tracked')] } }),
        candidate('slack:D1/5', 'one more question', { evidence: { linkedTo: ['a'], matches: [firm('a', 'tracked')] } }),
      ],
      judgeSaying([
        { fp: 'jira:X-1@t', decision: 'change', reason: 'done', title: 'X-1 is done', body: 'Moved to Done.', facets: { status: ['done'] } },
        { fp: 'jira:X-2@t', decision: 'change', reason: 'field edited' },
        { fp: 'slack:D1/5', decision: 'ask', reason: 'follow-up question', title: 'Y asks again', body: 'What about Z?' },
      ]),
    );
    const by = new Map(res!.keep.map((k) => [k.candidate.fingerprint, k.verdict]));
    assert.equal(by.get('jira:X-1@t')!.decision, 'extend');
    assert.deepEqual(by.get('jira:X-1@t')!.facets, { status: ['done'] });
    assert.equal(by.get('slack:D1/5')!.decision, 'extend', 'a new ask on a tracked thread is news about that note');
    assert.deepEqual(res!.drop.map((d) => d.candidate.fingerprint), ['jira:X-2@t']);
    assert.match(res!.drop[0]!.reason, /nothing on the note changes/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate the judge leaves out is asked again, and then declined rather than written raw', async () => {
  const root = vault({ a: card('a') });
  const asks: string[][] = [];
  const forgetful: Ask = async (_s, user) => {
    const fps = (JSON.parse(user) as { fp: string }[]).map((c) => c.fp);
    asks.push(fps);
    // Answers for every candidate but `git:2`, every time.
    return JSON.stringify(fps.filter((fp) => fp !== 'git:2' && fp !== 'git:r@2').map((fp) => ({ fp, decision: 'drop', reason: 'noise' })));
  };
  try {
    const res = await classify(root, [candidate('git:1', 'a'), candidate('git:2', 'b'), candidate('git:3', 'c')], forgetful, 8);
    assert.deepEqual(asks, [['git:1', 'git:2', 'git:3'], ['git:2']], 'the one left out is asked about once more, alone');
    assert.deepEqual(res!.unjudged.map((c) => c.fingerprint), ['git:2']);
    assert.equal(res!.keep.length, 0, 'and it is not kept by default');

    // Through a pass: declined with that reason, visible in the pile, nothing written.
    writeFileSync(settingsPath(root), kernelOn(), 'utf8');
    await againstFake(
      async () => {
        const tick = await pollOnce(root, forgetful);
        assert.equal(tick.created.length, 0);
        assert.equal(tick.unanswered, 1);
        const row = suppressions(root).rows.find((r) => r.fingerprint === 'git:r@2')!;
        assert.match(row.reason, /no verdict from the judge after two asks/);
        assert.equal(row.decidedBy, 'model');
      },
      {},
      [gitEvent('r', '2', 'b', 'main')],
    );
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a link attaches the branch to the note and writes no card, and several keep every link', () => {
  const root = vault({ a: `---\nid: a\ntitle: The note\nlinks: ['jira:PROJ-1']\n---\n\nb\n` });
  try {
    const c = candidate('git:repo@feat', 'work', { channel: 'git', links: ['gh:branch:org/repo@feat'] });
    const res = materialise(root, 'git', [{ candidate: c, verdict: { fingerprint: c.fingerprint, decision: 'link', reason: 'progress: own commits', target: 'a' } }]);
    assert.deepEqual(res.created, []);
    assert.deepEqual(res.linked, [{ id: 'a', fingerprint: 'git:repo@feat' }]);
    const a = reindex(root).notes.get('a')!;
    assert.deepEqual(a.links.map((l) => l.raw), ['jira:PROJ-1', 'gh:branch:org/repo@feat'], 'the branch joins the note’s links');
    assert.deepEqual(a.absorbed_fingerprints, ['git:repo@feat'], 'and the note answers for the fingerprint from now on');

    // Twice attaches nothing twice.
    const again = materialise(root, 'git', [{ candidate: c, verdict: { fingerprint: c.fingerprint, decision: 'link', reason: 'r', target: 'a' } }]);
    assert.equal(again.linked.length + again.skipped, 1);
    assert.deepEqual(reindex(root).notes.get('a')!.absorbed_fingerprints, ['git:repo@feat']);

    // Several onto one note in one run keep every link, not only the last one's.
    const s1 = candidate('claude:s1', 'one', { channel: 'claude', links: ['claude:s1'] });
    const s2 = candidate('claude:s2', 'two', { channel: 'claude', links: ['claude:s2'] });
    materialise(root, 'claude', [s1, s2].map((x) => ({ candidate: x, verdict: { fingerprint: x.fingerprint, decision: 'link' as const, reason: 'progress', target: 'a' } })));
    assert.deepEqual(reindex(root).notes.get('a')!.links.map((l) => l.raw), ['jira:PROJ-1', 'gh:branch:org/repo@feat', 'claude:s1', 'claude:s2']);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session counts as this vault’s work only inside a declared repo or a recorded workspace', () => {
  const repos = ['/Users/x/repo'];
  const workspaces = ['/Users/x/wt/thing'];
  assert.equal(placeOf('/Users/x/repo/src', repos, workspaces), 'work');
  assert.equal(placeOf('/Users/x/wt/thing/repo', repos, workspaces), 'work');
  assert.equal(placeOf('/Users/x/personal', repos, workspaces), 'outside');
  assert.equal(placeOf('/Users/x/vault/.projector', repos, workspaces), 'app', 'the judge runs here');
  assert.equal(placeOf(undefined, repos, workspaces), 'unknown');

  // Through the mapping: a session in a personal project is skipped with the
  // directory in the reason, and one in a declared repo is offered.
  const root = vault({
    proj: `---\nid: proj\ntitle: P\nproject:\n  repos:\n    - path: /Users/x/repo\n---\n\nb\n`,
  });
  const session = (uuid: string, project: string, turns = 4, ended = '2026-08-20T10:03:30.000Z') =>
    ev(`claude:${uuid}@${ended}`, 'claude/session', ended, [`claude:project:${project}`], { session: uuid, turns, ended, project, title: 'turn 0' });
  try {
    const { candidates, skipped } = mapEvents('claude', context(root), [
      session('bbbbbbbb-0000-0000-0000-000000000001', '/Users/x/repo/src'),
      session('bbbbbbbb-0000-0000-0000-000000000002', '/Users/x/personal'),
      session('bbbbbbbb-0000-0000-0000-000000000003', '/Users/x/repo', 2),
      session('bbbbbbbb-0000-0000-0000-000000000001', '/Users/x/repo/src', 6, '2026-08-20T11:00:00.000Z'),
    ]);
    assert.deepEqual(candidates.map((c) => [c.fingerprint, c.event?.payload.turns]), [['claude:bbbbbbbb-0000-0000-0000-000000000001', 6]], 'one session, at its newest move');
    assert.ok(skipped.some((s) => /\/Users\/x\/personal is outside every declared repo/.test(s.why)));
    assert.ok(skipped.some((s) => /2 turn\(s\) — below the threshold/.test(s.why)));
    assert.ok(skipped.some((s) => /folded into the session’s newer move/.test(s.why)));
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});


test('a rejudged card that extends a note is judged as news about that note', async () => {
  const root = vault({
    real: `---\nid: real\ntitle: The tracked note\nfacets: { status: [active] }\n---\n\nb\n`,
    card: `---\nid: card\ntitle: Timeline moved\nfacets: { intake: [unjudged], extends: [real], due: ['2026-09-06'] }\n---\n\nPromised for Monday.\n`,
  });
  writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n  single: true\ndue:\n  type: date\n  single: true\n', 'utf8');
  let seen = '';
  const judge: Ask = async (_s, user) => {
    seen = user;
    return JSON.stringify((JSON.parse(user) as { fp: string }[]).map((c) => ({ fp: c.fp, decision: 'change', reason: 'deadline moved', title: 'Timeline moved', body: 'Promised for Monday.', facets: { due: ['2026-09-07'] } })));
  };
  try {
    const res = await rejudge(root, { ask: judge });
    assert.match(seen, /"tracked":\[\{"id":"real"/, 'the card’s target is shown as the note it is news about');
    assert.deepEqual(res.wouldDrop, [], 'a change with a delta onto its note is kept');
    assert.deepEqual(res.changed.map((c) => c.id), ['card']);
    assert.deepEqual(reindex(root).notes.get('card')!.facets.extends, ['real'], 'and it still extends the note');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});
