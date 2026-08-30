import { useCallback, useEffect, useRef, useState } from 'react';
import { dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { ApiError, api } from '../api.ts';
import { CardTile } from '../components/CardTile.tsx';
import { emptyReason, unusedGrouping } from '../../view/empty.ts';
import { isCursorAt, type Spot } from './motion.ts';
import { attachPan } from './pan.ts';
import type { Meta, NoteDTO, Group, QueryResponse } from '../types.ts';

import { NONE } from '../../schema/vocabulary.ts';
import { dropOutcome, modeFor, type FacetIntent } from '../../view/dropOutcome.ts';
import { useRequestEnrichment } from '../enrichment.tsx';
import { groupsFor, labelFor } from './groups.ts';
import { IconButton } from '../components/Button.tsx';
import { BulkBar } from '../components/BulkBar.tsx';
import { visibleSelection, type Selection } from '../selection.ts';
import { LISTS_AXIS } from '../../schema/vocabulary.ts';

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
  meta,
  data,
  onOpen,
  selection,
  cursor,
  cursorSpot,
  onCursor,
  newIn,
  onNewHandled,
  nudge,
  onNudged,
  reload,
}: {
  /** For the vocabulary and the vault-wide axis population an empty board explains itself with. */
  meta: Meta;
  data: QueryResponse;
  onOpen: (id: string, at?: Spot | null) => void;
  /** Owned by `App` and carried in `?sel=`, so it survives a change of shape. */
  selection: Selection;
  /**
   * Where the keyboard is. A view only ever *draws* this: the ordering it moves
   * along is `motion.ts`'s, built by `App` from the same payload, so there is no
   * position to hand back up.
   */
  cursor: string | null;
  /**
   * Which *placement* the cursor is at. A note drawn in three columns is three
   * elements and one cursor, and this is which of the three.
   */
  cursorSpot: Spot | null;
  /** A pointer landing somewhere is the keyboard landing there too. */
  onCursor: (id: string, at?: Spot | null) => void;
  /**
   * The column `n` asked to create in, or `null`.
   *
   * A value rather than a boolean, because the request comes from the shell —
   * which knows where the cursor is but not which column that is on screen — and
   * arrives at one column out of however many are drawn. `onNewHandled` clears it
   * so pressing `n`, escaping, and pressing it again opens the field twice.
   */
  newIn: string | null;
  onNewHandled: () => void;
  /**
   * A request from `⌥j` / `⌥k` to move the cursor's card within its column.
   *
   * A delta rather than an order, and a prop rather than a call, for the reason
   * `newIn` is one: the shell knows a key was pressed and the board knows what a
   * column is. Everything about *which* ids and *what order* stays here, beside
   * the drag that answers the same question with a pointer.
   */
  nudge: number | null;
  onNudged: () => void;
  reload: () => void;
}) {
  const selected = selection.ids;
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  /**
   * The column axis, *as a facet a drop can write* — which `LISTS_AXIS` is not.
   *
   * A composition's columns are other views' answers, so there is no value to
   * set: dropping a card into "Needs status" cannot make it need one. Every
   * other use of the axis here is a write, so the empty string is the honest
   * spelling and `columnsAreLists` carries the rest.
   */
  const columnsAreLists = data.spec.query.groupBy?.[0] === LISTS_AXIS;
  const groupBy = columnsAreLists ? '' : data.spec.query.groupBy?.[0] ?? '';
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

  /**
   * A card can only be dragged onto an axis that exists. Ungrouped is a single
   * flat column, which is the "what's next" list and needs no drop targets.
   *
   * Either axis is enough, and on a composition only the second one ever is:
   * columns write nothing, lanes write the facet they are grouped by. So a
   * triage board with `groupBy: [lists, priority]` is draggable *down* and inert
   * *across*, which is exactly the two things those axes are. `dropOutcome`
   * already decides the two independently, so nothing there had to learn this.
   */
  const draggableBoard = Boolean(groupBy || laneBy);

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
   * `⌥j` / `⌥k`: the drag within a column, keyed.
   *
   * Reordering is the one board gesture with no other door — every other drag
   * writes a facet, and a facet is reachable from the panel — so until this
   * landed the stored order could only be set with a pointer.
   *
   * The saved-view requirement is not a limitation to route around: order *is*
   * arrangement, and an ad-hoc query has no file to keep it in. Saying so is
   * better than a key that silently does nothing on most views.
   */
  useEffect(() => {
    if (nudge === null) return;
    onNudged();
    if (!cursor) return;
    if (!viewName) {
      setProblem('Card order lives in a saved view. Save this query as one first.');
      return;
    }
    const column = data.groups?.find((g) => g.ids.includes(cursor))?.value;
    if (column === undefined) return;
    const ids = orderedFor(column);
    const at = ids.indexOf(cursor);
    const to = at + nudge;
    // The ends hold, the way `j` and `k` do at the ends of a column.
    if (at === -1 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(at, 1));
    void reorder(column, next);
  }, [nudge, onNudged, cursor, viewName, data.groups, orderedFor, reorder]);

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
        return true;
      } catch (err) {
        setProblem((err as ApiError).message);
        return false;
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
        else if (intent.kind === 'facet') {
          void (async () => {
            if (await move(intent)) {
              // The facet write makes the card appear in its new column; the
              // arrangement write then preserves the position its drop line
              // already showed. They must be sequential or the view may rank a
              // card before the move has made it a member of that column.
              if (intent.insertion) await reorder(intent.insertion.column, intent.insertion.ids);
            }
          })();
        }
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

  /*
   * The board's two ways of looking broken, which are not the same state.
   *
   * `unused` is the loud one and it is not an empty result at all: group by an
   * axis nothing carries and every note lands in `(none)` while each declared
   * column draws blank. `total` is healthy, so the empty-state text below
   * correctly says nothing, and the screen still reads as a failure. The columns
   * stay — they are the only drag target that can give the axis its first value.
   */
  const unused = unusedGrouping(meta, data);
  const empty = emptyReason(meta, data);

  return (
    <div className="board-wrap">
      {problem && <div className="banner is-bad">{problem}</div>}
      {unused && <div className="board-unused">{unused.text}</div>}

      <div
        className="board-scroll"
        // The Trello pan: press the background, drag, the board follows. Cards
        // and controls are exempt — see `pan.ts` for the whole gesture.
        ref={useCallback(
          (el: HTMLDivElement | null) => (el ? attachPan(el, { vertical: Boolean(laneBy) }) : undefined),
          [laneBy],
        )}
      >
        {lanes.map((lane, laneIndex) => (
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
              {columns(lane).map((g, columnIndex) => (
                <Column
                  key={`${lane ?? ''}/${g.value}`}
                  group={g}
                  lane={lane}
                  laneIndex={laneIndex}
                  columnIndex={columnIndex}
                  cursorSpot={cursorSpot}
                  order={orderedFor(g.value)}
                  cards={cards}
                  chips={data.spec.show}
                  selected={selected}
                  cursor={cursor}
                  onCursor={onCursor}
                  startAdding={newIn === g.value}
                  onNewHandled={onNewHandled}
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
              {!columns(lane).length && (
                <div className="emptystate board-empty">{empty?.text ?? 'nothing here'}</div>
              )}
            </div>
          </div>
        ))}
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

      {/*
        * There is no nudge for an ungrouped board. One flat list is a legitimate
        * answer — `unblocked` is one, and every column of a composition is one —
        * so a permanent line telling you to pick an axis was advice on a state
        * that is usually deliberate, in the one place it could not be dismissed.
        */}
      {!viewName && groupBy && (
        <div className="board-nudge">
          drag between columns to set <b>{groupBy}</b>. Reordering <em>within</em> a column needs a
          saved view — card order lives in a file, the way positions do.
        </div>
      )}
      {!viewName && !groupBy && laneBy && (
        <div className="board-nudge">
          drag between rows to set <b>{laneBy}</b>. The columns are saved views, so there is nothing
          a drop across one could write.
        </div>
      )}
    </div>
  );
}

function Column({
  group,
  lane,
  laneIndex,
  columnIndex,
  cursorSpot,
  order,
  cards,
  chips,
  selected,
  cursor,
  onCursor,
  startAdding,
  onNewHandled,
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
  /**
   * Where this column sits in the grid `motion.ts` walks, so a card can ask
   * whether it is the placement the cursor is at rather than merely one of its
   * note's. The indices line up because `gridOf` and this view make the same
   * `groupsFor` calls.
   */
  laneIndex: number;
  columnIndex: number;
  cursorSpot: Spot | null;
  /** The column's stored order, across lanes — what a reorder rewrites. */
  order: string[];
  cards: Record<string, NoteDTO>;
  chips: string[];
  selected: ReadonlySet<string>;
  cursor: string | null;
  onCursor: (id: string, at?: Spot | null) => void;
  /** `n` named this column. */
  startAdding: boolean;
  onNewHandled: () => void;
  dragging: string | null;
  groupBy: string;
  droppable: boolean;
  orderable: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string, at?: Spot | null) => void;
  onProblem: (msg: string) => void;
  onCreated: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const value = group.value;

  // `n` reached this column. Cleared immediately, so the request is a one-shot
  // rather than a state the column has to be talked back out of.
  useEffect(() => {
    if (!startAdding) return;
    setAdding(true);
    onNewHandled();
  }, [startAdding, onNewHandled]);

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
      <div className="column-body card-stack" ref={bodyRef}>
        {adding && (
          <div className="newcard">
            <textarea
              autoFocus
              rows={2}
              value={title}
              placeholder="title, ⏎ to create"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                // `stopPropagation` on Escape is not needed — the shell hands a
                // field every key it is given — but the field does have to put the
                // keyboard back on the board, or `n` is a one-way door.
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
        {group.ids.map((id, i) => {
          const card = cards[id];
          if (!card) return null;
          return (
            <CardTile
              key={id}
              card={card}
              source={{ column: value, ...(lane !== undefined ? { lane } : {}) }}
              // The index into the column's *stored* order, not into this cell.
              // Under a secondary axis the cell is a subset of it, and a reorder
              // writes the stored list — so a cell-local index landed the card
              // somewhere else.
              index={order.indexOf(id)}
              chips={chips}
              draggableTile={Boolean(groupBy)}
              orderable={orderable}
              isSelected={selected.has(id)}
              /*
               * The placement the cursor is *at*, not every placement of its note.
               *
               * `cursor === id` was true of all of them, so each drew a ring, each
               * took a tab stop, and each scrolled itself into view — the last in
               * DOM order winning, which is a board that jumps to the rightmost
               * copy and leaves the keyboard's own card off-screen. `isCursorAt`
               * is `locate`'s answer, which is the one every step already uses.
               */
              isCursor={isCursorAt(cursorSpot, laneIndex, columnIndex, i)}
              /* The others still say "this note is also here", quietly. */
              isEcho={cursor === id && !isCursorAt(cursorSpot, laneIndex, columnIndex, i)}
              /* Where this tile *is*, so a click on an echo puts the cursor on
                 the copy under the pointer rather than on the note's first one. */
              spot={[laneIndex, columnIndex, i]}
              onCursor={onCursor}
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

/** Run several cleanup functions as one. */
function combine(...fns: (() => void)[]): () => void {
  return () => fns.forEach((f) => f());
}
