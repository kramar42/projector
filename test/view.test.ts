import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { patchYamlFile, } from '../src/schema/frontmatter.ts';
import { validateViews, validateVocabulary } from '../src/view/validate.ts';
import { parseSpec, specFromFile } from '../src/view/spec.ts';
import { declaredFacets, loadFacets, } from '../src/schema/facets.ts';
import { NONE } from '../src/schema/vocabulary.ts';
import { groupsFor, labelFor } from '../src/web/views/groups.ts';
import { reindex } from '../src/index/indexer.ts';
import { COMPUTED, runQuery } from '../src/index/query.ts';
import { queryPayload } from '../src/view/payload.ts';


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

  // Computed axes are legitimate axes, and every real position is accepted.
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
 * through `patchNote` and did — so attaching a Jira issue left a card reading as
 * untouched, on a field README says "only ever says that *something* changed".
 */

test('grouping is one answer, and the empty-group policy is an argument', () => {
  const data = {
    ids: ['a', 'b'],
    groupOrder: { primary: ['now', 'month', 'backlog'], secondary: [] },
    groups: [
      // Deliberately out of the declared order, and one empty.
      { value: 'backlog', ids: ['b'] },
      { value: 'month', ids: [] },
      { value: 'now', ids: ['a'] },
    ],
  } as unknown as Parameters<typeof groupsFor>[0];

  assert.deepEqual(
    groupsFor(data, { lanes: 'all', empties: 'keep' }).map((g) => g.value),
    ['now', 'month', 'backlog'],
    'ordered by the grouping order the server declared, not by arrival',
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

test('a value the grouping order does not declare sorts after the ones it does', () => {
  const data = {
    ids: [],
    groupOrder: { primary: ['now'], secondary: [] },
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
  const file = facetsFile(
    'blocked: { values: [yes, no] }\nupdated: { type: date }\nlayer: { values: [a, b] }\n' +
      'project: { type: ref }\n',
  );
  const issues = validateVocabulary(declaredFacets(file), '/data/facets.yaml');
  const named = issues.map((i) => i.field).sort();

  // `blocked` is a computed axis and would be silently shadowed; `updated` is a
  // sortable note field; `project` is built-in and this one sets its *shape*.
  // `layer` is an ordinary axis and must survive.
  assert.deepEqual(named, ['blocked', 'project', 'updated']);

  // The built-in must not report itself — it is in every loaded map, declared or
  // not — and a vault setting only what is its to set is no error at all.
  assert.deepEqual(validateVocabulary(declaredFacets(facetsFile('layer: { values: [a] }\n')), 'f'), []);
  const policy = facetsFile('project: { label: Portfolio, expected: true }\n');
  assert.deepEqual(validateVocabulary(declaredFacets(policy), 'f'), []);
  const loaded = loadFacets(policy);
  assert.equal(loaded.project!.label, 'Portfolio', 'the label is the vault\'s');
  assert.equal(loaded.project!.expected, true, 'so is the expectation');
  assert.equal(loaded.project!.type, 'ref', 'the shape is not');
  assert.ok(issues.every((i) => i.severity === 'error'));
  assert.match(issues[0]!.message, /reserved/);
});

test('a note field outranks a facet wearing its name, whatever the facet type', () => {
  // Reserved names make this unreachable in a tended vault. It decides the
  // resting view of every board in one that ignored the error: `updated:desc` is
  // the default sort, and the vocabulary used to win it for a `date` facet and
  // lose it for a `label` one — the same collision, decided two ways.
  const card = (id: string, updated: string, facetValue: string) =>
    `---\nid: ${id}\ntitle: ${id}\nfacets: {updated: [${facetValue}]}\nupdated: ${updated}\n---\n\n`;

  for (const decl of ['updated: { type: date }', 'updated: { values: [a, b] }']) {
    const root = mkdtempSync(join(tmpdir(), 'projector-shadow-'));
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'older.md'), card('older', '2020-01-01', '2030-01-01'), 'utf8');
    writeFileSync(join(root, 'notes', 'newer.md'), card('newer', '2030-01-01', '2020-01-01'), 'utf8');
    writeFileSync(join(root, 'facets.yaml'), decl + '\n', 'utf8');

    const { db, notes } = reindex(root);
    const out = runQuery(db, notes, loadFacets(join(root, 'facets.yaml')), { sort: ['updated:asc'] });
    assert.deepEqual(out.ids, ['older', 'newer'], `${decl}: the note field must decide`);
    rmSync(root, { recursive: true, force: true });
  }
});


test('a declaration that cannot take effect is an error, not a shrug', () => {
  // The same failure the reserved-name check exists for, one level in: a key
  // that does not apply is dropped at load, so by the time anything could notice
  // there is nothing left to notice. Each of these looks exactly like a setting
  // that works.
  const file = facetsFile(
    [
      'mood: { values: [good, bad], hue: teal, inverse: Moods, closed: [finished] }',
      'when: { type: date, buckets: { late: {upTo: -1, hue: crimson} } }',
      'fine: { values: [a, b], hue: green, closed: [b] }',
      'rel:  { type: ref, inverse: Named by, hue: red }',
    ].join('\n') + '\n',
  );
  const messages = validateVocabulary(declaredFacets(file), 'f').map((i) => i.message);

  assert.equal(messages.filter((m) => /inverse/.test(m)).length, 1, 'only the label facet');
  assert.equal(messages.filter((m) => /not a family/.test(m)).length, 2, 'the facet hue and the bucket one');
  assert.equal(messages.filter((m) => /closed/.test(m)).length, 1, 'a closed value the vocabulary lacks');
  // `fine` and `rel` declare the same keys correctly and must say nothing.
  assert.deepEqual(messages.filter((m) => /"fine"|"rel"/.test(m)), []);
});


test('a view key the reader does not know is an error, not a line that does nothing', () => {
  const facets = loadFacets(facetsFile('status: { values: [planning, done] }\n'));
  const view = (raw: Record<string, unknown>) => [
    { spec: specFromFile('v', raw), file: '/data/views/v.yaml', raw },
  ];

  // Both of these were real keys once. `uncategorised` was a grouping policy;
  // `layout: manual` was written beside `nodes` and read by nothing. A retired
  // key parses exactly like a live one, which is why this check exists.
  const issues = validateViews(
    view({ shape: 'board', title: 'T', uncategorised: 'hide', layout: 'manual', sort: ['title:asc'] }),
    facets,
  );
  assert.deepEqual(issues.map((i) => i.field).sort(), ['layout', 'uncategorised']);
  assert.ok(issues.every((i) => i.severity === 'error'));

  // Everything the writer emits, and the two arrangement keys, are accepted.
  assert.deepEqual(
    validateViews(
      view({
        shape: 'canvas',
        title: 'T',
        filter: { status: ['planning'] },
        groupBy: ['status'],
        sort: ['updated:desc'],
        show: ['status'],
        q: 'text',
        nodes: { a: { x: 1, y: 2 } },
        order: { planning: ['a'] },
      }),
      facets,
    ),
    [],
  );

  // A caller holding only a spec still checks the axes, and reports no keys.
  assert.deepEqual(
    validateViews([{ spec: specFromFile('v', { shape: 'board', nope: 1 }), file: 'f' }], facets),
    [],
  );
});


// ---------------------------------------------------------------- show

test('every axis `show` accepts arrives on the card, computed or stored', () => {
  // `show` took a computed axis everywhere except where it mattered. The view
  // validated (`validateViews` checks `show` against facets *and* `COMPUTED`),
  // the table resolved the label off `counts` and drew the header — and then
  // every cell was empty, because a face reads `facets` and nothing computed is
  // in there. A correctly labelled column of nothing, silently: the same failure
  // the reserved-name check exists to prevent, one level out.
  const root = mkdtempSync(join(tmpdir(), 'projector-show-'));
  try {
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(
      join(root, 'notes', 'a.md'),
      '---\nid: a\ntitle: A\nfacets: {status: [active]}\nupdated: 2026-08-18\n---\n\n',
      'utf8',
    );
    writeFileSync(join(root, 'facets.yaml'), 'status:\n  values: [active, done]\n  expected: true\n', 'utf8');

    const facets = loadFacets(join(root, 'facets.yaml'));
    const { db, notes } = reindex(root);
    const payload = queryPayload(
      { facets, db, notes, views: [], today: '2026-08-20' },
      parseSpec({ show: 'status,staleness,triage,type' }),
    );
    const card = payload.notes.a!;

    // Stored stays stored: `computed` is beside `facets`, never merged into it,
    // or the panel would draw an editable row for something no write can change.
    assert.deepEqual(card.facets.status, ['active']);
    assert.equal(card.computed.status, undefined);

    // Two days before `today`, one expected facet and it is carried, no
    // `project:` block and nothing names it.
    assert.deepEqual(card.computed.staleness, ['week']);
    assert.deepEqual(card.computed.triage, ['complete']);
    assert.deepEqual(card.computed.type, ['plain']);

    // An axis with nothing to say is absent rather than empty — `(none)` is the
    // ordinary refinement, and `[]` would draw a chip with no text.
    assert.equal(card.computed.linked, undefined, 'a note with no links says nothing on `linked`');

    // The invariant behind all of it: every computed axis is answerable for every
    // card, so a column can never be labelled from `counts` and then come up dry.
    for (const name of Object.keys(COMPUTED)) {
      const values = card.facets[name] ?? card.computed[name] ?? [];
      assert.ok(Array.isArray(values), `${name} must be readable off the card`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
