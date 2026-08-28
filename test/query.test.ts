import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reindex } from '../src/index/indexer.ts';
import { axisPopulation } from '../src/index/queries.ts';
import { loadFacets } from '../src/schema/facets.ts';
import { NONE, focused, ftsPrefixQuery, runQuery, type Query } from '../src/index/query.ts';
import { negate } from '../src/schema/vocabulary.ts';
import { adjacency, refsOf } from '../src/index/refs.ts';
import { specFromFile } from '../src/view/spec.ts';
import { SEED_VIEWS } from '../src/server/seed.ts';
import { parse } from 'yaml';
import { paths } from '../src/config.ts';

/**
 * A vault of its own, so these assert the engine rather than whatever the real
 * notes happen to say today.
 *
 *   project-b ──member─ keycloak ──member─ kc-realms          (project chain)
 *   project-a ──parent── project-a-eventing ──parent── kafka-schema  (decomposition)
 *   blocked-card ──blocked_by──> blocker
 */
const CARDS: Record<string, string> = {
  'project-b': `---
id: project-b
title: Project B
facets: { status: [active] }
project: {}
updated: 2026-08-19
---
`,
  keycloak: `---
id: keycloak
title: Keycloak
facets: { project: [project-b], status: [active], priority: [now] }
links: [jira:PROJ-1, "https://example.com/x"]
project: {}
updated: 2026-08-19
---
`,
  'kc-realms': `---
id: kc-realms
title: Realm provisioning
facets: { project: [keycloak], status: [planning], priority: [month], tech: [keycloak] }
links: [doc:notes.md]
updated: 2026-08-18
---
`,
  'project-a': `---
id: project-a
title: Project A
facets: { status: [active] }
project: {}
updated: 2026-08-01
---
`,
  'project-a-eventing': `---
id: project-a-eventing
title: Eventing
facets: { kind: [node], parent: [project-a] }
updated: 2026-07-01
---
`,
  'kafka-schema': `---
id: kafka-schema
title: Glue schema registry
facets: { project: [project-a], priority: [now], status: [planning], tech: [kafka], parent: [project-a-eventing] }
updated: 2026-08-20
---
`,
  blocker: `---
id: blocker
title: Must land first
facets: { status: [active], priority: [now] }
updated: 2026-08-20
---
`,
  'blocked-card': `---
id: blocked-card
title: Waits on the blocker
facets: { status: [planning], priority: [now], project: [project-a], blocked_by: [blocker] }
updated: 2026-08-20
---
`,
  loose: `---
id: loose
title: No project and no priority
facets: { status: [planning] }
updated: 2026-01-01
---
`,
};

const FACETS = `
parent:     { label: Part of,  type: ref, single: true }
blocked_by: { label: blocked by, type: ref, blocking: true }
due:        { label: Due, type: date, single: true, buckets: { overdue: -1, today: 0, week: 7 }, overflow: later }
priority:   { label: Priority, values: [now, month, backlog], open: false, single: true }
status:     { label: Status,   values: [planning, active, done], open: false, single: true, closed: [done] }
tech:       { label: Tech,     values: [keycloak, kafka], open: true }
waiting_on: { label: Waiting on, values: [], open: true, blocking: true }
`;

