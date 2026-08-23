import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { patchYamlFile, } from '../src/schema/frontmatter.ts';
import { validateViews, validateVocabulary } from '../src/view/validate.ts';
import { specFromFile } from '../src/view/spec.ts';
import { loadFacets, } from '../src/schema/facets.ts';
import { NONE } from '../src/schema/vocabulary.ts';
import { groupsFor, labelFor } from '../src/web/views/groups.ts';
import { reindex } from '../src/index/indexer.ts';
import { runQuery } from '../src/index/query.ts';


/**
 * A view: its file, the axes it may name, and how a shape groups and labels what it holds.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

// ---------------------------------------------------------------- view files


/** A facets.yaml in a temp dir, so a test can declare the vocabulary it needs. */
function facetsFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'projector-facets-'));
  const f = join(dir, 'facets.yaml');
  writeFileSync(f, body, 'utf8');
  return f;
}

test('a plain YAML view file is patched in place, not wrapped as frontmatter', () => {
  const original = `# a comment
kind: canvas
title: Project A
layout: tree-lr
include:
  under: project-a
`;
  const out = patchYamlFile(original, { nodes: { project-a: { x: 1, y: 2 } }, layout: 'manual' });
  // The keys must appear exactly once — the frontmatter patcher would have
  // duplicated the whole document.
  assert.equal(out.match(/^kind:/gm)?.length, 1);
  assert.equal(out.match(/^layout:/gm)?.length, 1);
  assert.match(out, /layout: manual/);
  assert.doesNotMatch(out, /^---$/m);
  assert.match(out, /# a comment/);
  assert.match(out, /under: project-a/);
});


test('a view naming an unknown axis is an error, in every position it can appear', () => {
  const facets = loadFacets(
    facetsFile('status: { values: [planning, done] }\nparent: { type: ref }\n'),
  );
  const view = (raw: Record<string, unknown>) => [
    { spec: specFromFile('v', raw), file: '/data/views/v.yaml' },
  ];

  const cases: [string, Record<string, unknown>][] = [
    ['filter', { filter: { kind: ['task'] } }],
    ['groupBy', { groupBy: ['kind'] }],
    ['sort', { sort: ['kind:asc'] }],
    ['show', { show: ['kind'] }],
  ];
  for (const [where, raw] of cases) {
    const issues = validateViews(view(raw), facets);
    assert.equal(issues.length, 1, `${where}: expected exactly one issue`);
    assert.equal(issues[0]!.severity, 'error', `${where}: must be an error, not a warning`);
    assert.match(issues[0]!.message, /kind/, `${where}: must name the offending axis`);
  }

  // `focus.via` is walked, so it has to be a reference facet specifically — a
  // label facet parses fine and then traverses nothing.
  const viaLabel = validateViews(view({ focus: { id: 'x', via: 'status', dir: 'in' } }), facets);
  assert.equal(viaLabel.length, 1);
  assert.match(viaLabel[0]!.message, /reference facet/);

  // Pseudo-facets are legitimate axes, and every real position is accepted.
  const good = validateViews(
    view({
      filter: { status: ['planning'], blocked: ['clear'] },
      groupBy: ['triage'],
      sort: ['status:asc', 'updated:desc', 'title:asc'],
      show: ['parent', 'status'],
      focus: { id: 'x', via: 'parent', dir: 'in' },
    }),
    facets,
  );
  assert.deepEqual(good, [], 'a view built from declared axes must be clean');
});

/**
 * `pj link` is the only writer of a card's `links`, and it goes through the gate.
 *
 * Three commands used to write that array. `link` and `unlink` patched
 * frontmatter directly and so never bumped `updated`, while `link-session` went
 * through `patchCard` and did — so attaching a Jira issue left a card reading as
 * untouched, on a field README says "only ever says that *something* changed".
 */

test('grouping is one answer, and the empty-group policy is an argument', () => {
  const data = {
    ids: ['a', 'b'],
    axis: ['now', 'month', 'backlog'],
    lanes: [],
    groups: [
      // Deliberately out of axis order, and one empty.
      { value: 'backlog', ids: ['b'] },
      { value: 'month', ids: [] },
      { value: 'now', ids: ['a'] },
    ],
  } as unknown as Parameters<typeof groupsFor>[0];

  assert.deepEqual(
    groupsFor(data, { lanes: 'all', empties: 'keep' }).map((g) => g.value),
    ['now', 'month', 'backlog'],
    'ordered by the axis the server declared, not by arrival',
  );
  assert.deepEqual(
    groupsFor(data, { lanes: 'all', empties: 'drop' }).map((g) => g.value),
    ['now', 'backlog'],
    'a canvas band and a table section need something in them',
  );

  // Ungrouped: one nameless group holding everything, which every shape open-coded.
  const flat = { ids: ['a', 'b'], axis: [], lanes: [], groups: null } as unknown as Parameters<
    typeof groupsFor
  >[0];
  assert.deepEqual(groupsFor(flat, { lanes: 'all', empties: 'keep' }), [{ value: '', ids: ['a', 'b'] }]);
});

test('a value the axis does not declare sorts after the ones it does', () => {
  const data = {
    ids: [],
    axis: ['now'],
    lanes: [],
    groups: [
      { value: 'adhoc', ids: ['x'] },
      { value: 'now', ids: ['y'] },
    ],
  } as unknown as Parameters<typeof groupsFor>[0];
  assert.deepEqual(groupsFor(data, { lanes: 'all', empties: 'keep' }).map((g) => g.value), ['now', 'adhoc']);
});

/** Five places said it four ways, one of them by printing the wire form. */
test('the absence refinement has one wording', () => {
  assert.equal(labelFor(NONE), 'no value');
  assert.equal(labelFor('now'), 'now');
});


test('a facet may not take a reserved name, and the sort keys prove why', () => {
  const facets = loadFacets(
    facetsFile(
      'blocked: { values: [yes, no] }\nupdated: { type: date }\nlayer: { values: [a, b] }\n',
    ),
  );
  const issues = validateVocabulary(facets, '/data/facets.yaml');
  const named = issues.map((i) => i.field).sort();

  // `blocked` is a pseudo-facet and would be silently shadowed; `updated` is a
  // sortable record field. `layer` is an ordinary axis and must survive.
  assert.deepEqual(named, ['blocked', 'updated']);
  assert.ok(issues.every((i) => i.severity === 'error'));
  assert.match(issues[0]!.message, /reserved/);
});

test('a record field outranks a facet wearing its name, whatever the facet type', () => {
  // Reserved names make this unreachable in a tended vault. It decides the
  // resting view of every board in one that ignored the error: `updated:desc` is
  // the default sort, and the vocabulary used to win it for a `date` facet and
  // lose it for a `label` one — the same collision, decided two ways.
  const card = (id: string, updated: string, facetValue: string) =>
    `---\nid: ${id}\ntitle: ${id}\nfacets: {updated: [${facetValue}]}\nupdated: ${updated}\n---\n\n`;

  for (const decl of ['updated: { type: date }', 'updated: { values: [a, b] }']) {
    const root = mkdtempSync(join(tmpdir(), 'projector-shadow-'));
    mkdirSync(join(root, 'cards'), { recursive: true });
    writeFileSync(join(root, 'cards', 'older.md'), card('older', '2020-01-01', '2030-01-01'), 'utf8');
    writeFileSync(join(root, 'cards', 'newer.md'), card('newer', '2030-01-01', '2020-01-01'), 'utf8');
    writeFileSync(join(root, 'facets.yaml'), decl + '\n', 'utf8');

    const { db, records } = reindex(root);
    const out = runQuery(db, records, loadFacets(join(root, 'facets.yaml')), { sort: ['updated:asc'] });
    assert.deepEqual(out.ids, ['older', 'newer'], `${decl}: the record field must decide`);
    rmSync(root, { recursive: true, force: true });
  }
});
