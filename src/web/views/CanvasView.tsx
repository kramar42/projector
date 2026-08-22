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
import type { CardDTO, QueryResponse, Meta } from '../types.ts';
import { Button } from '../components/Button.tsx';
import { CommitInput } from '../components/CommitInput.tsx';

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
    card: CardDTO;
    show: string[];
    context: boolean;
    onOpen: (id: string) => void;
  };
  return (
    <div className={context ? 'is-context' : undefined}>
      {/* React Flow attaches edges to handles. Without them a custom node renders
          fine and every edge is silently dropped. */}
      <Handle type="target" position={Position.Left} />
      <CardBody card={card} showFacets={show} onOpen={onOpen} />
      <Handle type="source" position={Position.Right} />
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

const nodeTypes = { record: RecordNode, cluster: ClusterNode };

/**
 * How each relation draws. "Edge" below is React Flow's word for a line — the
 * model has only facets, and a *reference* facet is what puts one on screen.
 */
const RELATION_COLOUR: Record<string, string> = {
  parent: 'var(--rel-parent)',
  blocks: 'var(--rel-blocks)',
  project: 'var(--rel-project)',
};

const DASH: Record<string, string | undefined> = {
  blocks: '6 4',
  project: '1 3',
};

/**
 * Turn the decided edges into React Flow's shape. The decisions — pairing,
 * direction, which type leads — are `edgesFor`; everything here is appearance.
 */
function buildEdges(
  raw: { src: string; dst: string; type: string }[],
  hierarchy: string[],
): Edge[] {
  return edgesFor(raw, hierarchy).map(({ src, dst, types, lead }) => {
    const colour = RELATION_COLOUR[lead] ?? 'var(--rel-parent)';
    return {
      id: `${types.join('+')}:${src}->${dst}`,
      source: src,
      target: dst,
      type: 'smoothstep',
      style: { stroke: colour, strokeWidth: lead === 'parent' ? 1.6 : 1.4, strokeDasharray: DASH[lead] },
      // An arrowhead per type, so direction is legible without reading a label.
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: colour },
      // Only `blocks` earns text: it is the one relationship you cannot infer
      // from the layout. Neutral, because a label inherits the edge colour as its
      // fill otherwise, and a red word floating over a graph reads as an error.
      ...(types.includes('blocks') ? { label: types.length > 1 ? types.join(' + ') : 'blocks' } : {}),
      labelStyle: { fill: 'var(--ink-2)', fontSize: 10 },
      labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      data: { types, src, dst },
    } satisfies Edge;
  });
}

