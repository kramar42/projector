import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reindex } from '../src/index/indexer.ts';
import { loadFacets } from '../src/schema/facets.ts';
import { NONE, focused, ftsQuery, memberEdges, runQuery, type Query } from '../src/index/query.ts';

/**
 * A vault of its own, so these assert the engine rather than whatever the real
 * cards happen to say today.
 *
 *   project-b ──member─ keycloak ──member─ kc-realms          (project chain)
 *   project-a ──parent── project-a-eventing ──parent── kafka-schema  (decomposition)
 *   blocker ──blocks──> blocked-card
 */
const CARDS: Record<string, string> = {
  project-b: `---
id: project-b
kind: card
title: Project B
facets: { status: [active] }
project: { key: project-b }
updated: 2026-08-19
---
`,
  keycloak: `---
id: keycloak
kind: card
title: Keycloak
facets: { project: [project-b], status: [active], priority: [now] }
project: { key: keycloak }
updated: 2026-08-19
---
`,
  'kc-realms': `---
id: kc-realms
kind: card
title: Realm provisioning
facets: { project: [keycloak], status: [planning], priority: [month], tech: [keycloak] }
updated: 2026-08-18
---
`,
  project-a: `---
id: project-a
kind: card
title: Project A
facets: { status: [active] }
project: { key: project-a }
updated: 2026-08-01
---
`,
  'project-a-eventing': `---
id: project-a-eventing
kind: node
title: Eventing
edges: [{ type: parent, to: project-a }]
updated: 2026-07-01
---
`,
  'kafka-schema': `---
id: kafka-schema
kind: card
title: Glue schema registry
facets: { project: [project-a], priority: [now], status: [planning], tech: [kafka] }
edges: [{ type: parent, to: project-a-eventing }]
updated: 2026-08-20
---
`,
  blocker: `---
id: blocker
kind: card
title: Must land first
facets: { status: [active], priority: [now] }
edges: [{ type: blocks, to: blocked-card }]
updated: 2026-08-20
---
`,
  'blocked-card': `---
id: blocked-card
kind: card
title: Waits on the blocker
facets: { status: [planning], priority: [now], project: [project-a] }
updated: 2026-08-20
---
`,
  loose: `---
id: loose
kind: card
title: No project and no priority
facets: { status: [planning] }
updated: 2026-01-01
---
`,
};

const FACETS = `
priority: { label: Priority, values: [now, month, backlog], open: false }
status:   { label: Status,   values: [planning, active, done], open: false }
tech:     { label: Tech,     values: [keycloak, kafka], open: true }
project:  { label: Project,  values: [], open: true, valuesFrom: project-records }
`;

