import { useCallback, useEffect, useRef, useState } from 'react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { ApiError, api } from '../api.ts';
import { CardBody } from '../components/CardBody.tsx';
import { RecordPicker } from '../components/RecordPicker.tsx';
import type { CardDTO, Group, QueryResponse } from '../types.ts';

import { NONE, modeFor, nextValues } from './dragSemantics.ts';
import { useRequestEnrichment } from '../enrichment.tsx';
import { applyOrder } from '../query.ts';

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
  reload,
}: {
  data: QueryResponse;
  onOpen: (id: string) => void;
  reload: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const groupBy = data.spec.query.groupBy?.[0] ?? '';
  const cards = data.cards;
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
      const ids = data.groups
        ? data.groups.filter((g) => g.value === column).flatMap((g) => g.ids)
        : data.ids;
      return applyOrder([...new Set(ids)], data.spec.order?.[column]);
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

  const move = useCallback(
    async (cardId: string, from: string, to: string, mode: 'replace' | 'add' | 'remove') => {
      const card = cards[cardId];
      if (!card || !groupBy) return;
      const ids = selected.has(cardId) ? [...selected] : [cardId];
      setProblem(null);
      const next = nextValues(card.facets[groupBy] ?? [], from, to, mode);
      try {
        if (ids.length > 1) {
          await api.bulk({
            ids,
            op: 'facet',
            facet: groupBy,
            values: to === NONE ? [] : [to],
            mode: mode === 'add' ? 'add' : mode === 'remove' ? 'remove' : 'set',
          });
        } else {
          await api.patchCard(cardId, { facets: { ...card.facets, [groupBy]: next } });
        }
        reload();
      } catch (err) {
        setProblem((err as ApiError).message);
      }
    },
    [cards, groupBy, selected, reload],
  );

  // One monitor for the whole board: it reads the modifier keys off the drop, and
  // the innermost drop target says whether a position was aimed at.
  useEffect(() => {
    return monitorForElements({
      onDragStart: ({ source }) => setDragging(String(source.data.cardId ?? '')),
      onDrop: ({ source, location }) => {
        setDragging(null);
        const targets = location.current.dropTargets;
        const onCard = targets.find((t) => t.data.cardId !== undefined);
        const onColumn = targets.find((t) => t.data.column !== undefined);
        if (!onColumn) return;
        const cardId = String(source.data.cardId ?? '');
        const from = String(source.data.column ?? '');
        const to = String(onColumn.data.column ?? '');
        if (!cardId || !to) return;

        // Dropped onto a card: aim for that slot. Above or below is decided by
        // which half of the tile the pointer is in — no separate hitbox package
        // needed for one comparison.
        let at: number | null = null;
        if (onCard && onCard.data.cardId !== cardId) {
          const rect = onCard.element.getBoundingClientRect();
          const below = location.current.input.clientY > rect.top + rect.height / 2;
          at = Number(onCard.data.index ?? 0) + (below ? 1 : 0);
        }

        if (to === from) {
          // Within a column, a drag means order and nothing else. Without a
          // saved view there is nowhere to put it, so it is a no-op.
          if (at === null || !viewName) return;
          const current = orderedFor(to);
          const cut = current.indexOf(cardId);
          const without = current.filter((id) => id !== cardId);
          const index = cut !== -1 && cut < at ? at - 1 : at;
          void reorder(to, [...without.slice(0, index), cardId, ...without.slice(index)]);
          return;
        }
        void move(cardId, from, to, modeFor(location.current.input));
      },
    });
  }, [move, reorder, orderedFor, viewName]);

  const toggleSelect = (id: string, additive: boolean) =>
    setSelected((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      if (prev.has(id) && additive) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns = (lane: string | undefined): Group[] =>
    (data.groups ? data.groups.filter((g) => g.lane === lane) : [{ value: '', ids: data.ids }]).map(
      (g) => ({ ...g, ids: applyOrder(g.ids, data.spec.order?.[g.value]) }),
    );

  const lanes = data.lanes.length ? data.lanes : [undefined];

  return (
    <div className="board-wrap">
      {problem && <div className="banner is-bad">{problem}</div>}

      <div className="board-scroll">
        {lanes.map((lane) => (
          <div key={lane ?? '·'} className={`lane ${lane !== undefined ? 'is-laned' : ''}`}>
            {lane !== undefined && (
              <div className="lane-head">
                <span className="lane-name">{lane === NONE ? 'no value' : lane}</span>
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
                  cards={cards}
                  chips={data.spec.show}
                  selected={selected}
                  dragging={dragging}
                  groupBy={groupBy}
                  droppable={draggableBoard}
                  orderable={Boolean(viewName)}
                  onSelect={toggleSelect}
                  onOpen={onOpen}
                  onProblem={setProblem}
                  onCreated={reload}
                />
              ))}
              {!columns(lane).length && <div className="board-empty">nothing here</div>}
            </div>
          </div>
        ))}
      </div>

      {selected.size > 0 && (
        <BulkBar
          ids={[...selected]}
          counts={data.counts}
          onDone={() => {
            setSelected(new Set());
            reload();
          }}
          onClear={() => setSelected(new Set())}
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
  cards: Record<string, CardDTO>;
  chips: string[];
  selected: Set<string>;
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
        getData: () => ({ column: value }),
        onDragEnter: () => setOver(true),
        onDragLeave: () => setOver(false),
        onDrop: () => setOver(false),
      }),
      // A 68-card column has to scroll while dragging or the far end is unreachable.
      autoScrollForElements({ element: body }),
    );
  }, [value, droppable]);

  const create = () => {
    const t = title.trim();
    setAdding(false);
    if (!t) return;
    setTitle('');
    // A card created in a column inherits that column's value for the grouped
    // facet. Creating is not editing, so this is the one write outside the panel
    // that is not a gesture (C10).
    api
      .createCard({ title: t, facets: value && value !== NONE ? { [groupBy]: [value] } : {} })
      .then(onCreated)
      .catch((e: ApiError) => onProblem(e.message));
  };

  return (
    <section
      ref={ref as React.Ref<HTMLElement>}
      className={`column ${value === NONE ? 'is-none' : ''} ${over ? 'is-over' : ''}`}
    >
      <header className="column-head">
        <span className="column-name">{value === NONE ? 'no value' : value || 'all'}</span>
        <span className="column-count">{group.ids.length}</span>
        <button className="btn ghost tiny icon-button icon-add" title="new card here" onClick={() => setAdding(true)}>
          +
        </button>
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
        {group.ids.map((id, index) => {
          const card = cards[id];
          if (!card) return null;
          return (
            <CardTile
              key={id}
              card={card}
              column={value}
              index={index}
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
  index,
  chips,
  draggableTile,
  orderable,
  isSelected,
  isDragging,
  onSelect,
  onOpen,
}: {
  card: CardDTO;
  column: string;
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
      cleanups.push(draggable({ element: el, getInitialData: () => ({ cardId: card.id, column }) }));
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
  }, [card.id, column, index, draggableTile, orderable]);

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

/**
 * Bulk actions across a selection — what makes cleaning 130 imported cards
 * feasible, and structure-only, so it stays on the gesture side of C10.
 *
 * The facet list comes from the query's own histogram, so it offers the axes
 * actually present in what is on screen rather than the whole vocabulary.
 */
function BulkBar({
  ids,
  counts,
  onDone,
  onClear,
  onProblem,
}: {
  ids: string[];
  counts: QueryResponse['counts'];
  onDone: () => void;
  onClear: () => void;
  onProblem: (m: string) => void;
}) {
  const [pickParent, setPickParent] = useState(false);
  const [facet, setFacet] = useState('');
  const editable = counts.filter((c) => !c.pseudo);
  const chosen = editable.find((c) => c.facet === facet);

  const run = (fn: () => Promise<unknown>) =>
    fn()
      .then(onDone)
      .catch((e: ApiError) => onProblem(e.message));

  return (
    <div className="bulkbar">
      <span className="bulkbar-count">{ids.length} selected</span>

      <button className="btn small" onClick={() => setPickParent((v) => !v)}>
        Set parent…
      </button>

      <select className="bulkbar-select" value={facet} onChange={(e) => setFacet(e.target.value)}>
        <option value="">set a facet…</option>
        {editable.map((c) => (
          <option key={c.facet} value={c.facet}>
            {c.label}
          </option>
        ))}
      </select>
      {chosen && (
        <span className="bulkbar-values">
          {chosen.values
            .filter((v) => v.value !== NONE)
            .map((v) => (
              <button
                key={v.value}
                className="togglechip"
                onClick={() =>
                  void run(() => api.bulk({ ids, op: 'facet', facet, values: [v.value], mode: 'set' }))
                }
              >
                {v.value}
              </button>
            ))}
          <button
            className="togglechip is-clear"
            onClick={() => void run(() => api.bulk({ ids, op: 'facet', facet, values: [], mode: 'set' }))}
          >
            clear
          </button>
        </span>
      )}

      <button
        className="btn small danger"
        onClick={() => {
          if (!confirm(`Delete ${ids.length} card(s)?\n\nThe files are in git, so this is recoverable.`))
            return;
          void run(() => api.bulk({ ids, op: 'delete' }));
        }}
      >
        Delete
      </button>
      <button className="btn ghost small" onClick={onClear}>
        Clear selection
      </button>

      {pickParent && (
        <div className="bulkbar-picker">
          <RecordPicker
            exclude={ids}
            placeholder="parent for all selected…"
            onCancel={() => setPickParent(false)}
            onPick={(pid) => {
              setPickParent(false);
              void run(() => api.bulk({ ids, op: 'parent', parent: pid }));
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Run several cleanup functions as one. */
function combine(...fns: (() => void)[]): () => void {
  return () => fns.forEach((f) => f());
}
