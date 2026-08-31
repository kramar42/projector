import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NONE } from '../src/index/query.ts';
import { VIEW_KEYS, parseSpec, specFromFile, specToFile, specToParams } from '../src/view/spec.ts';
import { layoutRelation } from '../src/view/payload.ts';
import {
  clearFilters,
  clearFocus,
  patchIsEmpty,
  setFocus,
  setGroupBy,
  setSearch,
  setShape,
  specToPatch,
  toggleFilterValue,
} from '../src/view/intents.ts';

test('a spec survives the round trip through URL parameters', () => {
  const params = {
    shape: 'graph',
    'f.project': 'project-a,(none)',
    'f.blocked': 'clear',
    q: 'keycloak',
    focus: 'project-b',
    via: 'project',
    dir: 'in',
    depth: '2',
    group: 'priority,status',
    sort: 'priority:asc,updated:desc',
    show: 'parent,project,tech',
  };
  const spec = parseSpec(params);
  assert.deepEqual(spec.query.filter, { project: ['project-a', NONE], blocked: ['clear'] });
  assert.deepEqual(spec.query.groupBy, ['priority', 'status']);
  assert.deepEqual(spec.query.focus, { id: 'project-b', via: 'project', dir: 'in', depth: 2 });
  assert.deepEqual(spec.show, ['parent', 'project', 'tech']);
  assert.deepEqual(specToParams(spec), params);
});

/**
 * `setFocus` merges with the previous focus so each rail control can send only
 * the field it changed — which means "clear" must be sayable, not just omitted.
 * `null` clears; `undefined` inherits.
 */
test('selecting "all" clears a set depth instead of inheriting it', () => {
  const spec = parseSpec({ focus: 'iam', via: 'parent', dir: 'in', depth: '2' });
  const cleared = setFocus(spec, { id: 'iam', depth: null });
  assert.deepEqual(cleared.query.focus, { id: 'iam', via: 'parent', dir: 'in' });
});

test('changing one focus field inherits the others, depth included', () => {
  const spec = parseSpec({ focus: 'iam', via: 'parent', dir: 'in', depth: '2' });
  const retargeted = setFocus(spec, { id: 'iam', via: 'project' });
  assert.deepEqual(retargeted.query.focus, { id: 'iam', via: 'project', dir: 'in', depth: 2 });
});

/**
 * The one filter a focus cancels, and every filter it does not.
 *
 * `type` says where a note sits in the reference graph and a focus selects by
 * where a note sits in the reference graph, so `type=[project]` plus "walk inward
 * from this project" is a query that deletes what it was asked to find. On the
 * seeded **Projects** view — which is `filter: type=[project]` — the focus control
 * reshaped the query and still drew the one row, which reads as a dead button.
 *
 * Emptied rather than dropped: on a saved view an absent key inherits the file's
 * value, so deleting it would bring `type: [project]` back on the next read. That
 * is the same distinction `clearFilters` rests on, and the reason `focused.yaml`
 * exists in the coverage vault.
 */
test('a focus clears a structural filter and leaves every other one alone', () => {
  const spec = parseSpec({
    'f.type': 'project',
    'f.priority': 'now',
    'f.status': 'active,-done',
    q: 'keycloak',
  });
  const focused = setFocus(spec, { id: 'iam', via: 'project', dir: 'in' });

  assert.deepEqual(focused.query.filter?.type, [], 'emptied, so a saved view cannot reinstate it');
  assert.deepEqual(focused.query.filter?.priority, ['now'], 'a preference is not a position');
  assert.deepEqual(focused.query.filter?.status, ['active', '-done'], 'negations included');
  assert.equal(focused.query.q, 'keycloak', 'and the text search is not a filter on position');

  // A spec with no structural filter is left byte-identical, so the key is never
  // invented — `?f.type=` in every URL that has ever carried a focus is noise.
  const plain = parseSpec({ 'f.priority': 'now' });
  assert.deepEqual(
    setFocus(plain, { id: 'iam', via: 'project', dir: 'in' }).query.filter,
    { priority: ['now'] },
  );
});

/**
 * A negation is a filter token like `(none)` and a range, so it needs nothing of
 * its own on the wire: it round-trips through the URL, a view file and `pj
 * --filter` because it is carried inside the value list rather than beside it.
 */
test('a negated value round-trips as itself', () => {
  const params = { shape: 'board' as const, 'f.project': 'project-a,-project-b' };
  const spec = parseSpec(params);
  assert.deepEqual(spec.query.filter, { project: ['project-a', '-project-b'] });
  assert.deepEqual(specToParams(spec), params);
  // A bare `-` is a value, not a negation of nothing.
  assert.deepEqual(parseSpec({ 'f.tech': '-' }).query.filter, { tech: ['-'] });
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
  assert.equal(spec.shape, 'table');
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
    show: ['project'],
    q: 'keycloak',
  });
  assert.equal(spec.shape, 'board');
  assert.deepEqual(spec.query.filter, { kind: ['card'], due: ['overdue', 'today'] });
  assert.deepEqual(spec.query.groupBy, ['due']);
  assert.deepEqual(spec.query.sort, ['due:asc']);
  assert.deepEqual(spec.show, ['project']);
  // `q` used to be written and never read back, so a saved search vanished on
  // the next open.
  assert.equal(spec.query.q, 'keycloak');
});