function vault(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'projector-query-'));
  mkdirSync(paths(root).config, { recursive: true });
  for (const [id, text] of Object.entries(CARDS)) {
    writeFileSync(join(paths(root).notes, `${id}.md`), text, 'utf8');
  }
  writeFileSync(paths(root).facets, FACETS, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function open(root: string) {
  const { db, notes } = reindex(root);
  const facets = loadFacets(paths(root).facets);
  return (query: Query, connect?: string) =>
    runQuery(db, notes, facets, query, { today: '2026-08-20', connect });
}

function ids(root: string, query: Query): string[] {
  return [...open(root)(query).ids].sort();
}

test('every note is loaded, so a bare query is the whole vault', () => {
  const { root, cleanup } = vault();
  try {
    assert.equal(open(root)({}).total, Object.keys(CARDS).length);
  } finally {
    cleanup();
  }
});


test('a facet filter is one level deep and reads values, not edges', () => {
  const { root, cleanup } = vault();
  try {
    // `kc-realms` belongs to keycloak, which belongs to project-b — and is still not
    // selected by `project=project-b`. That gap is what focus exists for.
    assert.deepEqual(ids(root, { filter: { project: ['project-b'] } }), ['keycloak']);
    assert.deepEqual(ids(root, { filter: { project: ['project-a'] } }), ['blocked-card', 'kafka-schema']);
  } finally {
    cleanup();
  }
});

test('(none) selects absence, which no stored value can express', () => {
  const { root, cleanup } = vault();
  try {
    assert.deepEqual(ids(root, { filter: { project: [NONE] } }), ['blocker', 'loose', 'project-a', 'project-a-eventing', 'project-b']);
    assert.deepEqual(ids(root, { filter: { priority: [NONE] } }), ['loose', 'project-a', 'project-a-eventing', 'project-b']);
    // A value and absence at once: "unassigned, or assigned to project-a".
    assert.deepEqual(ids(root, { filter: { priority: [NONE, 'month'] } }), [
      'kc-realms',
      'loose',
      'project-a',
      'project-a-eventing',
      'project-b',
    ]);
  } finally {
    cleanup();
  }
});

test('facets are ANDed, values within one are ORed', () => {
  const { root, cleanup } = vault();
  try {
    assert.deepEqual(ids(root, { filter: { priority: ['now'], status: ['planning'] } }), [
      'blocked-card',
      'kafka-schema',
    ]);
  } finally {
    cleanup();
  }
});

test('computed axes filter exactly like stored ones', () => {
  const { root, cleanup } = vault();
  try {
    assert.deepEqual(ids(root, { filter: { kind: ['node'] } }), ['project-a-eventing']);
    assert.deepEqual(ids(root, { filter: { type: ['project'] } }), ['keycloak', 'project-a', 'project-b']);
    assert.deepEqual(ids(root, { filter: { type: ['node'] } }), ['blocker', 'project-a-eventing']);
    assert.deepEqual(ids(root, { filter: { type: ['plain'] } }), ['blocked-card', 'kafka-schema', 'kc-realms', 'loose']);
    assert.deepEqual(ids(root, { filter: { blocked: ['blocked_by'] } }), ['blocked-card']);
    // What the `triage` axis used to answer, asked as the queries that replaced
    // it. Both are conditions on an absence, and the second is a condition on
    // two axes at once — which is why they are views rather than one axis: no
    // grouping can draw a column per pair of facets.
    assert.deepEqual(ids(root, { filter: { project: [NONE], type: ['plain', 'node'] } }), [
      'blocker',
      'loose',
      'project-a-eventing',
    ]);
    assert.deepEqual(
      ids(root, { filter: { status: [negate(NONE)], priority: [NONE] } }),
      ['loose', 'project-a', 'project-b'],
      'committed to as work, and unplanned — project notes included, since the view is what exempts them',
    );
    assert.deepEqual(ids(root, { filter: { staleness: ['older'] } }), ['loose', 'project-a-eventing']);
    assert.deepEqual(ids(root, { filter: { staleness: ['month'] } }), ['project-a']);
  } finally {
    cleanup();
  }
});

test('there is no triage axis: a vault states its filing rules as views', () => {
  const { root, cleanup } = vault();
  try {
    // It was computed from `expected: true`, which asserted that every note is
    // work — so a note deliberately carrying no `status`, because it is context,
    // could never be filed. The axis is gone rather than narrowed.
    assert.deepEqual(ids(root, { filter: { triage: ['needs-project'] } }), []);
    // Grouping by it now does what grouping by any name the vocabulary does not
    // have does: one column, holding everything, for the value nothing carries.
    // `validateViews` is what stops a saved view saying it silently.
    assert.deepEqual(open(root)({ groupBy: ['triage'] }).groupOrder.primary, [NONE]);

    // And no exemption moved into the engine with it. A project note carries no
    // `project` facet, so the view that asks says which types it means.
    assert.ok(ids(root, { filter: { project: [NONE] } }).includes('project-b'));
    assert.equal(
      ids(root, { filter: { project: [NONE], type: ['plain', 'node'] } }).includes('project-b'),
      false,
      'and the view is what exempts it',
    );
  } finally {
    cleanup();
  }
});

test('a done blocker stops blocking', () => {
  const { root, cleanup } = vault();
  try {
    writeFileSync(
      join(paths(root).notes, 'blocker.md'),
      CARDS.blocker!.replace('status: [active]', 'status: [done]'),
      'utf8',
    );
    assert.deepEqual(ids(root, { filter: { blocked: ['blocked'] } }), []);
  } finally {
    cleanup();
  }
});

test('focus walks references transitively, in the direction asked for', () => {
  const { root, cleanup } = vault();
  try {
    const { notes } = reindex(root);
    const set = (f: Parameters<typeof focused>[0]) => [...focused(f, notes)].sort();

    // Includes the focus itself: "this subtree" contains its own root.
    assert.deepEqual(set({ id: 'project-a', via: 'parent', dir: 'in' }), ['kafka-schema', 'project-a', 'project-a-eventing']);
    assert.deepEqual(set({ id: 'kafka-schema', via: 'parent', dir: 'out' }), ['kafka-schema', 'project-a', 'project-a-eventing']);
    // The project reference reaches the grandchild that `project=project-b` could not.
    assert.deepEqual(set({ id: 'project-b', via: 'project', dir: 'in' }), ['kc-realms', 'keycloak', 'project-b']);
    // The relation is stored on the note that is stuck, so `out` from it reaches
    // its blockers and `in` from a blocker reaches what it holds up.
    assert.deepEqual(set({ id: 'blocked-card', via: 'blocked_by', dir: 'out' }), ['blocked-card', 'blocker']);
    assert.deepEqual(set({ id: 'blocker', via: 'blocked_by', dir: 'in' }), ['blocked-card', 'blocker']);
    // depth caps the walk one hop short of the grandchild.
    assert.deepEqual(set({ id: 'project-b', via: 'project', dir: 'in', depth: 1 }), ['keycloak', 'project-b']);
  } finally {
    cleanup();
  }
});

test('dir=both is two walks unioned, not one walk over a symmetric graph', () => {
  const { root, cleanup } = vault();
  try {
    const { notes } = reindex(root);
    // From the middle of the chain: its own container and its own member, and
    // not `project-a` — which a walk over undirected edges would reach through project-b.
    assert.deepEqual([...focused({ id: 'keycloak', via: 'project', dir: 'both' }, notes)].sort(), [
      'kc-realms',
      'keycloak',
      'project-b',
    ]);
  } finally {
    cleanup();
  }
});

test('membership is read from the facet, never stored as a relation of its own', () => {
  const { root, cleanup } = vault();
  try {
    const { notes } = reindex(root);
    assert.deepEqual(
      refsOf('project', notes)
        .map((e) => `${e.src}->${e.dst}`)
        .sort(),
      ['blocked-card->project-a', 'kafka-schema->project-a', 'kc-realms->keycloak', 'keycloak->project-b'],
    );
    // There is no relation storage to check against: a note has facets and
    // links, and that is all. `edges` is not a field any more.
    for (const rec of notes.values()) {
      assert.ok(!('edges' in rec));
    }
  } finally {
    cleanup();
  }
});

test('focus bounds the facet filter rather than being one', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const res = run({
      focus: { id: 'project-a', via: 'parent', dir: 'in' },
      filter: { priority: ['now'] },
    });
    assert.deepEqual(res.ids, ['kafka-schema']);
  } finally {
    cleanup();
  }
});

test('grouping puts a multi-valued note in every matching column', () => {
  const { root, cleanup } = vault();
  try {
    writeFileSync(
      join(paths(root).notes, 'kc-realms.md'),
      CARDS['kc-realms']!.replace('priority: [month]', 'priority: [now, month]'),
      'utf8',
    );
    const res = open(root)({ groupBy: ['priority'] });
    // Every declared value gets a column, `backlog` included with nothing in it.
    assert.deepEqual(
      res.groups!.map((g) => g.value),
      ['now', 'month', 'backlog', NONE],
    );
    assert.ok(res.groups![0]!.ids.includes('kc-realms'));
    assert.ok(res.groups![1]!.ids.includes('kc-realms'));
    // One note, two placements — the model, not a duplicate.
    assert.equal(res.total, Object.keys(CARDS).length);
    assert.equal(res.placements, res.total + 1);
  } finally {
    cleanup();
  }
});

