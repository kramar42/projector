import { useCallback, useEffect, useRef, useState } from 'react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { ApiError, api } from '../api.ts';
import { CardBody } from '../components/CardBody.tsx';
import type { NoteDTO, Group, QueryResponse } from '../types.ts';

import { NONE } from '../../schema/vocabulary.ts';
import { dropOutcome, modeFor, type FacetIntent } from '../../view/dropOutcome.ts';
import { useRequestEnrichment } from '../enrichment.tsx';
import { groupsFor, labelFor } from './groups.ts';
import { IconButton } from '../components/Button.tsx';
import { BulkBar } from '../components/BulkBar.tsx';
import { visibleSelection, type Selection } from '../selection.ts';

/**
 * Columns from the primary grouping axis; when a second axis is set, lanes as
 * rows and the board becomes a matrix — which is what `swimlanes` was going to
 * be, except it is a position in `groupBy` rather than a key of its own.
 *
 * No header: the sidebar states the query and the footer counts it. What lives
 * here instead is the bulk bar, which floats because it only exists while a
 * selection does.
 */
export function BoardView({
  data,
  onOpen,
  selection,
  reload,
}: {
  data: QueryResponse;
  onOpen: (id: string) => void;
  /** Owned by `App` and carried in `?sel=`, so it survives a change of shape. */
  selection: Selection;
  reload: () => void;
}) {
  const selected = selection.ids;
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const groupBy = data.spec.query.groupBy?.[0] ?? '';
  // The second axis is a facet like the first, so a drag across a swimlane is a
  // write like any other. It used to be a row label and nothing else.
  const laneBy = data.spec.query.groupBy?.[1] ?? '';
  const cards = data.notes;
  // Only a named view can hold card order — arrangement lives in a file or
  // nowhere (C9). An ad-hoc query stays in the query's sort order.
  const viewName = data.spec.name;

  useRequestEnrichment([
    ...new Set(Object.values(cards).flatMap((c) => c.links.map((l) => l.raw))),
  ]);

  // A card can only be dragged onto an axis that exists. Ungrouped is a single
  // flat column, which is the "what's next" list and needs no drop targets.
  const draggableBoard = Boolean(groupBy);

  /**
   * The ids of one column, in the order it renders: stored order first, then
   * whatever the query's sort said.
   *
   * Order is keyed by the column value alone, so a matrix shares one order per
   * column across its lanes — which is what you want, since the lane is a
   * different question about the same card.
   */
  const orderedFor = useCallback(
    (column: string): string[] => {
      // The payload arrives in the view's order, so this is the union across lanes
      // and nothing more.
      const ids = data.groups
        ? data.groups.filter((g) => g.value === column).flatMap((g) => g.ids)
        : data.ids;
      return [...new Set(ids)];
    },
    [data],
  );

  /**
   * Write the order of one column.
   *
   * The stored list is the whole column, so it stays stable as cards come and go:
   * ids present in it lead, in its order, and anything new falls in behind.
   */
  const reorder = useCallback(
    async (column: string, ids: string[]) => {
      if (!viewName) return;
      setProblem(null);
      try {
        await api.saveArrangement(viewName, { order: { [column]: ids } });
        reload();
      } catch (err) {
        setProblem((err as ApiError).message);
      }
    },
    [viewName, reload],
  );

  /**
   * A facet move, however many cards it applies to.
   *
   * There is no branch on cardinality any more. There used to be: the single-card
   * path computed `nextValues` and the bulk path re-derived uniform values inline,
   * so shift-dragging `now`→`month` removed `now` for one card and `month` for
   * two. The endpoints travel and the server applies the one transform per card.
   */
  const move = useCallback(
    async (intent: FacetIntent) => {
      setProblem(null);
      try {
        await api.bulk({
          ids: intent.ids,
          op: 'move',
          moves: intent.moves,
          dragMode: intent.mode,
        });
        reload();
      } catch (err) {
        setProblem((err as ApiError).message);
      }
    },
    [reload],
  );

  // One monitor for the whole board. It reads the pointer and the modifier keys,
  // asks `dropOutcome` what that means, and does what it is told — the decision
  // itself is a pure function with tests, which is what it was not.
  useEffect(() => {
    return monitorForElements({
      onDragStart: ({ source }) => setDragging(String(source.data.cardId ?? '')),
      onDrop: ({ source, location }) => {
        setDragging(null);
        const targets = location.current.dropTargets;
        const onCardTarget = targets.find((t) => t.data.cardId !== undefined);
        const onColumn = targets.find((t) => t.data.column !== undefined);
        const column = onColumn ? String(onColumn.data.column ?? '') : null;
        // A lane is not a target of its own — the column tile knows which row it
        // is in, so one drop reports both coordinates.
        const lane =
          onColumn && onColumn.data.lane !== undefined ? String(onColumn.data.lane) : null;

        // Above or below is which half of the tile the pointer is in — one
        // comparison, and the only geometry the decision needs.
        let onCard: { id: string; index: number; below: boolean } | null = null;
        if (onCardTarget) {
          const rect = onCardTarget.element.getBoundingClientRect();
          onCard = {
            id: String(onCardTarget.data.cardId ?? ''),
            index: Number(onCardTarget.data.index ?? 0),
            below: location.current.input.clientY > rect.top + rect.height / 2,
          };
        }

        const intent = dropOutcome({
          cardId: String(source.data.cardId ?? ''),
          from: String(source.data.column ?? ''),
          fromLane: String(source.data.lane ?? ''),
          to: column,
          toLane: lane,
          onCard,
          groupBy,
          laneBy,
          mode: modeFor(location.current.input),
          selected,
          order: column ? orderedFor(column) : [],
          viewName,
        });

        if (intent.kind === 'reorder') void reorder(intent.column, intent.ids);
        else if (intent.kind === 'facet') void move(intent);
      },
    });
  }, [move, reorder, orderedFor, viewName, groupBy, laneBy, selected]);

  // A board keeps an empty declared column: it is somewhere to drag a card to.
  const columns = (lane: string | undefined): Group[] => groupsFor(data, { lane, empties: 'keep' });

  const lanes: (string | undefined)[] = data.groupOrder.secondary.length
    ? data.groupOrder.secondary
    : [undefined];

  // What the bar writes: the selection narrowed to what this board draws, so a
  // card carried in the URL from another shape is remembered without being
  // written to behind your back.
  const acting = visibleSelection(selected, data.ids);

  return (
    <div className="board-wrap">
      {problem && <div className="banner is-bad">{problem}</div>}

      <div className="board-scroll">
        {lanes.map((lane) => (
          <div key={lane ?? '·'} className={`lane ${lane !== undefined ? 'is-laned' : ''}`}>
            {lane !== undefined && (
              <div className="lane-head">
                <span>{labelFor(lane ?? '')}</span>
                <span className="lane-count">
                  {columns(lane).reduce((n, g) => n + g.ids.length, 0)}
                </span>
              </div>
            )}
            <div className="board">
              {columns(lane).map((g) => (
                <Column
                  key={`${lane ?? ''}/${g.value}`}
                  group={g}
                  lane={lane}
                  order={orderedFor(g.value)}
                  cards={cards}
                  chips={data.spec.show}
                  selected={selected}
                  dragging={dragging}
                  groupBy={groupBy}
                  droppable={draggableBoard}
                  orderable={Boolean(viewName)}
                  onSelect={selection.toggle}
                  onOpen={onOpen}
                  onProblem={setProblem}
                  onCreated={reload}
                />
              ))}
              {!columns(lane).length && <div className="emptystate board-empty">nothing here</div>}
            </div>
          </div>
        ))}
      </div>

      {acting.length > 0 && (
        <BulkBar
          ids={acting}
          counts={data.counts}
          onDone={() => {
            selection.clear();
            reload();
          }}
          onClear={selection.clear}
          onProblem={setProblem}
        />
      )}

      {!groupBy && (
        <div className="board-nudge">
          ungrouped — one flat list. Pick a <b>group by</b> in the sidebar for columns.
        </div>
      )}
      {!viewName && groupBy && (
        <div className="board-nudge">
          drag between columns to set <b>{groupBy}</b>. Reordering <em>within</em> a column needs a
          saved view — card order lives in a file, the way positions do.
        </div>
      )}
    </div>
  );
}

