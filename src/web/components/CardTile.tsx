import { useEffect, useRef, useState } from 'react';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { CardBody } from './CardBody.tsx';
import { useCursorFocus } from '../cursor.ts';
import type { Spot } from '../views/motion.ts';
import type { NoteDTO } from '../types.ts';
import './CardTile.css';

/**
 * The interactive card in a vertically ordered stack.
 *
 * Board columns and calendar days are different adapters around the same stack:
 * they decide which cards exist and what their drag source means, while this
 * module owns the shared pointer, keyboard, insertion-line and cursor grammar.
 * Keeping that grammar here is what makes a fix to one stack a fix to both.
 */
export function CardTile({
  card,
  source,
  index,
  chips,
  draggableTile,
  orderable,
  isSelected,
  isCursor,
  isEcho,
  spot,
  onCursor,
  isDragging,
  onSelect,
  onOpen,
}: {
  card: NoteDTO;
  /** The adapter-specific grouping coordinates a drag leaves from. */
  source: { column: string; lane?: string };
  /** Position in the complete stored order before any drag removes a card. */
  index: number;
  chips: string[];
  draggableTile: boolean;
  /** A named view is the only place an insertion order can live. */
  orderable: boolean;
  isSelected: boolean;
  isCursor: boolean;
  /** Another placement of the cursor's note: marked, but not the cursor. */
  isEcho: boolean;
  spot: Spot;
  onCursor: (id: string, at?: Spot | null) => void;
  isDragging: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string, at?: Spot | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState<'top' | 'bottom' | null>(null);
  const { column, lane } = source;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cleanups: (() => void)[] = [];
    if (draggableTile) {
      cleanups.push(
        draggable({ element: el, getInitialData: () => ({ cardId: card.id, column, ...(lane !== undefined ? { lane } : {}) }) }),
      );
    }
    if (orderable) {
      cleanups.push(
        dropTargetForElements({
          element: el,
          getData: () => ({ cardId: card.id, index }),
          canDrop: ({ source: dragging }) => dragging.data.cardId !== card.id,
          onDrag: ({ location }) => {
            const rect = el.getBoundingClientRect();
            setEdge(location.current.input.clientY > rect.top + rect.height / 2 ? 'bottom' : 'top');
          },
          onDragLeave: () => setEdge(null),
          onDrop: () => setEdge(null),
        }),
      );
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [card.id, column, lane, index, draggableTile, orderable]);

  const pointed = useCursorFocus(ref, isCursor);

  return (
    <div
      ref={ref}
      // Roving tabindex: a stack gets one tab stop, not one per card.
      tabIndex={isCursor ? 0 : -1}
      data-card={card.id}
      className={`column-card ${isSelected ? 'is-selected' : ''} ${isCursor ? 'is-cursor' : ''} ${isEcho ? 'is-echo' : ''} ${
        isDragging ? 'is-dragging' : ''
      } ${edge ? `is-over-${edge}` : ''}`}
      onClick={(e) => {
        pointed();
        onCursor(card.id, spot);
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          onSelect(card.id, true);
        } else if (isSelected) onSelect(card.id, true);
        else onOpen(card.id, spot);
      }}
    >
      <CardBody card={card} showFacets={chips} />
    </div>
  );
}
