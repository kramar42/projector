import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, } from '../src/schema/card.ts';
import { createCard, deleteCard, patchFields } from '../src/server/mutate.ts';
import { isProject } from '../src/index/project.ts';
import { CONTEXT_BAND, assignClusters, clusterBoxes, clusteredLayout, treeLayout } from '../src/web/views/layout.ts';
import type { CardDTO } from '../src/web/types.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin, } from 'node:path';
import { tmpdir } from 'node:os';


/**
 * Canvas layout: the nested-set walk, clusters, and how a band is measured.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

// ---------------------------------------------------------------- nested set

function scratchVault(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-set-'));
  mkdirSync(pathJoin(root, 'cards'), { recursive: true });
  writeFileSync(
    pathJoin(root, 'facets.yaml'),
    'status: { values: [planning, done], open: false, single: true }\ndue: { type: date, single: true }\n',
    'utf8',
  );
  writeFileSync(
    pathJoin(root, 'cards', 'x.md'),
    '---\nid: x\n# a comment worth keeping\ntitle: X\nfacets: { status: [planning] }\n---\n\nbody\n',
    'utf8',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('--set writes a nested field, and YAML values carry structure', () => {
  const { root, cleanup } = scratchVault();
  try {
    patchFields(root, 'x', { 'project.jira': 'PROJ' });
    patchFields(root, 'x', { 'project.repos': '[{path: ~/a, base: main}]' });
    const rec = loadCard(pathJoin(root, 'cards', 'x.md'));
    assert.ok(rec.ok);
    // A flat key=value cannot express a list of maps, which is why the value is
    // parsed as YAML rather than split on a separator.
    assert.equal(rec.rec.project?.jira, 'PROJ');
    assert.deepEqual(rec.rec.project?.repos, [{ path: '~/a', base: 'main' }]);
    // Only the touched key is rewritten, so everything else survives.
    const text = readFileSync(pathJoin(root, 'cards', 'x.md'), 'utf8');
    assert.match(text, /# a comment worth keeping/);
    assert.equal(text.endsWith('\nbody\n'), true);
  } finally {
    cleanup();
  }
});

test('--set project={} makes a project and --set project= unmakes one', () => {
  const { root, cleanup } = scratchVault();
  try {
    patchFields(root, 'x', { project: '{}' });
    const made = loadCard(pathJoin(root, 'cards', 'x.md'));
    assert.ok(made.ok);
    assert.equal(isProject(made.rec), true);
    patchFields(root, 'x', { project: '' });
    const after = loadCard(pathJoin(root, 'cards', 'x.md'));
    assert.ok(after.ok);
    assert.equal(after.rec.project, undefined);
  } finally {
    cleanup();
  }
});

test('--set is validated against the result, not the input', () => {
  const { root, cleanup } = scratchVault();
  try {
    // The same vocabulary rules as any other write: a single facet cannot hold
    // two, and `id` is refused because other records reference it.
    assert.throws(() => patchFields(root, 'x', { 'facets.status': '[planning, done]' }), /one value at a time/);
    assert.throws(() => patchFields(root, 'x', { id: 'y' }), /id cannot be changed/);
    assert.throws(() => patchFields(root, 'x', { 'facets.nope': '[a]' }), /unknown facet/);
    assert.throws(() => patchFields(root, 'x', { 'facets.due': '["next friday"]' }), /not YYYY-MM-DD/);
    assert.throws(() => patchFields(root, 'x', { 'title.deep': 'x' }), /not a mapping/);
  } finally {
    cleanup();
  }
});

test('a caller-supplied id is honoured or refused, never silently changed', () => {
  const { root, cleanup } = scratchVault();
  try {
    assert.equal(createCard(root, { title: 'Whatever', id: 'chosen' }).id, 'chosen');
    // Something is about to reference this by name, so a collision is an error
    // rather than a quietly suffixed id.
    assert.throws(() => createCard(root, { title: 'Again', id: 'chosen' }), /already taken/);
    assert.throws(() => createCard(root, { title: 'Bad', id: 'Not A Slug' }), /lowercase slug/);
  } finally {
    cleanup();
  }
});

test('deleting a record drops every reference pointing at it', () => {
  const { root, cleanup } = scratchVault();
  try {
    writeFileSync(pathJoin(root, 'facets.yaml'), 'parent: { type: ref, single: true }\n', 'utf8');
    createCard(root, { title: 'Container', id: 'box' });
    createCard(root, { title: 'Inside', id: 'thing', parent: 'box' });
    const { removedEdges } = deleteCard(root, 'box');
    assert.equal(removedEdges, 1);
    const left = loadCard(pathJoin(root, 'cards', 'thing.md'));
    assert.ok(left.ok);
    // A dangling reference is what removing the file by hand leaves behind.
    assert.equal(left.rec.facets.parent, undefined);
  } finally {
    cleanup();
  }
});


// ---------------------------------------------------------------- clusters

const face = (id: string): CardDTO =>
  ({ id, title: id, isProject: false, facets: {}, buckets: {}, links: [], progress: null,
     excerpt: '', body: '', updated: null, refCount: 0, blockedBy: [], unblocks: [] }) as CardDTO;

test('a record in several groups is clustered into the first the axis declares', () => {
  const nodes = [face('a'), face('b'), face('c')];
  const groups = [
    { value: 'now', ids: ['a', 'b'] },
    { value: 'month', ids: ['b'] },
  ];
  const assign = assignClusters(nodes, groups);
  // A board draws `b` in both columns; a canvas cannot, because a record has one
  // position. First declared wins, and the sidebar says how many that applies to.
  assert.equal(assign.get('b'), 'now');
  assert.equal(assign.get('a'), 'now');
  // `c` matched no group — it is context, and gets a band of its own rather than
  // being scattered through the others.
  assert.equal(assign.get('c'), CONTEXT_BAND);
});

test('clusters stack without overlapping, context last', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(face);
  const groups = [
    { value: 'now', ids: ['a', 'b'] },
    { value: 'month', ids: ['c'] },
  ];
  const placed = clusteredLayout(nodes, [], [], groups);
  const boxes = clusterBoxes(assignClusters(nodes, groups), placed, groups);
  assert.deepEqual(boxes.map((b) => b.value), ['now', 'month', CONTEXT_BAND]);
  for (let i = 1; i < boxes.length; i++) {
    assert.ok(boxes[i]!.y > boxes[i - 1]!.y + boxes[i - 1]!.h - 1, 'bands must not overlap');
  }
});

test('a band is measured from where its members actually are', () => {
  const nodes = ['a', 'b'].map(face);
  const groups = [{ value: 'now', ids: ['a', 'b'] }];
  const placed = clusteredLayout(nodes, [], [], groups);
  const before = clusterBoxes(assignClusters(nodes, groups), placed, groups)[0]!;
  // Dragging a card grows its band, because the box is derived from final
  // positions rather than from the layout pass — which is what lets a saved
  // arrangement and clustering coexist without agreeing about anything.
  placed.set('b', { ...placed.get('b')!, x: 4000 });
  const after = clusterBoxes(assignClusters(nodes, groups), placed, groups)[0]!;
  assert.ok(after.w > before.w);
});

test('an empty declared value gets no band', () => {
  const nodes = [face('a')];
  const groups = [
    { value: 'now', ids: ['a'] },
    { value: 'someday', ids: [] },
  ];
  // A board draws an empty column because it is somewhere to drag a card *to*.
  // Dragging on a canvas moves a position and changes no facet, so an empty band
  // would be decoration with no affordance.
  const boxes = clusterBoxes(assignClusters(nodes, groups), clusteredLayout(nodes, [], [], groups), groups);
  assert.deepEqual(boxes.map((b) => b.value), ['now']);
});

/**
 * A view file naming a facet the vocabulary does not have.
 *
 * This is the `pj next` bug in its new address. That command spent two days
 * filtering on `kind`, a facet P7 deleted, and an empty result is not an error —
 * so moving the query out of TypeScript and into `views/*.yaml` would have moved
 * the failure rather than fixing it. `pj check` reading views is what closes it.
 */

