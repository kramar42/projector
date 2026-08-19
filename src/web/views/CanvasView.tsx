import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.ts';
import { CardBody } from '../components/CardBody.tsx';
import { manualLayout, sizeFor, treeLayout } from './layout.ts';
import type { CanvasResponse, CardDTO } from '../types.ts';

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
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <CardBody card={card} size={size} onOpen={onOpen} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

const nodeTypes = { record: RecordNode };

const EDGE_STYLE: Record<string, Partial<Edge>> = {
  parent: { style: { stroke: 'var(--edge-parent)', strokeWidth: 1.6 } },
  blocks: {
    style: { stroke: 'var(--edge-blocks)', strokeWidth: 1.8, strokeDasharray: '6 4' },
    animated: false,
    label: 'blocks',
  },
  relates: { style: { stroke: 'var(--edge-relates)', strokeWidth: 1.2, strokeDasharray: '2 4' } },
};

export function CanvasView({ name, onOpen }: { name: string; onOpen: (id: string) => void }) {
  const [data, setData] = useState<CanvasResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api.canvas(name).then(setData, (e: Error) => setError(e.message));
  }, [name]);

  const { nodes, edges } = useMemo(() => {
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
      return {
        id: card.id,
        type: 'record',
        position: { x: p.x, y: p.y },
        // Declare width and height explicitly, for two reasons. The minimap reads
        // dimensions from the *user* node rather than the measured internals, so
        // without them it skips every node and renders an empty box. And dagre has
        // already laid the graph out assuming these exact dimensions, so stating
        // them keeps what is drawn identical to what was measured.
        width: p.w,
        height: p.h,
        style: { width: p.w, height: p.h },
        data: { card, size: sizeFor(card, data.stored[card.id]?.size, viewDefault), onOpen },
        // P1 is read-only: nothing on the canvas moves or reconnects yet.
        draggable: false,
        connectable: false,
      };
    });

    const rfEdges: Edge[] = data.edges.map((e, i) => ({
      id: `${e.type}:${e.src}->${e.dst}:${i}`,
      // A parent edge is drawn parent → child, matching the layout direction.
      source: e.type === 'parent' ? e.dst : e.src,
      target: e.type === 'parent' ? e.src : e.dst,
      type: 'smoothstep',
      ...EDGE_STYLE[e.type],
    }));

    return { nodes: rfNodes, edges: rfEdges };
  }, [data, onOpen]);

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
          {data.nodes.length} records · {Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(' · ') || 'no edges'}
          {' '}· layout <b>{data.view.layout}</b>
        </span>
      </div>
      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.02}
          maxZoom={2}
          proOptions={{ hideAttribution: false }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, n) => onOpen(n.id)}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dot)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" />
        </ReactFlow>
      </div>
    </div>
  );
}
