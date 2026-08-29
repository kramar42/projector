import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { ApiError, api } from '../api.ts';
import { CardBody } from '../components/CardBody.tsx';
import { Button, IconButton } from '../components/Button.tsx';
import { emptyReason } from '../../view/empty.ts';
import { NONE } from '../../schema/vocabulary.ts';
import { dropOutcome, modeFor, type FacetIntent } from '../../view/dropOutcome.ts';
import {
  CAL_COLS_PARAM,
  CAL_PARAM,
  CAL_ROWS_PARAM,
  CAL_START_PARAM,
  WEEK_DAYS,
  calendarPage,
  dateAxis,
  dayLabel,
  pageLabel,
  pagedTo,
  placements,
  weekdayLabels,
  type WeekDay,
} from '../../view/calendar.ts';
import { useRequestEnrichment } from '../enrichment.tsx';
import { BulkBar } from '../components/BulkBar.tsx';
import { visibleSelection, type Selection } from '../selection.ts';
import { useCursorFocus } from '../cursor.ts';
import { isCursorAt, type Spot } from './motion.ts';
import { paramsOf, type Patch } from '../query.ts';
import type { Meta, NoteDTO, QueryResponse } from '../types.ts';

/**
 * Days as cells, from the same payload every shape draws (C5).
 *
 * The query decides which notes exist here — filter, search, focus, sort all
 * mean what they mean everywhere — and the *page* decides which of their days
 * are on screen. The page is not part of the query on purpose: it lives in
 * app-owned URL params (`view/calendar.ts` has the argument), so `‹` and `›`
 * re-render without asking the server a question whose answer cannot have
 * changed.
 *
 * Grouping is the one control this shape does not draw. A calendar's columns
 * *are* an axis — the date facet's days — so `group by` has nothing to add
 * that would not be a second grid; the rail keeps the control live and the
 * other shapes honour it, the way a canvas keeps a second grouping axis it
 * cannot draw.
 *
 * A drop writes the date facet through the same intent pipeline as a board
 * drop: `dropOutcome` with the day as the column value, `(none)` for the
 * unscheduled rail, `POST /api/bulk` move at the end. Storage stays a raw
 * date, so the board's `due` buckets go on grouping exactly as before.
 */
