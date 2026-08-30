import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAL_PARAMS,
  addDays,
  arrangePlacements,
  calendarPage,
  dateAxis,
  dayLabel,
  pageLabel,
  pagedTo,
  placements,
  weekdayLabels,
} from '../src/view/calendar.ts';
import { parseSpec, specToParams, SPEC_PARAMS } from '../src/view/spec.ts';
import { NONE } from '../src/schema/vocabulary.ts';
import { gridOf } from '../src/web/views/motion.ts';
import type { QueryResponse } from '../src/web/types.ts';
import type { Facets } from '../src/schema/types.ts';

// 2026-08-29 is a Saturday; the ISO week around it starts Monday the 24th.
const TODAY = '2026-08-29';

test('the default page is the week around today, monday-first', () => {
  const page = calendarPage({}, TODAY);
  assert.equal(page.start, '2026-08-24');
  assert.equal(page.end, '2026-08-31');
  assert.deepEqual(page.days, [[
    '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
    '2026-08-28', '2026-08-29', '2026-08-30',
  ]]);
  assert.deepEqual(weekdayLabels(page.weekStart), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
});

test('an anchor snaps back to the declared week start only at week width', () => {
  // Sunday-first: the week holding Saturday the 29th starts Sunday the 23rd.
  const sun = calendarPage({ 'cal': TODAY, 'cal.start': 'sun' }, TODAY);
  assert.equal(sun.start, '2026-08-23');
  assert.deepEqual(weekdayLabels('sun')[0], 'sun');

  // An anchor already on the week start stays put.
  assert.equal(calendarPage({ cal: '2026-08-24' }, TODAY).start, '2026-08-24');

  // Any other width is a plain window: there is no week to align to.
  const three = calendarPage({ cal: TODAY, 'cal.cols': '3' }, TODAY);
  assert.equal(three.start, TODAY);
  assert.deepEqual(three.days, [['2026-08-29', '2026-08-30', '2026-08-31']]);
});

test('rows stack consecutive weeks, and paging moves by one whole page', () => {
  const month = calendarPage({ 'cal.rows': '5' }, TODAY);
  assert.equal(month.days.length, 5);
  assert.equal(month.days[0]![0], '2026-08-24');
  assert.equal(month.days[4]![6], '2026-09-27');
  assert.equal(month.end, '2026-09-28');

  // `›` lands where this page ends, `‹` a full page earlier — so a card dragged
  // to the edge of one page is on the face of the next.
  assert.equal(pagedTo(month, 1), '2026-09-28');
  assert.equal(pagedTo(month, -1), '2026-07-20');
  // And the arithmetic crosses a month boundary without snapping drift: paging
  // forward from the result comes back to the same start.
  const next = calendarPage({ cal: pagedTo(month, 1), 'cal.rows': '5' }, TODAY);
  assert.equal(pagedTo(next, -1), month.start);
});

test('bad parameters degrade to the defaults rather than refusing', () => {
  // A stale bookmark opens — parseSpec's rule, held here too.
  const page = calendarPage(
    { cal: 'someday', 'cal.cols': 'wide', 'cal.rows': '-3', 'cal.start': 'caturday' },
    TODAY,
  );
  assert.equal(page.cols, 7);
  assert.equal(page.rows, 1);
  assert.equal(page.weekStart, 'mon');
  assert.equal(page.start, '2026-08-24', 'the anchor fell back to today');
  // And a hostile count is capped rather than honoured.
  assert.equal(calendarPage({ 'cal.rows': '9999' }, TODAY).rows, 12);
  assert.equal(calendarPage({ 'cal.cols': '9999' }, TODAY).cols, 14);
});

test('day arithmetic is UTC over the wire form, so no hour shifts a date', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  // The leap rule's three clauses, cheap to hold: 2028 leaps, 2100 does not.
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2100-02-28', 1), '2100-03-01');
});

test('labels stay legible where the month or the year turns', () => {
  const week = calendarPage({}, TODAY);
  assert.equal(pageLabel(week), '24 – 30 Aug 2026');
  assert.equal(pageLabel(calendarPage({ 'cal.rows': '2' }, TODAY)), '24 Aug – 6 Sep 2026');
  assert.equal(
    pageLabel(calendarPage({ cal: '2026-12-28', 'cal.rows': '2' }, TODAY)),
    '28 Dec 2026 – 10 Jan 2027',
  );
  // A cell says only its day, except where saying only the day would lie about
  // which month it is in.
  assert.equal(dayLabel('2026-08-24', true), '24 Aug');
  assert.equal(dayLabel('2026-08-25', false), '25');
  assert.equal(dayLabel('2026-09-01', false), '1 Sep');
});

const def = (type: 'label' | 'ref' | 'date') => ({
  label: type,
  type,
  values: [],
  open: true,
  single: false,
});

test('the calendar schedules by the first date facet in show, else the vault’s first', () => {
  const facets = { priority: def('label'), due: def('date'), review: def('date') } as unknown as Facets;
  // `show` order is the control, exactly as it is for a canvas's layout relation.
  assert.equal(dateAxis(facets, ['priority', 'review', 'due']), 'review');
  // Unlike a canvas, an empty `show` falls back to the vocabulary: a calendar
  // without an axis draws nothing at all, which is a worse failure than a
  // canvas without edges.
  assert.equal(dateAxis(facets, []), 'due');
  assert.equal(dateAxis({ priority: def('label') } as unknown as Facets, []), undefined);
});

