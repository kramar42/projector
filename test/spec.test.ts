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
    via: 'project',
    dir: 'in',
    depth: '2',
    group: 'priority,status',
    sort: 'priority:asc,updated:desc',
    uncategorised: 'start',
    edges: 'parent,project',
    chips: 'project,tech',
  };
  const spec = parseSpec(params);
  assert.deepEqual(spec.query.filter, { project: ['project-a', NONE], blocked: ['clear'] });
  assert.deepEqual(spec.query.groupBy, ['priority', 'status']);
  assert.deepEqual(spec.query.focus, { id: 'project-b', via: 'project', dir: 'in', depth: 2 });
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
  const spec = parseSpec({ shape: 'mindmap', dir: 'sideways', size: 'expanded', edges: 'parent,telepathy' });
  assert.equal(spec.shape, 'board');
  assert.deepEqual(spec.chips, []);
  // Relation names are *not* checked against a list — a reference facet declared
  // in facets.yaml has to work without a second place enumerating what exists,
  // so an unknown one is carried through and simply draws nothing.
  assert.deepEqual(spec.edges, ['parent', 'telepathy']);
  assert.equal(spec.query.focus, undefined);
});

test('a view file reads back as the query it was written from', () => {
  const spec = specFromFile('due', {
    shape: 'board',
    title: 'Due',
    filter: { kind: ['card'], due: ['overdue', 'today'] },
    groupBy: ['due'],
    sort: ['due:asc'],
    uncategorised: 'hide',
    chips: ['project'],
    q: 'keycloak',
  });
  assert.equal(spec.shape, 'board');
  assert.deepEqual(spec.query.filter, { kind: ['card'], due: ['overdue', 'today'] });
  assert.deepEqual(spec.query.groupBy, ['due']);
  assert.deepEqual(spec.query.sort, ['due:asc']);
  assert.equal(spec.query.uncategorised, 'hide');
  assert.deepEqual(spec.chips, ['project']);
  // `q` used to be written and never read back, so a saved search vanished on
  // the next open.
  assert.equal(spec.query.q, 'keycloak');
});

test('a canvas keeps `connect` across a save', () => {
  const spec = parseSpec({ shape: 'canvas', connect: 'none' });
  const file = specToFile(spec, 'Graph');
  assert.equal(file.connect, 'none');
  assert.equal(specFromFile('graph', file).query.connect, 'none');
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
    chips: ['tech'],
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
  // A table renders the same list as its columns, so there is no separate key.
  assert.deepEqual(reloaded.chips, ['project', 'priority']);
});

test('an explicitly empty focus overrides a saved one', () => {
  const saved = specFromFile('project-a', { shape: 'canvas', focus: { id: 'project-a', via: 'parent', dir: 'in' } });
  assert.deepEqual(saved.query.focus, { id: 'project-a', via: 'parent', dir: 'in', depth: undefined });

  // How the ✕ has to travel: deleting the key means "inherit", and the server
  // merges the file's parameters under the URL's, so the focus would come back.
  const merged = parseSpec({ ...specToParams(saved), focus: '' });
  assert.equal(merged.query.focus, undefined);

  // Absent, for contrast: the saved focus survives, which is right for every
  // other parameter and wrong for a control with a clear button.
  assert.deepEqual(parseSpec(specToParams(saved)).query.focus, saved.query.focus);
});
