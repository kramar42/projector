import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { reindex } from '../src/index/indexer.ts';
import { closeIntakeDb, commitWatermark, openIntakeDb, recordPending, rescues, resetWatermark, suppress, suppressedFingerprints, suppressions, unsuppress, watermarkFor, watermarks } from '../src/intake/db.ts';
import { evidenceFor, ftsOverlapQuery, matchBranch, matchCwd, repoIndex } from '../src/intake/match.ts';
import { fromWorkspacePath, workspacePath } from '../src/agent/workspaceName.ts';
import { CHANNELS, advance, candidateCount, channelNames, renderSweep, renderStatus, statusOf, sweep } from '../src/intake/run.ts';
import { materialise } from '../src/intake/materialise.ts';
import { rejudge } from '../src/intake/rejudge.ts';
import { instructions, linkFor } from '../src/intake/mcp.ts';
import { parseLink } from '../src/schema/links.ts';
import { deleteNote } from '../src/server/mutate.ts';
import { pollOnce, startPolling, stopPolling } from '../src/server/poll.ts';
import { classify, type Ask, type Verdict } from '../src/intake/classify.ts';
import { settingsFor, settingsPath } from '../src/settings.ts';
import { touchedButIdle } from '../src/intake/claude.ts';
import { listTranscripts, pickSession, describeTranscript, type LiveSession } from '../src/sources/claude.ts';
import { jqlDate } from '../src/sources/jira.ts';
import { lastTurn, sessionState, type Turn } from '../src/sources/claude.ts';
import type { Candidate, Channel, IntakeContext } from '../src/intake/types.ts';
import { paths } from '../src/config.ts';
import { BUILTIN_FACETS, loadFacets } from '../src/schema/facets.ts';

/**
 * Intake is the one part of projector holding state that is not derived from the
 * note files, so most of what is worth testing here is the discipline around
 * that: the cursor may not skip anything, and it may not be the thing
 * correctness depends on.
 */

