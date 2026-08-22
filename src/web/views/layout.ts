import dagre from '@dagrejs/dagre';
import type { CardDTO } from '../types.ts';
import { INWARD_REFS } from '../../schema/vocabulary.ts';

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One face, for every record.
 *
 * There used to be a smaller `chip` face for plain nodes, on the reasoning that
 * a node has no facets to draw. It does not hold: a node carries facets like
 * anything else, and how much of a record to draw is a property of the *view* —
 * that is what `chips` is — not of the record. Two faces meant the same card
 * changed shape depending on a stored field, which is the tell.
 *
 * There is deliberately no count-based rule either. Shrinking cards once a
 * canvas gets busy would mean the same card looked different depending on how
 * many neighbours it happened to have, and past a hundred records nothing is
 * legible at fit-zoom in any size — you zoom in, or you narrow the query.
 */
const FACE = { w: 268, h: 116 } as const;

export function dims(_card: CardDTO): { w: number; h: number } {
  return FACE;
}

/**
 * Left-to-right tree layout via dagre, which reproduces the shape of the
 * original mind-map.
 */
export function treeLayout(
  nodes: CardDTO[],
  edges: { src: string; dst: string; type: string }[],
  direction: 'LR' | 'TB' = 'LR',
  layoutBy: string[] = ['parent'],
  inward: readonly string[] = INWARD_REFS,
): Map<string, Placed> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: 26,
    ranksep: 110,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    const { w, h } = dims(n);
    g.setNode(n.id, { width: w, height: h });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const feeds = new Set(layoutBy);
  const points = new Set(inward);
  for (const e of edges) {
    if (!feeds.has(e.type) || !ids.has(e.src) || !ids.has(e.dst)) continue;
    // Which relation defines the tree and which way that relation is stored are
    // two questions, and one parameter used to answer both. `parent` and
    // `project` point child → parent and member → container, and dagre wants
    // container → member so the roots sit on the left and the tree opens
    // outward. `blocks` already points away from its root, so flipping it laid
    // the chain out backwards — which only showed once a canvas was laid out by
    // something other than `parent`.
    if (points.has(e.type)) g.setEdge(e.dst, e.src);
    else g.setEdge(e.src, e.dst);
  }

  dagre.layout(g);

  const out = new Map<string, Placed>();
  for (const n of nodes) {
    const gn = g.node(n.id) as { x: number; y: number; width: number; height: number } | undefined;
    const { w, h } = dims(n);
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
  layoutBy: string[] = ['parent'],
  inward: readonly string[] = INWARD_REFS,
  computed?: Map<string, Placed>,
): Map<string, Placed> {
  const fallback = computed ?? treeLayout(nodes, edges, 'LR', layoutBy, inward);
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

// ---------------------------------------------------------------- clusters

/** Where the records that matched nothing on the grouping axis are drawn. */
export const CONTEXT_BAND = '(context)';

export interface Cluster {
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 26;
const LABEL = 24;
/**
 * The vertical step between two bands' *contents*.
 *
 * A box is drawn `PAD + LABEL` above its topmost member and `PAD` below its
 * lowest, so the step has to clear both or consecutive boxes overlap. This is
 * that sum plus a visible gap.
 */
const BAND = PAD * 2 + LABEL + 20;

/**
 * Which cluster each record is drawn in.
 *
 * A record with several values on the grouping axis belongs to several groups —
 * that is the model working, and a board draws it in each. A canvas cannot: a
 * node has one position. So it is drawn in the **first** group the axis declares,
 * and the sidebar says how many records that applies to rather than letting the
 * count quietly disagree with the board.
 *
 * Records kept for context matched no group at all, so they get a band of their
 * own instead of being scattered through the others.
 */
export function assignClusters(
  nodes: CardDTO[],
  groups: { value: string; ids: string[] }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) {
    for (const id of g.ids) if (!out.has(id)) out.set(id, g.value);
  }
  for (const n of nodes) if (!out.has(n.id)) out.set(n.id, CONTEXT_BAND);
  return out;
}

/** The cluster values that actually hold something, in axis order. */
function bands(assign: Map<string, string>, groups: { value: string }[]): string[] {
  const live = new Set(assign.values());
  const declared = groups.map((g) => g.value).filter((v) => live.has(v));
  return live.has(CONTEXT_BAND) ? [...declared, CONTEXT_BAND] : declared;
}

/**
 * Lay each cluster out on its own, then stack the clusters vertically.
 *
 * Only edges with both ends inside a cluster feed dagre: one crossing the
 * boundary would drag a member toward a rank in another cluster and pull the
 * band apart.
 */
export function clusteredLayout(
  nodes: CardDTO[],
  edges: { src: string; dst: string; type: string }[],
  layoutBy: string[],
  groups: { value: string; ids: string[] }[],
  inward: readonly string[] = INWARD_REFS,
): Map<string, Placed> {
  const assign = assignClusters(nodes, groups);
  const placed = new Map<string, Placed>();
  let top = 0;

  for (const value of bands(assign, groups)) {
    const members = nodes.filter((n) => assign.get(n.id) === value);
    if (!members.length) continue;
    const ids = new Set(members.map((m) => m.id));
    const inner = treeLayout(
      members,
      edges.filter((e) => ids.has(e.src) && ids.has(e.dst)),
      'LR',
      layoutBy,
      inward,
    );
    const xs = [...inner.values()].map((p) => p.x);
    const ys = [...inner.values()].map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    let bottom = top;
    for (const [id, p] of inner) {
      const moved = { ...p, x: p.x - minX, y: p.y - minY + top };
      placed.set(id, moved);
      bottom = Math.max(bottom, moved.y + moved.h);
    }
    top = bottom + BAND;
  }
  return placed;
}

/**
 * The box drawn behind each cluster, from where its members actually are.
 *
 * Derived from final positions rather than from the layout pass, so a dragged
 * card grows its band and a saved arrangement is respected without the two
 * needing to agree about anything.
 */
export function clusterBoxes(
  assign: Map<string, string>,
  placed: Map<string, Placed>,
  groups: { value: string }[],
): Cluster[] {
  const out: Cluster[] = [];
  for (const value of bands(assign, groups)) {
    const members = [...placed.entries()].filter(([id]) => assign.get(id) === value);
    if (!members.length) continue;
    const x = Math.min(...members.map(([, p]) => p.x));
    const y = Math.min(...members.map(([, p]) => p.y));
    const right = Math.max(...members.map(([, p]) => p.x + p.w));
    const bottom = Math.max(...members.map(([, p]) => p.y + p.h));
    out.push({
      value,
      x: x - PAD,
      y: y - PAD - LABEL,
      w: right - x + PAD * 2,
      h: bottom - y + PAD * 2 + LABEL,
    });
  }
  return out;
}
