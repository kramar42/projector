import type { Facets } from '../schema/types.ts';
import { NONE } from '../schema/vocabulary.ts';
import { applyOrder } from './order.ts';

/**
 * The calendar's page arithmetic, pure and DOM-free.
 *
 * A calendar is the fourth shape (C5): the same query, drawn as days. Nothing
 * here is a new query concept — the notes come from the payload like any shape's,
 * and a drop writes the date facet through the same `bulkMove` a board drop uses.
 * What is genuinely new is *which days are on screen*, and that is this module.
 *
 * Where that state lives is the decision worth writing down. The page, the grid
 * and the week start are **app-owned URL parameters** like `?sel=` and `?note=`
 * — where you are looking, not what you are looking at — and deliberately not
 * spec params. Three things follow, each wanted: turning a page never refetches
 * (the answer cannot have changed), *save current as…* never stores a page that
 * would decay by the time the view is reopened, and no `localStorage` key or
 * view-file key exists (C9 — the URL is the view, and a key nothing reads is not
 * part of it).
 */

/** The first day shown — a YYYY-MM-DD anchor. Absent means the page with today on it. */
export const CAL_PARAM = 'cal';
/** Days per row. 7 is a week and the default; rows then align to `cal.start`. */
export const CAL_COLS_PARAM = 'cal.cols';
/** Rows per page. 1 is a week view, 5 is a month's worth. */
export const CAL_ROWS_PARAM = 'cal.rows';
/** Which weekday starts a row, when the row is a week. */
export const CAL_START_PARAM = 'cal.start';

export const CAL_PARAMS: readonly string[] = [
  CAL_PARAM,
  CAL_COLS_PARAM,
  CAL_ROWS_PARAM,
  CAL_START_PARAM,
];

/** In `Date.getUTCDay` order, so `indexOf` is the day number. */
export const WEEK_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The grid actually drawn: consecutive days, `rows` rows of `cols`. */
export interface CalendarPage {
  /** The first day drawn — the anchor snapped to the week start when rows are weeks. */
  start: string;
  /** The day after the last one drawn, so "on this page" is `start <= d < end`. */
  end: string;
  days: string[][];
  cols: number;
  rows: number;
  weekStart: WeekDay;
}

// ---------------------------------------------------------------- days

/**
 * All arithmetic is UTC over the wire form. A YYYY-MM-DD has no zone, and
 * `bucketOf` and the payload's `today` already treat it that way — going through
 * a local `Date` here would shift a day at exactly the hours a deadline matters.
 */
function utc(iso: string): number {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return iso(utc(day) + n * 86400000);
}

export function isDate(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** `mon`-first by default: an ISO week, and what a work calendar reads as. */
function weekStartOf(raw: string | undefined): WeekDay {
  return (WEEK_DAYS as readonly string[]).includes(raw ?? '') ? (raw as WeekDay) : 'mon';
}

function clamped(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * The page the parameters describe.
 *
 * When a row is a week (`cols` is 7), the anchor snaps *back* to the week start,
 * so `?cal=` can carry any day — today, or wherever a paginate arithmetic landed
 * — and the page is the week around it. Any other width is a plain window of
 * `cols` days from the anchor: there is no week to align to.
 *
 * Bad parameters degrade rather than refuse — a stale bookmark should open, the
 * rule `parseSpec` already follows. An unreadable anchor is today, an unreadable
 * count is the default, and both are capped so `?cal.rows=9999` cannot ask the
 * browser for a hundred thousand drop targets.
 */
export function calendarPage(
  params: Record<string, string | undefined>,
  today: string,
): CalendarPage {
  const cols = clamped(params[CAL_COLS_PARAM], 7, 14);
  const rows = clamped(params[CAL_ROWS_PARAM], 1, 12);
  const weekStart = weekStartOf(params[CAL_START_PARAM]);
  const anchorRaw = params[CAL_PARAM];
  const anchor = isDate(anchorRaw) ? anchorRaw : today;

  let start = anchor;
  if (cols === 7) {
    const back = (new Date(utc(anchor)).getUTCDay() - WEEK_DAYS.indexOf(weekStart) + 7) % 7;
    start = addDays(anchor, -back);
  }

  const days: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) row.push(addDays(start, r * cols + c));
    days.push(row);
  }
  return { start, end: addDays(start, rows * cols), days, cols, rows, weekStart };
}

/** Where `‹` and `›` go: the same window, one page earlier or later. */
export function pagedTo(page: CalendarPage, delta: number): string {
  return addDays(page.start, delta * page.rows * page.cols);
}

// ---------------------------------------------------------------- labels