test('every declared value gets a group, empty or not', () => {
  const { root, cleanup } = vault();
  try {
    // `backlog` is declared in facets.yaml and no note carries it. It still gets a
    // column: a priority board missing one reads as though it did not exist, and
    // an empty column is somewhere to drag a card to.
    assert.deepEqual(
      open(root)({ groupBy: ['priority'] }).groups!.map((g) => g.value),
      ['now', 'month', 'backlog', NONE],
    );
    // Declared order, not the order the values happen to appear in.
    assert.deepEqual(
      open(root)({ groupBy: ['status'] }).groups!.map((g) => g.value),
      ['planning', 'active', 'done', NONE],
    );
  } finally {
    cleanup();
  }
});

test('the (none) column comes last, and only when something is in it', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const values = (q: Query) => run(q).groups!.map((g) => g.value);
    assert.deepEqual(values({ groupBy: ['priority'] }), ['now', 'month', 'backlog', NONE]);

    // There was an `uncategorised: end | start | hide` option. Excluding the
    // uncategorised is what a *filter* does — and does correctly, where `hide`
    // dropped the cards from the groups but left them in `ids`, so the count
    // over-reported and a canvas went on drawing them.
    const filtered = run({ groupBy: ['priority'], filter: { priority: ['now', 'month'] } });
    assert.deepEqual(filtered.groups!.map((g) => g.value), ['now', 'month']);
    assert.equal(
      filtered.total,
      filtered.groups!.reduce((n, g) => n + g.ids.length, 0),
      'and the total counts exactly what the groups hold',
    );
  } finally {
    cleanup();
  }
});

test('sort by a facet uses its declared order, not the alphabet', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const priorities = run({ sort: ['priority:asc'], filter: { priority: ['now', 'month'] } }).ids;
    // now before month, though "month" sorts first alphabetically.
    assert.deepEqual(priorities.slice(0, 3).includes('kc-realms'), false);
    assert.equal(priorities.at(-1), 'kc-realms');

    const desc = run({ sort: ['updated:desc'] }).ids;
    assert.equal(desc[desc.length - 1], 'loose'); // oldest updated
    const asc = run({ sort: ['updated:asc'] }).ids;
    assert.equal(asc[0], 'loose');
    assert.equal(run({ sort: ['title:asc'] }).ids[0], 'project-a-eventing'); // "Eventing"
  } finally {
    cleanup();
  }
});

test('notes missing the sort facet go last, whichever direction', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const withPriority = new Set(['keycloak', 'kc-realms', 'kafka-schema', 'blocker', 'blocked-card']);
    const asc = run({ sort: ['priority:asc'] }).ids;
    const firstMissing = asc.findIndex((id) => !withPriority.has(id));
    assert.equal(asc.slice(0, firstMissing).every((id) => withPriority.has(id)), true);
  } finally {
    cleanup();
  }
});

test('counts are disjunctive, so a selection can be widened', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const of = (res: ReturnType<typeof run>, facet: string) =>
      Object.fromEntries(res.counts.find((c) => c.facet === facet)!.values.map((v) => [v.value, v.count]));

    // `backlog` is declared and carried by nobody. It is listed at zero all the
    // same: the panel says what the axis *is*, so a value can be selected before
    // anything has it — and, more to the point, re-selected after being cleared.
    const open0 = run({});
    assert.deepEqual(of(open0, 'priority'), { now: 4, month: 1, backlog: 0, [NONE]: 4 });

    const narrowed = run({ filter: { priority: ['month'] } });
    // priority's own counts are unchanged — the other values still say what
    // adding them would bring, which is the whole point.
    assert.deepEqual(of(narrowed, 'priority'), { now: 4, month: 1, backlog: 0, [NONE]: 4 });
    // Another facet's counts do reflect the selection. Its zeros stay listed:
    // the universe has those values, so the panel says they exist and that
    // nothing currently matching has them.
    // `done` is declared and unused here, so it too is listed at zero.
    assert.deepEqual(of(narrowed, 'status'), { planning: 1, active: 0, done: 0, [NONE]: 0 });
  } finally {
    cleanup();
  }
});

test('an axis absent from the universe is not offered; a selected one always is', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const names = (res: ReturnType<typeof run>) => res.counts.map((c) => c.facet);
    // A facet filter does not remove an axis — see the sideways test above. Only
    // focus and search change what the universe holds.
    assert.ok(names(run({})).includes('tech'));
    assert.ok(names(run({ filter: { project: [NONE] } })).includes('tech'));
    assert.ok(!names(run({ q: 'realm' })).includes('waiting_on'));
    // `project` itself stays, because its own selection is lifted — the real
    // values have to remain visible or `(none)` becomes a one-way door.
    const project = run({ filter: { project: [NONE] } }).counts.find((c) => c.facet === 'project')!;
    assert.deepEqual(
      project.values.map((v) => v.value),
      ['keycloak', 'project-a', 'project-b', NONE],
    );
    // Selected but empty stays reachable, or it could never be unselected.
    const stuck = run({ filter: { priority: ['backlog'] } });
    const priority = stuck.counts.find((c) => c.facet === 'priority')!;
    assert.deepEqual(
      priority.values.find((v) => v.value === 'backlog'),
      { value: 'backlog', count: 0, selected: true, excluded: false },
    );
  } finally {
    cleanup();
  }
});

test('connect adds context along the relation it is given, never as matches', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const res = run({ filter: { tech: ['kafka'] } }, 'parent');
    assert.deepEqual(res.ids, ['kafka-schema']);
    // The chain up to the root comes back separately, so the count stays honest.
    assert.deepEqual([...res.context].sort(), ['project-a', 'project-a-eventing']);
    assert.equal(res.total, 1);

    // A different relation is a different chain — which is the whole point of
    // passing one. Laying a canvas out by `project` while pulling context along
    // `parent` showed a graph the layout did not follow.
    assert.deepEqual([...run({ filter: { tech: ['kafka'] } }, 'project').context].sort(), ['project-a']);
    assert.deepEqual(run({ filter: { tech: ['kafka'] } }).context, []);
  } finally {
    cleanup();
  }
});