test('saving writes the complete effective view', () => {
  const spec = parseSpec({
    shape: 'graph',
    'f.project': 'project-a',
    'f.status': '',
    group: 'priority',
    show: 'parent,tech',
  });
  spec.nodes = { 'project-a': { x: 10, y: 20 } };
  spec.order = { now: ['a', 'b'] };
  spec.lists = ['needs-status', 'needs-priority'];
  spec.unlisted = true;
  spec.whenEmpty = 'Everything is filed';
  spec.expect = 'empty';
  const file = specToFile(spec, 'Project A graph');
  assert.deepEqual(file, {
    shape: 'graph',
    title: 'Project A graph',
    // The empty `status` selection is not written: a saved view states what it
    // filters on, and says nothing about what it does not.
    filter: { project: ['project-a'] },
    groupBy: ['priority'],
    show: ['parent', 'tech'],
    lists: ['needs-status', 'needs-priority'],
    unlisted: true,
    whenEmpty: 'Everything is filed',
    expect: 'empty',
    nodes: { 'project-a': { x: 10, y: 20 } },
    order: { now: ['a', 'b'] },
  });
});

test('calendar grid settings round-trip through view config', () => {
  const spec = parseSpec({
    shape: 'calendar',
    'cal.cols': '14',
    'cal.rows': '5',
    'cal.start': 'sun',
  });

  assert.deepEqual(spec.calendar, { days: 14, rows: 5, starts: 'sun' });
  assert.deepEqual(specToParams(spec), {
    shape: 'calendar',
    'cal.cols': '14',
    'cal.rows': '5',
    'cal.start': 'sun',
  });
  assert.deepEqual(specToFile(spec, 'Timeline').calendar, {
    days: 14,
    rows: 5,
    starts: 'sun',
  });

  const reloaded = specFromFile('timeline', specToFile(spec, 'Timeline'));
  assert.deepEqual(reloaded.calendar, spec.calendar);
});

test('calendar defaults can override a saved grid setting', () => {
  const saved = specFromFile('timeline', {
    shape: 'calendar',
    calendar: { days: 14, rows: 5, starts: 'sun' },
  });
  const next = parseSpec({ ...specToParams(saved), 'cal.rows': '1' });
  const patch = specToPatch(next, saved, '?view=timeline&cal.rows=1');
  assert.equal(patch['cal.rows'], '1');
  assert.ok(!patchIsEmpty(patch));
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
  const saved = specFromFile('project-a', { shape: 'graph', focus: { id: 'project-a', via: 'parent', dir: 'in' } });
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
  const params = { shape: 'graph', focus: 'ideas', via: 'parent', dir: 'in' };
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
 * `note` is which panel is open and `view` is which saved view the diff is
 * *against*. Neither spec writes them back, so unioning the URL blindly would
 * null both — closing the panel and dropping the view on every keystroke.
 */
test('an edit leaves the open note and the named view alone', () => {
  const spec = parseSpec({ shape: 'graph', focus: 'ideas', via: 'parent', dir: 'in' });
  const patch = specToPatch(clearFocus(spec), null, '?view=focused&focus=ideas&note=every-facet');
  assert.ok(!('note' in patch), 'the panel stays open');
  assert.ok(!('view' in patch), 'the view stays named');
});

test('a canvas lays out by the first reference facet in show', () => {
  const def = (type: 'label' | 'ref') => ({ label: type, type, values: [], open: true, single: false });
  const facets = { priority: def('label'), parent: def('ref'), project: def('ref') };
  // Labels are skipped: they name no notes to lay out. Order in `show` is the
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
  const spec = setGroupBy(setShape(parseSpec({}), 'graph'), 0, 'priority');
  const patch = specToPatch(spec, null);
  assert.equal(patch.shape, 'graph');
  assert.equal(patch.group, 'priority');
});

test('clearing the primary grouping axis promotes the secondary', () => {
  const two = specFromFile('v', { shape: 'board', groupBy: ['priority', 'project'] });
  assert.deepEqual(setGroupBy(two, 0, null).query.groupBy, ['project']);
  assert.deepEqual(setGroupBy(two, 1, null).query.groupBy, ['priority']);
});


test('every key the writer emits is a key the checker knows', () => {
  // `VIEW_KEYS` is a second list beside `specFromFile`, which is the shape of a
  // pair that drifts. The drift that actually happens is writer-first — a new
  // key reaches `specToFile` and `VIEW_KEYS` does not learn it — and then
  // `pj check` rejects a file the app itself just wrote. This is that direction,
  // pinned.
  //
  // Reader-first drift is left to a human on purpose: a key read but not listed
  // makes `pj check` reject a working file, loudly, which is the failure that
  // announces itself.
  const spec = parseSpec({
    shape: 'graph',
    'f.project': 'project-a',
    q: 'keycloak',
    focus: 'project-b',
    via: 'project',
    dir: 'in',
    depth: '2',
    group: 'priority,status',
    sort: 'priority:asc',
    show: 'parent,tech',
  });
  spec.nodes = { 'project-a': { x: 1, y: 2 } };
  spec.order = { now: ['a'] };

  const written = Object.keys(specToFile(spec, 'T'));
  assert.ok(written.length >= 7, 'the fixture should exercise most of the writer');
  const unknown = written.filter((k) => !VIEW_KEYS.includes(k));
  assert.deepEqual(unknown, [], `specToFile writes keys VIEW_KEYS does not list: ${unknown.join(', ')}`);

  // Arrangement is written by `saveArrangement` rather than `specToFile`, so it
  // has to be asserted separately or the two writers are only half covered.
  for (const key of ['nodes', 'order']) {
    assert.ok(VIEW_KEYS.includes(key), `${key} is written to view files and must be known`);
  }
});
