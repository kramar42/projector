import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NONE } from '../src/index/query.ts';
import { parseSpec, specFromFile, specToFile, specToParams } from '../src/view/spec.ts';
import { layoutRelation } from '../src/view/payload.ts';
import {
  clearFilters,
  clearFocus,
  patchIsEmpty,
  setGroupBy,
  setSearch,
  setShape,
  specToPatch,
  toggleFilterValue,
} from '../src/view/intents.ts';

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
    show: 'parent,project,tech',
  };
  const spec = parseSpec(params);
  assert.deepEqual(spec.query.filter, { project: ['project-a', NONE], blocked: ['clear'] });
  assert.deepEqual(spec.query.groupBy, ['priority', 'status']);
  assert.deepEqual(spec.query.focus, { id: 'project-b', via: 'project', dir: 'in', depth: 2 });
  assert.deepEqual(spec.show, ['parent', 'project', 'tech']);
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

test('a stale bookmark opens rather than erroring', () => {
  const spec = parseSpec({ shape: 'mindmap', dir: 'sideways', size: 'expanded', show: 'parent,telepathy' });
  assert.equal(spec.shape, 'board');
  // Facet names are *not* checked against a list — one declared in facets.yaml
  // has to work without a second place enumerating what exists, so an unknown
  // one is carried through and simply draws nothing.
  assert.deepEqual(spec.show, ['parent', 'telepathy']);
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
    show: ['project'],
    q: 'keycloak',
  });
  assert.equal(spec.shape, 'board');
  assert.deepEqual(spec.query.filter, { kind: ['card'], due: ['overdue', 'today'] });
  assert.deepEqual(spec.query.groupBy, ['due']);
  assert.deepEqual(spec.query.sort, ['due:asc']);
  assert.equal(spec.query.uncategorised, 'hide');
  assert.deepEqual(spec.show, ['project']);
  // `q` used to be written and never read back, so a saved search vanished on
  // the next open.
  assert.equal(spec.query.q, 'keycloak');
});