test('full text composes with the filter instead of replacing it', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    assert.deepEqual(run({ q: 'realm' }).ids, ['kc-realms']);
    // A prefix matches, because a search box is typed into one letter at a time.
    assert.deepEqual(run({ q: 'rea' }).ids, ['kc-realms']);
    assert.deepEqual(run({ q: 'schema', filter: { priority: ['now'] } }).ids, ['kafka-schema']);
    assert.deepEqual(run({ q: 'schema', filter: { priority: ['month'] } }).ids, []);
  } finally {
    cleanup();
  }
});

test('a search box mid-keystroke cannot throw', () => {
  assert.equal(ftsPrefixQuery('keyc'), '"keyc"*');
  assert.equal(ftsPrefixQuery('kafka sche'), '"kafka" "sche"*');
  // Every FTS5 operator character is stripped rather than passed through.
  assert.equal(ftsPrefixQuery('  '), null);
  assert.equal(ftsPrefixQuery('"'), null);
  assert.equal(ftsPrefixQuery('-'), null);
  assert.equal(ftsPrefixQuery('a OR b'), '"a" "OR" "b"*');
  assert.equal(ftsPrefixQuery('kc:realm'), '"kc" "realm"*');
  assert.equal(ftsPrefixQuery('((((('), null);
});

test('punctuation alone is not a search, and never fails the request', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    // Nothing survives sanitising, so there is no constraint to apply — the
    // alternative is a request that errors while the user is still typing.
    assert.equal(run({ q: '((' }).total, Object.keys(CARDS).length);
    assert.equal(run({ q: '"' }).total, Object.keys(CARDS).length);
    assert.equal(run({ q: 'realm' }).total, 1);
  } finally {
    cleanup();
  }
});

test('a second grouping axis makes a matrix, not a new concept', () => {
  const { root, cleanup } = vault();
  try {
    const res = open(root)({ groupBy: ['priority', 'status'], filter: { priority: ['now', 'month'] } });
    // `backlog` is excluded by the filter on the very axis this groups by, so it
    // is not a column. `status` is unfiltered, so every lane it declares stays.
    assert.deepEqual(res.groupOrder.primary, ['now', 'month']);
    assert.deepEqual(res.groupOrder.secondary, ['planning', 'active', 'done']);
    // Every cell exists, in reading order, so an empty one still holds its place.
    assert.deepEqual(
      res.groups!.filter((g) => g.lane !== 'done').map((g) => `${g.lane}/${g.value}:${g.ids.length}`),
      ['planning/now:2', 'planning/month:1', 'active/now:2', 'active/month:0'],
    );
    // Each note lands in exactly one cell here, so nothing is double-counted.
    assert.equal(res.placements, res.total);
  } finally {
    cleanup();
  }
});

/**
 * A filter on the axis you group by says which columns exist.
 *
 * The axis used to be the vocabulary and nothing else, so `due` — grouped by
 * `due`, filtered to three of its four buckets — drew a `later` column no note
 * could ever reach, and `triage` drew `complete` the same way. The two cases a
 * board has to tell apart: a value the filter *admits* that happens to be empty
 * is a place to drag a card to, and a value the filter *excludes* is not part of
 * this axis at all.
 */
test('a value the filter excludes is not a column; an admitted empty one still is', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    // `backlog` is declared and admitted, and no note carries it — the empty
    // column a board wants, because it is somewhere to drag to.
    const wide = run({ groupBy: ['priority'] });
    assert.deepEqual(wide.groupOrder.primary, ['now', 'month', 'backlog', NONE]);

    // Narrow the same axis and the excluded values stop being columns. `month`
    // stays at zero: admitted, and emptied by the *other* half of the filter.
    const narrow = run({ groupBy: ['priority'], filter: { priority: ['now', 'month'], status: ['active'] } });
    assert.deepEqual(narrow.groupOrder.primary, ['now', 'month']);
    assert.deepEqual(
      narrow.groups!.map((g) => `${g.value}:${g.ids.length}`),
      ['now:2', 'month:0'],
    );
  } finally {
    cleanup();
  }
});

test('the lane axis narrows on the same rule as the column axis', () => {
  const { root, cleanup } = vault();
  try {
    // Grouping is one function called twice, so this needs no policy of its own —
    // which is the assertion.
    const res = open(root)({
      groupBy: ['status', 'priority'],
      filter: { priority: ['now'] },
    });
    assert.deepEqual(res.groupOrder.secondary, ['now']);
    assert.deepEqual(res.groupOrder.primary, ['planning', 'active', 'done'], 'the unfiltered axis is untouched');
  } finally {
    cleanup();
  }
});

test('a derived axis narrows too, having no vocabulary of its own to defend', () => {
  const { root, cleanup } = vault();
  try {
    const res = open(root)({ groupBy: ['blocked'], filter: { blocked: ['clear'] } });
    // `blocked` and `waiting` are excluded. Nothing can be dragged onto a derived
    // axis in any case, so an empty column there was decoration.
    assert.deepEqual(res.groupOrder.primary, ['clear']);
  } finally {
    cleanup();
  }
});

/**
 * The property that makes narrowing safe, stated as a test: to match a selection
 * of value *names* a note must carry one of those names, so it always keeps a
 * column. A note admitted by a *range* need not — its bucket can sit outside the
 * selection entirely — so a range selection narrows nothing rather than emptying
 * the board.
 */
test('a range selection narrows nothing, so no note loses its column', () => {
  const { root, cleanup } = vault();
  try {
    const res = open(root)({ groupBy: ['due'], filter: { due: ['>2026-01-01'] } });
    // Every bucket the facet declares, exactly as before: the tokens are
    // expressions, and nothing here can say which buckets they cover.
    assert.deepEqual(res.groupOrder.primary, ['overdue', 'today', 'week', 'later']);
    // And the invariant itself, for the name case: every hit is placed somewhere.
    const named = open(root)({ groupBy: ['priority'], filter: { priority: ['now'] } });
    const placed = new Set(named.groups!.flatMap((g) => g.ids));
    assert.deepEqual([...named.ids].sort().filter((id) => !placed.has(id)), []);
  } finally {
    cleanup();
  }
});

/**
 * On a multi-valued axis the narrowing drops *placements*, and that is the point:
 * a column headed `keycloak` in a view that holds only `kafka` notes invites the
 * wrong reading. What it must never drop is a note.
 */