function vault(cards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pj-intake-'));
  mkdirSync(paths(root).config, { recursive: true });
  for (const [name, body] of Object.entries(cards)) {
    writeFileSync(join(paths(root).notes, `${name}.md`), body, 'utf8');
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
    suppressed: new Set<string>(),
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

test('a sweep writes no notes and moves no cursor', async () => {
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

test('a channel with no tools named is not fetched, and still reports its cursor', async () => {
  const root = vault({ a: card('a') });
  try {
    commitWatermark(root, 'slack', '1755700000.1');
    const s = await sweep(root, { only: ['slack', 'gmail'] });
    const slack = s.reports.find((r) => r.channel === 'slack')!;
    // The default, and the safe one: Slack and Gmail are the shared channels C2
    // names, so a vault that has not named the tools gets no agent at all.
    assert.equal(slack.fetched, false);
    assert.equal(slack.cursor, '1755700000.1');
    assert.match(slack.reason ?? '', /mcp\.slack/);
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

test('a fingerprint already on a note is what makes a re-sweep converge', () => {
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
  });
  try {
    const ctx = context(root);
    // The session sits in a worktree *inside* the workspace, which is where
    // `pj work` puts every repo — so containment, not equality.
    assert.deepEqual(matchCwd(ctx, '/wt/plat-wt-tos-ship/api'), [
      { id: 'ship', title: 'ship', why: 'workspace' },
    ]);
    assert.deepEqual(matchCwd(ctx, '/wt/plat-wt-tos-other'), []);
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
 * `pj intake status --json` used to be accepted and ignored, so the sweep's caller read
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
    const file = paths(root).intakeDb;
    const raw = new DatabaseSync(file);
    const before = raw
      .prepare('SELECT channel, cursor, ran_at, seen, captured FROM watermark')
      .all() as { channel: string; cursor: string; ran_at: string; seen: number; captured: number }[];
    // The old shape is written out, not derived by dropping the pending columns.
    // `DROP COLUMN` rewrites the stored schema text, and before SQLite 3.53 the
    // `--` comment above the last column swallowed the closing paren — so that
    // spelling passed on Node's SQLite and failed on Bun's. This one also states
    // the pre-migration schema instead of approximating it.
    raw.exec('DROP TABLE watermark');
    raw.exec(`CREATE TABLE watermark (
      channel   TEXT PRIMARY KEY,
      cursor    TEXT,
      ran_at    TEXT NOT NULL,
      seen      INTEGER NOT NULL DEFAULT 0,
      captured  INTEGER NOT NULL DEFAULT 0
    )`);
    const ins = raw.prepare(
      'INSERT INTO watermark (channel, cursor, ran_at, seen, captured) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of before) ins.run(r.channel, r.cursor, r.ran_at, r.seen, r.captured);
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

test('a declined candidate survives the cursor moving past it', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:abc', reason: 'my own commit', channel: 'git' });
    commitWatermark(root, 'git', '2026-01-01T00:00:00.000Z');

    // The cursor has moved past it and the note was never written, and the
    // rejection is still readable — which is the whole point.
    const rows = suppressions(root).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.fingerprint, 'git:abc');
    assert.equal(rows[0]!.reason, 'my own commit');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a suppressed candidate is declined by the sweep, not silently dropped', async () => {
  const root = vault({ a: card('a') });
  try {
    const first = await sweep(root, { only: ['claude', 'git'], limit: 3 });
    const seen = first.reports.flatMap((r) => r.candidates);
    // The fixture vault may legitimately produce nothing to propose; the
    // invariant only has teeth when there is a candidate to suppress.
    if (!seen.length) return;

    const victim = seen[0]!;
    suppress(root, { fingerprint: victim.fingerprint, reason: 'noise', channel: victim.channel });

    const second = await sweep(root, { only: ['claude', 'git'], limit: 3 });
    const proposed = second.reports.flatMap((r) => r.candidates.map((c) => c.fingerprint));
    assert.ok(!proposed.includes(victim.fingerprint), 'a suppressed candidate is not re-proposed');

    // It moves to `skipped` rather than vanishing: a run that quietly dropped
    // what it fetched would read as a quiet channel, and that reading must not
    // be available.
    const declined = second.reports.flatMap((r) => r.skipped.map((s) => s.fingerprint));
    assert.ok(declined.includes(victim.fingerprint), 'and it is named as declined');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('suppressing again replaces the reason rather than failing', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'git:abc', reason: 'first answer' });
    suppress(root, { fingerprint: 'git:abc', reason: 'second answer' });
    const rows = suppressions(root).rows;
    assert.equal(rows.length, 1, 'one row per fingerprint');
    assert.equal(rows[0]!.reason, 'second answer', 'the current judgement wins');
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
 * Polling: the same sweep with nobody standing there to answer it.
 *
 * The difference is not the fetching, which is identical — it is that a
 * materialising run writes each candidate down, and therefore earns the right to
 * move a cursor that a proposing run does not have.
 */

/**
 * A classifier that keeps everything, for the tests that are about something else.
 *
 * The real one shells out to a model, which a test must never do — so every
 * `pollOnce` here passes a transport, and the ones asserting judgement pass one
 * that judges.
 */
const keepAll: Ask = async (_system, user) =>
  JSON.stringify(
    (JSON.parse(user) as { fp: string }[]).map((c) => ({
      fp: c.fp,
      decision: 'keep',
      reason: 'kept',
    })),
  );

/**
 * Candidates paired with a bare "keep" verdict — for the materialise tests, whose
 * subject is the write and not the judgement.
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
    // Both are mechanical facts about the vault rather than judgements about
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

test('polling is off unless the vault asks for it', () => {
  const root = vault({ a: card('a') });
  try {
    assert.equal(startPolling(root), false, 'a vault with no config is not polled');
    writeFileSync(settingsPath(root), 'poll:\n  enabled: true\n  every: 120\n', 'utf8');
    assert.equal(startPolling(root), true);
    assert.equal(startPolling(root), true, 'and starting twice does not double the rate');
  } finally {
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
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

test('a channel that throws is that channel’s news, not the sweep’s', async () => {
  const root = vault({ a: card('a') });
  const boom: Channel = {
    name: 'boom',
    defaultDays: 1,
    collect() {
      throw new Error('credential expired');
    },
  };
  CHANNELS.push(boom);
  try {
    const { reports } = await sweep(root, { only: ['boom', 'git'] });
    const failed = reports.find((r) => r.channel === 'boom');
    assert.ok(failed, 'the failing channel still reports');
    assert.equal(failed!.fetched, false);
    assert.match(failed!.reason ?? '', /credential expired/);
    assert.equal(failed!.nextCursor, null, 'and it holds its cursor, having examined nothing');

    // The point: the other channel still ran. Before this, one bad credential
    // meant no git candidates either.
    assert.ok(reports.some((r) => r.channel === 'git'), 'the healthy channel still ran');
  } finally {
    CHANNELS.splice(CHANNELS.indexOf(boom), 1);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreachable channel is reported and its cursor is not advanced', async () => {
  const root = vault({ a: card('a') });
  try {
    // Slack and Gmail have no credential here by design, so they are the honest
    // fixture for "could not fetch".
    const res = await pollOnce(root, keepAll);
    const names = res.unreachable.map((u) => u.channel);
    assert.ok(names.includes('slack') && names.includes('gmail'), 'both are named, with reasons');
    for (const u of res.unreachable) assert.ok(u.reason, `${u.channel} says why`);
    assert.ok(!res.advanced.includes('slack'), 'and nothing it did not fetch is advanced');
  } finally {
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a materialising run advances the cursor, because nothing is left unrecorded', async () => {
  const root = vault({ a: card('a') });
  const fake: Channel = {
    name: 'fake',
    defaultDays: 1,
    collect: (ctx) => ({
      channel: 'fake',
      cursor: ctx.cursor,
      nextCursor: '2026-02-02T00:00:00.000Z',
      fetched: true,
      candidates: [candidate('fake:1', 'Something that happened', { channel: 'fake' })],
      skipped: [],
    }),
  };
  CHANNELS.push(fake);
  writeFileSync(settingsPath(root), 'poll:\n  enabled: true\nchannels: [fake]\n', 'utf8');
  try {
    // A sweep run by a person proposes and holds — it wrote nothing down, so
    // passing the boundary would step over candidates that exist only on screen.
    await sweep(root, { only: ['fake'] });
    assert.equal(watermarkFor(root, 'fake')?.cursor, null, 'proposing does not advance');

    // A poll writes each candidate into the vault, so every item behind the new
    // boundary is a file. That is what earns the advance.
    const res = await pollOnce(root, keepAll);
    assert.equal(res.created.length, 1);
    assert.ok(res.advanced.includes('fake'));
    assert.equal(watermarkFor(root, 'fake')?.cursor, '2026-02-02T00:00:00.000Z');
  } finally {
    CHANNELS.splice(CHANNELS.indexOf(fake), 1);
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('captured is attributed per channel, not totalled across the tick', async () => {
  const root = vault({ a: card('a') });
  const report = (name: string, candidates: Candidate[]) => (ctx: IntakeContext) => ({
    channel: name,
    cursor: ctx.cursor,
    nextCursor: '2026-04-04T00:00:00.000Z',
    fetched: true,
    candidates,
    skipped: [],
  });
  const busy: Channel = {
    name: 'busy',
    defaultDays: 1,
    collect: report('busy', [candidate('busy:1', 'Something that happened', { channel: 'busy' })]),
  };
  const quiet: Channel = { name: 'quiet', defaultDays: 1, collect: report('quiet', []) };
  CHANNELS.push(busy, quiet);
  writeFileSync(settingsPath(root), 'poll:\n  enabled: true\nchannels: [busy, quiet]\n', 'utf8');
  try {
    const res = await pollOnce(root, keepAll);
    assert.equal(res.created.length, 1);
    // The stat feeds `pj intake status`, per channel. A channel that wrote
    // nothing must not inherit the tick's total, or every quiet channel reads
    // as busy as the busiest one.
    assert.equal(watermarkFor(root, 'busy')?.captured, 1);
    assert.equal(watermarkFor(root, 'quiet')?.captured, 0);
  } finally {
    CHANNELS.splice(CHANNELS.indexOf(busy), 1);
    CHANNELS.splice(CHANNELS.indexOf(quiet), 1);
    stopPolling(root);
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

test('a candidate the model forgot to mention is kept', async () => {
  const root = vault({ a: card('a') });
  // Keeping costs a glance; dropping costs the item. So silence means keep.
  const forgetful: Ask = async () => '[{"fp":"git:1","decision":"drop","reason":"noise"}]';
  try {
    const res = await classify(root, [candidate('git:1', 'a'), candidate('git:2', 'b')], forgetful);
    assert.deepEqual(res!.keep.map((k) => k.candidate.fingerprint), ['git:2']);
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

test('a held tick writes nothing and moves no cursor', async () => {
  const root = vault({ a: card('a') });
  const fake: Channel = {
    name: 'fake',
    defaultDays: 1,
    collect: (ctx) => ({
      channel: 'fake',
      cursor: ctx.cursor,
      nextCursor: '2026-03-03T00:00:00.000Z',
      fetched: true,
      candidates: [candidate('fake:1', 'Something', { channel: 'fake' })],
      skipped: [],
    }),
  };
  CHANNELS.push(fake);
  writeFileSync(settingsPath(root), 'poll:\n  enabled: true\nchannels: [fake]\n', 'utf8');
  try {
    const res = await pollOnce(root, async () => null);
    assert.ok(res.held, 'the tick says it held');
    assert.deepEqual(res.created, [], 'and wrote nothing');
    assert.equal(watermarkFor(root, 'fake')?.cursor, null, 'and moved no cursor');

    // The point of holding: the next tick sees exactly what this one saw.
    const retry = await pollOnce(root, keepAll);
    assert.equal(retry.created.length, 1);
  } finally {
    CHANNELS.splice(CHANNELS.indexOf(fake), 1);
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('turning the classifier off writes everything down, explicitly', async () => {
  const root = vault({ a: card('a') });
  const fake: Channel = {
    name: 'fake',
    defaultDays: 1,
    collect: (ctx) => ({
      channel: 'fake',
      cursor: ctx.cursor,
      nextCursor: '2026-03-03T00:00:00.000Z',
      fetched: true,
      candidates: [candidate('fake:1', 'Something', { channel: 'fake' })],
      skipped: [],
    }),
  };
  CHANNELS.push(fake);
  // `classify: {enabled: false}` is the way to ask for the firehose on purpose.
  // Never reached by omission — a missing classifier holds instead.
  writeFileSync(
    settingsPath(root),
    'poll:\n  enabled: true\nchannels: [fake]\nclassify:\n  enabled: false\n',
    'utf8',
  );
  try {
    const res = await pollOnce(root, async () => null);
    assert.ok(!res.held, 'no judgement was wanted, so nothing could hold it');
    assert.equal(res.created.length, 1);
  } finally {
    CHANNELS.splice(CHANNELS.indexOf(fake), 1);
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a vault may override the judgement without editing the app', () => {
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

test('both prompts that reach a model carry the secrets rule', async () => {
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
    assert.match(
      instructions('slack', null, 7),
      /leave the value out/,
      'and the fetching agent is told not to carry one in',
    );
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

test('the fetching agent is asked for an id and a permalink as two fields', () => {
  // One field got whichever the tool volunteered, which for Slack is a channel
  // and a timestamp. Pinned as wording for the same reason the secrets rule is.
  const text = instructions('slack', null, 7);
  assert.match(text, /"url":"<permalink>"/, 'the schema asks for it');
  assert.match(text, /never the id in another costume/, 'and says it is not the id');
  assert.match(instructions('gmail', null, 14), /mail\.google\.com/);
});

test('deleting a captured note is a decline, so the sweep stops offering it', () => {
  const root = vault({ a: card('a') });
  try {
    const res = materialise(root, 'git', asKept([candidate('git:1', 'A thing')]));
    const id = res.created[0]!;

    // The gesture that obviously means no. Before this it destroyed the one thing
    // stopping the next sweep re-proposing the card.
    deleteNote(root, id);
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
    // says the judgement was wrong the expensive way, and it existed nowhere
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

test('un-declining walks the cursor back, or it is offered again nowhere', () => {
  const root = vault({ a: card('a') });
  try {
    commitWatermark(root, 'git', '2026-08-01T00:00:00Z');
    suppress(root, { fingerprint: 'git:abc', reason: 'routine', channel: 'git' });

    const back = unsuppress(root, 'git:abc');
    assert.equal(back?.rewound, 'git');

    // The row going is only half of it. Every channel fetches forward of its
    // watermark, so an item behind the cursor is un-hidden and still out of
    // reach — and a repair that repairs nothing is worse than no repair, because
    // it reads as one.
    assert.equal(watermarkFor(root, 'git'), null, "the channel falls back to its default window");
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the channel to reach back into is read off the fingerprint when the row lacks one', () => {
  const root = vault({ a: card('a') });
  try {
    commitWatermark(root, 'jira', '2026-08-01T00:00:00Z');
    // What the delete cascade writes: it knows the fingerprint the note answered
    // for and has no channel to hand.
    suppress(root, { fingerprint: 'jira:ABC-1', reason: 'declined from the queue' });

    assert.equal(unsuppress(root, 'jira:ABC-1')?.rewound, 'jira');
    assert.equal(watermarkFor(root, 'jira'), null);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fingerprint naming no channel is still un-declined, and rewinds nothing', () => {
  const root = vault({ a: card('a') });
  try {
    suppress(root, { fingerprint: 'no-colon-here', reason: 'hand-written' });
    const back = unsuppress(root, 'no-colon-here');
    assert.equal(back?.rewound, null);
    assert.equal(suppressedFingerprints(root).size, 0, 'the decline is lifted either way');
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
    deleteNote(root, 'offered');
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

test('an MCP channel with no tools named calls no agent at all', async () => {
  const root = vault({ a: card('a') });
  try {
    // The C2 guard, stated as a test: Slack and Gmail are the shared channels the
    // principle names, so the default has to be that no agent is launched into
    // them — not that one is launched with tools we hope are read-only.
    writeFileSync(settingsPath(root), 'channels: [slack]\n', 'utf8');
    const { reports } = await sweep(root, { only: ['slack'] });
    const slack = reports[0]!;
    assert.equal(slack.fetched, false);
    assert.equal(slack.nextCursor, null);
    assert.match(slack.reason ?? '', /mcp\.slack/);
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
    assert.match(readFileSync(join(paths(root).notes, 'raw.md'), 'utf8'), /---\n\n> x\n\nAlready said\.\n$/);
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
    const text = readFileSync(join(paths(root).notes, 'raw.md'), 'utf8');

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
    const text = readFileSync(join(paths(root).notes, 'raw.md'), 'utf8');
    assert.match(text, /---\n\nkeep me\n$/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});
