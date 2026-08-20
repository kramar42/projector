import { useCallback, useEffect, useRef, useState } from 'react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { ApiError, api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { CardBody } from '../components/CardBody.tsx';
import { RecordPicker } from '../components/RecordPicker.tsx';
import type { BoardResponse, CardDTO, Meta } from '../types.ts';

import { NONE, modeFor, nextValues } from './dragSemantics.ts';
import { useRequestEnrichment } from '../enrichment.tsx';

export function BoardView({
  name,
  meta,
  onOpen,
}: {
  name: string;
  meta: Meta;
  onOpen: (id: string) => void;
}) {
  const { data, error, reload } = useLive<BoardResponse>(() => api.board(name), [name]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  useEffect(() => setSelected(new Set()), [name]);

  const groupBy = data?.view.groupBy ?? '';

  // Ask for every link on screen once. Batched into a single call, and the view
  // renders regardless of whether anything comes back.
  useRequestEnrichment(
    data ? [...new Set(data.groups.flatMap((g) => g.cards.flatMap((c) => c.links.map((l) => l.raw))))] : [],
  );

  const move = useCallback(
    async (cardId: string, from: string, to: string, mode: 'replace' | 'add' | 'remove') => {
      const card = data?.groups.flatMap((g) => g.cards).find((c) => c.id === cardId);
      if (!card || !data) return;
      // Move every selected card when the dragged one is part of the selection.
      const ids = selected.has(cardId) ? [...selected] : [cardId];
      setProblem(null);

      // Every facet is written the same way, project included. There is no
      // special case here any more, which is the point.
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
    [data, groupBy, selected, reload],
  );

  // One monitor for the whole board: it reads the modifier keys off the drop.
  useEffect(() => {
    return monitorForElements({
      onDragStart: ({ source }) => setDragging(String(source.data.cardId ?? '')),
      onDrop: ({ source, location }) => {
        setDragging(null);
        const target = location.current.dropTargets[0];
        if (!target) return;
        const cardId = String(source.data.cardId ?? '');
        const from = String(source.data.column ?? '');
        const to = String(target.data.column ?? '');
        if (!cardId || !to) return;
        const mode = modeFor(location.current.input);
        if (to === from && mode === 'replace') return;
        void move(cardId, from, to, mode);
      },
    });
  }, [move]);

  if (error) return <div className="pane-error">{error}</div>;
  if (!data) return <div className="pane-loading">loading…</div>;

  const multi = data.placements - data.total;
  const toggleSelect = (id: string, additive: boolean) =>
    setSelected((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      if (prev.has(id) && additive) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="board-wrap">
      <div className="board-head">
        <h1>{data.view.title}</h1>
        <span className="board-sub">
          grouped by <b>{data.view.groupBy}</b> · {data.total} cards
          {multi > 0 && (
            <>
              {' '}·{' '}
              <span
                className="multi-note"
                title="A card whose grouped facet holds several values appears in each matching column. That is the model, not a duplicate."
              >
                {multi} in more than one column
              </span>
            </>
          )}
        </span>
        <span className="board-hint">drag to move · ⌥ drop to add · ⇧ drag to remove</span>
      </div>

      {problem && <div className="banner is-bad">{problem}</div>}

      {selected.size > 0 && (
        <BulkBar
          ids={[...selected]}
          meta={meta}
          onDone={() => {
            setSelected(new Set());
            reload();
          }}
          onClear={() => setSelected(new Set())}
          onProblem={setProblem}
        />
      )}

      <div className="board">
        {data.groups.map((g) => (
          <Column
            key={g.value}
            value={g.value}
            cards={g.cards}
            cardFacets={data.view.cardFacets}
            selected={selected}
            dragging={dragging}
            groupBy={groupBy}
            adding={addingTo === g.value}
            onAdd={() => setAddingTo(g.value)}
            onAddCancel={() => setAddingTo(null)}
            onCreated={() => {
              setAddingTo(null);
              reload();
            }}
            onSelect={toggleSelect}
            onOpen={onOpen}
            onProblem={setProblem}
          />
        ))}
      </div>
    </div>
  );
}

function Column({
  value,
  cards,
  cardFacets,
  selected,
  dragging,
  groupBy,
  adding,
  onAdd,
  onAddCancel,
  onCreated,
  onSelect,
  onOpen,
  onProblem,
}: {
  value: string;
  cards: CardDTO[];
  cardFacets?: string[];
  selected: Set<string>;
  dragging: string | null;
  groupBy: string;
  adding: boolean;
  onAdd: () => void;
  onAddCancel: () => void;
  onCreated: () => void;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
  onProblem: (msg: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    const el = ref.current;
    const body = bodyRef.current;
    if (!el || !body) return;
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
  }, [value]);

  const create = () => {
    const t = title.trim();
    if (!t) return onAddCancel();
    setTitle('');
    // A card created in a column inherits that column's value for the grouped facet.
    api
      .createCard({ title: t, facets: value === NONE ? {} : { [groupBy]: [value] } })
      .then(onCreated)
      .catch((e: ApiError) => onProblem(e.message));
  };

  return (
    <section
      ref={ref as React.Ref<HTMLElement>}
      className={`column ${value === NONE ? 'is-none' : ''} ${over ? 'is-over' : ''}`}
    >
      <header className="column-head">
        <span className="column-name">{value}</span>
        <span className="column-count">{cards.length}</span>
        <button className="btn ghost tiny" title="new card here" onClick={onAdd}>+</button>
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
                if (e.key === 'Escape') onAddCancel();
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  create();
                }
              }}
              onBlur={create}
            />
          </div>
        )}
        {cards.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            column={value}
            cardFacets={cardFacets}
            isSelected={selected.has(card.id)}
            isDragging={dragging === card.id}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

function CardTile({
  card,
  column,
  cardFacets,
  isSelected,
  isDragging,
  onSelect,
  onOpen,
}: {
  card: CardDTO;
  column: string;
  cardFacets?: string[];
  isSelected: boolean;
  isDragging: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ cardId: card.id, column }),
    });
  }, [card.id, column]);

  return (
    <div
      ref={ref}
      className={`column-card ${isSelected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''}`}
      onClick={(e) => {
        // Cmd/Ctrl or Shift builds a selection for a bulk action; a plain click opens.
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          onSelect(card.id, true);
        } else if (isSelected) onSelect(card.id, true);
        else onOpen(card.id);
      }}
    >
      <CardBody card={card} size="card" showFacets={cardFacets} />
    </div>
  );
}

