import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { ApiError, api } from '../api.ts';
import { CardBody } from '../components/CardBody.tsx';
import { Button } from '../components/Button.tsx';
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
  search,
  patch,
  reload,
}: {
  meta: Meta;
  data: QueryResponse;
  onOpen: (id: string) => void;
  /** Owned by `App` and carried in `?sel=`, so it survives a change of shape. */
  selection: Selection;
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
          {page.days.flat().map((day, i) => (
            <DayCell
              key={day}
              day={day}
              label={dayLabel(day, i === 0)}
              isToday={day === today}
              ids={placed.byDay.get(day) ?? []}
              cards={cards}
              chips={data.spec.show}
              selected={selected}
              dragging={dragging}
              onSelect={selection.toggle}
              onOpen={onOpen}
            />
          ))}
        </div>

        {/*
          * The side list: the filter's notes with no value on the axis. A drop
          * target like any day — landing here is `(none)`, which clears the
          * value the card was dragged from, the board's own `(none)` rule.
          */}
        <Rail
          ids={placed.unscheduled}
          cards={cards}
          chips={data.spec.show}
          selected={selected}
          dragging={dragging}
          onSelect={selection.toggle}
          onOpen={onOpen}
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

function DayCell({
  day,
  label,
  isToday,
  ids,
  cards,
  chips,
  selected,
  dragging,
  onSelect,
  onOpen,
}: {
  day: string;
  label: string;
  isToday: boolean;
  ids: string[];
  cards: Record<string, NoteDTO>;
  chips: string[];
  selected: ReadonlySet<string>;
  dragging: string | null;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);

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

  return (
    <section
      ref={ref as React.Ref<HTMLElement>}
      className={`calendar-day ${isToday ? 'is-today' : ''} ${over ? 'is-over' : ''}`}
    >
      <header className="calendar-day-head">
        <span className="calendar-day-date">{label}</span>
        {ids.length > 0 && <span className="column-count">{ids.length}</span>}
      </header>
      <div className="calendar-day-body">
        {ids.map((id) => {
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
              onSelect={onSelect}
              onOpen={onOpen}
            />
          );
        })}
      </div>
    </section>
  );
}

function Rail({
  ids,
  cards,
  chips,
  selected,
  dragging,
  onSelect,
  onOpen,
}: {
  ids: string[];
  cards: Record<string, NoteDTO>;
  chips: string[];
  selected: ReadonlySet<string>;
  dragging: string | null;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ column: NONE }),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
  }, []);

  return (
    <aside
      ref={ref as React.Ref<HTMLElement>}
      className={`calendar-unscheduled ${over ? 'is-over' : ''}`}
    >
      <header className="calendar-day-head">
        <span className="calendar-day-date">unscheduled</span>
        <span className="column-count">{ids.length}</span>
      </header>
      <div className="calendar-day-body">
        {ids.map((id) => {
          const card = cards[id];
          if (!card) return null;
          return (
            <CalCard
              key={id}
              card={card}
              column={NONE}
              chips={chips}
              isSelected={selected.has(id)}
              isDragging={dragging === id}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          );
        })}
      </div>
    </aside>
  );
}

/**
 * The board's tile, minus what a calendar has no answer for: no stored order, so
 * no card-edge drop target, and no cursor yet (`gridOf` says why). The click
 * grammar is the board's exactly, so a pointer means the same thing per shape.
 */
function CalCard({
  card,
  column,
  chips,
  isSelected,
  isDragging,
  onSelect,
  onOpen,
}: {
  card: NoteDTO;
  column: string;
  chips: string[];
  isSelected: boolean;
  isDragging: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({ element: el, getInitialData: () => ({ cardId: card.id, column }) });
  }, [card.id, column]);

  return (
    <div
      ref={ref}
      data-card={card.id}
      className={`column-card ${isSelected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''}`}
      onClick={(e) => {
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
