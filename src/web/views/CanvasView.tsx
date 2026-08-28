import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ApiError, api } from '../api.ts';
import { CardBody } from '../components/CardBody.tsx';
import { relations } from '../query.ts';
import { connectOutcome } from '../../view/dropOutcome.ts';
import { groupsFor, labelFor } from './groups.ts';
import { edgesFor } from './edges.ts';
import {
  CONTEXT_BAND,
  assignClusters,
  clusterBoxes,
  clusteredLayout,
  manualLayout,
  treeLayout,
} from './layout.ts';
import { useRequestEnrichment } from '../enrichment.tsx';
import type { NoteDTO, QueryResponse, Meta } from '../types.ts';
import { Button } from '../components/Button.tsx';
import { BulkBar } from '../components/BulkBar.tsx';
import { emptyReason } from '../../view/empty.ts';
import { visibleSelection, type Selection } from '../selection.ts';
import { CommitInput } from '../components/CommitInput.tsx';
import { edgeColour } from '../hue.ts';

/**
 * A canvas node hosts the same `<CardBody>` every other shape renders. That is
 * the requirement React Flow was chosen for: a node is an ordinary React
 * component, so link chips and progress work here with no second implementation.
 *
 * `is-context` nodes are the unmatched ancestors kept so the graph stays
 * connected. They are drawn muted and are never counted as matches — a filter
 * that quietly widens its own result set is a filter you stop trusting.
 */
function RecordNode({ data }: NodeProps) {
  const { card, show, context, onOpen } = data as unknown as {
    card: NoteDTO;
    show: string[];
    context: boolean;
    onOpen: (id: string) => void;
  };
  return (
    <div className={context ? 'is-context' : undefined}>
      {/* React Flow attaches edges to handles. Without them a custom node renders
          fine and every edge is silently dropped.

          Two pairs, because attachment is the first thing a line says: the
          layout relation flows left → right with the ranks, and every other
          relation attaches top and bottom — so a blocked edge and a membership
          edge differ in geometry before colour or dash has to be read. An edge
          naming a handle id that does not exist is silently dropped, so these
          four ids and `buildEdges` must agree. */}
      <Handle id="tree-in" type="target" position={Position.Left} />
      <Handle id="cross-in" type="target" position={Position.Top} />
      <CardBody card={card} showFacets={show} onOpen={onOpen} />
      <Handle id="tree-out" type="source" position={Position.Right} />
      <Handle id="cross-out" type="source" position={Position.Bottom} />
    </div>
  );
}

/**
 * The band behind a cluster, when a canvas is grouped.
 *
 * Not a React Flow parent node: those make member positions relative, and a
 * saved arrangement stores absolute ones. A plain node behind everything keeps
 * arrangement working untouched.
 */
function ClusterNode({ data }: NodeProps) {
  const { value } = data as unknown as { value: string };
  return (
    <div className={`cluster ${value === CONTEXT_BAND ? 'is-context' : ''}`}>
      <span className="cluster-label">{labelFor(value)}</span>
    </div>
  );
}

const nodeTypes = { note: RecordNode, cluster: ClusterNode };

/**
 * Turn the decided edges into React Flow's shape. The decisions — pairing,
 * direction, which type leads — are `edgesFor`; everything here is appearance.
 *
 * No relation is named. Colour is the leading facet's own `hue`, the same one its
 * chips draw in, so a line and a chip for one axis are one colour by
 * construction; there used to be a second three-entry map here, keyed by facet
 * name, which a rename silently emptied.
 *
 * Solid for the relation the canvas is laid out by, dashed for the rest — a
 * property of the *view*, which is what a dash should say, and derivable rather
 * than declared.
 *
 * Text goes on every relation except the layout one, generalising the rule that
 * gave `blocks` a label: the layout relation is the one you can read off the
 * arrangement, and any other line is one you cannot. The words are the facet's
 * `label`, so a vault names its own edges.
 */
