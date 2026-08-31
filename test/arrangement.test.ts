import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { saveArrangement, saveView, deleteView } from '../src/server/mutate.ts';
import { loadViews } from '../src/server/views.ts';
import { applyOrder } from '../src/view/order.ts';
import { paths, resolveCliVault, vaultAbove } from '../src/config.ts';

/**
 * Vault resolution reads the environment, so these tests have to start from a
 * known-empty one. Otherwise a `PROJECTOR_DATA` exported in the shell running the
 * suite wins over the vault each test builds, and the tests about *resolving* a
 * vault fail for a reason no assertion mentions. The tests that want a seam set it
 * themselves.
 */
delete process.env.PROJECTOR_DATA;
delete process.env.PROJECTOR_VAULTS;

/**
 * Arrangement — positions and note order — lives in a named view and nowhere
 * else (C9). These lock the two rules that make that safe to use: a save merges
 * rather than replaces, and a note that has gone is the only thing dropped.
 */
function vault(views: Record<string, string> = {}, cards = ['a', 'b', 'c']): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'projector-arr-'));
  mkdirSync(paths(root).config, { recursive: true });
  mkdirSync(paths(root).views, { recursive: true });
  for (const id of cards) {
    writeFileSync(join(paths(root).notes, `${id}.md`), `---\nid: ${id}\nkind: card\ntitle: Card ${id}\n---\n`, 'utf8');
  }
  for (const [name, body] of Object.entries(views)) {
    writeFileSync(join(paths(root).views, `${name}.yaml`), body, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const read = (root: string, name: string) =>
  parse(readFileSync(join(paths(root).views, `${name}.yaml`), 'utf8')) as Record<string, unknown>;

test('saving positions merges, so a filtered canvas cannot discard the rest', () => {
  const { root, cleanup } = vault({
    graph: 'shape: graph\ntitle: Graph\nnodes:\n  a: {x: 10, y: 10}\n  b: {x: 20, y: 20}\n  c: {x: 30, y: 30}\n',
  });
  try {
    // What a filtered canvas sends: only the node it is currently rendering.
    saveArrangement(root, 'graph', { nodes: { b: { x: 99, y: 98 } } });
    assert.deepEqual(read(root, 'graph').nodes, {
      a: { x: 10, y: 10 },
      b: { x: 99, y: 98 },
      c: { x: 30, y: 30 },
    });
  } finally {
    cleanup();
  }
});

test('a position is dropped only when its note is gone', () => {
  const { root, cleanup } = vault(
    { graph: 'shape: graph\nnodes:\n  a: {x: 1, y: 1}\n  ghost: {x: 2, y: 2}\n' },
    ['a'],
  );
  try {
    saveArrangement(root, 'graph', { nodes: { a: { x: 5, y: 5 } } });
    assert.deepEqual(read(root, 'graph').nodes, { a: { x: 5, y: 5 } });
  } finally {
    cleanup();
  }
});

test('note order merges per column and rounds positions', () => {
  const { root, cleanup } = vault({ board: 'shape: board\norder:\n  now: [a, b]\n  later: [c]\n' });
  try {
    saveArrangement(root, 'board', { order: { now: ['b', 'a'] } });
    assert.deepEqual(read(root, 'board').order, { now: ['b', 'a'], later: ['c'] });

    saveArrangement(root, 'board', { nodes: { a: { x: 1.6, y: -2.4 } } });
    assert.deepEqual(read(root, 'board').nodes, { a: { x: 2, y: -2 } });
    // Order survived a positions-only save, and vice versa.
    assert.deepEqual(read(root, 'board').order, { now: ['b', 'a'], later: ['c'] });
  } finally {
    cleanup();
  }
});

test('an emptied column drops out rather than being stored empty', () => {
  const { root, cleanup } = vault({ board: 'shape: board\norder:\n  now: [a]\n  later: [b]\n' }, ['b']);
  try {
    saveArrangement(root, 'board', { order: { now: ['a'] } });
    assert.deepEqual(read(root, 'board').order, { later: ['b'] });
  } finally {
    cleanup();
  }
});

test('saving over a view keeps the arrangement it already had', () => {
  const { root, cleanup } = vault({
    graph: 'shape: graph\ntitle: Graph\nnodes:\n  a: {x: 7, y: 7}\norder:\n  now: [a]\n',
  });
  try {
    // *Save current as…* over an existing name: the query is replaced wholesale.
    saveView(root, 'graph', { shape: 'board', title: 'Now a board', groupBy: ['priority'] });
    const after = read(root, 'graph');
    assert.equal(after.shape, 'board');
    assert.deepEqual(after.groupBy, ['priority']);
    // …and the layout is not collateral damage.
    assert.deepEqual(after.nodes, { a: { x: 7, y: 7 } });
    assert.deepEqual(after.order, { now: ['a'] });
  } finally {
    cleanup();
  }
});

test('saving a partial update keeps the calendar view config', () => {
  const { root, cleanup } = vault({
    timeline: 'shape: calendar\ntitle: Timeline\ncalendar: {days: 14, rows: 5, starts: sun}\n',
  });
  try {
    saveView(root, 'timeline', { shape: 'calendar', title: 'Timeline' });
    assert.deepEqual(read(root, 'timeline').calendar, { days: 14, rows: 5, starts: 'sun' });
  } finally {
    cleanup();
  }
});

test('saving a composition keeps its columns and saved-only meaning', () => {
  const { root, cleanup } = vault({
    triage:
      'shape: board\ntitle: Triage\nlists: [intake, needs-status]\nunlisted: true\n' +
      'whenEmpty: Everything is filed\nexpect: empty\nnodes: { a: { x: 7, y: 7 } }\norder: { Intake: [a] }\n',
  });
  try {
    // Filtering a composition refines its children; it must not turn it into an
    // ordinary board by dropping the file-only fields that name those children.
    saveView(root, 'triage', { shape: 'table', title: 'Filtered triage', filter: { priority: ['now'] } });
    assert.deepEqual(read(root, 'triage'), {
      shape: 'table',
      title: 'Filtered triage',
      filter: { priority: ['now'] },
      lists: ['intake', 'needs-status'],
      unlisted: true,
      whenEmpty: 'Everything is filed',
      expect: 'empty',
      nodes: { a: { x: 7, y: 7 } },
      order: { Intake: ['a'] },
    });
  } finally {
    cleanup();
  }
});

test('a saved view is named by a slug and reads back through the loader', () => {
  const { root, cleanup } = vault();
  try {
    const { name } = saveView(root, 'Now by Project!', { shape: 'table', title: 'Now by Project' });
    assert.equal(name, 'now-by-project');
    const loaded = loadViews(root).find((v) => v.name === 'now-by-project')!;
    assert.equal(loaded.shape, 'table');
    assert.equal(loaded.title, 'Now by Project');

    deleteView(root, 'now-by-project');
    assert.equal(loadViews(root).length, 0);
  } finally {
    cleanup();
  }
});

test('writing arrangement to a view that does not exist is refused', () => {
  const { root, cleanup } = vault();
  try {
    assert.throws(() => saveArrangement(root, 'nope', { order: { now: ['a'] } }), /no view "nope"/);
  } finally {
    cleanup();
  }
});

test('stored order pins its notes and never loses the others', () => {
  // The query's own order, with three of them pinned.
  assert.deepEqual(applyOrder(['a', 'b', 'c', 'd'], ['c', 'a']), ['c', 'a', 'b', 'd']);
  // An id that is no longer in the column is skipped, not left as a hole.
  assert.deepEqual(applyOrder(['a', 'b'], ['gone', 'b']), ['b', 'a']);
  // No order at all leaves the query's sort untouched.
  assert.deepEqual(applyOrder(['a', 'b'], undefined), ['a', 'b']);
  assert.deepEqual(applyOrder(['a', 'b'], []), ['a', 'b']);
});

test('the CLI finds a vault from the working directory, without a registry', () => {
  const { root, cleanup } = vault();
  try {
    // Standing inside one, or anywhere below it — the way git finds a repo.
    assert.equal(vaultAbove(root), root);
    assert.equal(vaultAbove(paths(root).notes), root);
    assert.equal(vaultAbove(paths(root).views), root);
    // A folder that is not a vault and has none above it.
    assert.equal(vaultAbove(tmpdir()), null);

    // So `pj` needs no flag and no registry entry when run from inside. Compared
    // against the real path: chdir resolves symlinks, and on macOS the temp dir
    // is one.
    const cwd = process.cwd();
    try {
      process.chdir(paths(root).notes);
      assert.deepEqual(resolveCliVault(null, []), { root: realpathSync(root) });
    } finally {
      process.chdir(cwd);
    }
  } finally {
    cleanup();
  }
});

test('an explicit vault still wins over the working directory', () => {
  const a = vault();
  const b = vault();
  try {
    const cwd = process.cwd();
    try {
      process.chdir(a.root);
      assert.deepEqual(resolveCliVault(b.root, []), { root: b.root });
      process.env.PROJECTOR_DATA = b.root;
      assert.deepEqual(resolveCliVault(null, []), { root: b.root });
    } finally {
      delete process.env.PROJECTOR_DATA;
      process.chdir(cwd);
    }
  } finally {
    a.cleanup();
    b.cleanup();
  }
});
