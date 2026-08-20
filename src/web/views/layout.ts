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
} as const;

export type SizeName = keyof typeof SIZE;

function asSize(v: string | undefined): SizeName | undefined {
  return v === 'chip' || v === 'card' ? v : undefined;
}

/**
 * The size a record renders at: the view's `face.size`, then the record's nature.
 *
 * The per-node override is gone — it was reachable by nothing, and it was the
 * last thing keeping arrangement on a card rather than in a view.
 *
 * There is deliberately no count-based rule. Shrinking cards once a canvas gets
 * busy would mean the same card looked different depending on how many neighbours
 * it happened to have, and past a hundred records nothing is legible at fit-zoom
 * in any size — you zoom in, or you narrow the query.
 */
export function sizeFor(card: CardDTO, viewSize?: string): SizeName {
  // Nodes are thinking scaffolding — a title is all they need.
  if (card.kind === 'node' && !card.isProject) return 'chip';
  // Projects keep their face even in a compact view: they are the landmarks.
  const fromView = asSize(viewSize);
  if (fromView && !card.isProject) return fromView;
  return 'card';
}

export function dims(card: CardDTO, viewSize?: string): { w: number; h: number } {
  return SIZE[sizeFor(card, viewSize)];
}

/**
 * Which edge types give a canvas its shape.
 *
 * `parent` is decomposition and `member-of` is membership — both are hierarchies,
 * so either can lay a graph out. `blocks` and `relates` are drawn but never fed
 * to dagre: a blocker pointing sideways across the tree would distort every rank
 * it crosses.
 *
 * This has to follow what is *shown*, not just `parent`. A member-of canvas has
 * no parent edges at all, and laying it out by parent put 27 records in one
 * column with the hierarchy invisible.
 */
const HIERARCHY = ['parent', 'member-of'];

export function layoutTypes(shown: string[]): string[] {
  const usable = shown.filter((t) => HIERARCHY.includes(t));
  return usable.length ? usable : ['parent'];
}

/**
 * Left-to-right tree layout via dagre, which reproduces the shape of the
 * original mind-map.
 */
export function treeLayout(
  nodes: CardDTO[],
  edges: { src: string; dst: string; type: string }[],
  direction: 'LR' | 'TB' = 'LR',
  viewSize?: string,
  hierarchy: string[] = ['parent'],
): Map<string, Placed> {
  const tight = asSize(viewSize) === 'chip';
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
    const { w, h } = dims(n, viewSize);
    g.setNode(n.id, { width: w, height: h });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const feeds = new Set(hierarchy);
  for (const e of edges) {
    // Both hierarchy edges point child → parent and member → container; dagre
    // wants container → member so the roots sit on the left and the tree opens
    // outward.
    if (!feeds.has(e.type) || !ids.has(e.src) || !ids.has(e.dst)) continue;
    g.setEdge(e.dst, e.src);
  }

  dagre.layout(g);

  const out = new Map<string, Placed>();
  for (const n of nodes) {
    const gn = g.node(n.id) as { x: number; y: number; width: number; height: number } | undefined;
    const { w, h } = dims(n, viewSize);
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

/**
 * Stored positions where present, dagre for the rest.
 *
 * `stored` only ever arrives from a saved view: an ad-hoc query has no file to
 * hold arrangement, so naming a view is what buys manual positioning (C9).
 */
export function manualLayout(
  nodes: CardDTO[],
  edges: { src: string; dst: string; type: string }[],
  stored: Record<string, { x?: number; y?: number }>,
  viewSize?: string,
  hierarchy: string[] = ['parent'],
): Map<string, Placed> {
  const fallback = treeLayout(nodes, edges, 'LR', viewSize, hierarchy);
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
