import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { patchYamlFile, } from '../src/schema/frontmatter.ts';
import { validateViews, validateVocabulary } from '../src/view/validate.ts';
import { parseSpec, specFromFile, specToParams, withSavedOnly, type ViewSpec } from '../src/view/spec.ts';
import { LISTS_AXIS } from '../src/schema/vocabulary.ts';
import { SHAPES } from '../src/web/query.ts';
import { declaredFacets, loadFacets, } from '../src/schema/facets.ts';
import { NONE } from '../src/schema/vocabulary.ts';
import { groupsFor, labelFor } from '../src/web/views/groups.ts';
import { reindex } from '../src/index/indexer.ts';
import { COMPUTED, runQuery } from '../src/index/query.ts';
import { queryPayload } from '../src/view/payload.ts';
import { SEED_FACETS } from '../src/server/seed.ts';
import { paths } from '../src/config.ts';


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
  const out = patchYamlFile(original, { nodes: { 'project-a': { x: 1, y: 2 } }, layout: 'manual' });
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
      groupBy: ['type'],
      sort: ['status:asc', 'updated:desc', 'title:asc'],
      show: ['parent', 'status'],
      focus: { id: 'x', via: 'parent', dir: 'in' },
    }),
    facets,
  );
  assert.deepEqual(good, [], 'a view built from declared axes must be clean');
});

/**
 * `pj link` is the only writer of a note's `links`, and it goes through the gate.
 *
 * Three commands used to write that array. `link` and `unlink` patched
 * frontmatter directly and so never bumped `updated`, while `link-session` went
 * through `patchNote` and did — so attaching a Jira issue left a note reading as
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
  const policy = facetsFile('project: { label: Portfolio, hue: purple }\n');
  assert.deepEqual(validateVocabulary(declaredFacets(policy), 'f'), []);
  const loaded = loadFacets(policy);
  assert.equal(loaded.project!.label, 'Portfolio', 'the label is the vault\'s');
  assert.equal(loaded.project!.hue, 'purple', 'so is the colour');
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
    mkdirSync(paths(root).config, { recursive: true });
    writeFileSync(join(paths(root).notes, 'older.md'), card('older', '2020-01-01', '2030-01-01'), 'utf8');
    writeFileSync(join(paths(root).notes, 'newer.md'), card('newer', '2030-01-01', '2020-01-01'), 'utf8');
    writeFileSync(paths(root).facets, decl + '\n', 'utf8');

    const { db, notes } = reindex(root);
    const out = runQuery(db, notes, loadFacets(paths(root).facets), { sort: ['updated:asc'] });
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


/**
 * The keyboard address, and the two ways a vault can ask for one that cannot work.
 *
 * Both are the silent failure this whole check exists for. An unshaped key is
 * never matched; a reserved one is *shadowed*, because `bind` reads the map
 * before the vocabulary — so the declaration sits in the file looking correct and
 * the letter goes on moving the cursor.
 */
test('a keyboard key a vault may not have is refused, in both of its forms', () => {
  const shaped = facetsFile('mood: { values: [a], key: pp }\nwhen: { type: date, key: "3" }\n');
  const messages = validateVocabulary(declaredFacets(shaped), 'f').map((i) => i.message);
  assert.equal(messages.filter((m) => /one letter/.test(m)).length, 2);

  // `j` moves the cursor. A vault claiming it would break motion rather than
  // gaining an axis.
  const taken = facetsFile('mood: { values: [a], key: j }\n');
  const clash = validateVocabulary(declaredFacets(taken), 'f');
  assert.equal(clash.length, 1);
  assert.match(clash[0]!.message, /the keyboard already uses/);
  assert.equal(clash[0]!.severity, 'error');
});

test('one letter, one axis — the second claimant is named rather than silently losing', () => {
  const file = facetsFile('mood: { values: [a], key: m }\nmeans: { values: [b], key: m }\n');
  const issues = validateVocabulary(declaredFacets(file), 'f');
  assert.equal(issues.length, 1, 'reported once, against the claimant that loses');
  assert.equal(issues[0]!.field, 'means');
  assert.match(issues[0]!.message, /"means" and "mood" both ask for key "m"/);
});