function vault(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-query-'));
  mkdirSync(join(root, 'cards'), { recursive: true });
  for (const [id, text] of Object.entries(CARDS)) {
    writeFileSync(join(root, 'cards', `${id}.md`), text, 'utf8');
  }
  writeFileSync(join(root, 'facets.yaml'), FACETS, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function open(root: string) {
  const { db, records } = reindex(root);
  const facets = loadFacets(join(root, 'facets.yaml'));
  return (query: Query) => runQuery(db, records, facets, query, { today: '2026-08-20' });
}

function ids(root: string, query: Query): string[] {
  return [...open(root)(query).ids].sort();
}

test('every card is loaded, so a bare query is the whole vault', () => {
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
    assert.deepEqual(ids(root, { filter: { project: [NONE] } }), ['blocker', 'project-b', 'loose', 'project-a', 'project-a-eventing']);
    assert.deepEqual(ids(root, { filter: { priority: [NONE] } }), ['project-b', 'loose', 'project-a', 'project-a-eventing']);
    // A value and absence at once: "unassigned, or assigned to project-a".
    assert.deepEqual(ids(root, { filter: { priority: [NONE, 'month'] } }), [
      'project-b',
      'kc-realms',
      'loose',
      'project-a',
      'project-a-eventing',
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

test('pseudo-facets filter exactly like stored ones', () => {
  const { root, cleanup } = vault();
  try {
    assert.deepEqual(ids(root, { filter: { kind: ['node'] } }), ['project-a-eventing']);
    assert.deepEqual(ids(root, { filter: { type: ['project'] } }), ['project-b', 'keycloak', 'project-a']);
    assert.deepEqual(ids(root, { filter: { blocked: ['blocked'] } }), ['blocked-card']);
    // Three axes missing at once puts a card in three triage buckets.
    assert.deepEqual(ids(root, { filter: { triage: ['needs-project'] } }), [
      'blocker',
      'project-b',
      'loose',
      'project-a',
      'project-a-eventing',
    ]);
    assert.deepEqual(ids(root, { filter: { staleness: ['older'] } }), ['loose', 'project-a-eventing']);
    assert.deepEqual(ids(root, { filter: { staleness: ['month'] } }), ['project-a']);
  } finally {
    cleanup();
  }
});

test('a done blocker stops blocking', () => {
  const { root, cleanup } = vault();
  try {
    writeFileSync(
      join(root, 'cards', 'blocker.md'),
      CARDS.blocker!.replace('status: [active]', 'status: [done]'),
      'utf8',
    );
    assert.deepEqual(ids(root, { filter: { blocked: ['blocked'] } }), []);
  } finally {
    cleanup();
  }
});

test('focus walks edges transitively, in the direction asked for', () => {
  const { root, cleanup } = vault();
  try {
    const { records } = reindex(root);
    const set = (f: Parameters<typeof focused>[0]) => [...focused(f, records)].sort();

    // Includes the focus itself: "this subtree" contains its own root.
    assert.deepEqual(set({ id: 'project-a', via: 'parent', dir: 'down' }), ['kafka-schema', 'project-a', 'project-a-eventing']);
    assert.deepEqual(set({ id: 'kafka-schema', via: 'parent', dir: 'up' }), ['kafka-schema', 'project-a', 'project-a-eventing']);
    // member-of reaches the grandchild that `project=project-b` could not.
    assert.deepEqual(set({ id: 'project-b', via: 'member-of', dir: 'down' }), ['project-b', 'kc-realms', 'keycloak']);
    // Downstream of a blocker is what finishing it unblocks.
    assert.deepEqual(set({ id: 'blocker', via: 'blocks', dir: 'down' }), ['blocked-card', 'blocker']);
    assert.deepEqual(set({ id: 'blocked-card', via: 'blocks', dir: 'up' }), ['blocked-card', 'blocker']);
    // depth caps the walk one hop short of the grandchild.
    assert.deepEqual(set({ id: 'project-b', via: 'member-of', dir: 'down', depth: 1 }), ['project-b', 'keycloak']);
  } finally {
    cleanup();
  }
});

test('dir=both is two walks unioned, not one walk over a symmetric graph', () => {
  const { root, cleanup } = vault();
  try {
    const { records } = reindex(root);
    // From the middle of the chain: its own container and its own member, and
    // not `project-a` — which a walk over undirected edges would reach through project-b.
    assert.deepEqual([...focused({ id: 'keycloak', via: 'member-of', dir: 'both' }, records)].sort(), [
      'project-b',
      'kc-realms',
      'keycloak',
    ]);
  } finally {
    cleanup();
  }
});

test('member-of edges are derived from the facet, never stored', () => {
  const { root, cleanup } = vault();
  try {
    const { records } = reindex(root);
    assert.deepEqual(
      memberEdges(records)
        .map((e) => `${e.src}->${e.dst}`)
        .sort(),
      ['blocked-card->project-a', 'kafka-schema->project-a', 'kc-realms->keycloak', 'keycloak->project-b'],
    );
    // Nothing was written: the cards carry a facet, not an edge.
    for (const rec of records.values()) {
      assert.ok(!rec.edges.some((e) => (e.type as string) === 'member-of'));
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
      focus: { id: 'project-a', via: 'parent', dir: 'down' },
      filter: { priority: ['now'] },
    });
    assert.deepEqual(res.ids, ['kafka-schema']);
  } finally {
    cleanup();
  }
});

test('grouping puts a multi-valued card in every matching column', () => {
  const { root, cleanup } = vault();
  try {
    writeFileSync(
      join(root, 'cards', 'kc-realms.md'),
      CARDS['kc-realms']!.replace('priority: [month]', 'priority: [now, month]'),
      'utf8',
    );
    const res = open(root)({ groupBy: ['priority'] });
    assert.deepEqual(
      res.groups!.map((g) => g.value),
      ['now', 'month', NONE],
    );
    assert.ok(res.groups![0]!.ids.includes('kc-realms'));
    assert.ok(res.groups![1]!.ids.includes('kc-realms'));
    // One record, two placements — the model, not a duplicate.
    assert.equal(res.total, Object.keys(CARDS).length);
    assert.equal(res.placements, res.total + 1);
  } finally {
    cleanup();
  }
});

test('showEmpty keeps a declared column that nothing is in', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    assert.deepEqual(
      run({ groupBy: ['priority'] }).groups!.map((g) => g.value),
      ['now', 'month', NONE],
    );
    assert.deepEqual(
      run({ groupBy: ['priority'], showEmpty: true }).groups!.map((g) => g.value),
      ['now', 'month', 'backlog', NONE],
    );
  } finally {
    cleanup();
  }
});

test('uncategorised places or hides the (none) column', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const values = (u: Query['uncategorised']) =>
      run({ groupBy: ['priority'], uncategorised: u }).groups!.map((g) => g.value);
    assert.deepEqual(values('start'), [NONE, 'now', 'month']);
    assert.deepEqual(values('end'), ['now', 'month', NONE]);
    assert.deepEqual(values('hide'), ['now', 'month']);
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

test('records missing the sort facet go last, whichever direction', () => {
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

    const open0 = run({});
    assert.deepEqual(of(open0, 'priority'), { now: 4, month: 1, [NONE]: 4 });

    const narrowed = run({ filter: { priority: ['month'] } });
    // priority's own counts are unchanged — the other values still say what
    // adding them would bring, which is the whole point.
    assert.deepEqual(of(narrowed, 'priority'), { now: 4, month: 1, [NONE]: 4 });
    // Another facet's counts do reflect the selection. Its zeros stay listed:
    // the universe has those values, so the panel says they exist and that
    // nothing currently matching has them.
    assert.deepEqual(of(narrowed, 'status'), { planning: 1, active: 0, [NONE]: 0 });
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
      ['project-b', 'keycloak', 'project-a', NONE],
    );
    // Selected but empty stays reachable, or it could never be unselected.
    const stuck = run({ filter: { priority: ['backlog'] } });
    const priority = stuck.counts.find((c) => c.facet === 'priority')!;
    assert.deepEqual(
      priority.values.find((v) => v.value === 'backlog'),
      { value: 'backlog', count: 0, selected: true },
    );
  } finally {
    cleanup();
  }
});

test('connect=ancestors adds context, never matches', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    const res = run({ filter: { tech: ['kafka'] }, connect: 'ancestors' });
    assert.deepEqual(res.ids, ['kafka-schema']);
    // The chain up to the root comes back separately, so the count stays honest.
    assert.deepEqual([...res.context].sort(), ['project-a', 'project-a-eventing']);
    assert.equal(res.total, 1);
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
  assert.equal(ftsQuery('keyc'), '"keyc"*');
  assert.equal(ftsQuery('kafka sche'), '"kafka" "sche"*');
  // Every FTS5 operator character is stripped rather than passed through.
  assert.equal(ftsQuery('  '), null);
  assert.equal(ftsQuery('"'), null);
  assert.equal(ftsQuery('-'), null);
  assert.equal(ftsQuery('a OR b'), '"a" "OR" "b"*');
  assert.equal(ftsQuery('kc:realm'), '"kc" "realm"*');
  assert.equal(ftsQuery('((((('), null);
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
    assert.deepEqual(res.axis, ['now', 'month']);
    assert.deepEqual(res.lanes, ['planning', 'active']);
    // Every cell exists, in reading order, so an empty one still holds its place.
    assert.deepEqual(
      res.groups!.map((g) => `${g.lane}/${g.value}:${g.ids.length}`),
      ['planning/now:2', 'planning/month:1', 'active/now:2', 'active/month:0'],
    );
    // Each record lands in exactly one cell here, so nothing is double-counted.
    assert.equal(res.placements, res.total);
  } finally {
    cleanup();
  }
});

test('grouping options read the same on either axis', () => {
  const { root, cleanup } = vault();
  try {
    const run = open(root);
    // `showEmpty` and `uncategorised` are properties of grouping, not of boards:
    // they apply to the lane axis exactly as they apply to the column axis.
    const res = run({ groupBy: ['status', 'priority'], showEmpty: true, uncategorised: 'start' });
    // `project-a-eventing` is a node with no facets at all, so both axes have a
    // (none) — leading, because `uncategorised` says so, on either axis.
    assert.deepEqual(res.axis, [NONE, 'planning', 'active', 'done']);
    assert.deepEqual(res.lanes, [NONE, 'now', 'month', 'backlog']);
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
    // `tech` lives on two cards, neither in the project-b project chain.
    const scoped = run({ focus: { id: 'project-b', via: 'member-of', dir: 'down' } });
    assert.ok(scoped.counts.some((c) => c.facet === 'tech')); // kc-realms is in there
    const elsewhere = run({ focus: { id: 'blocker', via: 'blocks', dir: 'down' } });
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
    const scoped = run({ focus: { id: 'project-a', via: 'parent', dir: 'down' } });
    assert.equal(scoped.universe, 3);
    assert.equal(scoped.total, 3);
  } finally {
    cleanup();
  }
});
