import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFacets, } from '../src/schema/facets.ts';
import { NONE } from '../src/schema/vocabulary.ts';
import {
  connectOutcome,
  dropOutcome,
  modeFor,
  nextValues,
  type DragMode,
} from '../src/view/dropOutcome.ts';


/**
 * What a drag means — the modifier convention, the value transform, and the drop intent.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

// ---------------------------------------------------------------- drag semantics


/** A facets.yaml in a temp dir, so a test can declare the vocabulary it needs. */
function facetsFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'projector-facets-'));
  const f = join(dir, 'facets.yaml');
  writeFileSync(f, body, 'utf8');
  return f;
}

test('a plain drop replaces the value it came from', () => {
  assert.deepEqual(nextValues(['now'], 'now', 'month', 'replace'), ['month']);
});

test('⌥ drop adds, so a card sits in two columns deliberately', () => {
  assert.deepEqual(nextValues(['now'], 'now', 'month', 'add'), ['now', 'month']);
});

test('⌥ drop on a column the card is already in changes nothing', () => {
  assert.deepEqual(nextValues(['now', 'month'], 'now', 'month', 'add'), ['now', 'month']);
});

test('⇧ drag removes only the value dragged from', () => {
  assert.deepEqual(nextValues(['now', 'month'], 'now', 'backlog', 'remove'), ['month']);
});

test('a replace never leaves a duplicate behind', () => {
  assert.deepEqual(nextValues(['now', 'month'], 'now', 'month', 'replace'), ['month']);
});

test('dropping into uncategorised clears a card that had one value there', () => {
  assert.deepEqual(nextValues(['now'], 'now', NONE, 'replace'), []);
});

/**
 * The multi-valued half of the same drop, pinned because it is under review.
 *
 * A card in two columns keeps its other value, so it never actually lands in
 * `(none)` — which makes a plain drop there return exactly what `⇧` returns, and
 * those two gestures are documented as different. The alternative is clearing the
 * whole axis; `bulkMove` applies `nextValues` once per `AxisMove`, so that would
 * also mean a diagonal drop into a `(none)` column and a `(none)` lane clears both
 * axes at once.
 *
 * Neither answer is obviously right, and the one in place has never been used in
 * anger. This test exists so that choosing the other one is an edit somebody makes
 * on purpose, rather than something that shifts under a refactor.
 */
test('dropping into uncategorised leaves a multi-valued card in its other columns', () => {
  assert.deepEqual(nextValues(['now', 'month'], 'now', NONE, 'replace'), ['month']);
  assert.deepEqual(nextValues(['now', 'month', 'backlog'], 'now', NONE, 'replace'), ['month', 'backlog']);
  // The consequence worth seeing spelled out: for such a card, plain == ⇧.
  assert.deepEqual(
    nextValues(['now', 'month'], 'now', NONE, 'replace'),
    nextValues(['now', 'month'], 'now', NONE, 'remove'),
  );
});

test('dragging out of uncategorised just adds the target value', () => {
  assert.deepEqual(nextValues([], NONE, 'now', 'replace'), ['now']);
});

test('⌥ into uncategorised is a no-op rather than an empty-string value', () => {
  assert.deepEqual(nextValues(['now'], 'now', NONE, 'add'), ['now']);
});

test('modifier keys map to modes, shift winning over alt', () => {
  assert.equal(modeFor({}), 'replace');
  assert.equal(modeFor({ altKey: true }), 'add');
  assert.equal(modeFor({ shiftKey: true }), 'remove');
  assert.equal(modeFor({ shiftKey: true, altKey: true }), 'remove');
});