export function CalendarView({
  meta,
  data,
  onOpen,
  selection,
  cursor,
  cursorSpot,
  onCursor,
  newIn,
  onNewHandled,
  search,
  patch,
  reload,
}: {
  meta: Meta;
  data: QueryResponse;
  onOpen: (id: string) => void;
  /** Owned by `App` and carried in `?sel=`, so it survives a change of shape. */
  selection: Selection;
  /** Where the keyboard is — drawn here, stepped by `motion.ts` (the board's split). */
  cursor: string | null;
  /**
   * Which *placement* the cursor is at. A note due twice on one page is two
   * tiles and one cursor, and this is which of the two.
   */
  cursorSpot: Spot | null;
  /** A pointer landing somewhere is the keyboard landing there too. */
  onCursor: (id: string) => void;
  /**
   * The day `n` asked to create in — an ISO date, or `(none)` for the rail.
   * A value rather than a boolean, the board's reasoning: the shell knows the
   * cursor's column and this shape knows which cell that is on screen.
   */
  newIn: string | null;
  onNewHandled: () => void;
  /** The page's own query string — the page and grid params are read off it. */
  search: string;
  /** Write URL params. The calendar owns `cal`/`cal.*` the way `?sel=` is owned. */
  patch: (p: Patch, replace?: boolean) => void;
  reload: () => void;
}) {
  const selected = selection.ids;
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // The client's `today` and the server's can disagree across midnight by
  // design: both read the UTC date, the same clock the buckets use.
  const today = new Date().toISOString().slice(0, 10);
  const params = useMemo(() => Object.fromEntries(paramsOf(search)), [search]);
  const page = useMemo(() => calendarPage(params, today), [params, today]);

  /**
   * The axis a drop writes: the first date facet in `show`, else the vault's
   * first. Read off the declared *type*, so no facet is named here (C4).
   */
  const axis = dateAxis(meta.facets, data.spec.show);
  const cards = data.notes;

  useRequestEnrichment([
    ...new Set(Object.values(cards).flatMap((c) => c.links.map((l) => l.raw))),
  ]);

  // The same two pure calls `gridOf` makes over the same inputs, which is what
  // keeps the cursor's walk and this drawing pointed at one screen.
  const placed = useMemo(
    () => placements(data.ids, (id) => (axis ? cards[id]?.facets[axis] ?? [] : []), page),
    [data.ids, cards, axis, page],
  );

  const move = useCallback(
    async (intent: FacetIntent) => {
      setProblem(null);
      try {
        await api.bulk({ ids: intent.ids, op: 'move', moves: intent.moves, dragMode: intent.mode });
        reload();
      } catch (err) {
        setProblem((err as ApiError).message);
      }
    },
    [reload],
  );

  // One monitor, the board's shape: read the pointer, ask `dropOutcome`, obey.
  // No lanes, no card-on-card order — a day's order is the query's sort.
  useEffect(() => {
    if (!axis) return;
    return monitorForElements({
      onDragStart: ({ source }) => setDragging(String(source.data.cardId ?? '')),
      onDrop: ({ source, location }) => {
        setDragging(null);
        const target = location.current.dropTargets.find((t) => t.data.column !== undefined);
        const intent = dropOutcome({
          cardId: String(source.data.cardId ?? ''),
          from: String(source.data.column ?? ''),
          fromLane: '',
          to: target ? String(target.data.column ?? '') : null,
          toLane: null,
          onCard: null,
          groupBy: axis,
          laneBy: undefined,
          mode: modeFor(location.current.input),
          selected,
          order: [],
          viewName: undefined,
        });
        if (intent.kind === 'facet') void move(intent);
      },
    });
  }, [axis, selected, move]);

  /** Page and grid edits. Defaults are removed rather than written, so a URL says only what differs. */
  const goTo = (day: string | null) => patch({ [CAL_PARAM]: day });
  const setGrid = (key: string, value: string, fallback: string) =>
    patch({ [key]: value === fallback ? null : value }, true);

  const acting = visibleSelection(selected, data.ids);
  const empty = data.total === 0 ? emptyReason(meta, data) : null;
  const offPage = [
    placed.earlier ? `${placed.earlier} earlier` : '',
    placed.later ? `${placed.later} later` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  if (!axis) {
    // Not an empty result — a vocabulary without a day to draw. Said outright,
    // the way an unused grouping axis is, rather than as a blank grid.
    return (
      <div className="calendar-wrap">
        <div className="emptystate calendar-empty">
          a calendar draws a <b>date</b> facet, and this vault declares none — add one
          (<code>type: date</code>) in facets.yaml
        </div>
      </div>
    );
  }

  const days = page.days.flat();
  const shared = {
    axis,
    cards,
    chips: data.spec.show,
    selected,
    dragging,
    cursor,
    cursorSpot,
    onCursor,
    onNewHandled,
    onSelect: selection.toggle,
    onOpen,
    onCreated: reload,
    onProblem: setProblem,
  };

  return (
    <div className="calendar-wrap">
      {problem && <div className="banner is-bad">{problem}</div>}

      <div className="calendar-head">
        <div className="calendar-nav">
          <Button tone="ghost" size="tiny" title="previous page" aria-label="previous page" onClick={() => goTo(pagedTo(page, -1))}>
            ‹
          </Button>
          <Button tone="ghost" size="tiny" title="the page with today on it" onClick={() => goTo(null)}>
            today
          </Button>
          <Button tone="ghost" size="tiny" title="next page" aria-label="next page" onClick={() => goTo(pagedTo(page, 1))}>
            ›
          </Button>
          <span className="calendar-range">{pageLabel(page)}</span>
          {offPage && (
            <span className="calendar-offpage" title="matches the filter, dated off this page">
              {offPage}
            </span>
          )}
        </div>
        {/* Floats with the shape, the canvas's rule: only a calendar can honour these. */}
        <div className="calendar-config">
          <label className="calendar-config-item">
            days
            <select
              className="rail-select"
              value={String(page.cols)}
              onChange={(e) => setGrid(CAL_COLS_PARAM, e.target.value, '7')}
            >
              {Array.from({ length: 14 }, (_, i) => String(i + 1)).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="calendar-config-item">
            rows
            <select
              className="rail-select"
              value={String(page.rows)}
              onChange={(e) => setGrid(CAL_ROWS_PARAM, e.target.value, '1')}
            >
              {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="calendar-config-item">
            starts
            <select
              className="rail-select"
              value={page.weekStart}
              // Only meaningful at week width; kept live anyway, so setting it
              // before widening back to 7 columns is not a dead control.
              onChange={(e) => setGrid(CAL_START_PARAM, e.target.value as WeekDay, 'mon')}
            >
              {WEEK_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {empty && <div className="emptystate calendar-empty">{empty.text}</div>}

      <div className="calendar-main">
        <div
          className={`calendar-grid ${page.cols === 7 ? 'has-dow' : ''}`}
          style={{ ['--cal-cols' as string]: page.cols, ['--cal-rows' as string]: page.rows }}
        >
          {page.cols === 7 &&
            weekdayLabels(page.weekStart).map((d) => (
              <div key={d} className="calendar-dow">
                {d}
              </div>
            ))}
          {days.map((day, i) => (
            <DayColumn
              key={day}
              day={day}
              label={dayLabel(day, i === 0)}
              isToday={day === today}
              // Where this cell sits in the grid `motion.ts` walks: one lane,
              // the page's days in reading order, the rail last. The indices
              // line up because `gridOf` builds them from the same calls.
              columnIndex={i}
              ids={placed.byDay.get(day) ?? []}
              startAdding={newIn === day}
              {...shared}
            />
          ))}
        </div>

        {/*
          * The side list: the filter's notes with no value on the axis. A drop
          * target like any day — landing here is `(none)`, which clears the
          * value the card was dragged from, the board's own `(none)` rule —
          * and creating here is a card born unscheduled.
          */}
        <DayColumn
          day={NONE}
          label="unscheduled"
          isToday={false}
          columnIndex={days.length}
          ids={placed.unscheduled}
          startAdding={newIn === NONE}
          {...shared}
        />
      </div>

      {acting.length > 0 && (
        <BulkBar
          ids={acting}
          notes={data.notes}
          counts={data.counts}
          onDone={() => {
            selection.clear();
            reload();
          }}
          onClear={selection.clear}
          onProblem={setProblem}
        />
      )}
    </div>
  );
}

/**
 * One column of the calendar: a day cell, or — as the `(none)` value — the
 * unscheduled rail. One component because they differ only in dress and in
 * whether a created card carries a date; the drop target, the creator, the
 * cursor arithmetic and the tiles are the same thing in both.
 */
function DayColumn({
  day,
  label,
  isToday,
  columnIndex,
  ids,
  axis,
  cards,
  chips,
  selected,
  dragging,
  cursor,
  cursorSpot,
  onCursor,
  startAdding,
  onNewHandled,
  onSelect,
  onOpen,
  onCreated,
  onProblem,
}: {
  /** The ISO day this column is, or `(none)` for the rail. */
  day: string;
  label: string;
  isToday: boolean;
  /** This column's position in the one-lane grid `gridOf` builds. */
  columnIndex: number;
  ids: string[];
  axis: string;
  cards: Record<string, NoteDTO>;
  chips: string[];
  selected: ReadonlySet<string>;
  dragging: string | null;
  cursor: string | null;
  cursorSpot: Spot | null;
  onCursor: (id: string) => void;
  /** `n` named this column. */
  startAdding: boolean;
  onNewHandled: () => void;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
  onCreated: () => void;
  onProblem: (msg: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const rail = day === NONE;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ column: day }),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
  }, [day]);

  // `n` reached this column. Cleared immediately, the board's one-shot rule.
  useEffect(() => {
    if (!startAdding) return;
    setAdding(true);
    onNewHandled();
  }, [startAdding, onNewHandled]);

  const create = () => {
    const t = title.trim();
    setAdding(false);
    if (!t) return;
    setTitle('');
    // A card created in a day is born due that day — the board's rule, with the
    // date facet as the axis. The rail's card is born unscheduled (C10: creating
    // is the one write outside the panel that is not a gesture).
    api
      .createNote({ title: t, facets: rail ? {} : { [axis]: [day] } })
      .then(onCreated)
      .catch((e: ApiError) => onProblem(e.message));
  };

  const Tag = rail ? 'aside' : 'section';
  return (
    <Tag
      ref={ref as React.Ref<HTMLElement>}
      className={
        rail
          ? `calendar-unscheduled ${over ? 'is-over' : ''}`
          : `calendar-day ${isToday ? 'is-today' : ''} ${over ? 'is-over' : ''}`
      }
    >
      <header className="calendar-day-head">
        <span className="calendar-day-date">{label}</span>
        {ids.length > 0 && <span className="column-count">{ids.length}</span>}
        <IconButton glyph="add" title="new card here" onClick={() => setAdding(true)} />
      </header>
      <div className="calendar-day-body">
        {adding && (
          <div className="newcard">
            <textarea
              autoFocus
              rows={2}
              value={title}
              placeholder="title, ⏎ to create"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setAdding(false);
                  setTitle('');
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  create();
                }
              }}
              onBlur={create}
            />
          </div>
        )}
        {ids.map((id, i) => {
          const card = cards[id];
          if (!card) return null;
          return (
            <CalCard
              key={id}
              card={card}
              column={day}
              chips={chips}
              isSelected={selected.has(id)}
              isDragging={dragging === id}
              /* The placement the cursor is *at* — `locate`'s answer, so the
                 walk and the ring cannot disagree. One lane, so lane is 0. */
              isCursor={isCursorAt(cursorSpot, 0, columnIndex, i)}
              /* Another placement of the cursor's note — due twice, drawn twice. */
              isEcho={cursor === id && !isCursorAt(cursorSpot, 0, columnIndex, i)}
              onCursor={onCursor}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          );
        })}
      </div>
    </Tag>
  );
}

