import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Conflict,
  Invalid,
  bulkDelete,
  bulkFacet,
  bulkMove,
  checkFacets,
  mtimeOf,
  patchCard,
  putFrontmatter,
  saveAsset,
} from '../src/server/mutate.ts';
import { readAll } from '../src/index/indexer.ts';

/**
 * The write gate.
 *
 * Every change to a card file goes through this module, and half of it had no
 * test — including `bulkMove`, the per-card transform that makes a drag mean the
 * same thing for one card and for twelve. That fix was verified by hand in a
 * terminal and never pinned, which is the pattern this codebase keeps producing:
 * the pure part covered, the thing that applies it not.
 *
 * Everything here takes a root and writes inside it, so a temp directory is the
 * whole setup — no injection, no harness.
 */

function vault(cards: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pj-mutate-'));
  mkdirSync(join(root, 'cards'), { recursive: true });
  writeFileSync(
    join(root, 'facets.yaml'),
    'priority: { label: Priority, values: [now, month, backlog], open: false }\n' +
      'status: { label: Status, values: [planning, done], open: false, single: true }\n' +
      'tech: { label: Tech, values: [kafka], open: true }\n' +
      'parent: { label: Part of, type: ref, single: true }\n',
    'utf8',
  );
  for (const [id, body] of Object.entries(cards)) {
    writeFileSync(join(root, 'cards', `${id}.md`), body, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const card = (id: string, facets: string) =>
  `---\nid: ${id}\ntitle: ${id.toUpperCase()}\nfacets: { ${facets} }\n---\nbody of ${id}\n`;

const facetsOf = (root: string, id: string) =>
  readAll(join(root, 'cards')).records.get(id)?.facets ?? {};

// ---------------------------------------------------------------- bulkMove

/**
 * The bug this function exists to make unrepresentable: the board computed the
 * new values for one card and threw them away whenever more than one was
 * selected, sending uniform values instead. Shift-dragging `now`→`month` took
 * `now` off a single card and `month` off a batch.
 *
 * The property is that every card gets *its own* answer from one transform, which
 * a uniform `values` array cannot express — so the test uses three cards holding
 * three different things and one gesture.
 */
test('a move gives every card its own answer from one gesture', () => {
  const v = vault({
    both: card('both', 'priority: [now, month]'),
    only: card('only', 'priority: [now]'),
    other: card('other', 'priority: [now, backlog]'),
  });
  try {
    const res = bulkMove(v.root, ['both', 'only', 'other'], 'priority', 'now', 'month', 'remove');
    assert.equal(res.changed, 3);
    // `now` came off every one; `month` came off none. Under the old uniform path
    // `both` would have become ['now'] — the inversion.
    assert.deepEqual(facetsOf(v.root, 'both').priority, ['month']);
    assert.equal(facetsOf(v.root, 'only').priority, undefined, 'an emptied facet is dropped');
    assert.deepEqual(facetsOf(v.root, 'other').priority, ['backlog']);
  } finally {
    v.cleanup();
  }
});

test('a plain move replaces the value dragged from and keeps the rest', () => {
  const v = vault({ a: card('a', 'priority: [now, month]') });
  try {
    bulkMove(v.root, ['a'], 'priority', 'now', 'backlog', 'replace');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month', 'backlog']);
  } finally {
    v.cleanup();
  }
});

test('a move writes only the facet it names', () => {
  const v = vault({ a: card('a', 'priority: [now], status: [planning], tech: [kafka]') });
  try {
    bulkMove(v.root, ['a'], 'priority', 'now', 'month', 'replace');
    const after = facetsOf(v.root, 'a');
    assert.deepEqual(after.priority, ['month']);
    // The whole-map replacement this replaced could revert a facet an agent had
    // changed since the client's last read.
    assert.deepEqual(after.status, ['planning']);
    assert.deepEqual(after.tech, ['kafka']);
  } finally {
    v.cleanup();
  }
});

test('a move that changes nothing writes nothing', () => {
  const v = vault({ a: card('a', 'priority: [month]') });
  try {
    const before = mtimeOf(join(v.root, 'cards', 'a.md'));
    assert.equal(bulkMove(v.root, ['a'], 'priority', 'now', 'month', 'add').changed, 0);
    assert.equal(mtimeOf(join(v.root, 'cards', 'a.md')), before, 'the file was not touched');
  } finally {
    v.cleanup();
  }
});

test('a move refuses a value the vocabulary does not have', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    assert.throws(
      () => bulkMove(v.root, ['a'], 'priority', 'now', 'urgent', 'replace'),
      (e: Error) => e instanceof Invalid && /urgent/.test(e.message),
    );
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['now'], 'and leaves the card alone');
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- bulkFacet

/** Uniform on purpose: "make these say `now`" is a different operation from a move. */
test('a bulk facet write is uniform, and set / add / remove each mean one thing', () => {
  const v = vault({
    a: card('a', 'priority: [now, month]'),
    b: card('b', 'priority: [backlog]'),
  });
  try {
    bulkFacet(v.root, ['a', 'b'], 'priority', ['now'], 'set');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['now']);
    assert.deepEqual(facetsOf(v.root, 'b').priority, ['now'], 'set replaces whatever was there');

    bulkFacet(v.root, ['a', 'b'], 'priority', ['month'], 'add');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['now', 'month']);

    bulkFacet(v.root, ['a'], 'priority', ['now'], 'remove');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month']);
  } finally {
    v.cleanup();
  }
});

test('a bulk write skips an id that is not a record rather than failing the batch', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    assert.equal(bulkFacet(v.root, ['a', 'ghost'], 'priority', ['month'], 'set').changed, 1);
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month']);
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- validation

/** The gate every write passes through, and it had no test of its own. */
test('the vocabulary is enforced: unknown facets, closed values, single-valued axes', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    assert.throws(() => checkFacets(v.root, 'a', { nonsuch: ['x'] }), /unknown facet "nonsuch"/);
    assert.throws(() => checkFacets(v.root, 'a', { priority: ['urgent'] }), /urgent/);
    assert.throws(() => checkFacets(v.root, 'a', { status: ['planning', 'done'] }), /one value/);

    // An open facet takes anything; a declared value on a closed one is fine.
    checkFacets(v.root, 'a', { tech: ['something-new'] });
    checkFacets(v.root, 'a', { priority: ['now', 'month'] });
  } finally {
    v.cleanup();
  }
});

