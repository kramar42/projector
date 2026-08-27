import dagre from '@dagrejs/dagre';
import type { NoteDTO } from '../types.ts';

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One face width, for every note.
 *
 * There used to be a smaller `chip` face for plain nodes, on the reasoning that
 * a node has no facets to draw. It does not hold: a node carries facets like
 * anything else, and how much of a note to draw is a property of the *view* —
 * that is what `show` is — not of the note. Two faces meant the same card
 * changed shape depending on a stored field, which is the tell.
 *
 * There is deliberately no count-based rule either. Shrinking cards once a
 * canvas gets busy would mean the same card looked different depending on how
 * many neighbours it happened to have, and past a hundred notes nothing is
 * legible at fit-zoom in any size — you zoom in, or you narrow the query.
 */
const FACE_W = 268;

/**
 * Height metrics, read off the stylesheet the face renders with. The height
 * used to be one constant too — 116px — and it lied: dagre spaced rows for that
 * while a face with a wrapped title, a chip row, a meta line and links rendered
 * at twice it. Measured on a real vault, 42 of 55 nodes drew past their
 * declared height, the worst at 233px — literally covering the card beneath.
 *
 * An estimate, deliberately biased a few pixels tall: a card estimated short
 * overlaps its neighbour, one estimated tall costs whitespace.
 */
const INNER = 246;      // FACE_W minus the face's 10px side padding and border
const CH_TITLE = 6.8;   // px per character at 13px
const CH_BODY = 6.2;    // at 12px
const CH_CHIP = 6;      // at 10px mono
const LINE_TITLE = 18;  // 13px × 1.35
const LINE_BODY = 17;   // 12px × 1.4
const ROW_CHIP = 20;    // a chip's text, padding and border
const ROW_META = 16;    // the 10.5px mono meta line
const CHIP_GAP = 4;
const BLOCK_GAP = 6;    // the face's own flex gap
const FRAME = 26;       // 9px padding × 2, 1px border × 2, and slack

/** How many rows a run of chips takes, filled greedily the way flex wraps. */
function chipRows(widths: number[]): number {
  let rows = 0;
  let x = Infinity;
  for (const w of widths) {
    if (x + CHIP_GAP + w > INNER) {
      rows++;
      x = w;
    } else x += CHIP_GAP + w;
  }
  return rows;
}

export function dims(card: NoteDTO, show: string[] = []): { w: number; h: number } {
  const blocks: number[] = [];
  // The title, clamped to two lines on a canvas node; the mark takes ~20px.
  blocks.push(
    Math.min(2, Math.max(1, Math.ceil((card.title.length * CH_TITLE) / (INNER - 20)))) * LINE_TITLE,
  );
  // Facet chips — the same axes `axisValues` answers for the face.
  const chips = show.flatMap((f) => card.facets[f] ?? card.computed[f] ?? []);
  if (chips.length) {
    blocks.push(chipRows(chips.map((v) => v.length * CH_CHIP + 14)) * (ROW_CHIP + CHIP_GAP) - CHIP_GAP);
  }
  // The meta line renders whenever the face has progress, blockers or links —
  // empty when only links do, but an empty block still takes its flex gap.
  const blockedNow = card.blockedBy.some((b) => !b.done);
  if (card.progress || blockedNow || card.links.length) {
    blocks.push(card.progress || blockedNow || card.unblocks.length ? ROW_META : 0);
  }
  // Up to three link chips, plus the overflow count. Enrichment lengthens a
  // label after layout — a Jira key becomes its summary — so any enrichable
  // kind is sized at the label cap plus glyph and badge, not at its raw ref.
  if (card.links.length) {
    const widths = card.links
      .slice(0, 3)
      .map((l) => (l.kind === 'url' || l.kind === 'slack' ? Math.min(l.label.length * CH_CHIP, 130) + 28 : 174));
    if (card.links.length > 3) widths.push(34);
    blocks.push(chipRows(widths) * (ROW_CHIP + CHIP_GAP) - CHIP_GAP);
  }
  // The excerpt, clamped to two lines, drawn only when no progress bar is.
  if (card.excerpt && !card.progress) {
    blocks.push(Math.min(2, Math.ceil((card.excerpt.length * CH_BODY) / INNER)) * LINE_BODY);
  }
  const h = FRAME + blocks.reduce((a, b) => a + b, 0) + BLOCK_GAP * (blocks.length - 1);
  return { w: FACE_W, h: Math.max(56, Math.round(h)) };
}

/**
 * Where fan-out stops being a tree. dagre gives every member its own row, so a
 * project whose forty members contain nothing of their own was a forty-card
 * pillar — scrolled, never read. From this many childless members of one
 * container, they lay out as a grid instead.
 */
const WRAP_AT = 6;

/** Grid gutters, matching `nodesep` so wrapped and ranked spacing agree. */
const GAP = 26;

/**
 * The grid a brood takes: roughly square in cards, wide in pixels. Row heights
 * follow the tallest face in each row, since faces are sized by their content.
 */
function gridFor(
  leaves: string[],
  size: Map<string, { w: number; h: number }>,
): { cols: number; rowH: number[]; w: number; h: number } {
  const cols = Math.max(2, Math.round(Math.sqrt(leaves.length)));
  const rowH: number[] = [];
  leaves.forEach((id, i) => {
    const row = Math.floor(i / cols);
    rowH[row] = Math.max(rowH[row] ?? 0, size.get(id)!.h);
  });
  return {
    cols,
    rowH,
    w: cols * FACE_W + (cols - 1) * GAP,
    h: rowH.reduce((a, b) => a + b, 0) + (rowH.length - 1) * GAP,
  };
}

