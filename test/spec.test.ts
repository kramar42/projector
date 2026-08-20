import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NONE } from '../src/index/query.ts';
import { parseSpec, specFromFile, specToFile, specToParams } from '../src/view/spec.ts';

test('a spec survives the round trip through URL parameters', () => {
  const params = {
    shape: 'canvas',
    'f.project': 'project-a,(none)',
    'f.blocked': 'clear',
    q: 'keycloak',
    focus: 'project-b',
    via: 'member-of',
    dir: 'down',
    depth: '2',
    group: 'priority,status',
    sort: 'priority:asc,updated:desc',
    uncategorised: 'start',
    showEmpty: '1',
    edges: 'parent,member-of',
    size: 'chip',
    chips: 'project,tech',
  };
  const spec = parseSpec(params);
  assert.deepEqual(spec.query.filter, { project: ['project-a', NONE], blocked: ['clear'] });
  assert.deepEqual(spec.query.groupBy, ['priority', 'status']);
  assert.deepEqual(spec.query.focus, { id: 'project-b', via: 'member-of', dir: 'down', depth: 2 });
  // `connect` is only written when it differs from the shape's default.
  assert.deepEqual(specToParams(spec), params);
});

test('(none) travels as itself so a literal value cannot collide with absence', () => {
  assert.deepEqual(parseSpec({ 'f.project': '(none)' }).query.filter, { project: [NONE] });
  assert.deepEqual(specToParams(parseSpec({ 'f.project': '(none),project-a' }))['f.project'], '(none),project-a');
  // A value that merely reads like it stays a value.
  assert.deepEqual(parseSpec({ 'f.project': 'none' }).query.filter, { project: ['none'] });
});

test('an empty selection is a statement, not an absent key', () => {
  // How a URL says "no status filter" over a default selection that had one.
  assert.deepEqual(parseSpec({ 'f.status': '' }).query.filter, { status: [] });
  assert.deepEqual(parseSpec({}).query.filter, {});
});

test('a canvas connects itself by default; other shapes do not', () => {
  assert.equal(parseSpec({ shape: 'canvas' }).query.connect, 'ancestors');
  assert.equal(parseSpec({ shape: 'canvas', connect: 'none' }).query.connect, 'none');
  assert.equal(parseSpec({ shape: 'board' }).query.connect, 'none');
  assert.equal(parseSpec({ shape: 'table' }).query.connect, 'none');
});

test('a stale bookmark opens rather than erroring', () => {
  const spec = parseSpec({ shape: 'mindmap', via: 'sideways', size: 'expanded', edges: 'parent,telepathy' });
  assert.equal(spec.shape, 'board');
  assert.equal(spec.face.size, undefined);
  assert.deepEqual(spec.edges, ['parent']);
});

test('the seven views written before P5 still open', () => {
  const board = specFromFile('priority-lists', {
    kind: 'board',
    title: 'Priority lists',
    filter: { status: ['planning', 'active', 'waiting', 'blocked'] },
    groupBy: 'priority',
    swimlanes: null,
    cardFacets: ['project', 'tech'],
    sort: ['updated:desc'],
    showEmpty: true,
    uncategorised: 'end',
  });
  assert.equal(board.shape, 'board');
  assert.deepEqual(board.query.filter, { status: ['planning', 'active', 'waiting', 'blocked'] });
  assert.deepEqual(board.query.groupBy, ['priority']);
  assert.deepEqual(board.face.chips, ['project', 'tech']);
  assert.equal(board.query.showEmpty, true);

  // `blockedBy: none` was a computed predicate in a filter; it is a pseudo-facet.
  const unblocked = specFromFile('unblocked', {
    kind: 'board',
    filter: { status: ['planning', 'active'], blockedBy: 'none' },
    groupBy: 'energy',
  });
  assert.deepEqual(unblocked.query.filter, { status: ['planning', 'active'], blocked: ['clear'] });

  // `include.under` was always a traversal, so it reads as one.
  const canvas = specFromFile('project-a', {
    kind: 'canvas',
    title: 'Project A',
    layout: 'tree-lr',
    include: { under: 'project-a' },
    edges: { show: ['parent', 'blocks'] },
  });
  assert.equal(canvas.shape, 'canvas');
  assert.deepEqual(canvas.query.focus, { id: 'project-a', via: 'parent', dir: 'down', depth: undefined });
  assert.deepEqual(canvas.edges, ['parent', 'blocks']);

  const filtered = specFromFile('trello', {
    kind: 'canvas',
    include: { filter: { source: ['trello'] } },
    defaultSize: 'chip',
  });
  assert.deepEqual(filtered.query.filter, { source: ['trello'] });
  assert.equal(filtered.face.size, 'chip');
});

test('a swimlane in an old file becomes the second grouping axis', () => {
  const spec = specFromFile('matrix', { kind: 'board', groupBy: 'priority', swimlanes: 'project' });
  assert.deepEqual(spec.query.groupBy, ['priority', 'project']);
});

test('defaultSize: expanded is read as a card face, since expanded is gone', () => {
  assert.equal(specFromFile('x', { kind: 'canvas', defaultSize: 'expanded' }).face.size, undefined);
  assert.equal(specFromFile('x', { kind: 'canvas', defaultSize: 'chip' }).face.size, 'chip');
});

test('saving writes the query half and never the arrangement', () => {
  const spec = parseSpec({
    shape: 'canvas',
    'f.project': 'project-a',
    'f.status': '',
    group: 'priority',
    edges: 'parent',
    chips: 'tech',
  });
  spec.nodes = { project-a: { x: 10, y: 20 } };
  spec.order = { now: ['a', 'b'] };
  const file = specToFile(spec, 'Project A graph');
  assert.deepEqual(file, {
    shape: 'canvas',
    title: 'Project A graph',
    // The empty `status` selection is not written: a saved view states what it
    // filters on, and says nothing about what it does not.
    filter: { project: ['project-a'] },
    groupBy: ['priority'],
    edges: { show: ['parent'] },
    face: { chips: ['tech'] },
  });
  assert.ok(!('nodes' in file));
  assert.ok(!('order' in file));
});

test('a file round-trips through save and reload', () => {
  const original = parseSpec({
    shape: 'table',
    'f.type': 'project',
    group: 'status',
    sort: 'title:asc',
    chips: 'project,priority',
  });
  const reloaded = specFromFile('projects', specToFile(original, 'Projects'));
  assert.equal(reloaded.shape, 'table');
  assert.deepEqual(reloaded.query.filter, original.query.filter);
  assert.deepEqual(reloaded.query.groupBy, original.query.groupBy);
  assert.deepEqual(reloaded.query.sort, original.query.sort);
  // A table renders `chips` as its columns, so there is no separate key to keep.
  assert.deepEqual(reloaded.face.chips, ['project', 'priority']);
});

test('an explicitly empty focus overrides a saved one', () => {
  const saved = specFromFile('project-a', { shape: 'canvas', focus: { id: 'project-a', via: 'parent', dir: 'down' } });
  assert.deepEqual(saved.query.focus, { id: 'project-a', via: 'parent', dir: 'down', depth: undefined });

  // How the ✕ has to travel: deleting the key means "inherit", and the server
  // merges the file's parameters under the URL's, so the focus would come back.
  const merged = parseSpec({ ...specToParams(saved), focus: '' });
  assert.equal(merged.query.focus, undefined);

  // Absent, for contrast: the saved focus survives, which is right for every
  // other parameter and wrong for a control with a clear button.
  assert.deepEqual(parseSpec(specToParams(saved)).query.focus, saved.query.focus);
});
