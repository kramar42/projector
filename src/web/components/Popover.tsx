import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A panel anchored to a trigger, rendered into `document.body`.
 *
 * The sidebar establishes its own overflow and stacking context, so anything
 * positioned inside it is clipped at the rail's edge — which is why the vault
 * dropdown was cut off. A portal plus `position: fixed` from the trigger's own
 * rect is the general fix, and it is needed four times over: the vault switcher,
 * the face chip picker, the focus record picker and the sort key picker.
 *
 * Placement flips above the trigger when there is no room below and more room
 * above, and the width is clamped so a long list cannot run off screen.
 */

interface Rect {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const GAP = 6;
const MARGIN = 12;

function place(anchor: HTMLElement, panel: HTMLElement | null, minWidth: number, fitContent: boolean): Rect {
  const a = anchor.getBoundingClientRect();
  const wanted = panel?.scrollHeight ?? 0;
  const below = window.innerHeight - a.bottom - GAP - MARGIN;
  const above = a.top - GAP - MARGIN;
  const flip = wanted > below && above > below;

  const naturalWidth = fitContent ? panel?.scrollWidth ?? 0 : 0;
  const width = Math.min(window.innerWidth - MARGIN * 2, Math.max(a.width, minWidth, naturalWidth));
  return {
    top: flip ? Math.max(MARGIN, a.top - GAP - Math.min(wanted, above)) : a.bottom + GAP,
    left: Math.min(Math.max(MARGIN, a.left), Math.max(MARGIN, window.innerWidth - width - MARGIN)),
    width,
    maxHeight: Math.max(120, flip ? above : below),
  };
}

export function Popover({
  open,
  anchor,
  onClose,
  children,
  minWidth = 220,
  fitContent = false,
  className = '',
}: {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  minWidth?: number;
  /** Let a picker menu grow to its content, while still respecting the viewport. */
  fitContent?: boolean;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  // Measure after the panel exists but before paint, or it appears at 0,0 first.
  useLayoutEffect(() => {
    if (!open || !anchor) return setRect(null);
    setRect(place(anchor, panel.current, minWidth, fitContent));
  }, [open, anchor, minWidth, fitContent, children]);

  useEffect(() => {
    if (!open || !anchor) return;
    const reposition = () => setRect(place(anchor, panel.current, minWidth, fitContent));
    // `true` catches scrolling inside the sidebar, not just the window.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    // Pointerdown, not click: a mousedown that lands elsewhere should dismiss
    // before that element handles its own click.
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, anchor, minWidth, fitContent, onClose]);

  if (!open || !anchor) return null;
  return createPortal(
    <div
      ref={panel}
      className={`popover ${className}`}
      style={{
        top: rect?.top ?? -9999,
        left: rect?.left ?? -9999,
        width: rect?.width,
        maxHeight: rect?.maxHeight,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * A button that opens a popover, with the anchor wiring done once.
 *
 * `render` gets `close` so a menu item can dismiss the panel; a checkbox list
 * simply ignores it and stays open for the next click.
 */
export function PopoverButton({
  label,
  title,
  className = '',
  minWidth,
  fitContent,
  panelClassName,
  render,
}: {
  label: ReactNode;
  title?: string;
  className?: string;
  minWidth?: number;
  fitContent?: boolean;
  panelClassName?: string;
  render: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        title={title}
        className={`popbtn ${className} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="popbtn-label">{label}</span>
      </button>
      <Popover
        open={open}
        anchor={ref.current}
        onClose={() => setOpen(false)}
        minWidth={minWidth}
        fitContent={fitContent}
        className={panelClassName ?? ''}
      >
        {render(() => setOpen(false))}
      </Popover>
    </>
  );
}
