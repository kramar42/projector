import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { reindex } from '../src/index/indexer.ts';
import { closeIntakeDb, commitWatermark, recordPending, resetWatermark, watermarkFor, watermarks } from '../src/intake/db.ts';
import { evidenceFor, ftsOverlapQuery, matchBranch, matchCwd, repoIndex } from '../src/intake/match.ts';
import { fromWorkspacePath, workspacePath } from '../src/agent/workspaceName.ts';
import { advance, candidateCount, channelNames, renderSweep, renderStatus, statusOf, sweep } from '../src/intake/run.ts';
import { touchedButIdle } from '../src/intake/claude.ts';
import { listTranscripts, pickSession, describeTranscript, type LiveSession } from '../src/sources/claude.ts';
import { jqlDate } from '../src/sources/jira.ts';
import { lastTurn, sessionState, type Turn } from '../src/sources/claude.ts';
import type { IntakeContext } from '../src/intake/types.ts';

/**
 * Intake is the one part of projector holding state that is not derived from the
 * card files, so most of what is worth testing here is the discipline around
 * that: the cursor may not skip anything, and it may not be the thing
 * correctness depends on.
 */

function vault(cards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pj-intake-'));
  mkdirSync(join(root, 'notes'), { recursive: true });
  for (const [name, body] of Object.entries(cards)) {
    writeFileSync(join(root, 'notes', `${name}.md`), body, 'utf8');
  }
  return root;
}

function context(root: string, over: Partial<IntakeContext> = {}): IntakeContext {
  const { db, notes } = reindex(root);
  const fingerprints = new Map<string, string[]>();
  const links = new Map<string, string[]>();
  for (const rec of notes.values()) {
    if (rec.source_fingerprint) fingerprints.set(rec.source_fingerprint, [rec.id]);
    for (const l of rec.links) links.set(l.raw, [...(links.get(l.raw) ?? []), rec.id]);
  }
  return {
    root,
    db,
    notes,
    fingerprints,
    links,
    since: new Date(0),
    cursor: null,
    limit: 25,
    ...over,
  };
}

const card = (id: string, extra = '') => `---\nid: ${id}\ntitle: ${id}\n${extra}---\n\nbody\n`;

// ------------------------------------------------------------------ watermarks

