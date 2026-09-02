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
import { candidateFor, linkFor } from '../src/intake/mcp.ts';
import {
  conversationsFrom,
  costFromEnvelope,
  knownFor,
  parseGmailRelay,
  parseSlackRelay,
  relayInstructions,
  renderCost,
  scrubSecrets,
  searchToolIn,
  slackBoundary,
  slackPermalinkParts,
  trackedBy,
  transcribedAll,
  transcript as exchangeOf,
} from '../src/intake/relay.ts';
import { markSeen, seenState } from '../src/intake/db.ts';
import { claudeChannel } from '../src/intake/claude.ts';
import { jiraChannel } from '../src/intake/jira.ts';
import { gogSearchArgs, parseGogSearch } from '../src/intake/gmail.ts';
import { parseLink } from '../src/schema/links.ts';
import { deleteNote } from '../src/server/mutate.ts';
import { pollOnce, startPolling, stopPolling, withinHours } from '../src/server/poll.ts';
import { classify, ollamaAsk, type Ask, type Verdict } from '../src/intake/classify.ts';
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
    // rows exist — but every cursor is still unset, and only `pj intake advance`
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
    // The fetching agent is a relay now and copies verbatim on purpose, so the
    // rule moved from its prompt into code: known shapes are redacted before any
    // text leaves the parser. The maxim from NEXT.md — never ask a model to
    // honour a rule code can apply.
    const scrubbed = scrubSecrets(
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and AKIAIOSFODNN7EXAMPLE and xoxb-1234567890-abcdefghij, commit 3f2a9c1d',
    );
    assert.doesNotMatch(scrubbed, /ghp_|AKIA|xoxb-/, 'the values are gone');
    assert.match(scrubbed, /\[redacted github token\].*\[redacted aws key id\].*\[redacted slack token\]/, 'and say what they were');
    assert.match(scrubbed, /3f2a9c1d/, 'a commit hash is not a secret');
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

test('the relay is told exactly what to call, to copy verbatim, and never to write', () => {
  // Pinned as wording for the same reason the secrets rule was: the read-only
  // line and the verbatim rule are the whole safety story of an agent in the
  // fetch path, and a later edit must not drop either silently.
  const since = new Date('2026-08-29T01:11:25+02:00');
  const slack = relayInstructions('slack', { since, pages: 5, searchTool: 'mcp__x__slack_search_public_and_private' });
  assert.match(slack, /READ ONLY/);
  assert.match(slack, /Do not filter, summarise, judge/, 'a relay, not a summariser');
  assert.match(slack, /mcp__x__slack_search_public_and_private/, 'the tool the vault named, by its exact id');
  assert.match(slack, /"to:me"/);
  assert.match(slack, /"from:me"/, 'both directions, so whose move it is can be computed');
  assert.match(slack, new RegExp(`after "${Math.floor(since.getTime() / 1000)}"`), 'the cursor as an epoch the tool understands');
  assert.match(slack, /up to 5 pages/);
  assert.match(slack, /"permalink"/, 'a link a person can open');
  assert.match(slack, /"ts"/, 'and the id a fingerprint is made of, as two fields');

  // Gmail's `after:` is a day in the account's own timezone, so the relay is
  // given the UTC day before the cursor and the parser applies the cursor
  // exactly. A day of overlap costs a few known threads; a day of gap costs mail.
  const gmail = relayInstructions('gmail', { since: new Date('2026-08-29T12:00:00Z'), pages: 3, searchTool: 'mcp__x__search_threads' });
  assert.match(gmail, /in:inbox after:2026\/08\/28/);
  assert.match(gmail, /in:sent after:2026\/08\/28/);
  assert.match(gmail, /"labels"/, 'SENT is how the owner’s own mail is told apart');

  // The relay needs one tool per source, found in the allowlist by suffix; a
  // list without it is a configuration error the channel reports, not a guess.
  assert.equal(searchToolIn('slack', ['mcp__x__slack_read_channel', 'mcp__x__slack_search_public_and_private']), 'mcp__x__slack_search_public_and_private');
  assert.equal(searchToolIn('gmail', ['mcp__x__get_thread']), null);
});