function Column({
  group,
  lane,
  order,
  cards,
  chips,
  selected,
  dragging,
  groupBy,
  droppable,
  orderable,
  onSelect,
  onOpen,
  onProblem,
  onCreated,
}: {
  group: Group;
  /**
   * The row this cell sits in, or `undefined` on a board with one axis. It rides
   * on both the drag and the drop data so a drop knows the lane it left and the
   * lane it landed in.
   */
  lane: string | undefined;
  /** The column's stored order, across lanes — what a reorder rewrites. */
  order: string[];
  cards: Record<string, NoteDTO>;
  chips: string[];
  selected: ReadonlySet<string>;
  dragging: string | null;
  groupBy: string;
  droppable: boolean;
  orderable: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
  onProblem: (msg: string) => void;
  onCreated: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const value = group.value;

  useEffect(() => {
    const el = ref.current;
    const body = bodyRef.current;
    if (!el || !body || !droppable) return;
    return combine(
      dropTargetForElements({
        element: el,
        getData: () => ({ column: value, lane }),
        onDragEnter: () => setOver(true),
        onDragLeave: () => setOver(false),
        onDrop: () => setOver(false),
      }),
      // A 68-card column has to scroll while dragging or the far end is unreachable.
      autoScrollForElements({ element: body }),
    );
  }, [value, lane, droppable]);

  const create = () => {
    const t = title.trim();
    setAdding(false);
    if (!t) return;
    setTitle('');
    // A card created in a column inherits that column's value for the grouped
    // facet. Creating is not editing, so this is the one write outside the panel
    // that is not a gesture (C10).
    api
      .createNote({ title: t, facets: value && value !== NONE ? { [groupBy]: [value] } : {} })
      .then(onCreated)
      .catch((e: ApiError) => onProblem(e.message));
  };

  return (
    <section
      ref={ref as React.Ref<HTMLElement>}
      className={`column ${value === NONE ? 'is-none' : ''} ${over ? 'is-over' : ''}`}
    >
      <header className="column-head">
        <span className="column-name">{value ? labelFor(value) : 'all'}</span>
        <span className="column-count">{group.ids.length}</span>
        <IconButton glyph="add" title="new card here" onClick={() => setAdding(true)} />
      </header>
      <div className="column-body" ref={bodyRef}>
        {adding && (
          <div className="newcard">
            <textarea
              autoFocus
              rows={2}
              value={title}
              placeholder="title, ⏎ to create"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setAdding(false);
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  create();
                }
              }}
              onBlur={create}
            />
          </div>
        )}
        {group.ids.map((id) => {
          const card = cards[id];
          if (!card) return null;
          return (
            <CardTile
              key={id}
              card={card}
              column={value}
              lane={lane}
              // The index into the column's *stored* order, not into this cell.
              // Under a secondary axis the cell is a subset of it, and a reorder
              // writes the stored list — so a cell-local index landed the card
              // somewhere else.
              index={order.indexOf(id)}
              chips={chips}
              draggableTile={Boolean(groupBy)}
              orderable={orderable}
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

function CardTile({
  card,
  column,
  lane,
  index,
  chips,
  draggableTile,
  orderable,
  isSelected,
  isDragging,
  onSelect,
  onOpen,
}: {
  card: NoteDTO;
  column: string;
  lane: string | undefined;
  index: number;
  chips: string[];
  draggableTile: boolean;
  orderable: boolean;
  isSelected: boolean;
  isDragging: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState<'top' | 'bottom' | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cleanups: (() => void)[] = [];
    if (draggableTile) {
      cleanups.push(
        draggable({ element: el, getInitialData: () => ({ cardId: card.id, column, lane }) }),
      );
    }
    if (orderable) {
      cleanups.push(
        dropTargetForElements({
          element: el,
          getData: () => ({ cardId: card.id, index }),
          canDrop: ({ source }) => source.data.cardId !== card.id,
          onDrag: ({ location }) => {
            const rect = el.getBoundingClientRect();
            setEdge(location.current.input.clientY > rect.top + rect.height / 2 ? 'bottom' : 'top');
          },
          onDragLeave: () => setEdge(null),
          onDrop: () => setEdge(null),
        }),
      );
    }
    return () => cleanups.forEach((f) => f());
  }, [card.id, column, lane, index, draggableTile, orderable]);

  return (
    <div
      ref={ref}
      className={`column-card ${isSelected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''} ${
        edge ? `is-over-${edge}` : ''
      }`}
      onClick={(e) => {
        // Cmd/Ctrl or Shift builds a selection for a bulk action; a plain click opens.
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

/** Run several cleanup functions as one. */
function combine(...fns: (() => void)[]): () => void {
  return () => fns.forEach((f) => f());
}
