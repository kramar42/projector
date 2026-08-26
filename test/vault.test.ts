import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { SEED_FACETS, SEED_VIEWS } from '../src/server/seed.ts';
import {
  countNotes,
  initVault,
  looksLikeVault,
  normalise,
  resolveDoc,
  shippedVaults,
  suggestName,
} from '../src/vault.ts';
import { readAll } from '../src/index/indexer.ts';
import { isConfigured, paths, resolveCliVault, vaultAbove } from '../src/config.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  mkdirSync(paths(dir).config, { recursive: true });
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

/**
 * The two halves of "is this a vault", and why they are not the same question.
 *
 * A folder of markdown can be *opened* as one — that is the whole point of the
 * layout — but it cannot be *found* as one by walking up, or `pj set` run inside
 * any repository would take that repository for its vault. Only `.projector/`,
 * which somebody made by opening a vault, answers the second question.
 */
test('markdown is enough to open a folder as a vault, and never enough to walk up to one', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'pj-vault-'));
  try {
    assert.equal(looksLikeVault(dir), false, 'an empty folder is nobody’s vault');

    // A README is a card like any other file, so a folder holding only one is a
    // folder of markdown — there is no exempted filename left.
    writeFileSync(pathJoin(dir, 'README.md'), '# Notes\n', 'utf8');
    assert.equal(looksLikeVault(dir), true, 'markdown is a vault you can open');
    assert.equal(isConfigured(dir), false, 'but nobody has opened it');
    assert.equal(vaultAbove(dir), null, 'so standing in it finds nothing');

    // Opening it is what leaves the marker, and the marker is what the walk-up
    // reads.
    mkdirSync(paths(dir).config, { recursive: true });
    assert.equal(isConfigured(dir), true);
    assert.equal(vaultAbove(pathJoin(dir, 'deep', 'er')), dir, 'from anywhere below');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  for (const name of ['parent', 'blocked_by']) {
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
    assert.ok(existsSync(paths(root).facets));
    assert.ok(existsSync(paths(root).notes));
    assert.ok(existsSync(paths(root).views));
    // No card-conventions README. That text was a copy of the `pj-about` skill,
    // which an agent already has — and two places stating the format is one
    // place to drift out of date.
    assert.equal(existsSync(pathJoin(paths(root).notes, 'README.md')), false);
    // A seeded vault is a vault, and an empty one.
    assert.ok(looksLikeVault(root));
    assert.equal(countNotes(root), 0);
    // Everything it wrote is under one directory, so the root is still only ever
    // what you put there.
    assert.deepEqual(
      readdirSync(root).filter((f) => f !== '.gitignore'),
      ['.projector'],
      'seeding leaves nothing at the root but the ignore file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A folder of somebody's notes, opened.
 *
 * The three properties that make this *opening* rather than importing: nothing is
 * moved, every markdown file is a card including the README, and the config
 * arrives beside them rather than around them.
 */
test('opening a folder of markdown adds a .projector and touches nothing else', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-adopt-md-'));
  try {
    writeFileSync(pathJoin(root, 'README.md'), '# My notes\n', 'utf8');
    writeFileSync(pathJoin(root, 'kafka.md'), '# Kafka\n', 'utf8');
    mkdirSync(pathJoin(root, 'archive'));
    writeFileSync(pathJoin(root, 'archive', 'old.md'), '# Old\n', 'utf8');
    const before = readFileSync(pathJoin(root, 'README.md'), 'utf8');

    initVault(root, SEED_FACETS, SEED_VIEWS);

    // The vocabulary and views it needs to open onto something.
    assert.ok(existsSync(paths(root).facets), 'a folder of markdown is seeded, not left blank');
    assert.ok(existsSync(pathJoin(paths(root).views, 'home.yaml')));

    // Three cards: the README is one of them, and so is the one in a subfolder.
    assert.equal(countNotes(root), 3, 'no exempted filename, and any depth');
    assert.equal(readFileSync(pathJoin(root, 'README.md'), 'utf8'), before, 'nothing rewritten');
    assert.equal(existsSync(pathJoin(root, 'notes')), false, 'and nothing moved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- what ships

/**
 * A fresh clone opens onto something, without a committed registry.
 *
 * `vaults.json` cannot be committed and be correct: its entries are absolute
 * paths, so one checked in would name the machine it came from. An absent
 * registry *means* the example vault instead, resolved against `appRoot` when it
 * is read — right in every clone, and never written until you open something.
 */
test('an unconfigured install knows about the vault that ships with it', () => {
  const shipped = shippedVaults();
  assert.equal(shipped.length, 1, 'exactly one, and it is in the repository');
  assert.equal(basename(shipped[0]!.path), 'example');
  assert.equal(shipped[0]!.name, 'example');
  assert.ok(isConfigured(shipped[0]!.path), 'and it is a vault, not an empty folder');

  // `PROJECTOR_VAULTS` opts out: pointing the registry elsewhere says the list is
  // mine, and a test asserting "no vaults yet" should not have to know what the
  // repository ships with.
  process.env.PROJECTOR_VAULTS = '/nonexistent/vaults.json';
  try {
    assert.deepEqual(shippedVaults(), []);
  } finally {
    delete process.env.PROJECTOR_VAULTS;
  }
});

test('the example vault is a working vault, not a folder of samples', () => {
  const root = shippedVaults()[0]!.path;
  const { notes, unreadable, duplicates } = readAll(paths(root).notes);
  assert.deepEqual(unreadable, [], 'every file in it parses');
  assert.deepEqual(duplicates, [], 'and no two cards claim one id');
  assert.ok(notes.size >= 8, 'enough of a tour to be worth opening');

  // The two things the layout claims, asserted against the vault a stranger sees
  // first: a card with no frontmatter at all, and a README that is a card.
  const bare = [...notes.values()].filter((r) => !r.body.startsWith('---'));
  assert.ok(
    bare.some((r) => r.id === 'getting-started'),
    'it demonstrates a note that says nothing about itself',
  );
  assert.ok(
    [...notes.values()].some((r) => basename(r.file) === 'README.md'),
    'and a README that is a card like any other file',
  );
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



test('seeding a fresh vault is not the same act as adopting one', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-adopt-'));
  try {
    // Fresh: the starter vocabulary and views go in.
    initVault(root, SEED_FACETS, SEED_VIEWS);
    assert.ok(existsSync(paths(root).facets));
    assert.ok(existsSync(pathJoin(paths(root).views, 'home.yaml')));

    // Now the vault decides it wants neither. Both absences are meaningful: no
    // vocabulary is a vault carrying the built-ins alone, and a deleted view is
    // a view somebody deleted.
    rmSync(paths(root).facets);
    rmSync(pathJoin(paths(root).views, 'home.yaml'));

    // Re-running `--create` over it must not put them back. It used to, because
    // "the file is missing" and "this vault is new" were the same test while a
    // vault could not do without them.
    initVault(root, SEED_FACETS, SEED_VIEWS);
    assert.equal(existsSync(paths(root).facets), false, 'no vocabulary was re-seeded');
    assert.equal(existsSync(pathJoin(paths(root).views, 'home.yaml')), false, 'and no view');

    // And the folder is still a working vault: `cards/` is what says so.
    assert.ok(looksLikeVault(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a folder with somebody else\'s files is refused, not adopted', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-notavault-'));
  try {
    writeFileSync(pathJoin(root, 'thesis.docx'), 'not a vault', 'utf8');
    assert.throws(() => initVault(root, SEED_FACETS, SEED_VIEWS), /not empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