/**
 * The board's tile, minus what a calendar has no answer for: no stored order,
 * so no card-edge drop target. The click grammar and the roving tabindex are
 * the board's exactly, so a pointer and the keyboard mean the same thing per
 * shape.
 */
function CalCard({
  card,
  column,
  chips,
  isSelected,
  isDragging,
  isCursor,
  isEcho,
  onCursor,
  onSelect,
  onOpen,
}: {
  card: NoteDTO;
  column: string;
  chips: string[];
  isSelected: boolean;
  isDragging: boolean;
  isCursor: boolean;
  isEcho: boolean;
  onCursor: (id: string) => void;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({ element: el, getInitialData: () => ({ cardId: card.id, column }) });
  }, [card.id, column]);

  const pointed = useCursorFocus(ref, isCursor);

  return (
    <div
      ref={ref}
      // Only the cursor's tile is tabbable — the board's roving tabindex.
      tabIndex={isCursor ? 0 : -1}
      data-card={card.id}
      className={`column-card ${isSelected ? 'is-selected' : ''} ${isCursor ? 'is-cursor' : ''} ${
        isEcho ? 'is-echo' : ''
      } ${isDragging ? 'is-dragging' : ''}`}
      onClick={(e) => {
        // Wherever a pointer lands, the keyboard picks up — the board's rule.
        pointed();
        onCursor(card.id);
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          onSelect(card.id, true);
        } else if (isSelected) onSelect(card.id, true);
        else onOpen(card.id);
      }}
    >
      <CardBody card={card} showFacets={chips} />
    </div>
  );
}
