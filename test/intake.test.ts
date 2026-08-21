import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reindex } from '../src/index/indexer.ts';
import { commitWatermark, resetWatermark, watermarkFor, watermarks } from '../src/intake/db.ts';
import { evidenceFor, fromWorkspacePath, ftsQuery, matchBranch, matchCwd, repoIndex } from '../src/intake/match.ts';
import { candidateCount, channelNames, renderSweep, sweep } from '../src/intake/run.ts';
import { jqlDate } from '../src/sources/jira.ts';
import { workspacePath } from '../src/agent/worktree.ts';
import type { IntakeContext } from '../src/intake/types.ts';

/**
 * Intake is the one part of cockpit holding state that is not derived from the
 * card files, so most of what is worth testing here is the discipline around
 * that: the cursor may not skip anything, and it may not be the thing
 * correctness depends on.
 */

function vault(cards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ck-intake-'));
  mkdirSync(join(root, 'cards'), { recursive: true });
  for (const [name, body] of Object.entries(cards)) {
    writeFileSync(join(root, 'cards', `${name}.md`), body, 'utf8');
  }
  return root;
}

function context(root: string, over: Partial<IntakeContext> = {}): IntakeContext {
  const { db, records } = reindex(root);
  const fingerprints = new Map<string, string[]>();
  const links = new Map<string, string[]>();
  for (const rec of records.values()) {
    if (rec.source_fingerprint) fingerprints.set(rec.source_fingerprint, [rec.id]);
    for (const l of rec.links) links.set(l.raw, [...(links.get(l.raw) ?? []), rec.id]);
  }
  return {
    root,
    db,
    records,
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
    // A run that fetched nothing has no new boundary to record. Overwriting with
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
    const before = reindex(root).records.size;
    await sweep(root, { only: ['claude', 'git'], limit: 3 });
    assert.equal(reindex(root).records.size, before);
    // Proposing is not resolving: only `ck intake commit` moves a cursor.
    assert.deepEqual(watermarks(root), []);
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

test('a channel ck cannot reach still reports its cursor', async () => {
  const root = vault({ a: card('a') });
  try {
    commitWatermark(root, 'slack', '1755700000.1');
    const s = await sweep(root, { only: ['slack', 'gmail'] });
    const slack = s.reports.find((r) => r.channel === 'slack')!;
    assert.equal(slack.fetched, false);
    assert.equal(slack.cursor, '1755700000.1');
    assert.match(slack.note ?? '', /MCP/);
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

// ------------------------------------------------------------------ FTS safety

test('an opening prompt full of FTS operators produces a query, not a syntax error', () => {
  const q = ftsQuery('fix the "keycloak" logout (NEAR: token) AND cookie -- please');
  assert.ok(q);
  // Every token quoted, so nothing in a prompt can be read as an operator.
  assert.match(q!, /^"[a-z0-9]+"( OR "[a-z0-9]+")*$/);
  assert.ok(q!.includes('"keycloak"'));
});

test('a prompt with nothing distinctive left produces no query at all', () => {
  // A query of pure noise matches everything, which is worse than no match.
  assert.equal(ftsQuery('can you please just fix this for me'), null);
  assert.equal(ftsQuery('hi'), null);
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