function buildEdges(
  raw: { src: string; dst: string; type: string }[],
  facets: Meta['facets'],
  layout: string | null,
): Edge[] {
  return edgesFor(raw, facets).map(({ src, dst, types, lead }) => {
    // Through `hue.ts`, which is also what a chip asks — so a relation's line and
    // its axis's values cannot disagree about the family, and the app's own axis
    // draws its edges in the accent rather than falling to grey.
    const colour = edgeColour(facets[lead]);
    const named = types.filter((t) => t !== layout);
    const tree = lead === layout;
    return {
      id: `${types.join('+')}:${src}->${dst}`,
      source: src,
      target: dst,
      // Two path families, matching the two handle pairs on `RecordNode`: the
      // layout relation curves — a fan of curves to different targets diverges
      // at the source, so forty members are forty traceable lines — and every
      // other relation is drawn straight, cutting against the curved grain at
      // an angle no tree edge takes. Stepped paths with staggered turn lanes
      // were tried between these two and read as circuit traces: orderly, and
      // still one corridor to lose a line in.
      type: tree ? 'default' : 'straight',
      sourceHandle: tree ? 'tree-out' : 'cross-out',
      targetHandle: tree ? 'tree-in' : 'cross-in',
      style: {
        stroke: colour,
        strokeWidth: tree ? 1.6 : 1.4,
        strokeDasharray: tree ? undefined : '6 4',
      },
      // An arrowhead per type, so direction is legible without reading a label.
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: colour },
      // Its fill and step live in `.react-flow__edge-text`, not here — an inline
      // `fontSize` is a type decision the scale test cannot see.
      ...(named.length
        ? { label: named.map((t) => facets[t]?.label ?? t).join(' + ') }
        : {}),
      labelBgStyle: { fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      data: { types, src, dst },
    } satisfies Edge & { pathOptions?: { offset?: number; curvature?: number } };
  });
}