/** Ids are slugs, so a colon cannot collide with a note. */
const gridId = (container: string) => `wrap:${container}`;

/**
 * Left-to-right tree layout via dagre, which reproduces the shape of the
 * original mind-map.
 */
export function treeLayout(
  nodes: NoteDTO[],
  edges: { src: string; dst: string; type: string }[],
  direction: 'LR' | 'TB' = 'LR',
  layoutBy: string[],
  show: string[] = [],
): Map<string, Placed> {
  const size = new Map(nodes.map((n) => [n.id, dims(n, show)]));
  const ids = new Set(nodes.map((n) => n.id));
  const feeds = new Set(layoutBy);
  const live = edges.filter((e) => feeds.has(e.type) && ids.has(e.src) && ids.has(e.dst));

  // Which containers hold which members. Members keep the payload's order — the
  // view's own sort — so a wrapped grid reads left → right, top → bottom in the
  // same order a board column would have listed.
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const kids = new Map<string, string[]>();
  for (const e of live) {
    const got = kids.get(e.dst);
    if (got) got.push(e.src);
    else kids.set(e.dst, [e.src]);
  }

  // A brood wraps: enough members holding nothing of their own become one
  // virtual node for dagre, expanded into a grid after layout. A member that
  // contains anything stays in the tree — it has structure the grid would
  // flatten. A leaf under two containers goes to the first, the rule
  // `assignClusters` already follows.
  const swallowed = new Map<string, string>();
  const broods = new Map<string, string[]>();
  for (const [container, members] of kids) {
    const leaves = members
      .filter((m) => !kids.has(m) && !swallowed.has(m))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    if (leaves.length < WRAP_AT) continue;
    broods.set(container, leaves);
    for (const l of leaves) swallowed.set(l, container);
  }

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
    if (swallowed.has(n.id)) continue;
    const { w, h } = size.get(n.id)!;
    g.setNode(n.id, { width: w, height: h });
  }
  for (const [container, leaves] of broods) {
    const grid = gridFor(leaves, size);
    g.setNode(gridId(container), { width: grid.w, height: grid.h });
  }

  const into = (id: string) => (swallowed.has(id) ? gridId(swallowed.get(id)!) : id);
  for (const e of live) {
    // Always the other way round. A reference is stored on the note that
    // depends and points at what it depends on; dagre wants container → member,
    // so the roots sit on the left and the tree opens outward.
    //
    // This used to take a list of which relations to flip, because `blocks` was
    // stored pointing away from its own root and laying a canvas out by it
    // produced a backwards chain. Inverting that relation retired the list.
    const src = into(e.dst);
    const dst = into(e.src);
    if (src !== dst) g.setEdge(src, dst);
  }

  dagre.layout(g);

  const out = new Map<string, Placed>();
  for (const n of nodes) {
    if (swallowed.has(n.id)) continue;
    const gn = g.node(n.id) as { x: number; y: number; width: number; height: number } | undefined;
    const { w, h } = size.get(n.id)!;
    out.set(n.id, {
      id: n.id,
      x: (gn?.x ?? 0) - w / 2,
      y: (gn?.y ?? 0) - h / 2,
      w,
      h,
    });
  }
  for (const [container, leaves] of broods) {
    const gn = g.node(gridId(container)) as { x: number; y: number } | undefined;
    const grid = gridFor(leaves, size);
    const left = (gn?.x ?? 0) - grid.w / 2;
    const top = (gn?.y ?? 0) - grid.h / 2;
    let rowTop = top;
    leaves.forEach((id, i) => {
      const col = i % grid.cols;
      const row = Math.floor(i / grid.cols);
      if (i > 0 && col === 0) rowTop += grid.rowH[row - 1]! + GAP;
      out.set(id, {
        id,
        x: left + col * (FACE_W + GAP),
        y: rowTop,
        w: FACE_W,
        h: size.get(id)!.h,
      });
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
  nodes: NoteDTO[],
  edges: { src: string; dst: string; type: string }[],
  stored: Record<string, { x?: number; y?: number }>,
  layoutBy: string[],
  computed?: Map<string, Placed>,
  show: string[] = [],
): Map<string, Placed> {
  const fallback = computed ?? treeLayout(nodes, edges, 'LR', layoutBy, show);
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

/** Where the notes that matched nothing on the grouping axis are drawn. */
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
 * Which cluster each note is drawn in.
 *
 * A note with several values on the grouping axis belongs to several groups —
 * that is the model working, and a board draws it in each. A canvas cannot: a
 * node has one position. So it is drawn in the **first** group the axis declares,
 * and the sidebar says how many notes that applies to rather than letting the
 * count quietly disagree with the board.
 *
 * Notes kept for context matched no group at all, so they get a band of their
 * own instead of being scattered through the others.
 */
export function assignClusters(
  nodes: NoteDTO[],
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
  nodes: NoteDTO[],
  edges: { src: string; dst: string; type: string }[],
  layoutBy: string[],
  groups: { value: string; ids: string[] }[],
  show: string[] = [],
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
      show,
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
