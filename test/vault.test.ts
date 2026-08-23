import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { SEED_FACETS, SEED_VIEWS } from '../src/server/seed.ts';
import { countCards, initVault, looksLikeVault, normalise, resolveDoc, suggestName } from '../src/vault.ts';
import { resolveCliVault } from '../src/config.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join as pathJoin, resolve } from 'node:path';
import { tmpdir } from 'node:os';


/**
 * Vaults — recognising one, naming one, and the files a fresh one is seeded with.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

// ---------------------------------------------------------------- vaults

test('a vault path is normalised: ~ expanded, absolute, no trailing slash', () => {
  assert.equal(normalise('/tmp/v/'), '/tmp/v');
  assert.equal(normalise('/tmp/v///'), '/tmp/v');
  assert.equal(normalise('~/v').startsWith('/'), true);
  assert.ok(!normalise('~/v').includes('~'));
});

test('the suggested name is the folder name, and nothing cleverer', () => {
  // There is no list of "too generic" leaf names that borrows the parent instead.
  // A suggestion sits in an editable field, so guessing buys nothing and costs
  // predictability.
  assert.equal(suggestName('/Users/k/notes/vault'), 'vault');
  assert.equal(suggestName('/Users/k/Code/work/projector/work'), 'work');
  assert.equal(suggestName('/Users/k/second-brain'), 'second-brain');
});

test('doc refs resolve against the vault, and absolutely when absolute', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'pj-vault-'));
  mkdirSync(pathJoin(dir, 'cards'), { recursive: true });
  writeFileSync(pathJoin(dir, 'inside.md'), '# in');
  const outside = pathJoin(dir, '..', `pj-outside-${process.pid}.md`);
  writeFileSync(outside, '# out');

  assert.equal(resolveDoc('inside.md', dir).path, pathJoin(dir, 'inside.md'));
  // A doc outside the vault is reached with `../` — relative means relative to
  // the vault, not to the card file.
  assert.equal(resolveDoc(`../${basename(outside)}`, dir).path, resolve(outside));
  assert.equal(resolveDoc(outside, dir).path, resolve(outside));
  // A miss reports what it tried, so the message can say where it looked.
  const miss = resolveDoc('nope.md', dir);
  assert.equal(miss.path, null);
  assert.deepEqual(miss.tried, [pathJoin(dir, 'nope.md')]);

  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

test('a directory is a vault when it holds what a vault is made of', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'pj-vault-'));
  assert.equal(looksLikeVault(dir), false);
  mkdirSync(pathJoin(dir, 'cards'));
  assert.equal(looksLikeVault(dir), true);
  rmSync(dir, { recursive: true, force: true });
});

test('the CLI picks a vault explicitly, or unambiguously, or asks', () => {
  // The registry is the subject here, so the env seam that outranks it is cleared
  // — otherwise a `PROJECTOR_DATA` exported in the shell answers every case.
  delete process.env.PROJECTOR_DATA;
  const one = [{ path: '/v/one', name: 'one' }];
  const two = [...one, { path: '/v/two', name: 'two' }];

  // An explicit flag wins over everything.
  assert.deepEqual(resolveCliVault(['node', 'pj', '--vault', '/v/x', 'ls'], two), { root: '/v/x' });
  // One registered vault needs no flag.
  assert.deepEqual(resolveCliVault(['node', 'pj', 'ls'], one), { root: '/v/one' });
  // Several, with no choice made, must ask rather than guess.
  const ambiguous = resolveCliVault(['node', 'pj', 'ls'], two);
  assert.ok('error' in ambiguous && /--vault/.test(ambiguous.error));
  // None at all says how to get one.
  const none = resolveCliVault(['node', 'pj', 'ls'], []);
  assert.ok('error' in none && /no vault/.test(none.error));
  // A flag with no value is an error, not a silent fallback.
  const bare = resolveCliVault(['node', 'pj', 'ls', '--vault'], one);
  assert.ok('error' in bare);
});


// ---------------------------------------------------------------- the seed

test('every seeded file parses as what it claims to be', () => {
  // The facet vocabulary and the conventions doc are template literals, so a
  // stray backtick in a comment silently ends the string and breaks the whole
  // module. That has happened three times; this is the guard.
  const facets = parse(SEED_FACETS) as Record<string, Record<string, unknown>>;
  assert.ok(Object.keys(facets).length > 5);
  for (const [name, def] of Object.entries(facets)) {
    assert.equal(typeof def, 'object', `${name} should be a mapping`);
  }
  // `project` is built-in, so the seed must *not* declare it — a declaration
  // would be inert, which is why the name is reserved.
  assert.equal(facets.project, undefined, 'project is built-in, not seeded');
  // Reference facets declare no values, and every relation is one.
  for (const name of ['parent', 'blocks']) {
    assert.equal(facets[name]!.type, 'ref', `${name} should be a reference facet`);
    assert.equal(facets[name]!.values, undefined, `${name} should declare no values`);
  }
  for (const view of SEED_VIEWS) {
    const y = parse(view.body) as Record<string, unknown>;
    assert.ok(y.shape, `${view.path} states its shape`);
    assert.ok(y.title, `${view.path} has a title`);
  }
});

test('a new vault is seeded with a vocabulary and views, and no prose', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-seed-'));
  try {
    initVault(root, SEED_FACETS, SEED_VIEWS);
    assert.ok(existsSync(pathJoin(root, 'facets.yaml')));
    assert.ok(existsSync(pathJoin(root, 'cards')));
    assert.ok(existsSync(pathJoin(root, 'views')));
    // No card-conventions README. That text was a copy of the `projector` skill,
    // which an agent already has — and two places stating the format is one
    // place to drift out of date.
    assert.equal(existsSync(pathJoin(root, 'cards', 'README.md')), false);
    // A seeded vault is a vault, and an empty one: the README used to be the
    // only file in cards/, so this is what "no cards yet" now looks like.
    assert.ok(looksLikeVault(root));
    assert.equal(countCards(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the seeded vocabulary covers every facet the seeded views use', () => {
  const facets = parse(SEED_FACETS) as Record<string, unknown>;
  const computed = new Set(['type', 'blocked', 'triage', 'due', 'staleness']);
  for (const view of SEED_VIEWS) {
    const y = parse(view.body) as { filter?: Record<string, unknown>; groupBy?: string[]; chips?: string[] };
    for (const name of [...Object.keys(y.filter ?? {}), ...(y.groupBy ?? []), ...(y.chips ?? [])]) {
      assert.ok(name in facets || computed.has(name), `${view.path} uses unknown facet "${name}"`);
    }
  }
});

