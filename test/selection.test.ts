import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ranged, toggled, visibleSelection } from '../src/web/selection.ts';

/**
 * What a selection gesture means.
 *
 * Selection lived as a `useState` inside `BoardView`, so the transform had no
 * name and no test, and the other two shapes had no selection at all. The set
 * transform is the interesting part and it needs no DOM — the same split that
 * makes `dropOutcome` testable.
 */

const set = (...ids: string[]) => new Set(ids);
const sorted = (s: ReadonlySet<string>) => [...s].sort();

// ---------------------------------------------------------------- toggled

test('cmd-click adds, and adds again to take away', () => {
  assert.deepEqual(sorted(toggled(set('a'), 'b', true)), ['a', 'b']);
  assert.deepEqual(sorted(toggled(set('a', 'b'), 'b', true)), ['a']);
});

test('a plain click replaces, so it means "just this one"', () => {
  // Not additive: whatever was selected is gone, which is what makes a plain
  // click on an unselected card mean one card rather than thirteen.
  assert.deepEqual(sorted(toggled(set('a', 'b'), 'c', false)), ['c']);
  // And a plain click on the only selected card still lands on it, rather than
  // clearing to nothing — the caller decides whether a plain click even reaches
  // here, and a board only sends one for a card already selected.
  assert.deepEqual(sorted(toggled(set('a'), 'a', false)), ['a']);
});

test('toggling never mutates the set it was given', () => {
  const before = set('a');
  toggled(before, 'b', true);
  assert.deepEqual(sorted(before), ['a'], 'React state is compared by identity');
});

// ---------------------------------------------------------------- ranged

const ROWS = ['a', 'b', 'c', 'd', 'e'];

test('shift-click selects the run between the anchor and the click', () => {
  assert.deepEqual(sorted(ranged(new Set(), ROWS, 1, 3)), ['b', 'c', 'd']);
});

test('a run reads the same in either direction', () => {
  assert.deepEqual(sorted(ranged(new Set(), ROWS, 3, 1)), sorted(ranged(new Set(), ROWS, 1, 3)));
});

test('a run adds to what was selected, so several can be collected', () => {
  assert.deepEqual(sorted(ranged(set('e'), ROWS, 0, 1)), ['a', 'b', 'e']);
});

test('anchor and click on the same row is that one row', () => {
  assert.deepEqual(sorted(ranged(new Set(), ROWS, 2, 2)), ['c']);
});

/**
 * A card whose grouped facet holds several values is drawn once per matching
 * section, so the same id appears at two indices. This is why `ranged` takes an
 * index and the drawn rows rather than an id: `indexOf` would have measured to
 * the first row every time, and a range ending on the second occurrence would
 * have run the wrong way or collapsed.
 */
test('a repeated card is a row twice, and a range can end on either', () => {
  const rows = ['a', 'dup', 'b', 'dup', 'c'];
  assert.deepEqual(sorted(ranged(new Set(), rows, 3, 4)), ['c', 'dup'], 'the second occurrence');
  assert.deepEqual(sorted(ranged(new Set(), rows, 0, 1)), ['a', 'dup'], 'the first');
  // Measured from the second occurrence back to the start, the run covers
  // everything between — which an id-based range could not express at all.
  assert.deepEqual(sorted(ranged(new Set(), rows, 0, 3)), ['a', 'b', 'dup']);
});

test('a shift-click with no anchor is just that row', () => {
  // The first click of a session, or an anchor whose row left the result set:
  // the gesture degrades to its obvious smaller meaning rather than doing nothing.
  assert.deepEqual(sorted(ranged(set('x'), ROWS, null, 2)), ['c', 'x']);
  assert.deepEqual(sorted(ranged(new Set(), ROWS, 99, 2)), ['c'], 'anchor past the rows');
});

test('a shift-click on a row that is not there changes nothing', () => {
  assert.deepEqual(sorted(ranged(set('a'), ROWS, 1, 99)), ['a']);
});

// ---------------------------------------------------------------- visibleSelection

/**
 * The URL keeps the whole selection so that switching to a shape which filters
 * some of it out and back again restores it. What the bulk bar counts and writes
 * is the part on screen: "3 selected" has to mean three you can see, and a bulk
 * write must not reach a record the query never returned.
 */
test('the bar acts on the part of the selection this shape draws', () => {
  const drawn = ['a', 'b', 'c'];
  assert.deepEqual(visibleSelection(set('a', 'c'), drawn), ['a', 'c']);
  // `d` was picked on another shape and is remembered by the URL, not written to.
  assert.deepEqual(visibleSelection(set('a', 'd'), drawn), ['a']);
  assert.deepEqual(visibleSelection(set('d', 'e'), drawn), [], 'none of it is here');
  assert.deepEqual(visibleSelection(new Set(), drawn), []);
});

test('it reads in the shape\'s order, not the selection\'s', () => {
  // The bar's ids follow what is on screen, so a delete confirm lists them the
  // way they are drawn rather than the way they were clicked.
  assert.deepEqual(visibleSelection(set('c', 'a', 'b'), ['a', 'b', 'c']), ['a', 'b', 'c']);
});
