import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCached, refresh } from '../src/server/enrich.ts';

/**
 * Enrichment has two signals and they are not the same event: `onRefreshed` says
 * *new data landed, re-ask*, and the promise `refresh` returns says *the queue
 * has drained*.
 *
 * They were one, and `refresh` fired it on only one of its two exits — the early
 * return for "nothing to fetch" stayed silent. That path is the common one: an
 * already-fresh ref, one already in flight, or a kind with no fetcher. So the one
 * caller that wanted completion raced the callback against a 60-second fallback
 * timer and lost every time, and `pj enrich` took a minute to report work that
 * had taken no time at all.
 *
 * Only `doc:` is exercised here. It is the one fetcher that reads the filesystem
 * and nothing else, so these stay hermetic — the rest need a network, a token or
 * the `gh` CLI, which is a property of the fetcher rather than of this contract.
 */
function vault(docs: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pj-enrich-'));
  mkdirSync(join(root, 'cards'), { recursive: true });
  mkdirSync(join(root, 'notes'), { recursive: true });
  for (const [name, body] of Object.entries(docs)) writeFileSync(join(root, 'notes', name), body, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('awaiting refresh means the fetch has actually landed', async () => {
  const { root, cleanup } = vault({ 'a.md': '# Written down\n\nbody\n' });
  try {
    assert.equal(readCached(root, ['doc:notes/a.md'])[0]!.state, 'missing');
    await refresh({ dataRoot: root }, ['doc:notes/a.md']);
    // The assertion the old signature could not support: `refresh` returned void,
    // so awaiting it resolved immediately and the cache was still empty here.
    const item = readCached(root, ['doc:notes/a.md'])[0]!;
    assert.equal(item.state, 'fresh');
    assert.equal(item.data?.label, 'a.md');
  } finally {
    cleanup();
  }
});

test('nothing to fetch resolves promptly, and claims nothing landed', async () => {
  const { root, cleanup } = vault();
  try {
    let signalled = 0;
    // `slack` has no fetcher, so there is nothing to queue. This is the exit that
    // used to return without a word.
    await refresh({ dataRoot: root, onRefreshed: () => signalled++ }, ['slack:C0123/1700000000.000100']);
    assert.equal(signalled, 0, 'no fetch happened, so nothing was invalidated');
    assert.equal(readCached(root, ['slack:C0123/1700000000.000100'])[0]!.state, 'unsupported');
  } finally {
    cleanup();
  }
});

test('a second pass over a fresh ref resolves without refetching', async () => {
  const { root, cleanup } = vault({ 'b.md': '# Fresh\n' });
  try {
    let signalled = 0;
    const opts = { dataRoot: root, onRefreshed: () => signalled++ };
    await refresh(opts, ['doc:notes/b.md']);
    assert.equal(signalled, 1, 'the first pass fetched, so it signalled');
    const first = readCached(root, ['doc:notes/b.md'])[0]!.fetchedAt;

    await refresh(opts, ['doc:notes/b.md']);
    assert.equal(signalled, 1, 'the second pass had nothing to do and said so by staying quiet');
    assert.equal(readCached(root, ['doc:notes/b.md'])[0]!.fetchedAt, first, 'and it did not rewrite the row');
  } finally {
    cleanup();
  }
});

test('a ref that cannot resolve is cached as an error rather than retried', async () => {
  const { root, cleanup } = vault();
  try {
    await refresh({ dataRoot: root }, ['doc:notes/absent.md']);
    const item = readCached(root, ['doc:notes/absent.md'])[0]!;
    assert.equal(item.state, 'error', 'a failure is cached like a success');
    assert.match(item.error ?? '', /no file at/);
    assert.notEqual(item.state, 'missing', 'otherwise every render retries it');
  } finally {
    cleanup();
  }
});

test('force refetches a ref that is already fresh', async () => {
  const { root, cleanup } = vault({ 'c.md': '# One\n' });
  try {
    let signalled = 0;
    const opts = { dataRoot: root, onRefreshed: () => signalled++ };
    await refresh(opts, ['doc:notes/c.md']);
    assert.equal(readCached(root, ['doc:notes/c.md'])[0]!.data?.title, 'One');

    writeFileSync(join(root, 'notes', 'c.md'), '# Two\n', 'utf8');
    await refresh(opts, ['doc:notes/c.md'], true);
    assert.equal(signalled, 2);
    assert.equal(readCached(root, ['doc:notes/c.md'])[0]!.data?.title, 'Two');
  } finally {
    cleanup();
  }
});