test('the Gmail CLI boundary is read-only and its JSON becomes factual candidates', () => {
  const root = vault({ a: card('a') });
  try {
    const args = gogSearchArgs(
      context(root, { since: new Date('2026-08-30T00:00:00.000Z') }),
      'me@example.com',
    );
    assert.ok(args.includes('--readonly'));
    assert.ok(args.includes('--gmail-no-send'));
    assert.ok(args.includes('--no-input'));
    assert.deepEqual(args.slice(-4), ['gmail', 'search', 'in:inbox after:1788048000', '--all']);
    assert.ok(!args.some((arg) => /send|modify|delete/.test(arg) && arg !== '--gmail-no-send'));

    assert.deepEqual(
      parseGogSearch(
        JSON.stringify({
          threads: [
            {
              id: 'abc123',
              subject: 'Can you review this?',
              from: 'Ada <ada@example.com>',
              date: '2026-08-30T10:00:00Z',
              snippet: 'The change is ready.',
            },
          ],
        }),
      ),
      [
        {
          id: 'abc123',
          title: 'Can you review this?',
          detail: 'Ada <ada@example.com> — The change is ready.',
          when: '2026-08-30T10:00:00.000Z',
        },
      ],
    );
    assert.equal(parseGogSearch('not json'), null);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
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


// ------------------------------------------------------------------- the relay

/**
 * The relay: an agent copies tool results into one shape, and everything that is
 * decided about them — conversations, whose move it is, whether the vault tracks
 * them — is computed here. These are the tests of the computing half, on records
 * shaped the way the relay is told to shape them.
 */

const P = (channel: string, ts: string) => `https://acme.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
const slackRecord = (
  channel: string,
  ts: string,
  user: string,
  text: string,
  mine = false,
  over: Record<string, unknown> = {},
) => ({
  channel_id: channel,
  channel: `DM with ${user === 'me' ? 'Someone' : user}`,
  ts,
  thread_ts: null,
  user_id: mine ? 'U0ME' : `U0${user.toUpperCase()}`,
  user: mine ? 'Me' : user,
  mine,
  text,
  permalink: P(channel, ts),
  ...over,
});

test('the relay’s Slack records become conversations that say whose move it is', () => {
  const env = JSON.stringify({
    messages: [
      // An ask nobody answered.
      slackRecord('D0AAAAAAA', '1788344704.998749', 'Marthe', 'do you have time this week to check the submissions?'),
      // An ask, answered eleven minutes later — the case a summariser could not see.
      slackRecord('D0BBBBBBB', '1788340111.790849', 'Vivek', 'can you help me pull the AWS contract?'),
      slackRecord('D0BBBBBBB', '1788340789.000001', 'me', 'never seen one, finance maybe?', true),
      // Only the owner spoke: nothing to react to.
      slackRecord('D0CCCCCCC', '1788340000.000001', 'me', 'sent you the link', true),
      // A record the relay got wrong, and one in a thread.
      slackRecord('not-a-channel', '1788340000.000002', 'x', 'garbage'),
      slackRecord('C0DDDDDDD', '1788350000.000002', 'Gerard', 'metadata on each definition?', false, { thread_ts: '1788349000.000001' }),
    ],
    more: false,
  });
  const parsed = parseSlackRelay(env)!;
  assert.equal(parsed.dropped, 1, 'a bad record is counted, not smuggled through');
  assert.equal(parsed.more, false);

  const convs = conversationsFrom('slack', parsed.messages, '2026-08-29T00:00:00Z');
  const byKey = new Map(convs.map((c) => [c.key, c]));
  assert.deepEqual([...byKey.keys()].sort(), ['C0DDDDDDD/1788349000.000001', 'D0AAAAAAA', 'D0BBBBBBB', 'D0CCCCCCC']);

  const marthe = byKey.get('D0AAAAAAA')!;
  assert.equal(marthe.ball, 'mine', 'she spoke last, so it is with the owner');
  assert.equal(marthe.asks.length, 1);

  const vivek = byKey.get('D0BBBBBBB')!;
  assert.equal(vivek.ball, 'theirs', 'the owner answered');
  assert.equal(vivek.asks.length, 1, 'but the ask is still an ask — the classifier reads the exchange and decides');
  assert.match(exchangeOf(vivek), /Vivek: can you help.*\n.*you: never seen one/s, 'the exchange, oldest first, the owner marked');

  assert.equal(byKey.get('D0CCCCCCC')!.asks.length, 0, 'only the owner’s own words: nothing to react to');
  assert.equal(byKey.get('C0DDDDDDD/1788349000.000001')!.thread, '1788349000.000001', 'a thread is its own conversation');

  assert.deepEqual(slackPermalinkParts(P('D0AAAAAAA', '1788344704.998749')), { channel: 'D0AAAAAAA', ts: '1788344704.998749' });
});

test('a conversation on an open note is an update; on a closed one, or none, it is not', () => {
  const root = vault({
    open: `---\nid: open\ntitle: Check the submissions\nfacets: { status: [active] }\nlinks: ['slack:${P('D0AAAAAAA', '1788000000.000001')}']\n---\n\nb\n`,
    closed: `---\nid: closed\ntitle: Old AWS thing\nfacets: { status: [done] }\nlinks: ['slack:${P('D0BBBBBBB', '1788000000.000002')}']\n---\n\nb\n`,
    swept: `---\nid: swept\ntitle: A swept thread reply\nsource_fingerprint: slack:C0DDDDDDD/1788349000.000001\n---\n\nb\n`,
  });
  writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n  closed: [done]\n  single: true\n', 'utf8');
  try {
    const ctx = context(root, { cursor: '2026-08-29T00:00:00Z' });
    const parsed = parseSlackRelay(
      JSON.stringify({
        messages: [
          slackRecord('D0AAAAAAA', '1788344704.998749', 'Marthe', 'any news?'),
          slackRecord('D0BBBBBBB', '1788340111.790849', 'Vivek', 'one more thing'),
          slackRecord('C0DDDDDDD', '1788350000.000002', 'Gerard', 'and the sequence?', false, { thread_ts: '1788349000.000001' }),
          slackRecord('D0EEEEEEE', '1788350000.000003', 'Oliver', 'got an issue with the thing'),
        ],
        more: false,
      }),
    )!;
    const known = knownFor('slack', ctx);
    const convs = new Map(conversationsFrom('slack', parsed.messages, ctx.cursor).map((c) => [c.key, c]));

    // Same DM as a message an open note links: tracked, by container.
    const marthe = convs.get('D0AAAAAAA')!;
    assert.deepEqual(trackedBy(marthe, known), ['open']);
    const update = candidateFor('slack', ctx, marthe, ['open'])!;
    assert.equal(update.fingerprint, 'slack:D0AAAAAAA/1788344704.998749', 'keyed by the newest ask, so each exchange is its own offer');
    assert.deepEqual(update.evidence?.linkedTo, ['open'], 'and it says which note it is news about');
    assert.equal(update.evidence?.matches?.[0]?.why, 'tracked', 'first among its matches, so extend may name it');
    assert.match(update.detail ?? '', /already on open/);

    // Same DM as a message a *closed* note links: not tracked — finished work
    // does not hear about later chatter.
    assert.deepEqual(trackedBy(convs.get('D0BBBBBBB')!, known), []);

    // A thread whose root a swept note answers for, by fingerprint.
    assert.deepEqual(trackedBy(convs.get('C0DDDDDDD/1788349000.000001')!, known), ['swept']);

    // Nothing tracks Oliver: a discovery, fingerprinted by its first ask.
    const oliver = convs.get('D0EEEEEEE')!;
    assert.deepEqual(trackedBy(oliver, known), []);
    const fresh = candidateFor('slack', ctx, oliver, [])!;
    assert.equal(fresh.fingerprint, 'slack:D0EEEEEEE/1788350000.000003');
    assert.deepEqual(fresh.links, [`slack:${P('D0EEEEEEE', '1788350000.000003')}`], 'the permalink, never the fingerprint');
    assert.equal(fresh.evidence?.linkedTo, undefined);
    assert.ok(fresh.fields?.some((f) => f.k === 'conversation'), 'the classifier is handed the exchange');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the relay’s Gmail threads become conversations, and SENT marks the owner’s mail', () => {
  const env = JSON.stringify({
    threads: [
      {
        id: '1a05c9cf17367981',
        subject: 'Weekly report',
        messages: [
          { id: '1a05c9cf17367981', date: '2026-09-01T10:56:12Z', from: 't@example.com', to: ['me@example.com'], labels: ['INBOX', 'UNREAD'], snippet: 'could you help with the weekly report' },
        ],
      },
      {
        id: '1a060d74b08da162',
        subject: 'Product version',
        messages: [
          { id: '1a060d74b08da162', date: '2026-09-02T06:38:36Z', from: 's@example.com', to: ['me@example.com'], labels: ['INBOX'], snippet: 'please create the product version' },
          { id: '1a060d74b08da163', date: '2026-09-02T07:00:00Z', from: 'me@example.com', to: ['s@example.com'], labels: ['SENT'], snippet: 'done, see the release page' },
          // The same message again, from the in:sent search: one message, not two.
          { id: '1a060d74b08da163', date: '2026-09-02T07:00:00Z', from: 'me@example.com', to: ['s@example.com'], labels: ['SENT'], snippet: 'done, see the release page', mine: true },
        ],
      },
      { id: 'bad id', subject: 'x', messages: [] },
    ],
    more: true,
  });
  const parsed = parseGmailRelay(env)!;
  assert.equal(parsed.dropped, 1);
  assert.equal(parsed.more, true, 'pages were left: Gmail pages newest-first, so the run is truncated and the cursor holds');
  const convs = new Map(conversationsFrom('gmail', parsed.messages, null).map((c) => [c.key, c]));

  const report = convs.get('1a05c9cf17367981')!;
  assert.equal(report.ball, 'mine');
  assert.equal(report.name, 'Weekly report');
  assert.equal(report.last.url, 'https://mail.google.com/mail/u/0/#all/1a05c9cf17367981', 'the thread URL Gmail opens, from the id the API gave');

  const version = convs.get('1a060d74b08da162')!;
  assert.equal(version.messages.length, 2, 'the overlap of the two searches is one message');
  assert.equal(version.ball, 'theirs', 'the owner answered — SENT says so');
  assert.equal(version.asks.length, 1);
});

test('a Gmail thread an open note links is an update keyed by the new message', () => {
  const root = vault({
    a: `---\nid: a\ntitle: Weekly report\nfacets: { status: [active] }\nlinks: ['https://mail.google.com/mail/u/0/#inbox/1a05c9cf17367981']\n---\n\nb\n`,
  });
  try {
    const ctx = context(root);
    const parsed = parseGmailRelay(
      JSON.stringify({
        threads: [
          {
            id: '1a05c9cf17367981',
            subject: 'Weekly report',
            messages: [{ id: '1a05c9cf17367999', date: '2026-09-03T10:00:00Z', from: 't@example.com', labels: ['INBOX'], snippet: 'any update?' }],
          },
        ],
        more: false,
      }),
    )!;
    const [conv] = conversationsFrom('gmail', parsed.messages, null);
    const tracked = trackedBy(conv!, knownFor('gmail', ctx));
    assert.deepEqual(tracked, ['a'], 'either URL shape a note carries names the thread');
    const c = candidateFor('gmail', ctx, conv!, tracked)!;
    assert.equal(c.fingerprint, 'gmail:1a05c9cf17367981@1a05c9cf17367999');
    assert.deepEqual(c.evidence?.linkedTo, ['a']);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a relay channel end to end: a fake agent’s envelope becomes candidates, with what it cost', async () => {
  const root = vault({ a: card('a') });
  // A stand-in for `claude -p`: prints the JSON envelope the CLI prints, with the
  // relay's answer in `result`. Executable, because `run` execs it directly.
  const agent = join(root, 'fake-agent.mjs');
  writeFileSync(
    agent,
    `#!/usr/bin/env node
const answer = ${JSON.stringify(JSON.stringify({ messages: [slackRecord('D0AAAAAAA', '1788344704.998749', 'Marthe', 'any time this week?')], more: false }))};
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: answer, duration_ms: 43210, num_turns: 4, total_cost_usd: 0.0412, usage: { input_tokens: 120, cache_creation_input_tokens: 20000, cache_read_input_tokens: 3000, output_tokens: 900 } }));
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  writeFileSync(
    settingsPath(root),
    `channels: [slack]\nmcp:\n  command: ${agent}\n  slack: [mcp__x__slack_search_public_and_private]\n`,
    'utf8',
  );
  try {
    const { reports } = await sweep(root, { only: ['slack'] });
    const r = reports[0]!;
    assert.equal(r.fetched, true);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]!.fingerprint, 'slack:D0AAAAAAA/1788344704.998749');
    assert.equal(r.nextCursor, '2026-09-02T10:25:04.998Z', 'the newest thing seen, as an ISO the next `after` is computed from');
    // Every field the envelope offers, so the log can say what a tick spent.
    assert.deepEqual(r.cost, { ms: 43210, inputTokens: 23120, outputTokens: 900, costUsd: 0.0412, turns: 4 });
    assert.match(renderSweep({ reports, unknown: [] }), /fetch 43\.2s · 23k in \/ 900 out tok · 4 turns · \$0\.041/);
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a vault naming a tool list without the search tool is told so, not guessed for', async () => {
  const root = vault({ a: card('a') });
  writeFileSync(settingsPath(root), 'channels: [slack]\nmcp:\n  slack: [mcp__x__slack_read_channel]\n', 'utf8');
  try {
    const { reports } = await sweep(root, { only: ['slack'] });
    assert.equal(reports[0]!.fetched, false);
    assert.match(reports[0]!.reason ?? '', /names no search tool/);
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
    assert.equal(v.decision, 'extend', '`keep` on tracked news is coerced');
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

test('a tracked Jira issue is offered when it moved and skipped when it did not', async () => {
  const root = vault({
    a: `---\nid: a\ntitle: Fix the thing\nfacets: { status: [active] }\nlinks: ['jira:PROJ-1']\n---\n\nb\n`,
    z: `---\nid: z\ntitle: Old thing\nfacets: { status: [done] }\nlinks: ['jira:PROJ-2']\n---\n\nb\n`,
  });
  writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n  closed: [done]\n  single: true\n', 'utf8');
  const env = { ...process.env };
  process.env.PROJECTOR_JIRA_URL = 'https://acme.atlassian.net';
  process.env.PROJECTOR_JIRA_EMAIL = 'me@acme.test';
  process.env.PROJECTOR_JIRA_TOKEN = 'not-a-real-token';
  const original = globalThis.fetch;
  let status = 'In Progress';
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        issues: [
          { key: 'PROJ-1', fields: { summary: 'Fix the thing', status: { name: status }, issuetype: { name: 'Bug' }, updated: '2026-09-01T10:00:00.000+0000' } },
          { key: 'PROJ-2', fields: { summary: 'Old thing', status: { name: 'Done' }, updated: '2026-09-01T11:00:00.000+0000' } },
          { key: 'PROJ-3', fields: { summary: 'Brand new', status: { name: 'Open' }, updated: '2026-09-01T12:00:00.000+0000' } },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  try {
    const first = await jiraChannel.collect(context(root));
    const fps = first.candidates.map((c) => c.fingerprint);
    // First look at a tracked issue: nothing to compare against, so it is offered
    // as an update — the classifier drops it if nothing meaningful moved.
    assert.ok(fps.includes('jira:PROJ-1@2026-09-01T10:00:00.000+0000'), `per update, not per issue: ${fps}`);
    const update = first.candidates.find((c) => c.fingerprint.startsWith('jira:PROJ-1@'))!;
    assert.deepEqual(update.evidence?.linkedTo, ['a']);
    assert.deepEqual(update.state, { key: 'jira:PROJ-1', value: 'In Progress · unassigned' });
    assert.ok(fps.includes('jira:PROJ-3'), 'a discovery keeps its plain fingerprint');
    assert.ok(
      first.skipped.some((s) => s.fingerprint === 'jira:PROJ-2' && /closed/.test(s.why)),
      'an issue only a finished note tracks is skipped, and says why',
    );

    // Judged: the tick records the state. The same state next time is not news.
    markSeen(root, 'jira:PROJ-1', 'In Progress · unassigned');
    const second = await jiraChannel.collect(context(root));
    assert.ok(!second.candidates.some((c) => c.fingerprint.startsWith('jira:PROJ-1')));
    assert.ok(second.skipped.some((s) => s.fingerprint === 'jira:PROJ-1' && /unchanged/.test(s.why)));

    // It moved: offered again, saying what it was.
    status = 'Done';
    const third = await jiraChannel.collect(context(root));
    const moved = third.candidates.find((c) => c.fingerprint.startsWith('jira:PROJ-1@'))!;
    assert.ok(moved, 'a status change is news');
    assert.match(moved.detail ?? '', /was In Progress/);
    assert.equal(seenState(root, 'jira:PROJ-1'), 'In Progress · unassigned', 'collecting never marks anything seen');
  } finally {
    globalThis.fetch = original;
    for (const k of ['PROJECTOR_JIRA_URL', 'PROJECTOR_JIRA_EMAIL', 'PROJECTOR_JIRA_TOKEN']) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tick records the state it judged in, a held tick does not, and both say what they cost', async () => {
  const root = vault({ a: card('a') });
  const fake: Channel = {
    name: 'fake',
    defaultDays: 1,
    collect: (ctx) => ({
      channel: 'fake',
      cursor: ctx.cursor,
      nextCursor: '2026-04-04T00:00:00.000Z',
      fetched: true,
      candidates: [candidate('fake:1', 'Something', { channel: 'fake', state: { key: 'fake:thing', value: 'v1' } })],
      skipped: [],
      cost: { ms: 1000, inputTokens: 10, outputTokens: 2 },
    }),
  };
  CHANNELS.push(fake);
  writeFileSync(settingsPath(root), 'poll:\n  enabled: true\nchannels: [fake]\n', 'utf8');
  try {
    const held = await pollOnce(root, async () => null);
    assert.ok(held.held);
    assert.equal(seenState(root, 'fake:thing'), null, 'a held tick must see the same change again');

    const judged = await pollOnce(root, async () => ({
      text: '[{"fp":"fake:1","decision":"keep","reason":"wanted","title":"A thing"}]',
      cost: { ms: 500, inputTokens: 300, outputTokens: 20 },
    }));
    assert.equal(judged.created.length, 1);
    assert.equal(seenState(root, 'fake:thing'), 'v1', 'judged, so the state is a fact now');
    assert.deepEqual(judged.cost, { ms: 1500, inputTokens: 310, outputTokens: 22 }, 'fetching plus judging');
    const line = judged.channels[0]!;
    assert.deepEqual(line.fetch, { ms: 1000, inputTokens: 10, outputTokens: 2 });
    assert.deepEqual(line.judge, { ms: 500, inputTokens: 300, outputTokens: 20 });
  } finally {
    CHANNELS.splice(CHANNELS.indexOf(fake), 1);
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('declined sessions do not count against the claude channel’s limit', () => {
  const home = mkdtempSync(join(tmpdir(), 'pj-claude-'));
  const prev = process.env.PROJECTOR_CLAUDE_HOME;
  process.env.PROJECTOR_CLAUDE_HOME = home;
  const root = vault({ a: card('a') });
  try {
    const dir = join(home, 'projects', '-Users-x-repo');
    mkdirSync(dir, { recursive: true });
    const uuids = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003'];
    uuids.forEach((uuid, i) => {
      const lines: string[] = [];
      for (let t = 0; t < 4; t++) {
        lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `turn ${t} of session ${i}` }, cwd: '/Users/x/repo', timestamp: `2026-08-2${i}T10:0${t}:00Z` }));
        lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: `2026-08-2${i}T10:0${t}:30Z` }));
      }
      writeFileSync(join(dir, `${uuid}.jsonl`), lines.join('\n') + '\n', 'utf8');
    });
    // Two of three declined, and a limit of two. Before the fix the declined pair
    // filled the limit, the run was truncated, the third was never offered and
    // the cursor never moved.
    const ctx = context(root, {
      since: new Date('2026-01-01'),
      limit: 2,
      suppressed: new Set([`claude:${uuids[0]}`, `claude:${uuids[1]}`]),
    });
    const r = claudeChannel.collect(ctx) as ReturnType<typeof claudeChannel.collect> & { candidates: Candidate[] };
    const report = r as Awaited<typeof r>;
    assert.deepEqual(report.candidates.map((c) => c.fingerprint), [`claude:${uuids[2]}`]);
    assert.equal(report.truncated, false, 'not truncated: the declined ones were not counted');
    assert.equal(report.skipped.filter((s) => s.why === 'suppressed earlier').length, 2);
    assert.ok(report.nextCursor, 'so the cursor can move');
  } finally {
    if (prev === undefined) delete process.env.PROJECTOR_CLAUDE_HOME;
    else process.env.PROJECTOR_CLAUDE_HOME = prev;
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
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

test('a channel judged before a hold keeps its notes and its cursor', async () => {
  const root = vault({ a: card('a') });
  const mk = (name: string): Channel => ({
    name,
    defaultDays: 1,
    collect: (ctx) => ({
      channel: name,
      cursor: ctx.cursor,
      nextCursor: `2026-05-05T00:00:00.000Z`,
      fetched: true,
      candidates: [candidate(`${name}:1`, `From ${name}`, { channel: name })],
      skipped: [],
    }),
  });
  const first = mk('fakeA');
  const second = mk('fakeB');
  CHANNELS.push(first, second);
  writeFileSync(settingsPath(root), 'poll:\n  enabled: true\nchannels: [fakeA, fakeB]\n', 'utf8');
  try {
    // The classifier answers for A and dies on B — a relay fetch that cost two
    // minutes must not be paid again next tick because the *other* channel held.
    const judge: Ask = async (_s, user) =>
      user.includes('fakeB:1') ? null : '[{"fp":"fakeA:1","decision":"keep","reason":"wanted","title":"A thing"}]';
    const res = await pollOnce(root, judge);
    assert.match(res.held ?? '', /fakeB/, 'the hold names the channel');
    assert.equal(res.created.length, 1, 'A was written');
    assert.deepEqual(res.advanced, ['fakeA'], 'and advanced');
    assert.equal(watermarkFor(root, 'fakeA')?.cursor, '2026-05-05T00:00:00.000Z');
    assert.equal(watermarkFor(root, 'fakeB')?.cursor ?? null, null, 'B holds where it was');
  } finally {
    CHANNELS.splice(CHANNELS.indexOf(first), 1);
    CHANNELS.splice(CHANNELS.indexOf(second), 1);
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});


test('a Slack run that ran out of pages moves the cursor to where both searches reached', () => {
  const at = (ts: string) => new Date(Number(ts) * 1000).toISOString();
  const msg = (ts: string, mine: boolean) => parseSlackRelay(JSON.stringify({ messages: [slackRecord('D0AAAAAAA', ts, mine ? 'me' : 'X', 't', mine)], more: true }))!.messages[0]!;
  // `to:me` reached further than `from:me`: the safe boundary is the earlier one,
  // because the pages of each search are contiguous from the cursor and the one
  // cut short is the one that decides.
  assert.equal(
    slackBoundary([msg('1788340000.000001', false), msg('1788350000.000001', false), msg('1788345000.000001', true)]),
    at('1788345000.000001'),
  );
  // One direction empty: the other's newest is the boundary.
  assert.equal(slackBoundary([msg('1788340000.000001', false)]), at('1788340000.000001'));
  assert.equal(slackBoundary([]), null);

  // Told to paginate to the end, and told why.
  const text = relayInstructions('slack', { since: new Date('2026-08-29T00:00:00Z'), pages: 5, searchTool: 't' });
  assert.match(text, /Do not stop early/);
});


test('a relay that transcribed fewer records than it read holds the cursor', async () => {
  // The page headers say how many results came back; the records are what the
  // model wrote down. A model can leave one out without failing any validation,
  // and a cursor moved past it loses it for good.
  const short = parseSlackRelay(
    JSON.stringify({
      pages: [{ query: 'to:me', results: 3 }, { query: 'from:me', results: 1 }],
      messages: [slackRecord('D0AAAAAAA', '1788344704.998749', 'Marthe', 'a'), slackRecord('D0AAAAAAA', '1788344800.000001', 'me', 'b', true)],
      more: false,
    }),
  )!;
  assert.equal(short.reported, 4);
  assert.equal(short.transcribed, 2);
  assert.equal(transcribedAll(short), false);
  const full = parseSlackRelay(JSON.stringify({ pages: [{ query: 'to:me', results: 1 }], messages: [slackRecord('D0AAAAAAA', '1788344704.998749', 'Marthe', 'a')], more: false }))!;
  assert.equal(transcribedAll(full), true);
  // More records than pages reported loses nothing: the relay listed fewer pages
  // than it read, not fewer records. One direction only.
  const under = parseSlackRelay(JSON.stringify({ pages: [{ query: 'to:me', results: 1 }], messages: [slackRecord('D0AAAAAAA', '1788344704.998749', 'Marthe', 'a'), slackRecord('D0AAAAAAA', '1788344800.000001', 'me', 'b', true)], more: false }))!;
  assert.equal(transcribedAll(under), true);
  // Gmail counts threads, and a thread both searches listed is two records.
  const gm = parseGmailRelay(JSON.stringify({
    pages: [{ query: 'in:inbox', results: 1 }, { query: 'in:sent', results: 1 }],
    threads: [
      { id: '1a05c9cf17367981', subject: 's', messages: [{ id: '1a05c9cf17367981', date: '2026-09-01T10:00:00Z', from: 'x', labels: ['INBOX'], snippet: 'q' }] },
      { id: '1a05c9cf17367981', subject: 's', messages: [{ id: '1a05c9cf17367982', date: '2026-09-01T11:00:00Z', from: 'me', labels: ['SENT'], snippet: 'a' }] },
    ],
    more: false,
  }))!;
  assert.equal(gm.transcribed, 2);
  assert.equal(transcribedAll(gm), true);
  assert.equal(transcribedAll(parseSlackRelay(JSON.stringify({ messages: [], more: false }))!), null, 'no pages reported: nothing to check against');

  // Through the channel: the candidates are still offered, the cursor is not moved.
  const root = vault({ a: card('a') });
  const agent = join(root, 'short-agent.mjs');
  writeFileSync(
    agent,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: ${JSON.stringify(JSON.stringify({ pages: [{ query: 'to:me', results: 2 }], messages: [slackRecord('D0AAAAAAA', '1788344704.998749', 'Marthe', 'any time?')], more: false }))}, duration_ms: 10, num_turns: 2 }));
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  writeFileSync(settingsPath(root), `channels: [slack]\nmcp:\n  command: ${agent}\n  slack: [mcp__x__slack_search_public_and_private]\n`, 'utf8');
  try {
    const { reports } = await sweep(root, { only: ['slack'] });
    const r = reports[0]!;
    assert.equal(r.fetched, true);
    assert.equal(r.candidates.length, 1, 'what was transcribed is still offered');
    assert.equal(r.nextCursor, null, 'but the cursor does not move past what was not');
    assert.equal(r.truncated, true);
    assert.match(r.reason ?? '', /reported 2 result\(s\) and transcribed 1 — cursor held/);
    assert.match(relayInstructions('slack', { since: new Date(), pages: 1, searchTool: 't' }), /"pages"/, 'the relay is asked for the counts');
  } finally {
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});


test('an unjudged card tracks nothing itself; one that extends a note stands in for it', () => {
  const root = vault({
    real: `---\nid: real\ntitle: The real note\nfacets: { status: [active] }\n---\n\nb\n`,
    // Last tick's card: a proposal pointing at the note, still in the queue.
    card: `---\nid: card\ntitle: A delta card\nfacets: { status: [active], intake: [unjudged], extends: [real] }\nlinks: ['slack:${P('D0AAAAAAA', '1788000000.000001')}']\nsource_fingerprint: slack:D0AAAAAAA/1788000000.000001\n---\n\nb\n`,
    // A proposal extending nothing, in another DM.
    loose: `---\nid: loose\ntitle: A loose card\nfacets: { status: [active], intake: [unjudged] }\nlinks: ['slack:${P('D0BBBBBBB', '1788000000.000002')}']\n---\n\nb\n`,
  });
  writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n  closed: [done]\n  single: true\n', 'utf8');
  try {
    const ctx = context(root, { cursor: '2026-08-29T00:00:00Z' });
    const known = knownFor('slack', ctx);
    const parsed = parseSlackRelay(JSON.stringify({ messages: [
      slackRecord('D0AAAAAAA', '1788344704.998749', 'Marthe', 'and now?'),
      slackRecord('D0BBBBBBB', '1788344704.998750', 'Vivek', 'one more'),
    ], more: false }))!;
    const convs = new Map(conversationsFrom('slack', parsed.messages, ctx.cursor).map((c) => [c.key, c]));
    // The conversation the card came from is news about the *note*, not about
    // the card: an update onto a proposal would chain proposals.
    assert.deepEqual(trackedBy(convs.get('D0AAAAAAA')!, known), ['real']);
    // A proposal that extends nothing tracks nothing until somebody accepts it.
    assert.deepEqual(trackedBy(convs.get('D0BBBBBBB')!, known), []);
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
  // tick is skipped, and nothing is fetched or advanced.
  const root = vault({ a: card('a') });
  const fake: Channel = {
    name: 'fakeH',
    defaultDays: 1,
    collect: (ctx) => ({
      channel: 'fakeH',
      cursor: ctx.cursor,
      nextCursor: '2026-06-06T00:00:00.000Z',
      fetched: true,
      candidates: [candidate('fakeH:1', 'Something', { channel: 'fakeH' })],
      skipped: [],
    }),
  };
  CHANNELS.push(fake);
  const h = new Date().getHours();
  writeFileSync(
    settingsPath(root),
    `poll:\n  enabled: true\n  hours: [${(h + 1) % 24}, ${(h + 2) % 24}]\nchannels: [fakeH]\n`,
    'utf8',
  );
  try {
    assert.equal(startPolling(root), true, 'the loop is running');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(watermarkFor(root, 'fakeH'), null, 'but the tick did not run');
    assert.deepEqual([...reindex(root).notes.keys()].filter((id) => id !== 'a'), [], 'and wrote nothing');
  } finally {
    CHANNELS.splice(CHANNELS.indexOf(fake), 1);
    stopPolling(root);
    closeIntakeDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});