test('placement splits the filter’s notes into days, the side list, and off-page counts', () => {
  const page = calendarPage({}, TODAY); // 24–30 Aug
  const values: Record<string, string[]> = {
    'on-monday': ['2026-08-24'],
    'also-monday': ['2026-08-24'],
    'twice-dated': ['2026-08-25', '2026-08-30'],
    'unscheduled': [],
    'last-month': ['2026-07-01'],
    'next-month': ['2026-10-01'],
    'split-off-page': ['2026-07-01', '2026-10-01'],
    'off-and-on': ['2026-07-01', '2026-08-26'],
    'not-a-date': ['friday'],
  };
  const ids = Object.keys(values);
  const placed = placements(ids, (id) => values[id] ?? [], page);

  // Order within a day is arrival order — the query's sort, untouched.
  assert.deepEqual(placed.byDay.get('2026-08-24'), ['on-monday', 'also-monday']);
  // A multi-valued date facet places its note once per day, as a board draws a
  // multi-valued facet once per column.
  assert.deepEqual(placed.byDay.get('2026-08-25'), ['twice-dated']);
  assert.deepEqual(placed.byDay.get('2026-08-30'), ['twice-dated']);
  // A note dated off the page and on it is simply on it.
  assert.deepEqual(placed.byDay.get('2026-08-26'), ['off-and-on']);

  // The side list is "no value at all" — the ordinary (none) refinement. A value
  // that is not a date schedules nothing and is not unscheduled either.
  assert.deepEqual(placed.unscheduled, ['unscheduled']);

  // Counted per note: where did my cards go, not how many values are elsewhere.
  assert.equal(placed.earlier, 1, 'last-month');
  assert.equal(placed.later, 2, 'next-month, and split-off-page counts once');
});

test('a saved calendar order is keyed by raw day, including a note placed twice', () => {
  const page = calendarPage({}, TODAY); // 24–30 Aug
  const values: Record<string, string[]> = {
    a: ['2026-08-24'],
    b: ['2026-08-24', '2026-08-26'],
    c: ['2026-08-24', '2026-08-26'],
    loose: [],
  };
  const raw = placements(['a', 'b', 'c', 'loose'], (id) => values[id] ?? [], page);
  const arranged = arrangePlacements(raw, {
    '2026-08-24': ['c', 'a'],
    '2026-08-26': ['b'],
    [NONE]: ['loose'],
  });

  assert.deepEqual(arranged.byDay.get('2026-08-24'), ['c', 'a', 'b']);
  assert.deepEqual(arranged.byDay.get('2026-08-26'), ['b', 'c']);
  assert.deepEqual(arranged.unscheduled, ['loose']);
  // Ordering is an overlay, not a mutation of the date projection cursor
  // arithmetic shares with the view.
  assert.deepEqual(raw.byDay.get('2026-08-24'), ['a', 'b', 'c']);
});

test('the cursor grid is one lane of the page’s days, the rail last, from the same arithmetic', () => {
  const facets = { due: def('date') } as unknown as Facets;
  const note = (due: string[]) => ({ facets: due.length ? { due } : {} });
  const data = {
    spec: { shape: 'calendar', show: [], query: { filter: {} } },
    ids: ['a', 'b', 'loose'],
    notes: { a: note(['2026-08-24']), b: note(['2026-08-24', '2026-08-26']), loose: note([]) },
  } as unknown as QueryResponse;

  const grid = gridOf(data, { search: '?shape=calendar', facets, today: TODAY });
  assert.equal(grid.cells.length, 1, 'one lane — the drawn rows are layout, not lanes');
  assert.equal(grid.columns.length, 8, 'seven days and the unscheduled rail');
  assert.equal(grid.columns[0], '2026-08-24');
  assert.equal(grid.columns[7], NONE, 'the rail is the last column, so `l` reaches it');
  // A note due twice on the page is two placements, exactly as the view draws it.
  assert.deepEqual(grid.cells[0]![0], ['a', 'b']);
  assert.deepEqual(grid.cells[0]![2], ['b']);
  assert.deepEqual(grid.cells[0]![7], ['loose']);
  assert.equal(grid.continuous, false, 'a day is a column with a visible end, the board’s rule');

  // The page param moves the grid with the screen — same URL the view reads.
  const paged = gridOf(data, { search: '?cal=2026-08-31', facets, today: TODAY });
  assert.equal(paged.columns[0], '2026-08-31');
  assert.deepEqual(paged.cells[0]!.slice(0, 7).flat(), [], 'the dated notes are off this page');

  // No date facet, no grid: the walk must not cross a screen that draws no cells.
  const bare = gridOf(data, { search: '', facets: {} as Facets, today: TODAY });
  assert.equal(bare.columns.length, 0);
});

test('calendar is a shape the wire carries, and its page params are not query params', () => {
  // Through the URL: a live control like any shape.
  const spec = parseSpec({ shape: 'calendar' });
  assert.equal(spec.shape, 'calendar');
  assert.equal(specToParams(spec).shape, 'calendar');

  // The page and grid ride beside the query, like `?sel=`: a saved view must
  // not store a date that decays, and turning a page must not refetch. If one
  // of these ever joins SPEC_PARAMS, that is a decision, not a drift.
  for (const p of CAL_PARAMS) {
    assert.ok(!(SPEC_PARAMS as readonly string[]).includes(p), `${p} must stay out of the spec`);
  }
});