test('narrowing a multi-valued axis drops extra placements but never a note', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const both = { tech: ['kafka', 'keycloak'] };
    const wide = run({ groupBy: ['tech'], filter: both });
    assert.deepEqual(wide.groupOrder.primary, ['keycloak', 'kafka']);

    const one = run({ groupBy: ['tech'], filter: { tech: ['kafka'] } });
    assert.deepEqual(one.groupOrder.primary, ['kafka']);
    // The notes themselves are untouched — only the column they also sat in went.
    assert.equal(one.total, 1);
    assert.equal(one.placements, 1);
    const placed = new Set(one.groups!.flatMap((g) => g.ids));
    assert.deepEqual(one.ids.filter((id) => !placed.has(id)), []);
  } finally {
    cleanup();
  }
});

test('grouping options read the same on either axis', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    // Grouping is a property of the query, not of a board: whatever the column
    // axis does, the lane axis does.
    const res = run({ groupBy: ['status', 'priority'] });
    // `project-a-eventing` is a node with no facets at all, so both axes have a
    // (none), and it trails on both.
    assert.deepEqual(res.groupOrder.primary, ['planning', 'active', 'done', NONE]);
    assert.deepEqual(res.groupOrder.secondary, ['now', 'month', 'backlog', NONE]);
  } finally {
    cleanup();
  }
});

test('refining one facet never removes another', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const names = (res: ReturnType<typeof run>) => res.counts.map((c) => c.facet).sort();
    const before = names(run({}));
    // A filter that matches nothing at all. The panel must still offer every
    // axis the universe has, or there is no way to look sideways out of a dead
    // end — only `q` and `focus` may narrow which facets exist.
    const dead = run({ filter: { tech: ['kafka'], project: ['project-b'] } });
    assert.equal(dead.total, 0);
    assert.deepEqual(names(dead), before);
    // …and the counts still tell you what widening would bring.
    const tech = dead.counts.find((c) => c.facet === 'tech')!;
    assert.deepEqual(
      tech.values.map((v) => `${v.value}:${v.count}`),
      ['keycloak:0', 'kafka:0', '(none):1'],
    );
  } finally {
    cleanup();
  }
});

test('focus and search do narrow which facets exist', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    // `tech` lives on two notes, neither in the project-b project chain.
    const scoped = run({ focus: { id: 'project-b', via: 'project', dir: 'in' } });
    assert.ok(scoped.counts.some((c) => c.facet === 'tech')); // kc-realms is in there
    const elsewhere = run({ focus: { id: 'blocker', via: 'blocks', dir: 'out' } });
    assert.ok(!elsewhere.counts.some((c) => c.facet === 'tech'));
  } finally {
    cleanup();
  }
});