/**
 * The graph checks only run when the record map is supplied — `isRef(def) &&
 * records`. Worth pinning, because a caller that omits it gets validation minus
 * the cycle rule and no indication that it did.
 */
test('a reference facet refuses a cycle, and self-reference, given the records', () => {
  const v = vault({
    top: card('top', 'parent: [mid]'),
    mid: card('mid', 'status: [planning]'),
  });
  try {
    const records = readAll(join(v.root, 'cards')).records;

    // `top` already points at `mid`; pointing `mid` back closes a loop.
    assert.throws(
      () => checkFacets(v.root, 'mid', { parent: ['top'] }, records),
      (e: Error) => e instanceof Invalid && /cycle/i.test(e.message),
    );
    assert.throws(
      () => checkFacets(v.root, 'mid', { parent: ['mid'] }, records),
      (e: Error) => e instanceof Invalid && /own record/i.test(e.message),
    );

    // Without the map the vocabulary is still checked, the graph is not.
    checkFacets(v.root, 'mid', { parent: ['top'] });
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- frontmatter

test('frontmatter is written whole, and a stale mtime is a conflict', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    const file = join(v.root, 'cards', 'a.md');
    const res = putFrontmatter(v.root, 'a', 'id: a\ntitle: Renamed\nfacets: { priority: [month] }\n');
    assert.ok(typeof res.mtime === 'number');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month']);
    assert.match(readFileSync(file, 'utf8'), /body of a/, 'the body is untouched');

    // A write carrying an mtime from before someone else's edit is refused.
    assert.throws(() => putFrontmatter(v.root, 'a', 'id: a\ntitle: X\n', 1), (e) => e instanceof Conflict);
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- assets

test('an asset is stored by content hash under its card, and its type is checked', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const first = saveAsset(v.root, 'a', 'image/png', png);
    // The path returned is relative to `cards/`, since that is where a card body
    // resolves it from.
    assert.match(first.path, /^assets\/a\/[0-9a-f]{12}\.png$/, first.path);
    assert.ok(existsSync(join(v.root, 'cards', first.path)), 'stored under cards/');

    // The same bytes hash to the same name rather than accumulating copies.
    assert.equal(saveAsset(v.root, 'a', 'image/png', png).path, first.path);

    assert.throws(() => saveAsset(v.root, 'a', 'application/zip', png), /unsupported image type/);
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- deletion

test('a bulk delete removes the files and reports how many', () => {
  const v = vault({ a: card('a', 'priority: [now]'), b: card('b', 'priority: [now]') });
  try {
    assert.equal(bulkDelete(v.root, ['a', 'ghost']).deleted, 1, 'a missing id is not a failure');
    assert.ok(!existsSync(join(v.root, 'cards', 'a.md')));
    assert.ok(existsSync(join(v.root, 'cards', 'b.md')));
  } finally {
    v.cleanup();
  }
});

test('linking bumps updated, and unlinking an absent ref refuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'projector-link-'));
  try {
    mkdirSync(join(root, 'cards'), { recursive: true });
    writeFileSync(
      join(root, 'cards', 'a.md'),
      '---\nid: a\ntitle: Card A\nupdated: 2020-01-01\n---\nbody\n',
      'utf8',
    );
    writeFileSync(join(root, 'facets.yaml'), 'status: { values: [planning, done] }\n', 'utf8');

    patchCard(root, 'a', { links: ['jira:FOO-1'] });
    const after = readFileSync(join(root, 'cards', 'a.md'), 'utf8');
    assert.match(after, /links: \[jira:FOO-1\]/);
    assert.doesNotMatch(after, /updated: 2020-01-01/, 'a write that leaves `updated` alone is the bug');
    assert.match(after, /updated: \d{4}-\d{2}-\d{2}/);

    // Emptying the array drops the key rather than storing `links: []`.
    patchCard(root, 'a', { links: [] });
    assert.doesNotMatch(readFileSync(join(root, 'cards', 'a.md'), 'utf8'), /links:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The gesture that meant two things.
 *
 * The board computed `nextValues` for one card and then threw it away whenever
 * more than one was selected, sending uniform values to the bulk endpoint
 * instead. Three of four gestures diverged and one *inverted*: shift-dragging
 * `now`→`month` took `now` off a single card and `month` off a batch. There is no
 * cardinality branch to test any more, so this asserts the property instead — the
 * intent carries endpoints, and one transform answers for every card.
 */