test('saving writes the query half and never the arrangement', () => {
  const spec = parseSpec({
    shape: 'canvas',
    'f.project': 'project-a',
    'f.status': '',
    group: 'priority',
    show: 'parent,tech',
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
    show: ['parent', 'tech'],
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
    show: 'project,priority',
  });
  const reloaded = specFromFile('projects', specToFile(original, 'Projects'));
  assert.equal(reloaded.shape, 'table');
  assert.deepEqual(reloaded.query.filter, original.query.filter);
  assert.deepEqual(reloaded.query.groupBy, original.query.groupBy);
  assert.deepEqual(reloaded.query.sort, original.query.sort);
  // A table renders the same list as its columns, so there is no separate key.
  assert.deepEqual(reloaded.show, ['project', 'priority']);
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


/** A URL's params after a patch, which is what `patchSearch` does to the search. */
function paramsAfter(params: Record<string, string>, patch: Record<string, string | null>): Record<string, string> {
  const out = { ...params };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * The other half of the ✕, and the half nothing covered: not "does an empty
 * `focus=` clear a saved focus" — asserted above by hand-building the params —
 * but "does the code that builds them actually emit one".
 *
 * On a saved view it did, because the saved side carries the key and so the diff
 * visits it. On an ad-hoc query neither spec carries it: the focus lives only in
 * the URL, and a diff of two specs cannot see a third place. The ✕ ran, the spec
 * lost its focus, and the patch came back saying nothing about it — so the URL
 * kept `focus=ideas` and the focus came straight back.
 */
test('the X clears a focus that lives only in the URL', () => {
  const params = { shape: 'canvas', focus: 'ideas', via: 'parent', dir: 'in' };
  const search = `?${new URLSearchParams(params).toString()}`;
  const spec = parseSpec(params);
  assert.deepEqual(spec.query.focus, { id: 'ideas', via: 'parent', dir: 'in', depth: undefined });

  const patch = specToPatch(clearFocus(spec), null, search);
  // `null` deletes the key, which is right when there is no saved view beneath it
  // to come back. `''` is for overriding a saved value — see the test above.
  assert.equal(patch.focus, null, 'the key has to be mentioned to be removed');
  assert.equal(patch.via, null);
  assert.equal(patch.dir, null);
  assert.equal(parseSpec(paramsAfter(params, patch)).query.focus, undefined);
});

/**
 * Focus was the one that got noticed. It is not the only one: any key a resolved
 * spec drops has the same shape, and `q` and `group` were both unclearable from
 * an ad-hoc URL for the same reason.
 */
test('any override that lives only in the URL can be cleared', () => {
  const cases: [string, Record<string, string>, (s: ReturnType<typeof parseSpec>) => ReturnType<typeof parseSpec>][] = [
    ['q', { q: 'keycloak' }, (s) => setSearch(s, '')],
    ['group', { group: 'priority' }, (s) => setGroupBy(s, 0, null)],
  ];
  for (const [key, params, clear] of cases) {
    const search = `?${new URLSearchParams(params).toString()}`;
    const patch = specToPatch(clear(parseSpec(params)), null, search);
    assert.ok(key in patch, `${key} must be mentioned`);
    assert.equal(patch[key], null, `${key} must be removed`);
  }
});

/**
 * `card` is which panel is open and `view` is which saved view the diff is
 * *against*. Neither spec writes them back, so unioning the URL blindly would
 * null both — closing the panel and dropping the view on every keystroke.
 */
test('an edit leaves the open card and the named view alone', () => {
  const spec = parseSpec({ shape: 'canvas', focus: 'ideas', via: 'parent', dir: 'in' });
  const patch = specToPatch(clearFocus(spec), null, '?view=focused&focus=ideas&card=every-facet');
  assert.ok(!('card' in patch), 'the panel stays open');
  assert.ok(!('view' in patch), 'the view stays named');
});

test('a canvas lays out by the first reference facet in show', () => {
  const def = (type: 'label' | 'ref') => ({ label: type, type, values: [], open: true, single: false });
  const facets = { priority: def('label'), parent: def('ref'), project: def('ref') };
  // Labels are skipped: they name no records to lay out. Order in `show` is the
  // control — `parent` first is a decomposition tree, `project` first the
  // portfolio — and the same answer decides what `connect` walks for context.
  assert.equal(layoutRelation(['priority', 'parent', 'project'], facets), 'parent');
  assert.equal(layoutRelation(['project', 'parent'], facets), 'project');
  assert.equal(layoutRelation(['priority'], facets), undefined);
  assert.equal(layoutRelation([], facets), undefined);
});

/**
 * The two bugs that lived in the gap between reading and writing a spec.
 *
 * The sidebar rendered a checkbox from the *resolved* spec — the saved view
 * merged under the URL — and then computed the new URL from the query string
 * alone. On `?view=home`, whose file selects `status: [planning, active]`, the
 * URL holds no `f.status`, so a checkbox that was drawn *checked* had an empty
 * current list underneath it.
 */
test('unchecking a saved view’s selected value clears it instead of narrowing', () => {
  const saved = specFromFile('home', {
    shape: 'board',
    filter: { status: ['planning', 'active'] },
    groupBy: ['priority'],
  });

  // What the user sees and clicks is the resolved spec, which here is the saved one.
  const after = toggleFilterValue(saved, 'status', 'planning');
  assert.deepEqual(after.query.filter?.status, ['active'], 'the clicked value comes off');

  // And the URL says so as an override, not by re-listing what is left out.
  const patch = specToPatch(after, saved);
  assert.equal(patch['f.status'], 'active');
  assert.equal(patch.group, null, 'an untouched axis stays inherited');

  // The old behaviour: current values read from an empty URL, so the click
  // produced "only planning" and silently dropped `active`.
  assert.notEqual(patch['f.status'], 'planning');
});

test('clearing a saved view’s filters empties them rather than doing nothing', () => {
  const saved = specFromFile('home', {
    shape: 'board',
    filter: { status: ['planning', 'active'], priority: ['now'] },
    q: 'keycloak',
  });

  const patch = specToPatch(clearFilters(saved), saved);
  // The empty string is the override. Dropping the key would inherit the file's
  // selection straight back, which is what made the old "clear" a no-op.
  assert.equal(patch['f.status'], '', 'an emptied filter is stated, not omitted');
  assert.equal(patch['f.priority'], '');
  assert.equal(patch.q, '', 'the text search clears with the same sentinel');
  assert.equal(patch.shape, null, 'shape is untouched and inherited');
  assert.ok(!patchIsEmpty(patch), 'clearing a filled view is a change');
});

test('a patch against an unchanged spec says nothing at all', () => {
  const saved = specFromFile('home', { shape: 'board', filter: { status: ['planning'] } });
  assert.ok(patchIsEmpty(specToPatch(saved, saved)), 'no diff, no override, no dirty badge');
});

test('an ad-hoc query with no saved view writes every key it sets', () => {
  const spec = setGroupBy(setShape(parseSpec({}), 'canvas'), 0, 'priority');
  const patch = specToPatch(spec, null);
  assert.equal(patch.shape, 'canvas');
  assert.equal(patch.group, 'priority');
});

test('clearing the primary grouping axis promotes the secondary', () => {
  const two = specFromFile('v', { shape: 'board', groupBy: ['priority', 'project'] });
  assert.deepEqual(setGroupBy(two, 0, null).query.groupBy, ['project']);
  assert.deepEqual(setGroupBy(two, 1, null).query.groupBy, ['priority']);
});