test('a channel with no watermark reports none rather than inventing one', () => {
  const root = vault({ a: card('a') });
  try {
    assert.equal(watermarkFor(root, 'claude'), null);
    assert.deepEqual(watermarks(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a commit with no cursor leaves the old one where it was', () => {
  const root = vault({ a: card('a') });
  try {
    commitWatermark(root, 'slack', '1755700000.1');
    // A run that fetched nothing has no new boundary to note. Overwriting with
    // null would reopen the whole window on the next sweep.
    commitWatermark(root, 'slack', null, { seen: 4 });
    const w = watermarkFor(root, 'slack');
    assert.equal(w?.cursor, '1755700000.1');
    assert.equal(w?.seen, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cursor is opaque: a Slack ts survives the round trip unparsed', () => {
  const root = vault({ a: card('a') });
  try {
    commitWatermark(root, 'slack', '1755700000.123456');
    assert.equal(watermarkFor(root, 'slack')?.cursor, '1755700000.123456');
    commitWatermark(root, 'gmail', '2026-08-01T00:00:00.000Z');
    assert.equal(watermarkFor(root, 'gmail')?.cursor, '2026-08-01T00:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resetting a cursor falls back to the default window, not to the beginning of time', async () => {
  const root = vault({ a: card('a') });
  try {
    commitWatermark(root, 'claude', new Date().toISOString());
    assert.equal(resetWatermark(root, 'claude'), 1);
    assert.equal(watermarkFor(root, 'claude'), null);
    // The fallback is a window, so losing the file is a wider sweep and never a
    // sweep of everything that has ever happened.
    const s = await sweep(root, { only: ['claude'], limit: 1 });
    assert.equal(s.reports[0]?.cursor, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the sweep

test('a sweep writes no cards and moves no cursor', async () => {
  const root = vault({ a: card('a') });
  try {
    const before = reindex(root).notes.size;
    await sweep(root, { only: ['claude', 'git'], limit: 3 });
    assert.equal(reindex(root).notes.size, before);

    // Proposing is not resolving. A sweep now *notes* where it would go, so the
    // rows exist — but every cursor is still unset, and only `pj intake commit`
    // promotes a proposal. Asserting the table is empty would be asserting the
    // storage rather than the invariant.
    const after = watermarks(root);
    assert.deepEqual(after.map((w) => w.channel).sort(), ['claude', 'git']);
    for (const w of after) {
      assert.equal(w.cursor, null, `${w.channel}: a sweep must not move the cursor`);
      assert.ok(w.pending, `${w.channel}: a sweep notes what it would advance to`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a truncated run holds its cursor, so nothing behind it is skipped', async () => {
  const root = vault({ a: card('a') });
  try {
    // The claude channel reads the real ~/.claude, which on any developer
    // machine has more than one transcript; a limit of one truncates it.
    const s = await sweep(root, { only: ['claude'], limit: 1, since: new Date(0) });
    const r = s.reports[0]!;
    if (r.truncated) assert.equal(r.nextCursor, null, 'a truncated report must not advance the cursor');
    else assert.ok(r.nextCursor === null || typeof r.nextCursor === 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a channel pj cannot reach still reports its cursor', async () => {
  const root = vault({ a: card('a') });
  try {
    commitWatermark(root, 'slack', '1755700000.1');
    const s = await sweep(root, { only: ['slack', 'gmail'] });
    const slack = s.reports.find((r) => r.channel === 'slack')!;
    assert.equal(slack.fetched, false);
    assert.equal(slack.cursor, '1755700000.1');
    assert.match(slack.reason ?? '', /MCP/);
    // Not fetching is not an error, and it never advances anything.
    assert.equal(slack.nextCursor, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown channel is named rather than silently swept away', async () => {
  const root = vault({ a: card('a') });
  try {
    const s = await sweep(root, { only: ['sms'] });
    assert.deepEqual(s.unknown, ['sms']);
    assert.equal(s.reports.length, 0);
    assert.match(renderSweep(s), /unknown channel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every channel in the registry is named in channelNames', () => {
  assert.deepEqual(channelNames(), ['claude', 'git', 'jira', 'slack', 'gmail']);
});

// ------------------------------------------------------------------- dedup

test('a fingerprint already on a card is what makes a re-sweep converge', () => {
  const root = vault({
    known: `---\nid: known\ntitle: known\nsource_fingerprint: claude:abc-123\n---\n\nb\n`,
  });
  try {
    const ctx = context(root);
    const ev = evidenceFor(ctx, { fingerprint: 'claude:abc-123' });
    assert.deepEqual(ev.capturedAs, ['known']);
    // And the same holds with no watermark at all, which is the property that
    // makes losing .intake.db safe rather than merely inconvenient.
    assert.deepEqual(context(root, { cursor: null }).fingerprints.get('claude:abc-123'), ['known']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a link already on a card is reported as linked, not as a candidate', () => {
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

test('a branch naming a Jira key finds the card carrying that key', () => {
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

test('a branch named after a card matches it, at any path segment', () => {
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

test('a transcript whose file was touched but had no activity is not new work', () => {
  const since = new Date('2026-08-14T00:00:00Z');
  // Found by mtime, rejected by the transcript: something rewrote a batch of
  // month-old transcripts in three seconds, and 13 of 30 candidates in the
  // first real sweep were finished sessions resurfacing.
  assert.equal(touchedButIdle('2026-08-04T13:50:00Z', since), true);
  assert.equal(touchedButIdle('2026-08-19T10:32:00Z', since), false);
  // No timestamp in the file at all: mtime is the only evidence there is, so it
  // stands rather than being second-guessed.
  assert.equal(touchedButIdle(undefined, since), false);
  assert.equal(touchedButIdle('not a date', since), false);
});

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

test('a sweep says out loud that it captured nothing', async () => {
  const root = vault({ a: card('a') });
  try {
    const s = await sweep(root, { only: ['slack'] });
    const out = renderSweep(s);
    assert.match(out, /Nothing is captured and no cursor has moved/);
    assert.equal(candidateCount(s), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

/**
 * `pj intake status --json` used to be accepted and ignored, so pj-capture read
 * the cursor it fetches Slack and Gmail from out of a padded table. The renderer
 * reads this now, which is what keeps the two from disagreeing.
 */
test('every channel reports a status, and the text is rendered from it', () => {
  const root = vault({});
  try {
    const rows = statusOf(root);
    assert.deepEqual(
      rows.map((r) => r.channel).sort(),
      channelNames().slice().sort(),
      'a channel missing from status is a channel whose cursor cannot be read',
    );
    for (const r of rows) {
      assert.equal(r.cursor, null, 'a fresh vault has committed no cursor');
      assert.equal(r.ranAt, null);
      assert.ok(r.defaultDays > 0, 'a channel with no cursor falls back to a window');
    }

    commitWatermark(root, 'git', 'abc123', { seen: 4, captured: 1 });
    const after = statusOf(root).find((r) => r.channel === 'git')!;
    assert.equal(after.cursor, 'abc123');
    assert.equal(after.seen, 4);
    assert.equal(after.captured, 1);
    assert.ok(after.ranAt, 'a committed channel notes when it ran');

    // The table is a view of the same rows, not a second query.
    const text = renderStatus(root);
    for (const r of statusOf(root)) assert.match(text, new RegExp(r.channel));
    assert.match(text, /abc123/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The sweep notes where it would go; `advance` promotes it.
 *
 * Resolving a sweep used to mean copying an opaque cursor — a Slack `ts`, a Gmail
 * date — out of one process and typing it into the next, once per channel, with
 * the counts retyped alongside. Both were `pj`'s own numbers. `captured` is the
 * exception, because capture happens between the two calls.
 */
test('a recorded sweep is promoted once, and only once', () => {
  const root = vault({});
  try {
    recordPending(root, 'slack', '1787229273.986369', 7);
    recordPending(root, 'git', null, 3);

    // Recorded is not advanced: nothing reads a pending value until it is promoted.
    const before = watermarkFor(root, 'slack')!;
    assert.equal(before.cursor, null, 'recording a proposal must not move the cursor');
    assert.equal(before.pending?.cursor, '1787229273.986369');
    assert.equal(before.pending?.seen, 7);

    const first = advance(root, { captured: 2 });
    assert.deepEqual(first.moved.map((m) => m.channel).sort(), ['git', 'slack']);
    assert.deepEqual(first.withoutPending.sort(), ['claude', 'gmail', 'jira']);

    const slack = watermarkFor(root, 'slack')!;
    assert.equal(slack.cursor, '1787229273.986369', 'the proposed cursor is now the cursor');
    assert.equal(slack.seen, 7, 'seen comes from the sweep, not from the caller');
    assert.equal(slack.captured, 2, 'captured is the one number the caller supplies');
    assert.equal(slack.pending, undefined, 'a promoted proposal is spent');

    // A null proposal means hold: a truncated run has items behind its cursor.
    assert.equal(watermarkFor(root, 'git')!.cursor, null);

    // Promoting twice must not re-commit a cursor that has already moved.
    const second = advance(root);
    assert.deepEqual(second.moved, []);
    assert.equal(watermarkFor(root, 'slack')!.captured, 2, 'the spent proposal left the counts alone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A store written before the pending columns existed gains them, keeping its cursors. */
test('the watermark store migrates in place rather than being replaced', () => {
  const root = vault({});
  try {
    commitWatermark(root, 'jira', '2026-08-18T13:32:49.967+0000', { seen: 1 });
    const file = join(root, '.intake.db');
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE watermark DROP COLUMN pending_cursor');
    raw.exec('ALTER TABLE watermark DROP COLUMN pending_seen');
    raw.exec('ALTER TABLE watermark DROP COLUMN pending_at');
    raw.close();
    closeIntakeDb(root);

    // Reopening runs the migration; the cursor that was already there survives it.
    assert.equal(watermarkFor(root, 'jira')!.cursor, '2026-08-18T13:32:49.967+0000');
    recordPending(root, 'jira', 'newer', 4);
    assert.equal(watermarkFor(root, 'jira')!.pending?.cursor, 'newer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
 * session's history on the wrong card and looks fine, so the cwd tier now requires
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