// ---------------------------------------------------------------- orientation

/**
 * Roots on the left, the tree opening outward — whichever relation it is laid out
 * by.
 *
 * `parent` and `project` are stored child → parent and member → container, so
 * dagre has to be handed them reversed. `blocks` is stored blocker → blocked,
 * which already points away from its root, so it must be handed over as it is.
 *
 * One parameter used to answer both "which relation defines the tree" and "which
 * way is that relation stored", and those coincide only while `parent` leads. A
 * canvas laid out by `blocks` therefore put the blocker on the right and pointed
 * every arrow back at it.
 */
test('the root sits left whichever relation the canvas lays out by', () => {
  const nodes = [face('blocker'), face('blocked')];
  // Stored on the card that is stuck, like every other reference.
  const chain = [{ src: 'blocked', dst: 'blocker', type: 'blocked_by' }];
  const placed = treeLayout(nodes, chain, 'LR', ['blocked_by']);
  assert.ok(
    placed.get('blocker')!.x < placed.get('blocked')!.x,
    'the blocker is the root of a dependency chain, so it is drawn first',
  );
});

test('a container sits left of its member', () => {
  const nodes = [face('child'), face('box')];
  const tree = [{ src: 'child', dst: 'box', type: 'parent' }];
  const placed = treeLayout(nodes, tree, 'LR', ['parent']);
  assert.ok(placed.get('box')!.x < placed.get('child')!.x, 'stored child → parent, drawn parent → child');
});

/**
 * The relation a canvas lays out by is the only one that positions anything. A
 * A `blocked_by` edge on a canvas laid out by `parent` still draws — `edgesFor`
 * decides that — but it must not drag a node into another rank.
 */
test('only the layout relation feeds the layout', () => {
  const nodes = [face('a'), face('b')];
  const edges = [{ src: 'a', dst: 'b', type: 'blocked_by' }];
  const placed = treeLayout(nodes, edges, 'LR', ['parent']);
  assert.equal(placed.get('a')!.x, placed.get('b')!.x, 'unranked nodes share a column');
});