test('a drop means the same thing however many cards are selected', () => {
  const both = ['now', 'month'];
  const cases: [string, string, DragMode, string[]][] = [
    ['now', 'month', 'remove', ['month']],
    ['now', 'backlog', 'replace', ['month', 'backlog']],
    ['now', NONE, 'replace', ['month']],
    ['now', 'month', 'add', both],
  ];
  for (const [from, to, mode, want] of cases) {
    const intent = dropOutcome({
      cardId: 'a',
      from,
      fromLane: '',
      to,
      toLane: null,
      onCard: null,
      groupBy: 'priority',
      laneBy: '',
      mode,
      selected: new Set(['a', 'b', 'c']),
      order: [],
      viewName: 'home',
    });
    assert.equal(intent.kind, 'facet');
    assert.ok(intent.kind === 'facet');
    // The endpoints travel, never the values — which is what makes one card and
    // twelve the same request.
    assert.deepEqual(intent.moves, [{ facet: 'priority', from, to }]);
    assert.equal(intent.mode, mode);
    assert.deepEqual(intent.ids, ['a', 'b', 'c'], 'a selected card drags the selection');
    // And every one of them resolves through the same transform.
    const move = intent.moves[0]!;
    for (const id of intent.ids) {
      assert.deepEqual(nextValues(both, move.from, move.to, intent.mode), want, `${id}: ${mode}`);
    }
  }
});

test('dragging an unselected card moves only that card', () => {
  const intent = dropOutcome({
    cardId: 'z',
    from: 'now',
    fromLane: '',
    to: 'month',
    toLane: null,
    onCard: null,
    groupBy: 'priority',
    laneBy: '',
    mode: 'replace',
    selected: new Set(['a', 'b']),
    order: [],
    viewName: 'home',
  });
  assert.ok(intent.kind === 'facet');
  assert.deepEqual(intent.ids, ['z']);
});

/**
 * A reorder splices into the column's stored order, and the index it is given has
 * to be an index into that same list. It used to be the position within one
 * lane's cell, which is a subset of the column once a secondary axis is in play —
 * so a matrix reorder wrote the card somewhere else. With no lanes the two
 * coincide, which is why it went unnoticed.
 */
test('a reorder lands where the pointer aimed, across lanes', () => {
  const order = ['a', 'b', 'c', 'd'];
  const at = (index: number, below: boolean) => {
    const intent = dropOutcome({
      cardId: 'd',
      from: 'now',
      fromLane: '',
      to: 'now',
      toLane: null,
      onCard: { id: order[index]!, index, below },
      groupBy: 'priority',
      laneBy: '',
      mode: 'replace',
      selected: new Set(),
      order,
      viewName: 'home',
    });
    assert.ok(intent.kind === 'reorder');
    return intent.ids;
  };
  assert.deepEqual(at(0, false), ['d', 'a', 'b', 'c'], 'above the first');
  assert.deepEqual(at(0, true), ['a', 'd', 'b', 'c'], 'below the first');
  assert.deepEqual(at(1, true), ['a', 'b', 'd', 'c'], 'below the second');
});

/**
 * The second grouping axis was a row label and nothing else.
 *
 * A drop wrote `groupBy` and only `groupBy`, so on `group=status,priority` —
 * status across, priority down — dragging a card into the `now` swimlane did
 * nothing at all. Landing it on a tile was worse than nothing: same column, so
 * the drop read as a reorder and wrote the view's arrangement file, which cannot
 * show, because order is per column and does not cross a lane.
 *
 * Both are grouping positions, so both are writable. The reorder branch is now
 * reachable only when neither axis was crossed.
 */
const matrix = {
  onCard: null,
  groupBy: 'status',
  laneBy: 'priority',
  mode: 'replace' as DragMode,
  selected: new Set<string>(),
  order: ['a', 'b'],
  viewName: 'home',
};

test('a drag into another swimlane writes the second axis', () => {
  const intent = dropOutcome({
    ...matrix,
    cardId: 'a',
    from: 'active',
    fromLane: 'someday',
    to: 'active',
    toLane: 'now',
  });
  assert.ok(intent.kind === 'facet');
  assert.deepEqual(intent.moves, [{ facet: 'priority', from: 'someday', to: 'now' }]);
});

test('a swimlane drop onto a tile moves the card instead of writing a phantom order', () => {
  const intent = dropOutcome({
    ...matrix,
    cardId: 'a',
    from: 'active',
    fromLane: 'someday',
    to: 'active',
    // The pointer is over a tile — which used to be the whole test for "reorder".
    onCard: { id: 'b', index: 1, below: true },
    toLane: 'now',
  });
  assert.ok(intent.kind === 'facet', 'a crossed lane is a move, not an order');
  assert.deepEqual(intent.moves, [{ facet: 'priority', from: 'someday', to: 'now' }]);
});