test('universe is what the filter is hiding, exactly', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const all = Object.keys(CARDS).length;
    assert.equal(run({}).universe, all);
    // A facet filter narrows `total` and leaves `universe` alone: the difference
    // is the number the sidebar reports as filtered out.
    const narrowed = run({ filter: { priority: ['now'] } });
    assert.equal(narrowed.universe, all);
    assert.equal(narrowed.total, 4);
    // Focus and search narrow the universe itself — they define what you are
    // looking at, so nothing is being "hidden" from you.
    const scoped = run({ focus: { id: 'project-a', via: 'parent', dir: 'in' } });
    assert.equal(scoped.universe, 3);
    assert.equal(scoped.total, 3);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- deadlines

/**
 * A second vault, because these axes need notes the others must not see —
 * adding a note to the shared fixture would move every count asserted above.
 */
const DATED: Record<string, string> = {
  'ship-it': `---
id: ship-it
title: Ship it
facets: { status: [active], due: [2026-08-18] }
updated: 2026-08-19
---
`,
  'ask-person-a': `---
id: ask-person-a
title: Ask Person A
facets: { status: [planning], waiting_on: [person-a], due: [2026-08-24] }
updated: 2026-08-19
---
`,
  someday: `---
id: someday
title: No deadline
facets: { status: [planning], blocked_by: [gate] }
updated: 2026-08-19
---
`,
  blocker: `---
id: gate
title: Gate
facets: { status: [active] }
updated: 2026-08-19
---
`,
};

function datedVault(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'projector-dated-'));
  mkdirSync(paths(root).config, { recursive: true });
  for (const [name, text] of Object.entries(DATED)) {
    writeFileSync(join(paths(root).notes, `${name}.md`), text, 'utf8');
  }
  writeFileSync(paths(root).facets, FACETS, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('an ordered facet presents buckets and compares raw', () => {
  const { root, cleanup } = datedVault();
  try {
    // today is 2026-08-20 in this harness.
    assert.deepEqual(ids(root, { filter: { due: ['overdue'] } }), ['ship-it']);
    assert.deepEqual(ids(root, { filter: { due: ['week'] } }), ['ask-person-a']);
    // No `undated` bucket: a note with no deadline has no value for the axis,
    // so it is reached the same way every other absence is.
    assert.deepEqual(ids(root, { filter: { due: [NONE] } }), ['gate', 'someday']);
    assert.ok(!ids(root, { filter: { due: [NONE] } }).includes('ship-it'));
  } finally {
    cleanup();
  }
});

test('sorting by due puts the undated last in both directions', () => {
  const { root, cleanup } = datedVault();
  try {
    const asc = open(root)({ sort: ['due:asc'] }).ids;
    const desc = open(root)({ sort: ['due:desc'] }).ids;
    assert.deepEqual(asc.slice(0, 2), ['ship-it', 'ask-person-a']);
    assert.deepEqual(desc.slice(0, 2), ['ask-person-a', 'ship-it']);
    // A deadline is a date, so "no deadline" is not the earliest one.
    assert.ok(!['ship-it', 'ask-person-a'].includes(asc.at(-1)!));
    assert.ok(!['ship-it', 'ask-person-a'].includes(desc.at(-1)!));
  } finally {
    cleanup();
  }
});

test('every blocking facet lands on one axis, under its own name', () => {
  const { root, cleanup } = datedVault();
  try {
    // A reference blocks while something it names is not closed; a label blocks
    // while it holds a value at all. Two facets, two values, one axis — and the
    // values are the facet names, so a vault declaring a third gets a third.
    assert.deepEqual(ids(root, { filter: { blocked: ['blocked_by'] } }), ['someday']);
    // Never from a stored status value — there is no `status: waiting` for it to
    // disagree with.
    assert.deepEqual(ids(root, { filter: { blocked: ['waiting_on'] } }), ['ask-person-a']);
    const clear = ids(root, { filter: { blocked: ['clear'] } });
    assert.ok(!clear.includes('someday'));
    assert.ok(!clear.includes('ask-person-a'));
  } finally {
    cleanup();
  }
});

test('there is no kind axis, stored or computed', () => {
  const { root, cleanup } = vault();
  try {
    const offered = open(root)({}).counts.map((c) => c.facet);
    assert.ok(!offered.includes('kind'));
    // What it used to gate: a note with no status is off a status-filtered
    // board, and a note something is part of is a container.
    const noStatus = ids(root, { filter: { status: [NONE] } });
    assert.ok(noStatus.includes('project-a-eventing'));
    assert.ok(!ids(root, { filter: { status: ['active', 'planning'] } }).includes('project-a-eventing'));
    assert.deepEqual(ids(root, { filter: { parent: ['project-a'] } }), ['project-a-eventing']);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- references

test('every relation is read the same way, so nothing knows which is which', () => {
  const { root, cleanup } = vault();
  try {
    const { notes } = reindex(root);
    // One reader, so `parent` and `project` are indistinguishable to everything
    // downstream — focus, the canvas, the roll-ups, config inheritance.
    const project = adjacency('project', notes);
    const parent = adjacency('parent', notes);
    assert.deepEqual(project.out.get('keycloak'), ['project-b']);
    assert.deepEqual(parent.out.get('project-a-eventing'), ['project-a']);
    assert.deepEqual(project.in.get('project-b'), ['keycloak']);
    assert.deepEqual(parent.in.get('project-a'), ['project-a-eventing']);
  } finally {
    cleanup();
  }
});

test('a value naming a note that does not exist is not a reference', () => {
  const { root, cleanup } = vault();
  try {
    writeFileSync(
      join(paths(root).notes, 'orphan.md'),
      '---\nid: orphan\ntitle: Orphan\nfacets: { project: [gone] }\n---\n',
      'utf8',
    );
    const { notes } = reindex(root);
    // It stays a facet value — it filters and groups — it simply has nothing to
    // walk to. `pj check` is what reports it.
    assert.deepEqual(notes.get('orphan')!.facets.project, ['gone']);
    assert.equal(adjacency('project', notes).out.get('orphan'), undefined);
    assert.deepEqual(ids(root, { filter: { project: ['gone'] } }), ['orphan']);
  } finally {
    cleanup();
  }
});

test('only a label facet declares a vocabulary of its own', () => {
  const { root, cleanup } = vault();
  try {
    const def = loadFacets(paths(root).facets).project!;
    // Only a `label` has a declared vocabulary: a reference's is the vault and
    // an ordered facet's is unbounded, so both imply `open` and a declared list
    // on either is dropped rather than half-honoured.
    assert.equal(def.type, 'ref');
    assert.equal(def.open, true);
    assert.deepEqual(def.values, []);
  } finally {
    cleanup();
  }
});

test('a relation groups a board and reaches (none), like any other facet', () => {
  const { root, cleanup } = vault();
  try {
    const res = open(root)({ groupBy: ['parent'] });
    const byValue = Object.fromEntries((res.groups ?? []).map((g) => [g.value, g.ids.length]));
    // None of this was possible while relations lived in an `edges` block:
    // filtering, grouping and absence all arrive because it is a facet.
    assert.equal(byValue['project-a'], 1);
    assert.equal(byValue['project-a-eventing'], 1);
    assert.ok(byValue[NONE]! > 0);
    assert.deepEqual(ids(root, { filter: { parent: ['project-a'] } }), ['project-a-eventing']);
    assert.ok(ids(root, { filter: { parent: [NONE] } }).includes('project-a'));
  } finally {
    cleanup();
  }
});

test('the blocked axis names the facet that is failing, and closed stops blocking', () => {
  const { root, cleanup } = vault();
  try {
    assert.deepEqual(ids(root, { filter: { blocked: ['blocked_by'] } }), ['blocked-card']);
    writeFileSync(
      join(paths(root).notes, 'blocker.md'),
      CARDS.blocker!.replace('status: [active]', 'status: [done]'),
      'utf8',
    );
    assert.deepEqual(ids(root, { filter: { blocked: ['blocked_by'] } }), []);
  } finally {
    cleanup();
  }
});

/**
 * `pj next` is this query and nothing else.
 *
 * It spent two days answering nothing, because a second implementation in SQL
 * filtered on `kind` — a facet P7 deleted — and an empty result is not an error.
 * So this asserts the shape *and* that it is non-empty: a clause naming a facet
 * the vocabulary no longer has would put it back to zero, silently.
 */
test('actionable now is one query, and never silently empty', () => {
  const { root, cleanup } = vault();
  try {
    const actionable = ids(root, {
      filter: { status: ['planning', 'active'], blocked: ['clear'] },
    });
    assert.ok(actionable.length > 0, 'no open, unblocked note — the filter matched nothing');
    // Open and clear: in. Blocked, waited-on, and carrying no lifecycle: out.
    assert.ok(actionable.includes('keycloak'));
    assert.ok(!actionable.includes('blocked-card'), 'an unfinished blocker keeps it out');
    assert.ok(!actionable.includes('project-a-eventing'), 'no status is not work');
  } finally {
    cleanup();
  }
});

/**
 * And the view file says the same thing.
 *
 * The query above used to live in `cmdNext`, where a typo was a compile error;
 * it lives in `views/unblocked.yaml` now, where a typo is silence. `pj check`
 * catches an axis the vocabulary never had — this catches the subtler one, a
 * clause that parses but no longer means "actionable".
 */
test('the unblocked view parses to exactly the actionable query', () => {
  const seeded = SEED_VIEWS.find((v) => v.path === 'unblocked.yaml');
  assert.ok(seeded, 'no unblocked.yaml ships in SEED_VIEWS');
  const spec = specFromFile('unblocked', parse(seeded.body) as Record<string, unknown>);

  assert.deepEqual(spec.query.filter, { status: ['planning', 'active'], blocked: ['clear'] });
  // A deadline outranks an intention, so `due` leads and undated notes fall last.
  assert.deepEqual(spec.query.sort, ['due:asc', 'priority:asc', 'updated:desc']);
  assert.equal(spec.query.groupBy, undefined, 'a flat worklist, as `pj next` printed');
});

test('the linked axis makes external references askable', () => {
  const { root, cleanup } = vault();
  try {
    // Every axis on a note was askable except this one, across the notes that
    // carry a link — most of the real vault.
    assert.deepEqual(ids(root, { filter: { linked: ['jira'] } }), ['keycloak']);
    assert.deepEqual(ids(root, { filter: { linked: ['doc'] } }), ['kc-realms']);
    // A note with no links has no value, so absence is the ordinary (none).
    assert.ok(ids(root, { filter: { linked: [NONE] } }).includes('project-a'));
    // One note, two kinds: it lands in every bucket it carries.
    assert.deepEqual(ids(root, { filter: { linked: ['url'] } }), ['keycloak']);
    const axis = open(root)({}).counts.find((c) => c.facet === 'linked');
    assert.ok(axis);
    assert.equal(axis.computed, true);
  } finally {
    cleanup();
  }
});

/**
 * Clearing a filter must leave the control that set it.
 *
 * `due` is declared with buckets and carried by no note — the state the real
 * vault is in, and `views/due.yaml` selects three of its buckets. The panel listed
 * a value only if the data held it or the query had selected it, so on that view
 * the three buckets were on screen *because they were selected*: unticking them
 * removed them one by one, and unticking the last one removed the whole axis. The
 * filter could be cleared and never put back.
 */
test('an axis the query names stays offered after its last value is cleared', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const due = (res: ReturnType<typeof run>) => res.counts.find((c) => c.facet === 'due');

    // Nothing in this vault carries a due date, and the query is silent about it:
    // an axis nobody uses and nobody asks for is not offered. That is the
    // narrowing behaviour focus depends on, and it is unchanged.
    assert.equal(due(run({})), undefined);

    // Selected: offered, with every declared bucket, all at zero.
    const picked = due(run({ filter: { due: ['overdue', 'today', 'week'] } }))!;
    assert.deepEqual(
      picked.values.map((v) => v.value),
      ['overdue', 'today', 'week', 'later', NONE],
    );
    assert.deepEqual(
      picked.values.filter((v) => v.selected).map((v) => v.value),
      ['overdue', 'today', 'week'],
    );

    // Two cleared, one left: the cleared ones stay on screen, unticked.
    const partly = due(run({ filter: { due: ['overdue'] } }))!;
    assert.deepEqual(partly.values.map((v) => v.value), ['overdue', 'today', 'week', 'later', NONE]);

    // All cleared. `due: []` is the query saying "explicitly nothing", which is
    // not silence — so the axis is still there, and every bucket is re-selectable.
    const cleared = due(run({ filter: { due: [] } }))!;
    assert.deepEqual(cleared.values.map((v) => v.value), ['overdue', 'today', 'week', 'later', NONE]);
    assert.deepEqual(cleared.values.filter((v) => v.selected), []);
  } finally {
    cleanup();
  }
});

/**
 * The board drew a column the panel would not offer.
 *
 * Grouping has always included every declared value, empty or not — an empty
 * column is somewhere to drag to. The histogram did not, so a declared-but-unused
 * value got a column and no way to filter by it. Two answers to "what values does
 * this axis have", in one response.
 */
/**
 * ...and disagree, on purpose, once that axis is filtered.
 *
 * The panel says what the axis *is* and counts each value with its own selection
 * lifted, so it is the control that widens a view — `backlog 1`, unchecked, one
 * click from being a column again. The board says what you asked for. They were
 * redundant while the board drew the whole vocabulary; making them complementary
 * is the change, so this pins the divergence rather than treating it as drift.
 */
test('the panel keeps offering a value the board has stopped drawing', () => {
  const { root, cleanup } = vault();
  try {
    const res = open(root)({ groupBy: ['priority'], filter: { priority: ['now'] } });
    const columns = res.groups!.map((g) => g.value);
    const offered = res.counts.find((c) => c.facet === 'priority')!.values;

    assert.deepEqual(columns, ['now'], 'the board draws the slice');
    assert.ok(
      offered.some((v) => v.value === 'backlog' && !v.selected),
      'and the panel still offers the way back',
    );
    // Counted with `priority`'s own selection lifted, so an unselected value can
    // read non-zero — which is what makes it worth clicking.
    assert.equal(offered.find((v) => v.value === 'month')!.count, 1);
  } finally {
    cleanup();
  }
});

test('grouping and the panel agree about a declared value nobody carries', () => {
  const { root, cleanup } = vault();
  try {
    const res = open(root)({ groupBy: ['priority'] });
    const columns = res.groups!.map((g) => g.value);
    const offered = res.counts.find((c) => c.facet === 'priority')!.values.map((v) => v.value);
    assert.ok(columns.includes('backlog'), 'grouping draws the empty column');
    assert.ok(offered.includes('backlog'), 'and the panel offers the same value');
    assert.deepEqual(columns, offered, 'one answer, not two');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- negation

/**
 * Filtering something *out*.
 *
 * The reason it exists rather than being spelled "select every other value" is
 * that the two are different queries, and the difference is what a backlog sweep
 * needs: a note with no value on the axis at all survives the negation, and there
 * are far more of those than there are values.
 */
test('a negation keeps every note the axis says nothing about', () => {
  const { root, cleanup } = vault();
  try {
    // `keycloak` is the only note in project `project-b`. Excluding it keeps the other
    // six — including the five that carry no project whatsoever.
    const out = ids(root, { filter: { project: ['-project-b'] } });
    assert.equal(out.includes('keycloak'), false);
    assert.deepEqual(out, [
      'blocked-card',
      'blocker',
      'kafka-schema',
      'kc-realms',
      'loose',
      'project-a',
      'project-a-eventing',
      'project-b',
    ]);

    // Which is what naming every other value cannot do. `project-b`, `blocker` and
    // `loose` carry no project at all, so no positive selection reaches them
    // short of adding `(none)` — and adding it would also have to be redone the
    // next time a project is created.
    assert.deepEqual(ids(root, { filter: { project: ['keycloak', 'project-a'] } }), [
      'blocked-card',
      'kafka-schema',
      'kc-realms',
    ]);
  } finally {
    cleanup();
  }
});

/**
 * The case that makes negation more than a shorthand: on a multi-valued axis a
 * positive and a negative compose, and no positive selection can say it.
 */
test('a positive and a negative on one axis are both applied', () => {
  const { root, cleanup } = vault();
  try {
    const both = join(paths(root).notes, 'both.md');
    writeFileSync(
      both,
      `---\nid: both\ntitle: Both\nfacets: { project: [project-b, keycloak] }\nupdated: 2026-08-19\n---\n`,
      'utf8',
    );
    // `keycloak` is in project-b; `both` is in project-b and keycloak. "In project-b but not in
    // keycloak" separates them, and selecting values alone cannot.
    assert.deepEqual(ids(root, { filter: { project: ['project-b'] } }), ['both', 'keycloak']);
    assert.deepEqual(ids(root, { filter: { project: ['project-b', '-keycloak'] } }), ['keycloak']);
  } finally {
    cleanup();
  }
});

test('a negated value loses its column, and the rest of the axis keeps theirs', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const values = (q: Query) => run(q).groups!.map((g) => g.value);
    assert.deepEqual(values({ groupBy: ['priority'] }), ['now', 'month', 'backlog', NONE]);
    // Not a column called `-now`: the token is an expression, and the axis is the
    // whole vocabulary less what it names.
    assert.deepEqual(values({ groupBy: ['priority'], filter: { priority: ['-now'] } }), [
      'month',
      'backlog',
      NONE,
    ]);
  } finally {
    cleanup();
  }
});

test('an excluded value is reported as excluded, and still counts what it would bring back', () => {
  const { root, cleanup } = vault();
  try {
    const res = open(root)({ filter: { project: ['-project-b'] } });
    const project = res.counts.find((c) => c.facet === 'project')!;
    const projectB = project.values.find((v) => v.value === 'project-b')!;
    assert.deepEqual(projectB, { value: 'project-b', count: 1, selected: false, excluded: true });
    // Counted with this axis's own filter lifted, like every other value — so the
    // row says what un-excluding it would restore rather than reading 0.
    assert.equal(project.values.find((v) => v.value === 'keycloak')!.count, 1);
  } finally {
    cleanup();
  }
});

/** A negation is stripped before the token is read, so a range negates too. */
test('a range can be negated', () => {
  const { root, cleanup } = vault();
  try {
    const dated = (id: string, due: string) =>
      writeFileSync(
        join(paths(root).notes, `${id}.md`),
        `---\nid: ${id}\ntitle: ${id}\nfacets: { due: [${due}] }\nupdated: 2026-08-19\n---\n`,
        'utf8',
      );
    dated('soon', '2026-08-19');
    dated('late', '2026-09-30');

    assert.deepEqual(ids(root, { filter: { due: ['>2026-08-20'] } }), ['late']);
    const not = ids(root, { filter: { due: ['->2026-08-20'] } });
    assert.equal(not.includes('late'), false);
    // And it keeps `soon` *and* every note with no date at all: a note the range
    // cannot describe is not a note the range excludes.
    assert.ok(not.includes('soon') && not.includes('loose'));
  } finally {
    cleanup();
  }
});

/**
 * The fact an empty screen cannot otherwise state.
 *
 * A board grouped by an axis draws that axis's declared columns whether or not
 * any note has ever taken one, so "the filter is too tight" and "nobody has ever
 * set this" render identically — opposite problems, opposite next moves. This is
 * the vault-wide half of telling them apart; `histogram` above is the
 * universe-scoped half, and they are deliberately two answers.
 */
test('an axis nobody has ever used is absent, not zero', () => {
  const { root, cleanup } = vault();
  try {
    const { db } = reindex(root);
    const pop = axisPopulation(db);

    // `tech` is declared and carried, so it counts notes rather than values: a
    // note with two tech values is one note here.
    assert.ok((pop.tech ?? 0) >= 1, 'a carried axis is counted');
    assert.equal(pop.status, Object.keys(CARDS).filter((id) => CARDS[id]!.includes('status:')).length);

    // The property the caller stands on: an axis the vocabulary declares and no
    // note carries has no key at all. Absent rather than 0, because the map is
    // built from the rows that exist — and a caller reading `?? 0` gets the same
    // answer either way, which is why nothing has to remember which it is.
    const declared = Object.keys(loadFacets(paths(root).facets));
    assert.ok(declared.includes('priority'), 'the fixture still declares what this asserts about');
    for (const name of declared) {
      const carried = Object.values(CARDS).some((t) => t.includes(`${name}:`));
      assert.equal(name in pop, carried, `${name}: population disagrees with the fixture`);
    }
  } finally {
    cleanup();
  }
});

/**
 * Computed axes are not in it, and that is the point rather than an omission.
 *
 * Every note has a `type` and a `blocked`, so a computed axis can never be
 * unpopulated — a zero here would be a category error offered to a reader as a
 * finding.
 */
test('a computed axis has no population, because it cannot be unpopulated', () => {
  const { root, cleanup } = vault();
  try {
    const pop = axisPopulation(reindex(root).db);
    for (const name of ['type', 'blocked', 'linked', 'staleness']) {
      assert.ok(!(name in pop), `${name} is computed and should not be counted here`);
    }
  } finally {
    cleanup();
  }
});

/**
 * The CLI is a fresh process per command, so the server memo cannot help it.
 * The persisted payload in index.db answers instead — gated on the same kind
 * of exact stamp (C1): reuse only when nothing reindex reads could have
 * changed, and `force` (pj reindex's contract) always rebuilds.
 */
test('the persisted index answers until a note changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'projector-gate-'));
  writeFileSync(join(root, 'one.md'), '# One\n\nfirst body\n', 'utf8');
  const first = reindex(root);
  assert.equal(first.cached, false, 'a fresh vault has nothing to answer from');
  first.db.close();

  const second = reindex(root);
  assert.equal(second.cached, true, 'nothing changed, so nothing is re-read');
  assert.equal(second.notes.get('one')?.title, 'One');
  second.db.close();

  const forced = reindex(root, { force: true });
  assert.equal(forced.cached, false, 'a command named reindex must reindex');
  forced.db.close();

  // ensure the mtime moves even on coarse filesystems
  const later = new Date(Date.now() + 2000);
  writeFileSync(join(root, 'one.md'), '# One renamed\n\nsecond body\n', 'utf8');
  utimesSync(join(root, 'one.md'), later, later);
  const third = reindex(root);
  assert.equal(third.cached, false, 'a changed byte invalidates the gate');
  assert.equal(third.notes.get('one')?.title, 'One renamed');
  third.db.close();
});

