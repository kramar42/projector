import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ApiError, api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { CardBody } from '../components/CardBody.tsx';
import { manualLayout, sizeFor, treeLayout } from './layout.ts';
import type { CanvasResponse, CardDTO, Meta } from '../types.ts';

/**
 * A canvas node hosts the same `<CardBody>` the board renders. That is the
 * requirement React Flow was chosen for: a node is an ordinary React component,
 * so link chips and progress work here with no second implementation.
 */
function RecordNode({ data }: NodeProps) {
  const { card, size, onOpen } = data as unknown as {
    card: CardDTO;
    size: 'chip' | 'card' | 'expanded';
    onOpen: (id: string) => void;
  };
  return (
    <>
      {/* React Flow attaches edges to handles. Without them a custom node renders
          fine and every edge is silently dropped. */}
      <Handle type="target" position={Position.Left} />
      <CardBody card={card} size={size} onOpen={onOpen} />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

const nodeTypes = { record: RecordNode };

const EDGE_STYLE: Record<string, Partial<Edge>> = {
  parent: { style: { stroke: 'var(--edge-parent)', strokeWidth: 1.6 } },
  blocks: {
    style: { stroke: 'var(--edge-blocks)', strokeWidth: 1.8, strokeDasharray: '6 4' },
    label: 'blocks',
  },
  relates: { style: { stroke: 'var(--edge-relates)', strokeWidth: 1.2, strokeDasharray: '2 4' } },
};

export function CanvasView({
  name,
  meta,
  onOpen,
}: {
  name: string;
  meta: Meta;
  onOpen: (id: string) => void;
}) {
  const { data, error, reload } = useLive<CanvasResponse>(() => api.canvas(name), [name]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [newEdgeType, setNewEdgeType] = useState<'parent' | 'blocks' | 'relates'>('parent');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const sizes = useRef<Record<string, string>>({});

  const built = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const viewDefault = data.view.defaultSize;
    const placed =
      data.view.layout === 'manual'
        ? manualLayout(data.nodes, data.edges, data.stored, viewDefault)
        : treeLayout(
            data.nodes,
            data.edges,
            data.stored,
            data.view.layout === 'tree-tb' ? 'TB' : 'LR',
            viewDefault,
          );

    const rfNodes: Node[] = data.nodes.map((card) => {
      const p = placed.get(card.id)!;
      const size = sizeFor(card, data.stored[card.id]?.size, viewDefault);
      sizes.current[card.id] = size;
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
        data: { card, size, onOpen },
      };
    });

    const rfEdges: Edge[] = data.edges.map((e, i) => ({
      id: `${e.type}:${e.src}->${e.dst}:${i}`,
      // A parent edge is drawn parent → child, matching the layout direction.
      source: e.type === 'parent' ? e.dst : e.src,
      target: e.type === 'parent' ? e.src : e.dst,
      type: 'smoothstep',
      data: { edgeType: e.type, src: e.src, dst: e.dst },
      ...EDGE_STYLE[e.type],
    }));

    return { nodes: rfNodes, edges: rfEdges };
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

  const savePositions = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const payload: Record<string, { x: number; y: number; size?: string }> = {};
      for (const n of nodes) {
        payload[n.id] = {
          x: n.position.x,
          y: n.position.y,
          ...(sizes.current[n.id] ? { size: sizes.current[n.id] } : {}),
        };
      }
      // Positions go to the canvas file, never to a card: views own arrangement,
      // so the same card can sit at different places on different canvases.
      await api.saveCanvas(name, payload);
      setDirty(false);
      reload();
    } catch (err) {
      setProblem((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  /** Dragging between handles creates an edge of the currently selected type. */
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !data) return;
      // Drawn parent → child, so a new parent edge is written onto the *target*
      // record, pointing back at the source.
      const owner = newEdgeType === 'parent' ? c.target : c.source;
      const to = newEdgeType === 'parent' ? c.source : c.target;
      if (owner === to) return;
      setProblem(null);
      const existing = data.edges
        .filter((e) => e.src === owner)
        .map((e) => ({ type: e.type, to: e.dst }));
      if (existing.some((e) => e.type === newEdgeType && e.to === to)) return;
      // One parent is the norm: replace rather than stack a second one.
      const kept = newEdgeType === 'parent' ? existing.filter((e) => e.type !== 'parent') : existing;
      api
        .setEdges(owner, [...kept, { type: newEdgeType, to }])
        .then(() => reload())
        .catch((e: ApiError) => setProblem(e.message));
    },
    [data, newEdgeType, reload],
  );

  const addNode = async () => {
    const title = prompt('New node — a thought, canvas only. Title:');
    if (!title?.trim()) return;
    try {
      await api.createCard({ title: title.trim(), kind: 'node' });
      reload();
    } catch (err) {
      setProblem((err as ApiError).message);
    }
  };

  if (error) return <div className="pane-error">{error}</div>;
  if (!data) return <div className="pane-loading">loading…</div>;

  const byType = data.edges.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="canvas-wrap">
      <div className="board-head">
        <h1>{data.view.title}</h1>
        <span className="board-sub">
          {data.nodes.length} records ·{' '}
          {Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(' · ') || 'no edges'} · layout{' '}
          <b>{data.view.layout}</b>
        </span>
        <span className="canvas-tools">
          <label className="edgepick">
            drag creates
            <select
              value={newEdgeType}
              onChange={(e) => setNewEdgeType(e.target.value as 'parent' | 'blocks' | 'relates')}
            >
              <option value="parent">parent</option>
              <option value="blocks">blocks</option>
              <option value="relates">relates</option>
            </select>
          </label>
          <button className="btn small" onClick={() => void addNode()}>
            + node
          </button>
          {dirty && (
            <button className="btn primary small" onClick={() => void savePositions()} disabled={saving}>
              {saving ? 'saving…' : 'Save layout'}
            </button>
          )}
        </span>
      </div>
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
          onNodeDoubleClick={(_, n) => onOpen(n.id)}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dot)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" />
        </ReactFlow>
      </div>
      <div className="canvas-foot">
        double-click a node to open it · drag from a node's right edge to another to connect ·{' '}
        {meta.counts.records} records indexed
      </div>
    </div>
  );
}