test('a diagonal drag names both axes and stays one intent', () => {
  const intent = dropOutcome({
    ...matrix,
    cardId: 'a',
    from: 'planning',
    fromLane: 'someday',
    to: 'active',
    toLane: 'now',
  });
  assert.ok(intent.kind === 'facet');
  // One intent, so one request and one write per note — never a status write that
  // lands and a priority write that is refused.
  assert.deepEqual(intent.moves, [
    { facet: 'status', from: 'planning', to: 'active' },
    { facet: 'priority', from: 'someday', to: 'now' },
  ]);
});

test('within one cell of a matrix a drag is still an order', () => {
  const intent = dropOutcome({
    ...matrix,
    cardId: 'd',
    from: 'active',
    fromLane: 'now',
    to: 'active',
    toLane: 'now',
    onCard: { id: 'a', index: 0, below: false },
    order: ['a', 'b', 'c', 'd'],
  });
  assert.ok(intent.kind === 'reorder');
  assert.deepEqual(intent.ids, ['d', 'a', 'b', 'c']);
});

test('a lane the board does not have is not a move', () => {
  // One axis: `toLane` is null on every column, so nothing can cross a lane and
  // the same-column drop falls through to the order branch as it always did.
  const intent = dropOutcome({
    ...matrix,
    laneBy: '',
    cardId: 'a',
    from: 'active',
    fromLane: '',
    to: 'active',
    toLane: null,
  });
  assert.deepEqual(intent, { kind: 'none', why: 'dropped where it already was' });
});

test('a drop with nowhere to put an order says so instead of vanishing', () => {
  const intent = dropOutcome({
    cardId: 'a',
    from: 'now',
    fromLane: '',
    to: 'now',
    toLane: null,
    onCard: { id: 'b', index: 1, below: false },
    groupBy: 'priority',
    laneBy: '',
    mode: 'replace',
    selected: new Set(),
    order: ['a', 'b'],
    viewName: undefined,
  });
  assert.deepEqual(intent, {
    kind: 'none',
    why: 'order has nowhere to live without a saved view',
  });
});

/** A single-valued relation moves rather than stacking; a multi-valued one adds. */
test('connecting two nodes moves a hierarchy edge and adds an ordinary one', () => {
  const facets = loadFacets(
    facetsFile('parent: { type: ref, single: true }\nblocks: { type: ref }\n'),
  );
  const valuesOf = (id: string) => (id === 'child' ? ['oldparent'] : []);

  // `parent` is the layout relation and single: dragging parent→child writes the
  // child, taking the parent it already had off.
  const up = connectOutcome({
    source: 'newparent',
    target: 'child',
    relation: 'parent',
    facets,
    layout: 'parent',
    valuesOf,
  });
  assert.ok(up.kind === 'facet');
  assert.deepEqual(up.ids, ['child']);
  const upMove = up.moves[0]!;
  assert.deepEqual(nextValues(['oldparent'], upMove.from, upMove.to, up.mode), ['newparent']);

  // `blocks` is multi-valued: the source owns it and the value is added.
  const across = connectOutcome({
    source: 'a',
    target: 'b',
    relation: 'blocks',
    facets,
    layout: 'parent',
    valuesOf: () => ['c'],
  });
  assert.ok(across.kind === 'facet');
  assert.deepEqual(across.ids, ['a']);
  const acrossMove = across.moves[0]!;
  assert.deepEqual(nextValues(['c'], acrossMove.from, acrossMove.to, across.mode), ['c', 'b']);

  // A relation that is not a reference facet cannot be drawn, so nothing happens.
  const bogus = connectOutcome({
    source: 'a',
    target: 'b',
    relation: 'priority',
    facets,
    layout: null,
    valuesOf: () => [],
  });
  assert.equal(bogus.kind, 'none');
});

/**
 * The self-blocking note that read `clear` on the axis while its own DTO said it
 * blocked itself, ten times over — the SQL closure applied neither of the two
 * rules `refsOf` applies, and was depth-capped at 10.
 */