export function CanvasView({
  meta,
  data,
  onOpen,
  selection,
  reload,
  wire,
  onSaved,
}: {
  meta: Meta;
  data: QueryResponse;
  onOpen: (id: string) => void;
  /** Owned by `App` and carried in `?sel=`, so it survives a change of shape. */
  selection: Selection;
  reload: () => void;
  /** The query half of the page URL — what a save notes. */
  wire: string;
  onSaved: (name: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  // Which built array `nodes` was seeded from. State and not a ref: a render that
  // React throws away must not leave behind the note that it happened.
  const [seed, setSeed] = useState<Node[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The vault's first relation, not a name written here — a vault that has no
  // `parent` used to open this control on a relation it does not have.
  const [newRelation, setNewRelation] = useState(relations(meta)[0] ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState(false);
  /**
   * The one edge a click is tracing, by id. Not the selection: selecting an
   * edge's endpoints was tried, and it cannot isolate a line — a hub note is
   * incident to its whole fan, so selecting it lit everything the click was
   * trying to single out. Local state rather than the URL because a trace is a
   * glance, not a place: nothing acts on it, so nothing needs it to survive.
   */
  const [traced, setTraced] = useState<string | null>(null);

  useRequestEnrichment([
    ...new Set(Object.values(data.notes).flatMap((c) => c.links.map((l) => l.raw))),
  ]);

  const built = useMemo(() => {
    const context = new Set(data.context);
    const shown = [...data.ids, ...data.context].map((id) => data.notes[id]).filter(Boolean) as NoteDTO[];
    const stored = data.spec.nodes ?? {};
    // Stored positions only ever come from a saved view. An ad-hoc query has no
    // file to hold arrangement, so it is auto-laid-out — naming a view is what
    // buys manual positioning (C9).
    // Computed by the server, not here: `layout` is the relation this canvas lays
    // out by, and it is the same one `connect` walked for context — two
    // computations of that could disagree.
    //
    // It used to answer a second question too, "which relations point at their
    // container", which is a property of the *relation* rather than the view. So
    // a canvas laid out by `blocks` flipped every blocks edge and dagre put the
    // blocker on the right, while a note inside a project drew two lines
    // instead of one. Every reference points at what it depends on now, so
    // nothing has to say which do.
    const layoutBy = data.layout ? [data.layout] : [];
    // `groupBy` used to be accepted and ignored here, so switching shape never
    // dropped the parameter. It draws now: one band per value of the primary
    // axis, in the order the facet declares.
    // No empty bands: a canvas drag moves a position without changing a facet, so
    // an empty band would be decoration with no affordance.
    const groups = data.groups ? groupsFor(data, { lanes: 'merged', empties: 'drop' }) : [];
    const clustered = groups.length > 0;
    const auto = clustered
      ? clusteredLayout(shown, data.relations, layoutBy, groups, data.spec.show)
      : treeLayout(shown, data.relations, 'LR', layoutBy, data.spec.show);
    const placed = Object.keys(stored).length
      ? manualLayout(shown, data.relations, stored, layoutBy, auto, data.spec.show)
      : auto;

    const rfNodes: Node[] = shown.map((card) => {
      const p = placed.get(card.id)!;
      return {
        id: card.id,
        type: 'note',
        position: { x: p.x, y: p.y },
        // Declared explicitly: the minimap reads dimensions from the user node
        // rather than the measured internals, and dagre has already laid the
        // graph out assuming exactly these.
        width: p.w,
        height: p.h,
        style: { width: p.w, height: p.h },
        // An unmatched ancestor is drawn to keep the graph connected, and is not
        // a match. Selecting one and running a bulk action would edit a note
        // the query never returned — the same widening the `context` split exists
        // to prevent. A band was already unselectable for its own reason.
        selectable: !context.has(card.id),
        data: {
          card,
          show: data.spec.show,
          context: context.has(card.id),
          onOpen,
        },
      };
    });

    const bands: Node[] = clustered
      ? clusterBoxes(assignClusters(shown, groups), placed, groups).map((c) => ({
          id: `cluster:${c.value}`,
          type: 'cluster',
          position: { x: c.x, y: c.y },
          width: c.w,
          height: c.h,
          style: { width: c.w, height: c.h },
          draggable: false,
          selectable: false,
          zIndex: -1,
          data: { value: c.value },
        }))
      : [];

    // Bands first, so a note is always drawn over its own background.
    return { nodes: [...bands, ...rfNodes], edges: buildEdges(data.relations, meta.facets, data.layout) };
  }, [data, onOpen]);

  /**
   * The built nodes, seeded into state so that a drag has somewhere to move them.
   *
   * Done while rendering rather than in an effect, which is React's own answer to
   * "adjust state when the input changes" and here is the difference between a new
   * query arriving in one paint and arriving in two. `edges` below is handed to
   * React Flow straight out of `built`, so the commit that paints the new edges
   * against the previous render's nodes draws every line to a note that is not
   * on the canvas yet — and an effect runs *after* that paint, which makes that
   * frame one you would see.
   *
   * The selection is applied here for the same reason: the effect below owns the
   * URL→nodes direction, and left to it alone the ring would drop off every
   * selected node for a frame whenever the query changed.
   */
  if (seed !== built.nodes) {
    setSeed(built.nodes);
    setNodes(
      built.nodes.map((n) =>
        n.type === 'note' ? { ...n, selected: selection.ids.has(n.id) } : n,
      ),
    );
    setDirty(false);
  }

  /**
   * Node changes, with `select` teed off to the URL.
   *
   * React Flow owns the *gesture* — cmd/ctrl-click adds, a marquee rewrites the
   * lot — and it reports each as a `select` change. Those go to `?sel=`, so the
   * selection outlives this component and a change of shape. One write per batch,
   * so a marquee over nine nodes is one history entry rather than nine.
   *
   * The changes are still applied to the nodes as well, rather than waiting for
   * the URL to come back round: React Flow reads `selected` off the nodes we hand
   * it, and routing the click through a navigation first puts a render between the
   * click and the ring.
   */
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((cur) => applyNodeChanges(changes, cur));
      // Only a finished drag counts as a change worth offering to save.
      if (changes.some((c) => c.type === 'position' && c.dragging === false)) setDirty(true);

      const picks = changes.filter(
        (c): c is NodeChange & { type: 'select'; id: string; selected: boolean } =>
          c.type === 'select',
      );
      if (!picks.length) return;
      // The wider spotlight takes over: node selection answers "what do these
      // connect to", and a lingering trace would mute most of that answer.
      setTraced(null);
      const next = new Set(selection.ids);
      for (const p of picks) {
        if (p.selected) next.add(p.id);
        else next.delete(p.id);
      }
      selection.replace(next);
    },
    [selection],
  );

  /**
   * The other direction: the URL onto the nodes.
   *
   * This is what makes a selection made on a board arrive here, and it is kept
   * out of `built` deliberately — folding `selected` into that memo re-seeds React
   * Flow's store, which is the cost the note on `onOpen` above is about. Returning
   * `cur` unchanged when nothing moved is what stops it fighting the handler above.
   */
  useEffect(() => {
    setNodes((cur) => {
      let moved = false;
      const next = cur.map((n) => {
        if (n.type !== 'note') return n;
        const want = selection.ids.has(n.id);
        if (Boolean(n.selected) === want) return n;
        moved = true;
        return { ...n, selected: want };
      });
      return moved ? next : cur;
    });
  }, [selection.ids, built.nodes]);

  // What the bar writes: `data.ids` is the matched set, so a context node — which
  // is not selectable in any case — could never be written to through it.
  const acting = visibleSelection(selection.ids, data.ids);

  /**
   * Two spotlights, the narrower one first. A traced edge leaves only itself
   * lit — the question a click on a line asks is "this one, where from, where
   * to". A selection leaves every edge touching a selected note — the question
   * there is "what do these connect to". Computed here rather than in
   * `buildEdges` so neither rebuilds the graph.
   */
  const edges = useMemo(() => {
    if (traced && built.edges.some((e) => e.id === traced)) {
      return built.edges.map((e) =>
        e.id === traced ? { ...e, className: 'is-traced', zIndex: 1 } : { ...e, className: 'is-muted' },
      );
    }
    if (!selection.ids.size) return built.edges;
    return built.edges.map((e) =>
      selection.ids.has(e.source) || selection.ids.has(e.target)
        ? e
        : { ...e, className: 'is-muted' },
    );
  }, [built.edges, selection.ids, traced]);

  /**
   * The same spotlight, on the notes. With a trace or a selection active, a
   * note that is neither in it nor at the far end of one of its lit lines
   * recedes with the edges — what stays at full strength is exactly the answer:
   * the traced pair, or the selection and everything one line away from it.
   * Derived from `nodes` (not `built.nodes`) so positions mid-drag are kept.
   */
  const litNodes = useMemo(() => {
    const trace = traced ? built.edges.find((e) => e.id === traced) : undefined;
    let lit: Set<string> | null = null;
    if (trace) lit = new Set([trace.source, trace.target]);
    else if (selection.ids.size) {
      lit = new Set(selection.ids);
      for (const e of built.edges) {
        if (selection.ids.has(e.source)) lit.add(e.target);
        if (selection.ids.has(e.target)) lit.add(e.source);
      }
    }
    if (!lit) return nodes;
    const dark = lit;
    return nodes.map((n) =>
      n.type === 'note' && !dark.has(n.id) ? { ...n, className: 'is-dimmed' } : n,
    );
  }, [nodes, built.edges, selection.ids, traced]);

  /**
   * What the first paint frames: the focused note and its first ring, when the
   * query has a focus — the rest of the graph is what the minimap is for. Without
   * a focus the whole graph fits, floored so fifty notes cannot open as slivers.
   */
  const fitTarget = useMemo(() => {
    const id = data.spec.query.focus?.id;
    if (!id || !data.notes[id]) return null;
    const near = new Set([id]);
    for (const r of data.relations) {
      if (r.src === id) near.add(r.dst);
      if (r.dst === id) near.add(r.src);
    }
    return [...near].map((n) => ({ id: n }));
  }, [data]);

  /**
   * Positions go to the view file, never to a card: views own arrangement, so the
   * same card can sit at a different place on each saved view.
   *
   * `title` is set when this is a *save as*: the view does not exist yet, so it
   * has to be created before it can hold anything. That ordering is the whole
   * shape of C9 — naming the query is what creates somewhere for the layout to
   * live.
   */
  const savePositions = async (name: string, title?: string) => {
    setSaving(true);
    setProblem(null);
    try {
      const payload: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) payload[n.id] = { x: n.position.x, y: n.position.y };
      if (title) {
        const saved = await api.saveView(name, wire, title);
        await api.saveArrangement(saved.name, { nodes: payload });
        setDirty(false);
        onSaved(saved.name);
        return;
      }
      await api.saveArrangement(name, { nodes: payload });
      setDirty(false);
      reload();
    } catch (err) {
      setProblem((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Dragging between handles adds a value to the selected relation.
   *
   * A relation is a reference facet, so this is an ordinary facet write — the
   * same call the note panel and the bulk bar make. A hierarchy is drawn
   * container → member, so the value lands on the *target* note and points
   * back at the source; `single: true` on the facet is what makes a second
   * parent replace the first rather than stack on it.
   */
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      const intent = connectOutcome({
        source: c.source,
        target: c.target,
        relation: newRelation,
        facets: meta.facets,
        // The server's answer to "which relation is the hierarchy", which is why it
        // is in the payload at all. This used to re-derive it from `single`.
        layout: data.layout,
        valuesOf: (id) => data.notes[id]?.facets[newRelation] ?? [],
      });
      if (intent.kind !== 'facet') return;
      setProblem(null);
      // The same targeted write the board uses: only this facet, and the values
      // computed per note. The old call spread the whole facet map from a
      // possibly-stale payload, so an unrelated change could be reverted.
      api
        .bulk({
          ids: intent.ids,
          op: 'move',
          moves: intent.moves,
          dragMode: intent.mode,
        })
        .then(() => reload())
        .catch((e: ApiError) => setProblem(e.message));
    },
    [data.notes, data.layout, meta.facets, newRelation, reload],
  );

  const addRecord = async () => {
    const title = prompt('New note. Title:');
    if (!title?.trim()) return;
    try {
      // No facets: a note with no status is not on any status-filtered board,
      // which is what "just a node" ever meant.
      await api.createNote({ title: title.trim() });
      reload();
    } catch (err) {
      setProblem((err as ApiError).message);
    }
  };

  /*
   * The canvas had no empty state at all — an empty graph is a blank plane with
   * a minimap on it, which is the least legible of the three ways to draw
   * nothing. It gets the same sentence the other two shapes get, over the top of
   * the plane rather than instead of it: the toolbar's `+ node` is right there
   * and is the way out of the state.
   */
  const empty = emptyReason(meta, data);

  return (
    <div className="canvas-wrap">
      {problem && <div className="banner is-bad">{problem}</div>}
      {/*
        `⏎` opens, the way it does on every other surface.

        React Flow's own keyboard a11y is deliberately left on: it is what makes a
        node Tab-reachable, `space` select it and the arrows move a selected one,
        and reimplementing those to own the whole grammar would be three
        mechanisms rebuilt to change one. What it also claims is `⏎`, which it
        treats as a second select — so the one key the rest of the app spends on
        *open* did nothing here but re-select what was already selected.

        Taken back in the capture phase rather than by turning its a11y off:
        React attaches at the root, so a capture listener on this element runs
        before the node's own handler and `stopPropagation` is enough to keep the
        key. `space` and the arrows fall through untouched, which is the half
        worth keeping.
      */}
      <div
        className="canvas"
        onKeyDownCapture={(e) => {
          if (e.key !== 'Enter') return;
          const node = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node');
          const id = node?.dataset.id;
          if (!id) return;
          e.stopPropagation();
          e.preventDefault();
          onOpen(id);
        }}
      >
        {empty && <div className="emptystate canvas-empty">{empty.text}</div>}
        <ReactFlow
          nodes={litNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          /*
           * The first paint is capped both ways: never enlarged past 1:1, never
           * fitted below readability — a keycloak-sized view used to open at 5%,
           * which said "there is a column" and nothing else. When the query has
           * a focus the fit frames that instead of the universe, in `onInit`,
           * so the plain `fitView` is off for that case rather than flashing
           * one framing before the other.
           */
          fitView={!fitTarget}
          fitViewOptions={{ maxZoom: 1, minZoom: 0.4 }}
          onInit={(inst) => {
            if (fitTarget) void inst.fitView({ nodes: fitTarget, maxZoom: 1, minZoom: 0.4, padding: 0.15 });
          }}
          minZoom={0.02}
          maxZoom={2}
          elementsSelectable
          /*
           * A line you cannot trace is a question; clicking it is the answer:
           * every other edge recedes, leaving the one line and its two ends. A
           * second click on it, a click on the pane, or selecting any note
           * releases it.
           */
          onEdgeClick={(_, edge) => setTraced((t) => (t === edge.id ? null : edge.id))}
          onPaneClick={() => setTraced(null)}
          /*
           * React Flow deletes the selected nodes on Backspace by default, and
           * `elementsSelectable` means there is always something selected to
           * delete. The change went through `applyNodeChanges` and the node left
           * the canvas — with no request sent and nothing to undo it but a
           * reload, which brought the card straight back. It read as a delete
           * that had silently failed, when nothing had been asked of the server
           * at all.
           *
           * Deleting a note is `bulkDelete` behind a confirm, because the files
           * are the vault. A keystroke that bypasses both is not a shortcut for
           * it, so the key is turned off rather than rebound.
           */
          deleteKeyCode={null}
          /*
           * Selecting is what a click means; moving is what a drag means.
           *
           * React Flow selects from two places, and the source says so at
           * `handleNodeClick`: the click handler, and — under `selectNodesOnDrag`
           * — drag start. The click branch is already live, because it runs
           * whenever `nodeDragThreshold > 0` and the default threshold is 1. So
           * the drag-start copy was never what made click-to-select work; it only
           * gave dragging a second meaning, and repositioning a card selected it
           * whether or not that was the point.
           */
          selectNodesOnDrag={false}
          /*
           * And a click is allowed to wobble. At the default of one pixel a twitch
           * during a click is a drag, which emits a `position` change and trips
           * `setDirty` above — so a canvas you had only clicked at started
           * offering to save a layout you never moved.
           */
          nodeDragThreshold={4}
          onNodeDoubleClick={(_, n) => onOpen(n.id)}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dot)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" />
        </ReactFlow>

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
          What floats here is what only a canvas can do *and* only while a canvas
          is open: creating a relation by dragging, adding a note, saving a
          layout. Which facets are drawn is `show`, which every shape has, so it
          lives in the rail — and keeping context is now a property of the shape
          rather than a control, since nothing but a canvas ever honoured it.
        */}
        <div className="canvas-float" data-navlist="toolbar" data-nav-flow="row">
          <label className="relationpick">
            drag creates
            <select
              data-nav="relation"
              data-rail="relation"
              value={newRelation}
              onChange={(e) => setNewRelation(e.target.value)}
            >
              {relations(meta).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>

          <Button size="small" data-nav="act" onClick={() => void addRecord()}>
            + note
          </Button>
          {dirty && !naming && (
            <Button
              tone="primary" size="small"
              data-nav="act"
              disabled={saving}
              onClick={() => {
                const name = data.spec.name;
                if (name) void savePositions(name);
                // An ad-hoc query has nowhere to put positions. Naming it is the
                // act that creates somewhere.
                else setNaming(true);
              }}
            >
              {saving ? 'saving…' : data.spec.name ? 'Save layout' : 'Save as view…'}
            </Button>
          )}
          {naming && (
            <CommitInput
              placeholder="view name"
              wrapper={{ tag: 'span', className: 'saveas' }}
              onCancel={() => setNaming(false)}
              onCommit={(title) => {
                setNaming(false);
                void savePositions(title, title);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Naming an ad-hoc canvas so it can hold a layout.
 *
 * This is the materialisation step, not a convenience: arrangement lives in a
 * file, so it needs a file to live in.
 *
 * The typed name goes up verbatim. The server derives the slug and returns it,
 * so there is one answer to "what is this view called" (C11) — slugging here too
 * meant a third implementation of it, and it also slugged the *title*, so
 * "Project A Portfolio" was saved as `project-a-portfolio`.
 */