/** Bulk actions across a selection — what makes cleaning 130 imported cards feasible. */
function BulkBar({
  ids,
  meta,
  onDone,
  onClear,
  onProblem,
}: {
  ids: string[];
  meta: Meta;
  onDone: () => void;
  onClear: () => void;
  onProblem: (m: string) => void;
}) {
  const [pickParent, setPickParent] = useState(false);
  const [facet, setFacet] = useState('');
  const editable = Object.entries(meta.facets);

  const run = (fn: () => Promise<unknown>) =>
    fn().then(onDone).catch((e: ApiError) => onProblem(e.message));

  return (
    <div className="bulkbar">
      <span className="bulkbar-count">{ids.length} selected</span>

      <button className="btn small" onClick={() => setPickParent((v) => !v)}>
        Set parent…
      </button>

      <select
        className="bulkbar-select"
        value={facet}
        onChange={(e) => setFacet(e.target.value)}
      >
        <option value="">set a facet…</option>
        {editable.map(([n, d]) => (
          <option key={n} value={n}>{d.label}</option>
        ))}
      </select>
      {facet && (
        <span className="bulkbar-values">
          {(meta.facets[facet]?.values ?? []).map((v) => (
            <button
              key={v}
              className="togglechip"
              onClick={() =>
                void run(() =>
                  api.bulk({ ids, op: 'facet', facet, values: [v], mode: 'set' }),
                )
              }
            >
              {v}
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
      <button className="btn ghost small" onClick={onClear}>Clear selection</button>

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