test('a key is normalised to the letter the keyboard actually sends', () => {
  // `P` is the shifted form and is never what `bind` looks up, so a vault writing
  // it means `p` — the loader settles that, and the checker does not complain.
  const file = facetsFile('mood: { values: [a], key: P }\n');
  assert.deepEqual(validateVocabulary(declaredFacets(file), 'f'), []);
  assert.equal(loadFacets(file).mood!.key, 'p');
});

test('the seeded vault and the tutorial vault declare keys that hold', () => {
  // The two vocabularies that actually ship. A collision here is a `pj check`
  // error the first time anyone opens them, which is not how a seed should read.
  // The tutorial vault is in the repository, so this holds in a fresh clone —
  // it used to read a private vault that exists on one machine.
  for (const file of [paths('vaults/tutorial').facets, undefined]) {
    const path = file ?? facetsFile(SEED_FACETS);
    assert.deepEqual(
      validateVocabulary(declaredFacets(path), path),
      [],
      `${path} declares a key it may not have`,
    );
  }
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
        shape: 'graph',
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

test('every axis `show` accepts arrives on the note, computed or stored', () => {
  // `show` took a computed axis everywhere except where it mattered. The view
  // validated (`validateViews` checks `show` against facets *and* `COMPUTED`),
  // the table resolved the label off `counts` and drew the header — and then
  // every cell was empty, because a face reads `facets` and nothing computed is
  // in there. A correctly labelled column of nothing, silently: the same failure
  // the reserved-name check exists to prevent, one level out.
  const root = mkdtempSync(join(tmpdir(), 'projector-show-'));
  try {
    mkdirSync(paths(root).config, { recursive: true });
    writeFileSync(
      join(paths(root).notes, 'a.md'),
      '---\nid: a\ntitle: A\nfacets: {status: [active]}\nupdated: 2026-08-18\n---\n\n',
      'utf8',
    );
    writeFileSync(paths(root).facets, 'status:\n  values: [active, done]\n', 'utf8');

    const facets = loadFacets(paths(root).facets);
    const { db, notes } = reindex(root);
    const payload = queryPayload(
      { facets, db, notes, views: [], today: '2026-08-20' },
      parseSpec({ show: 'status,staleness,type' }),
    );
    const card = payload.notes.a!;

    // Stored stays stored: `computed` is beside `facets`, never merged into it,
    // or the panel would draw an editable row for something no write can change.
    assert.deepEqual(card.facets.status, ['active']);
    assert.equal(card.computed.status, undefined);

    // Two days before `today`, no `project:` block and nothing names it.
    assert.deepEqual(card.computed.staleness, ['week']);
    assert.deepEqual(card.computed.type, ['plain']);

    // An axis with nothing to say is absent rather than empty — `(none)` is the
    // ordinary refinement, and `[]` would draw a chip with no text.
    assert.equal(card.computed.linked, undefined, 'a note with no links says nothing on `linked`');

    // The invariant behind all of it: every computed axis is answerable for every
    // note, so a column can never be labelled from `counts` and then come up dry.
    for (const name of Object.keys(COMPUTED)) {
      const values = card.facets[name] ?? card.computed[name] ?? [];
      assert.ok(Array.isArray(values), `${name} must be readable off the note`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a query payload carries derivations of the body, never the body', () => {
  // On a real vault the bodies are ~90% of the payload and no card face draws
  // one — the panel is the single reader, and it has its own route. What a face
  // does need is derived server-side so it cannot drift from the body (C8).
  const root = mkdtempSync(join(tmpdir(), 'projector-nobody-'));
  try {
    mkdirSync(paths(root).config, { recursive: true });
    writeFileSync(
      join(paths(root).notes, 'a.md'),
      '---\nid: a\ntitle: A\n---\n\nFirst prose paragraph.\n\n- [x] done\n- [ ] not\n',
      'utf8',
    );
    writeFileSync(paths(root).facets, 'status:\n  values: [active]\n', 'utf8');
    const facets = loadFacets(paths(root).facets);
    const { db, notes } = reindex(root);
    const card = queryPayload({ facets, db, notes, views: [] }, parseSpec({})).notes.a!;

    assert.equal('body' in card, false, 'the body travels only on the note route');
    assert.equal(card.excerpt, 'First prose paragraph.');
    assert.deepEqual(card.progress, { done: 1, total: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- composition

/**
 * `shape: lists` is the one view whose columns are other views.
 *
 * It exists because grouping cannot express the questions a triage board asks.
 * A grouped board derives its columns from one axis over one result set, so
 * "carries a priority but no status" and its mirror — conditions on two
 * different axes at once — can be *filtered* one at a time and never *drawn*
 * side by side. Composition runs each query and puts the answers next to each
 * other.
 */
test('a lists view draws its children as columns, and its own query does nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'projector-lists-'));
  try {
    mkdirSync(paths(root).config, { recursive: true });
    const note = (id: string, facets: string) =>
      writeFileSync(
        join(paths(root).notes, `${id}.md`),
        `---\nid: ${id}\ntitle: ${id}\nfacets: ${facets}\n---\n\n`,
        'utf8',
      );
    note('planned', '{priority: [now]}');
    note('committed', '{status: [active]}');
    note('both', '{status: [active], priority: [now]}');
    writeFileSync(
      paths(root).facets,
      'status:\n  values: [active]\npriority:\n  values: [now]\n',
      'utf8',
    );

    const facets = loadFacets(paths(root).facets);
    const { db, notes } = reindex(root);
    const children = [
      specFromFile('needs-status', {
        title: 'Needs status',
        unlisted: true,
        expect: 'empty',
        filter: { priority: ['-(none)'], status: ['(none)'] },
      }),
      specFromFile('needs-priority', {
        title: 'Needs priority',
        unlisted: true,
        expect: 'empty',
        filter: { status: ['-(none)'], priority: ['(none)'] },
      }),
    ];
    const parent = specFromFile('triage', {
      title: 'Triage',
      lists: ['needs-status', 'needs-priority'],
      sort: ['title:asc'],
    });
    const views = [...children, parent];
    const run = (spec: ViewSpec) =>
      queryPayload({ facets, db, notes, views, today: '2026-08-28' }, spec, parent);
    const payload = run(parent);

    // One column per child, in declared order, named by the child's *title* —
    // which is what a board prints as a column name and what `order` is keyed by.
    assert.deepEqual(payload.groupOrder.primary, ['Needs status', 'Needs priority']);
    assert.deepEqual(
      payload.groups?.map((g) => [g.value, g.ids]),
      [
        ['Needs status', ['planned']],
        ['Needs priority', ['committed']],
      ],
    );

    // `both` answers neither question, so it is in no column and not in `ids`.
    // The lists axis is the one grouping that is also a filter.
    //
    // `ids` is in the *view's* order — its `sort`, applied across the result —
    // and not the columns concatenated. That is the change that makes `sort` a
    // live control here: it used to be each child's own answer, already ordered,
    // and nothing downstream could reorder what it had been handed.
    assert.deepEqual(payload.ids, ['committed', 'planned']);
    assert.equal(payload.notes.both, undefined);
    assert.equal(payload.total, 2);
    assert.equal(payload.universe, 3);

    // Naming children *is* grouping by `lists`, without the file having to say
    // so. That is what makes every other control on the view mean what it means
    // everywhere else.
    assert.deepEqual(payload.spec.query.groupBy, [LISTS_AXIS]);

    // `unlisted` keeps the columns out of the picker while leaving them
    // addressable — the same objects `pj audit` runs.
    assert.deepEqual(
      payload.views.map((v) => v.name),
      ['triage'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a composition is a query like any other: shape, sort, filter and lanes all bite', () => {
  const root = mkdtempSync(join(tmpdir(), 'projector-lists-live-'));
  try {
    mkdirSync(paths(root).config, { recursive: true });
    const note = (id: string, facets: string) =>
      writeFileSync(
        join(paths(root).notes, `${id}.md`),
        `---\nid: ${id}\ntitle: ${id}\nfacets: ${facets}\n---\n\n`,
        'utf8',
      );
    // Two notes each column claims, so sort has something to order and the lane
    // axis has two values to split them across.
    note('a-now', '{status: [active], priority: [now]}');
    note('b-later', '{status: [active], priority: [later]}');
    note('c-nostatus', '{priority: [now]}');
    writeFileSync(
      paths(root).facets,
      'status:\n  values: [active]\npriority:\n  values: [now, later]\n',
      'utf8',
    );

    const facets = loadFacets(paths(root).facets);
    const { db, notes } = reindex(root);
    const views = [
      specFromFile('active', { title: 'Active', unlisted: true, filter: { status: ['active'] } }),
      specFromFile('urgent', { title: 'Urgent', unlisted: true, filter: { priority: ['now'] } }),
    ];
    const compose = (raw: Record<string, unknown>) => {
      const parent = specFromFile('board', { title: 'Board', lists: ['active', 'urgent'], ...raw });
      views.push(parent);
      const out = queryPayload({ facets, db, notes, views, today: '2026-08-28' }, parent, parent);
      views.pop();
      return out;
    };
    const cells = (p: ReturnType<typeof compose>) =>
      p.groups?.map((g) => [g.lane ?? null, g.value, g.ids] as const);

    // `shape` is a live control again. It was pinned, on the reasoning that a
    // composition has no query to project — but columns are exactly what a
    // table draws as sections and a canvas as bands.
    for (const shape of ['table', 'board', 'graph'] as const) {
      assert.equal(compose({ shape }).spec.shape, shape, `${shape} draws a composition`);
    }

    // `sort` orders *within* a column, which it could not when each child sorted
    // its own answer and handed back finished ids.
    assert.deepEqual(cells(compose({ sort: ['title:asc'] }))?.[0]?.[2], ['a-now', 'b-later']);
    assert.deepEqual(cells(compose({ sort: ['title:desc'] }))?.[0]?.[2], ['b-later', 'a-now']);

    // The filter crosses every column at once — "this board, but only the
    // urgent ones" — rather than being refused as a line that does nothing.
    const filtered = compose({ filter: { priority: ['now'] } });
    assert.deepEqual(cells(filtered), [
      [null, 'Active', ['a-now']],
      [null, 'Urgent', ['a-now', 'c-nostatus']],
    ]);
    // …and `universe - total` still says how many the filter is hiding.
    assert.equal(filtered.universe, 3);

    // A second axis makes lanes out of the columns: `value × lane` is the cell,
    // exactly as on a two-axis facet board.
    const laned = compose({ groupBy: [LISTS_AXIS, 'priority'], sort: ['title:asc'] });
    assert.deepEqual(laned.groupOrder.primary, ['Active', 'Urgent']);
    assert.deepEqual(laned.groupOrder.secondary, ['now', 'later']);
    assert.deepEqual(cells(laned), [
      ['now', 'Active', ['a-now']],
      ['now', 'Urgent', ['a-now', 'c-nostatus']],
      ['later', 'Active', ['b-later']],
      ['later', 'Urgent', []],
    ]);
    // A note in two columns is two placements and one note, on both axes.
    assert.equal(laned.placements, 4);
    assert.equal(laned.total, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a composition pins its columns and nothing else', () => {
  const saved = specFromFile('triage', {
    title: 'Triage',
    lists: ['needs-status'],
  });
  const url = (params: Record<string, string>) =>
    withSavedOnly(parseSpec({ ...specToParams(saved), ...params }), saved);

  // The columns are the children, so the first grouping position is spoken for
  // and a URL cannot displace it. It used to be the *shape* that was pinned,
  // which cost a triage board its table and its canvas to protect the one thing
  // that was actually at risk.
  assert.deepEqual(url({ group: 'priority' }).query.groupBy, [LISTS_AXIS, 'priority']);
  assert.deepEqual(url({ group: 'priority,status' }).query.groupBy, [LISTS_AXIS, 'priority']);
  // Naming it explicitly is the same view, not a doubled axis.
  assert.deepEqual(url({ group: 'lists,priority' }).query.groupBy, [LISTS_AXIS, 'priority']);
  assert.deepEqual(url({}).query.groupBy, [LISTS_AXIS]);

  // Everything else the shapes share is live, shape included.
  for (const shape of ['table', 'board', 'calendar', 'graph'] as const) {
    assert.equal(url({ shape }).shape, shape);
  }
  assert.deepEqual(url({ sort: 'title:desc' }).query.sort, ['title:desc']);

  // And an ordinary view is untouched by any of it.
  const plain = specFromFile('home', { shape: 'board', title: 'Home' });
  assert.equal(
    withSavedOnly(parseSpec({ ...specToParams(plain), shape: 'table' }), plain).shape,
    'table',
  );
  assert.deepEqual(
    withSavedOnly(parseSpec({ ...specToParams(plain), group: 'priority' }), plain).query.groupBy,
    ['priority'],
  );

  // Four shapes, and `lists` is not one of them — it never drew differently,
  // it decided where the columns came from.
  assert.deepEqual(
    SHAPES.map((s) => s.value),
    ['table', 'board', 'calendar', 'graph'],
  );
});

test('a composition is checked: children exist, stay flat, nest never, and own only their columns', () => {
  const facets = loadFacets(facetsFile('status: { values: [active] }\n'));
  const child = specFromFile('leaf', { title: 'Leaf', filter: { status: ['active'] } });
  const grouped = specFromFile('grouped', { title: 'Grouped', groupBy: ['status'] });
  const nested = specFromFile('nested', { title: 'Nested', lists: ['leaf'] });
  const at = (spec: ReturnType<typeof specFromFile>, raw: Record<string, unknown>) => ({
    spec,
    file: `/data/views/${spec.name}.yaml`,
    raw,
  });

  const issues = (raw: Record<string, unknown>) =>
    validateViews(
      [
        at(child, {}),
        at(grouped, {}),
        at(nested, {}),
        at(specFromFile('v', raw), raw),
      ],
      facets,
    ).filter((i) => i.id === 'v');

  // Every one of these is a line that parses and then does nothing, which is the
  // failure this validator exists for.
  assert.match(issues({ lists: ['gone'] })[0]!.message, /no view "gone"/);
  assert.match(issues({ lists: ['nested'] })[0]!.message, /one level deep/);
  assert.match(issues({ lists: ['grouped'] })[0]!.message, /which a column cannot draw/);
  assert.match(issues({ expect: 'none' })[0]!.message, /the only assertion is "empty"/);
  assert.match(issues({ unlisted: 'yes' })[0]!.message, /true or it is absent/);

  // `shape: lists` was the fourth shape. An older file saying it still draws —
  // it falls through to the default table — so it is named rather
  // than refused, because the word now claims something untrue.
  assert.match(issues({ shape: 'lists', lists: ['leaf'] })[0]!.message, /no longer a shape/);
  assert.match(issues({ shape: 'lists' })[0]!.message, /draws as a table/);

  // The columns are the children, so nothing else may claim the first grouping
  // position — and the message says how to keep both.
  assert.match(
    issues({ lists: ['leaf'], groupBy: ['status'] })[0]!.message,
    /cannot be the first grouping axis/,
  );
  assert.match(
    issues({ lists: ['leaf'], groupBy: ['status'] })[0]!.message,
    /\[lists, status\]/,
  );
  // …and the axis is meaningless without children to be the values of it.
  assert.match(issues({ groupBy: ['lists'] })[0]!.message, /names no "lists:"/);
  assert.match(
    issues({ lists: ['leaf'], groupBy: ['lists', 'status', 'status'] })[0]!.message,
    /two grouping axes at most/,
  );

  // A curated order is keyed by the column heading, so one that names no column
  // is an arrangement nothing will ever read — which is what a retitled child
  // leaves behind.
  assert.match(
    issues({ lists: ['leaf'], order: { Gone: ['x'] } })[0]!.message,
    /is not a column of this view/,
  );

  // The filter, the search and the sort are live controls on a composition now,
  // so none of them is a line that does nothing.
  assert.deepEqual(
    issues({ lists: ['leaf'], filter: { status: ['active'] }, sort: ['title:asc'] }),
    [],
  );
  // A lane axis beside the columns is the shape this replaced `swimlanes` with.
  assert.deepEqual(issues({ lists: ['leaf'], groupBy: ['lists', 'status'] }), []);

  // Two columns cannot share a name: one would swallow the other's notes.
  const twin = specFromFile('twin', { title: 'Leaf', filter: { status: ['active'] } });
  const clash = validateViews(
    [
      at(child, {}),
      at(twin, {}),
      at(specFromFile('v', { lists: ['leaf', 'twin'] }), { lists: ['leaf', 'twin'] }),
    ],
    facets,
  ).filter((i) => i.id === 'v');
  assert.match(clash[0]!.message, /would swallow the other/);

  assert.deepEqual(
    validateViews([at(child, {}), at(nested, { lists: ['leaf'] })], facets),
    [],
    'a well-formed composition is clean',
  );
});