export function CanvasView({
  meta,
  data,
  onOpen,
  reload,
  wire,
  onSaved,
}: {
  meta: Meta;
  data: QueryResponse;
  onOpen: (id: string) => void;
  reload: () => void;
  /** The query half of the page URL — what a save records. */
  wire: string;
  onSaved: (name: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [newRelation, setNewRelation] = useState('parent');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState(false);

  useRequestEnrichment([
    ...new Set(Object.values(data.cards).flatMap((c) => c.links.map((l) => l.raw))),
  ]);

  const built = useMemo(() => {
    const context = new Set(data.context);
    const shown = [...data.ids, ...data.context].map((id) => data.cards[id]).filter(Boolean) as CardDTO[];
    const stored = data.spec.nodes ?? {};
    // Stored positions only ever come from a saved view. An ad-hoc query has no
    // file to hold arrangement, so it is auto-laid-out — naming a view is what
    // buys manual positioning (C9).
    // Both computed by the server, not here. `layout` is the relation this canvas
    // lays out by — the same one `connect` walked for context, and two
    // computations of that could disagree. `hierarchies` is which relations point
    // at their container.
    //
    // One value used to serve both, and they are different questions: a canvas
    // laid out by `blocks` flipped every blocks edge, so the chain read "is
    // blocked by" while the label said `blocks`, and dagre put the blocker on the
    // right. It also meant a record inside a project drew two lines instead of
    // one, because the `parent` edge flipped and the `project` edge beside it did
    // not — defeating the collapse `edgesFor` exists to do.
    const layoutBy = data.layout ? [data.layout] : [];
    const inward = data.hierarchies;
    // `groupBy` used to be accepted and ignored here, so switching shape never
    // dropped the parameter. It draws now: one band per value of the primary
    // axis, in the order the facet declares.
    // No empty bands: a canvas drag moves a position without changing a facet, so
    // an empty band would be decoration with no affordance.
    const groups = data.groups ? groupsFor(data, { empties: 'drop' }) : [];
    const clustered = groups.length > 0;
    const auto = clustered
      ? clusteredLayout(shown, data.relations, layoutBy, groups, inward)
      : treeLayout(shown, data.relations, 'LR', layoutBy, inward);
    const placed = Object.keys(stored).length
      ? manualLayout(shown, data.relations, stored, layoutBy, inward, auto)
      : auto;

    const rfNodes: Node[] = shown.map((card) => {
      const p = placed.get(card.id)!;
      return {
        id: card.id,
        type: 'record',
        position: { x: p.x, y: p.y },
        // Declared explicitly: the minimap reads dimensions from the user node
        // rather than the measured internals, and dagre has already laid the
        // graph out assuming exactly these.
        width: p.w,
        height: p.h,
        style: { width: p.w, height: p.h },
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

    // Bands first, so a record is always drawn over its own background.
    return { nodes: [...bands, ...rfNodes], edges: buildEdges(data.relations, inward) };
  }, [data, onOpen]);

  useEffect(() => {
    setNodes(built.nodes);
    setDirty(false);
  }, [built.nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((cur) => applyNodeChanges(changes, cur));
    // Only a finished drag counts as a change worth offering to save.
    if (changes.some((c) => c.type === 'position' && c.dragging === false)) setDirty(true);
  }, []);

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
   * same call the card panel and the bulk bar make. A hierarchy is drawn
   * container → member, so the value lands on the *target* record and points
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
        valuesOf: (id) => data.cards[id]?.facets[newRelation] ?? [],
      });
      if (intent.kind !== 'facet') return;
      setProblem(null);
      // The same targeted write the board uses: only this facet, and the values
      // computed per record. The old call spread the whole facet map from a
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
    [data.cards, data.layout, meta.facets, newRelation, reload],
  );

  const addRecord = async () => {
    const title = prompt('New record. Title:');
    if (!title?.trim()) return;
    try {
      // No facets: a record with no status is not on any status-filtered board,
      // which is what "just a node" ever meant.
      await api.createCard({ title: title.trim() });
      reload();
    } catch (err) {
      setProblem((err as ApiError).message);
    }
  };

  return (
    <div className="canvas-wrap">
      {problem && <div className="banner is-bad">{problem}</div>}
      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={built.edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          fitView
          minZoom={0.02}
          maxZoom={2}
          elementsSelectable
          /*
           * React Flow deletes the selected nodes on Backspace by default, and
           * `elementsSelectable` means there is always something selected to
           * delete. The change went through `applyNodeChanges` and the node left
           * the canvas — with no request sent and nothing to undo it but a
           * reload, which brought the card straight back. It read as a delete
           * that had silently failed, when nothing had been asked of the server
           * at all.
           *
           * Deleting a record is `bulkDelete` behind a confirm, because the files
           * are the vault. A keystroke that bypasses both is not a shortcut for
           * it, so the key is turned off rather than rebound.
           */
          deleteKeyCode={null}
          onNodeDoubleClick={(_, n) => onOpen(n.id)}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dot)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" />
        </ReactFlow>

        {/*
          What floats here is what only a canvas can do *and* only while a canvas
          is open: creating a relation by dragging, adding a record, saving a
          layout. Which facets are drawn is `show`, which every shape has, so it
          lives in the rail — and keeping context is now a property of the shape
          rather than a control, since nothing but a canvas ever honoured it.
        */}
        <div className="canvas-float">
          <label className="relationpick">
            drag creates
            <select value={newRelation} onChange={(e) => setNewRelation(e.target.value)}>
              {relations(meta).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>

          <Button size="small" onClick={() => void addRecord()}>
            + record
          </Button>
          {dirty && !naming && (
            <Button
              tone="primary" size="small"
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