/** `17`, or `1 Sep` where the month turns, so a rolling grid stays legible. */
export function dayLabel(day: string, first: boolean): string {
  const d = new Date(utc(day));
  const date = d.getUTCDate();
  return first || date === 1 ? `${date} ${MONTHS[d.getUTCMonth()]}` : String(date);
}

/**
 * The page in words: `1 – 7 Sep 2026`, or spelled at both ends when the month or
 * year turns. Hand-rolled rather than `Intl`, so the label — and the test that
 * pins it — does not change with the machine's locale.
 */
export function pageLabel(page: CalendarPage): string {
  const a = new Date(utc(page.start));
  const b = new Date(utc(page.end) - 86400000);
  const tail = `${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  if (a.getUTCFullYear() !== b.getUTCFullYear()) {
    return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()} – ${tail}`;
  }
  if (a.getUTCMonth() !== b.getUTCMonth()) {
    return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${tail}`;
  }
  return `${a.getUTCDate()} – ${tail}`;
}

/** Column headings for a week-wide grid, starting where the page starts. */
export function weekdayLabels(weekStart: WeekDay): string[] {
  const at = WEEK_DAYS.indexOf(weekStart);
  return Array.from({ length: 7 }, (_, i) => WEEK_DAYS[(at + i) % 7]!);
}

// ---------------------------------------------------------------- the axis

/**
 * Which date facet the calendar schedules by: the first `type: date` facet in
 * `show`, else the first one the vault declares.
 *
 * The same shape as `layoutRelation` — the view's `show` order is the control —
 * with one difference earned by the failure mode. A canvas without a reference in
 * `show` draws no edges and still reads as a canvas; a calendar without an axis
 * draws *nothing at all*, so it falls back to the vocabulary rather than making
 * "why is my calendar empty" the answer to a key you forgot. The client naming no
 * facet is preserved (C4): this reads the declared *type*, never a name.
 */
export function dateAxis(facets: Facets, show: string[]): string | undefined {
  const dated = (name: string) => facets[name]?.type === 'date';
  return show.find(dated) ?? Object.keys(facets).find(dated);
}

// ---------------------------------------------------------------- placement

export interface Placements {
  /** day → note ids, in the order the ids arrived (the query's sort). */
  byDay: Map<string, string[]>;
  /** The filter's notes with no value on the axis at all — the side list. */
  unscheduled: string[];
  /** Dated, but not on this page: how many notes are earlier, and later. */
  earlier: number;
  later: number;
}

/**
 * Overlay a saved view's manual arrangement on the calendar projection.
 *
 * A calendar makes its columns from raw dates after the query has run, unlike a
 * board whose groups arrive ordered in the payload. Applying the same rule here
 * means an ISO date is a perfectly ordinary arrangement key, and a note due on
 * two days can be placed independently in each. The incoming placement stays
 * untouched so cursor arithmetic can continue to share its raw input.
 */
export function arrangePlacements(
  placed: Placements,
  order: Record<string, string[]> | undefined,
): Placements {
  return {
    ...placed,
    byDay: new Map(
      [...placed.byDay].map(([day, ids]) => [day, applyOrder(ids, order?.[day])]),
    ),
    unscheduled: applyOrder(placed.unscheduled, order?.[NONE]),
  };
}

/**
 * Every note placed, from the raw values the DTO already carries.
 *
 * Raw, not buckets: `buckets` is how an ordered facet *filters*, and a calendar
 * is the one surface that wants the day itself. A multi-valued date facet places
 * its note once per day, exactly as a board draws it once per column. A value
 * that is not a date (a hand-edited file can hold anything) schedules nothing and
 * does not count as unscheduled either — it is visible in the panel, and guessing
 * a day for it would be inventing data.
 */
export function placements(
  ids: readonly string[],
  valuesOf: (id: string) => readonly string[],
  page: CalendarPage,
): Placements {
  const byDay = new Map<string, string[]>();
  const unscheduled: string[] = [];
  let earlier = 0;
  let later = 0;
  for (const id of ids) {
    const dates = valuesOf(id).filter((v) => isDate(v));
    if (!dates.length) {
      if (!valuesOf(id).length) unscheduled.push(id);
      continue;
    }
    let shown = false;
    for (const day of dates) {
      if (day >= page.start && day < page.end) {
        const cell = byDay.get(day);
        if (cell) cell.push(id);
        else byDay.set(day, [id]);
        shown = true;
      }
    }
    // Counted per note, not per value: "3 earlier" answers "where did my cards
    // go", and one note due twice last month going missing is one note.
    if (!shown) {
      if (dates.every((d) => d < page.start)) earlier++;
      else later++;
    }
  }
  return { byDay, unscheduled, earlier, later };
}
