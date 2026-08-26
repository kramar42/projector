import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCached, refresh } from '../src/server/enrich.ts';
import type { Fetcher } from '../src/enrich/types.ts';
import { paths } from '../src/config.ts';

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
  mkdirSync(paths(root).config, { recursive: true });
  for (const [name, body] of Object.entries(docs)) writeFileSync(join(paths(root).notes, name), body, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('awaiting refresh means the fetch has actually landed', async () => {
  const { root, cleanup } = vault({ 'a.md': '# Written down\n\nbody\n' });
  try {
    assert.equal(readCached(root, ['doc:a.md'])[0]!.state, 'missing');
    await refresh({ dataRoot: root }, ['doc:a.md']);
    // The assertion the old signature could not support: `refresh` returned void,
    // so awaiting it resolved immediately and the cache was still empty here.
    const item = readCached(root, ['doc:a.md'])[0]!;
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
    await refresh(opts, ['doc:b.md']);
    assert.equal(signalled, 1, 'the first pass fetched, so it signalled');
    const first = readCached(root, ['doc:b.md'])[0]!.fetchedAt;

    await refresh(opts, ['doc:b.md']);
    assert.equal(signalled, 1, 'the second pass had nothing to do and said so by staying quiet');
    assert.equal(readCached(root, ['doc:b.md'])[0]!.fetchedAt, first, 'and it did not rewrite the row');
  } finally {
    cleanup();
  }
});

test('a ref that cannot resolve is cached as an error rather than retried', async () => {
  const { root, cleanup } = vault();
  try {
    await refresh({ dataRoot: root }, ['doc:absent.md']);
    const item = readCached(root, ['doc:absent.md'])[0]!;
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
    await refresh(opts, ['doc:c.md']);
    assert.equal(readCached(root, ['doc:c.md'])[0]!.data?.title, 'One');

    writeFileSync(join(paths(root).notes, 'c.md'), '# Two\n', 'utf8');
    await refresh(opts, ['doc:c.md'], true);
    assert.equal(signalled, 2);
    assert.equal(readCached(root, ['doc:c.md'])[0]!.data?.title, 'Two');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- in flight

/**
 * A fetcher that resolves when told to, so "waited for the other caller" and
 * "read the cache after it happened to finish" are distinguishable.
 *
 * Every real fetcher is either unusable here — network, a token, the `gh` CLI —
 * or, in `doc:`'s case, resolves inside a microtask. That is fast enough that the
 * two outcomes coincide, so a test written against it passes whether or not the
 * waiting works. This is why `EnrichOptions.fetchers` exists.
 */
function gated(): {
  fetchers: Record<string, Fetcher>;
  release: (ref: string) => void;
  calls: () => number;
} {
  const opens = new Map<string, () => void>();
  const waits = new Map<string, Promise<void>>();
  const gate = (ref: string): Promise<void> => {
    if (!waits.has(ref)) {
      let open!: () => void;
      waits.set(ref, new Promise<void>((r) => (open = r)));
      opens.set(ref, open);
    }
    return waits.get(ref)!;
  };
  let calls = 0;
  return {
    fetchers: {
      doc: {
        ttl: 30,
        async fetch(ref: string) {
          calls++;
          await gate(ref);
          return { label: ref };
        },
      },
    },
    // Per ref, so one can land while another stays open — which is what tells
    // "waited for my own work" apart from "waited for everything I asked about".
    release: (ref: string) => {
      gate(ref);
      opens.get(ref)!();
    },
    calls: () => calls,
  };
}

/**
 * A ref two callers ask for at once is fetched once, and both are told when it
 * lands.
 *
 * `inFlight` was a set of keys, so the second caller could tell that someone was
 * fetching but had no way to wait: the ref was dropped from its batch and the
 * promise resolved as though there had been nothing to do. Then it read the cache
 * back and saw the value that was, at that moment, still being fetched.
 */
test('a caller waits for a fetch another caller started', async () => {
  const { root, cleanup } = vault();
  const g = gated();
  try {
    const first = refresh({ dataRoot: root, fetchers: g.fetchers }, ['doc:shared.md']);
    // Synchronous up to the fetch's first await, so this call finds it in flight.
    const second = refresh({ dataRoot: root, fetchers: g.fetchers }, ['doc:shared.md']);

    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(secondDone, false, 'the borrower must not resolve while the fetch is open');
    assert.equal(readCached(root, ['doc:shared.md'])[0]!.state, 'missing');

    g.release('shared.md');
    await Promise.all([first, second]);
    assert.equal(g.calls(), 1, 'fetched once for both callers');
    assert.equal(readCached(root, ['doc:shared.md'])[0]!.state, 'fresh');
  } finally {
    cleanup();
  }
});

test('only the caller that fetched announces it', async () => {
  const { root, cleanup } = vault();
  const g = gated();
  try {
    let owner = 0;
    let borrower = 0;
    const first = refresh({ dataRoot: root, fetchers: g.fetchers, onRefreshed: () => owner++ }, ['doc:once.md']);
    const second = refresh({ dataRoot: root, fetchers: g.fetchers, onRefreshed: () => borrower++ }, ['doc:once.md']);
    g.release('once.md');
    await Promise.all([first, second]);
    assert.equal(owner, 1, 'the caller that fetched says so');
    assert.equal(borrower, 0, 'a borrower has nothing to announce the owner will not');
  } finally {
    cleanup();
  }
});

/**
 * A call that owns some refs and borrows others resolves when *both* are settled.
 * The promise means "every ref I asked about", not "the ones I happened to own".
 *
 * Releasing only the owned half is what separates the two: awaiting just its own
 * workers, this call would return with the borrowed ref still being fetched, and
 * the caller would read the cache back a moment too early — which is the whole
 * bug, one layer in.
 */
test('a mixed batch waits for the borrowed half too', async () => {
  const { root, cleanup } = vault();
  const g = gated();
  try {
    const first = refresh({ dataRoot: root, fetchers: g.fetchers }, ['doc:a.md']);
    const second = refresh({ dataRoot: root, fetchers: g.fetchers }, ['doc:a.md', 'doc:b.md']);
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });

    g.release('b.md'); // ours has landed; the borrowed one has not
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(secondDone, false, 'own work done is not the same as done');
    assert.equal(readCached(root, ['doc:a.md'])[0]!.state, 'missing');

    g.release('a.md');
    await Promise.all([first, second]);
    assert.deepEqual(
      readCached(root, ['doc:a.md', 'doc:b.md']).map((i) => i.state),
      ['fresh', 'fresh'],
    );
  } finally {
    cleanup();
  }
});

/**
 * The hazard the change introduces, guarded rather than reproduced.
 *
 * As a set, a ref left behind by a throw was merely never refetched. As a promise
 * it hangs everyone waiting on it, so the slot has to be released on every path.
 * Nothing currently reaches that: `parseLink` cannot throw and a fetcher that
 * does is already caught. Moving the last two statements inside the `try` is free
 * insurance, and this is the test that would time out rather than fail if a
 * future path ever leaked a slot — which is the only way a missing release shows.
 */
test('a fetcher that throws still settles, and unblocks a waiter', async () => {
  const { root, cleanup } = vault();
  const boom: Record<string, Fetcher> = {
    doc: {
      ttl: 30,
      fetch() {
        throw new Error('kaboom');
      },
    },
  };
  try {
    const first = refresh({ dataRoot: root, fetchers: boom }, ['doc:never.md']);
    const second = refresh({ dataRoot: root, fetchers: boom }, ['doc:never.md']);
    await Promise.all([first, second]);
    const item = readCached(root, ['doc:never.md'])[0]!;
    assert.equal(item.state, 'error');
    assert.match(item.error ?? '', /kaboom/);
  } finally {
    cleanup();
  }
});
