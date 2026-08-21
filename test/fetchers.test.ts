import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, firstLine } from '../src/sources/run.ts';
import { isUnavailable, unavailable } from '../src/enrich/types.ts';
import { branchFetcher, prFetcher } from '../src/enrich/github.ts';
import { sessionFetcher } from '../src/enrich/claudeSession.ts';
import { jiraFetcher, statusTone as jiraStatusTone } from '../src/enrich/jira.ts';
import { docFetcher } from '../src/enrich/doc.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


/**
 * The read-only link fetchers, one per kind, and what an unavailable one reports.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

// ---------------------------------------------------------------- enrichment

test('relative ages read naturally', () => {
  const now = Date.now();
  assert.equal(ago(now - 30_000), 'just now');
  assert.equal(ago(now - 20 * 60_000), '20m ago');
  assert.equal(ago(now - 5 * 3600_000), '5h ago');
  assert.equal(ago(now - 3 * 86400_000), '3d ago');
  assert.equal(ago(now - 400 * 86400_000), '1y ago');
  assert.equal(ago(undefined), '');
  assert.equal(ago('not a date'), '');
});

test('firstLine skips blank lines and truncates', () => {
  assert.equal(firstLine('\n\n  hello there\nsecond'), 'hello there');
  assert.equal(firstLine('x'.repeat(50), 10), 'x'.repeat(9) + '…');
});

test('a fetcher signals unavailability instead of throwing', () => {
  const u = unavailable('no credentials', true);
  assert.equal(isUnavailable(u), true);
  assert.equal(u.needsSetup, true);
  assert.equal(isUnavailable({ label: 'x' }), false);
});

test('an unparseable gh ref is reported, not fetched', async () => {
  for (const bad of ['no-hash', 'ORG/repo#', '#12', 'ORG/repo']) {
    const r = await prFetcher.fetch(bad);
    assert.equal(isUnavailable(r), true, bad);
    if (isUnavailable(r)) assert.match(r.reason, /expected gh:pr/);
  }
});

test('an unparseable branch ref is reported', async () => {
  for (const bad of ['ORG/repo', 'ORG/repo@', '@main']) {
    const r = await branchFetcher.fetch(bad);
    assert.equal(isUnavailable(r), true, bad);
  }
});

test('a session id that is not one is rejected without touching disk', async () => {
  const r = await sessionFetcher.fetch('nope');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) assert.match(r.reason, /not a session id/);
});

test('a desktop-app local_ id explains why it cannot resolve', async () => {
  const r = await sessionFetcher.fetch('local_3c379ddf-4887-4235-a12e-493ecfb49420');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) assert.match(r.reason, /transcript uuid/);
});

test('jira says what configuration it needs', async () => {
  const saved = process.env.PROJECTOR_JIRA_URL;
  delete process.env.PROJECTOR_JIRA_URL;
  const r = await jiraFetcher.fetch('PROJ-303');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) {
    assert.equal(r.needsSetup, true);
    assert.match(r.reason, /PROJECTOR_JIRA_URL/);
  }
  if (saved) process.env.PROJECTOR_JIRA_URL = saved;
});

test('a bad issue key never reaches the network', async () => {
  process.env.PROJECTOR_JIRA_URL = 'https://example.invalid';
  process.env.PROJECTOR_JIRA_EMAIL = 'a@b.c';
  process.env.PROJECTOR_JIRA_TOKEN = 'x';
  const r = await jiraFetcher.fetch('not-a-key');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) assert.match(r.reason, /not an issue key/);
  delete process.env.PROJECTOR_JIRA_URL;
  delete process.env.PROJECTOR_JIRA_EMAIL;
  delete process.env.PROJECTOR_JIRA_TOKEN;
});

test('jira status colour follows statusCategory, not workflow names', () => {
  // Custom workflows make names useless; the category is stable.
  assert.equal(jiraStatusTone('Preparation', 'new'), 'neutral');
  assert.equal(jiraStatusTone('in review', 'indeterminate'), 'warn');
  assert.equal(jiraStatusTone('Done', 'done'), 'good');
  // Jira files abandonment under `done`; that is not a success.
  assert.equal(jiraStatusTone("Won't do", 'done'), 'neutral');
  assert.equal(jiraStatusTone('Cancelled', 'done'), 'neutral');
  assert.equal(jiraStatusTone('Duplicate', 'done'), 'neutral');
  assert.equal(jiraStatusTone('Anything', undefined), 'neutral');
});


// ---------------------------------------------------------------- doc

/**
 * A doc is the one enriched kind that is not a web page, so the thing worth
 * pinning is how you get into it.
 *
 * `file://` is not an option — a browser will not navigate to one from an http
 * page, and where it does anything it downloads a copy. So the shape is the one
 * `claude:` already uses: a deep link where an app is registered for one, and a
 * command where none is. No URL scheme means "open with whatever owns this", so
 * the deep link has to be configured rather than guessed.
 */
test('a doc offers a command always, and a deep link only when one is configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pj-doc-'));
  writeFileSync(join(dir, 'note.md'), '# Title\n\nSome prose.\n', 'utf8');
  const before = process.env.PROJECTOR_DOC_URL;
  try {
    delete process.env.PROJECTOR_DOC_URL;
    const plain = await docFetcher(dir).fetch('note.md');
    assert.ok(!isUnavailable(plain));
    assert.equal(plain.command, `open ${join(dir, 'note.md')}`);
    assert.equal(plain.action, undefined, 'no editor is assumed');
    assert.equal(plain.url, undefined, 'never a file:// url');

    process.env.PROJECTOR_DOC_URL = 'cursor://file{path}';
    const configured = await docFetcher(dir).fetch('note.md');
    assert.ok(!isUnavailable(configured));
    assert.equal(configured.action?.href, `cursor://file${encodeURI(join(dir, 'note.md'))}`);
    assert.ok(configured.command, 'the command survives alongside the deep link');

    // A template that does not say where the path goes cannot be used.
    process.env.PROJECTOR_DOC_URL = 'cursor://file';
    const bad = await docFetcher(dir).fetch('note.md');
    assert.ok(!isUnavailable(bad));
    assert.equal(bad.action, undefined);
  } finally {
    if (before === undefined) delete process.env.PROJECTOR_DOC_URL;
    else process.env.PROJECTOR_DOC_URL = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a path with a space is quoted so the command can be pasted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pj-doc space-'));
  writeFileSync(join(dir, 'a note.md'), '# T\n', 'utf8');
  try {
    const res = await docFetcher(dir).fetch('a note.md');
    assert.ok(!isUnavailable(res));
    assert.match(res.command!, /^open "/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
