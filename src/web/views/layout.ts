import dagre from '@dagrejs/dagre';
import type { CardDTO } from '../types.ts';

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const SIZE = {
  chip: { w: 210, h: 44 },
  card: { w: 268, h: 116 },
  expanded: { w: 460, h: 340 },
} as const;

export type SizeName = keyof typeof SIZE;

function asSize(v: string | undefined): SizeName | undefined {
  return v === 'chip' || v === 'card' || v === 'expanded' ? v : undefined;
}

/**
 * The size a record renders at, in precedence order:
 *   the node's own `size:` → the canvas `defaultSize:` → the record's nature.
 *
 * There is deliberately no count-based rule here. Shrinking cards once a canvas
 * gets busy would mean the same card looked different depending on how many
 * neighbours it happened to have, and at a hundred-plus records nothing is
 * legible at fit-zoom in any size — you zoom in, or you scope the canvas. When
 * a dense overview *is* what's wanted, the canvas file says so in one line.
 */
export function sizeFor(card: CardDTO, requested?: string, viewDefault?: string): SizeName {
  const explicit = asSize(requested);
  if (explicit) return explicit;
  // Nodes are thinking scaffolding — a title is all they need.
  if (card.kind === 'node' && !card.isProject) return 'chip';
  // Projects keep their face even in a compact view: they are the landmarks.
  const fromView = asSize(viewDefault);
  if (fromView && !card.isProject) return fromView;
  return 'card';
}

export function dims(card: CardDTO, requested?: string, viewDefault?: string): { w: number; h: number } {
  return SIZE[sizeFor(card, requested, viewDefault)];
}

/**
 * Left-to-right tree layout via dagre, which reproduces the shape of the
 * original mind-map. `parent` edges define the hierarchy; other edge types are
 * drawn but excluded from layout so a `blocks` edge cannot distort the tree.
 */
export function treeLayout(
  nodes: CardDTO[],
  edges: { src: string; dst: string; type: string }[],
  stored: Record<string, { size?: string }>,
  direction: 'LR' | 'TB' = 'LR',
  viewDefault?: string,
): Map<string, Placed> {
  const tight = asSize(viewDefault) === 'chip';
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: tight ? 12 : 26,
    ranksep: tight ? 80 : 110,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    const { w, h } = dims(n, stored[n.id]?.size, viewDefault);
    g.setNode(n.id, { width: w, height: h });
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    // A parent edge points child → parent; dagre wants parent → child so the
    // roots sit on the left and the tree opens outward.
    if (e.type !== 'parent' || !ids.has(e.src) || !ids.has(e.dst)) continue;
    g.setEdge(e.dst, e.src);
  }

  dagre.layout(g);

  const out = new Map<string, Placed>();
  for (const n of nodes) {
    const gn = g.node(n.id) as { x: number; y: number; width: number; height: number } | undefined;
    const { w, h } = dims(n, stored[n.id]?.size, viewDefault);
    out.set(n.id, {
      id: n.id,
      x: (gn?.x ?? 0) - w / 2,
      y: (gn?.y ?? 0) - h / 2,
      w,
      h,
    });
  }
  return out;
}

/** Stored positions where present, dagre for the rest. */
export function manualLayout(
  nodes: CardDTO[],
  edges: { src: string; dst: string; type: string }[],
  stored: Record<string, { x?: number; y?: number; size?: string }>,
  viewDefault?: string,
): Map<string, Placed> {
  const fallback = treeLayout(nodes, edges, stored, 'LR', viewDefault);
  const out = new Map<string, Placed>();
  for (const n of nodes) {
    const s = stored[n.id];
    const base = fallback.get(n.id)!;
    out.set(n.id, {
      ...base,
      x: s?.x ?? base.x,
      y: s?.y ?? base.y,
    });
  }
  return out;
}
