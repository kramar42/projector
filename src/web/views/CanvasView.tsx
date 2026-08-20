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
import { PopoverButton } from '../components/Popover.tsx';
import { EDGE_KINDS, type Patch } from '../query.ts';
import { layoutTypes, manualLayout, sizeFor, treeLayout } from './layout.ts';
import { useRequestEnrichment } from '../enrichment.tsx';
import type { CardDTO, QueryResponse } from '../types.ts';

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
  const { card, size, chips, context, onOpen } = data as unknown as {
    card: CardDTO;
    size: 'chip' | 'card';
    chips: string[];
    context: boolean;
    onOpen: (id: string) => void;
  };
  return (
    <div className={context ? 'is-context' : undefined}>
      {/* React Flow attaches edges to handles. Without them a custom node renders
          fine and every edge is silently dropped. */}
      <Handle type="target" position={Position.Left} />
      <CardBody card={card} size={size} showFacets={chips} onOpen={onOpen} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { record: RecordNode };

const EDGE_COLOUR: Record<string, string> = {
  parent: 'var(--edge-parent)',
  blocks: 'var(--edge-blocks)',
  relates: 'var(--edge-relates)',
  'member-of': 'var(--edge-member)',
};

const DASH: Record<string, string | undefined> = {
  blocks: '6 4',
  relates: '2 4',
  'member-of': '1 3',
};

/**
 * One edge per pair of records, whatever the types.
 *
 * `parent` and `member-of` agreeing is the *expected* shape for a project
 * record — `keycloak` carries both — so drawing both put two identical lines on
 * top of each other with no way to tell there were two. Collapsing them means a
 * pair that agrees reads as one relationship, and a pair that *disagrees* still
 * shows up as two separate edges pointing at different records, which is the case
 * worth seeing.
 */
function buildEdges(
  raw: { src: string; dst: string; type: string }[],
  hierarchy: string[],
): Edge[] {
  const byPair = new Map<string, { src: string; dst: string; types: string[] }>();
  for (const e of raw) {
    // Hierarchy edges are stored child → parent and member → container. Drawn
    // the other way, so the arrow points the way the graph opens.
    const flip = hierarchy.includes(e.type);
    const src = flip ? e.dst : e.src;
    const dst = flip ? e.src : e.dst;
    const key = `${src}\u0000${dst}`;
    const found = byPair.get(key);
    if (found) found.types.push(e.type);
    else byPair.set(key, { src, dst, types: [e.type] });
  }

  return [...byPair.values()].map(({ src, dst, types }) => {
    // The most structural type wins the styling; the rest ride along in the title.
    const lead = ['parent', 'member-of', 'blocks', 'relates'].find((t) => types.includes(t)) ?? types[0]!;
    const colour = EDGE_COLOUR[lead] ?? 'var(--edge-relates)';
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
  data,
  onOpen,
  reload,
  patch,
  wire,
  onSaved,
}: {
  data: QueryResponse;
  onOpen: (id: string) => void;
  reload: () => void;
  patch: (p: Patch) => void;
  /** The query half of the page URL — what a save records. */
  wire: string;
  onSaved: (name: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [newEdgeType, setNewEdgeType] = useState<'parent' | 'blocks' | 'relates'>('parent');
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
    const hierarchy = layoutTypes(data.spec.edges);
    const placed = Object.keys(stored).length
      ? manualLayout(shown, data.edges, stored, hierarchy)
      : treeLayout(shown, data.edges, 'LR', hierarchy);

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
          size: sizeFor(card),
          chips: data.spec.chips,
          context: context.has(card.id),
          onOpen,
        },
      };
    });

    return { nodes: rfNodes, edges: buildEdges(data.edges, hierarchy) };
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

  /** Dragging between handles creates an edge of the currently selected type. */
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      // Drawn parent → child, so a new parent edge is written onto the *target*
      // record, pointing back at the source.
      const owner = newEdgeType === 'parent' ? c.target : c.source;
      const to = newEdgeType === 'parent' ? c.source : c.target;
      if (owner === to) return;
      setProblem(null);
      const existing = data.edges
        .filter((e) => e.src === owner && e.type !== 'member-of')
        .map((e) => ({ type: e.type, to: e.dst }));
      if (existing.some((e) => e.type === newEdgeType && e.to === to)) return;
      // One parent is the norm: replace rather than stack a second one.
      const kept = newEdgeType === 'parent' ? existing.filter((e) => e.type !== 'parent') : existing;
      api
        .setEdges(owner, [...kept, { type: newEdgeType, to }])
        .then(() => reload())
        .catch((e: ApiError) => setProblem(e.message));
    },
    [data.edges, newEdgeType, reload],
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
          onNodeDoubleClick={(_, n) => onOpen(n.id)}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dot)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" />
        </ReactFlow>

        {/*
          Everything a canvas has that the other shapes do not — geometry and
          edges — lives here rather than in the rail, so switching shape never
          changes the sidebar. Transient actions (Save layout, + node) float for
          the same reason: a control that appears and vanishes mid-rail makes the
          whole thing jump.
        */}
        <div className="canvas-float">
          <PopoverButton
            className="floatbtn"
            minWidth={170}
            label={edgeLabel(data.spec.edges)}
            title="which edge types are drawn — the hierarchy ones also lay the graph out"
            render={() => (
              <>
                <div className="pop-head">Edges drawn</div>
                {EDGE_KINDS.map((kind) => (
                  <label key={kind} className="pop-check">
                    <input
                      type="checkbox"
                      checked={data.spec.edges.includes(kind)}
                      onChange={(e) => {
                        const next = new Set(data.spec.edges);
                        if (e.target.checked) next.add(kind);
                        else next.delete(kind);
                        patch({ edges: [...next].join(',') || 'parent' });
                      }}
                    />
                    {kind}
                  </label>
                ))}
              </>
            )}
          />

          <select
            className="floatselect"
            value={data.spec.query.connect ?? 'ancestors'}
            title="keep unmatched ancestors so the graph stays connected — drawn muted, never counted as matches"
            onChange={(e) => patch({ connect: e.target.value })}
          >
            <option value="ancestors">keep context</option>
            <option value="none">matches only</option>
          </select>

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
          {dirty && !naming && (
            <button
              className="btn primary small"
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
            </button>
          )}
          {naming && (
            <SaveAs
              onCancel={() => setNaming(false)}
              onSave={(title) => {
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
 */
function SaveAs({ onCancel, onSave }: { onCancel: () => void; onSave: (name: string) => void }) {
  const [text, setText] = useState('');
  return (
    <span className="saveas">
      <input
        autoFocus
        value={text}
        placeholder="view name"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && text.trim()) onSave(slug(text));
        }}
      />
      <button className="btn primary small" disabled={!text.trim()} onClick={() => onSave(slug(text))}>
        Save
      </button>
    </span>
  );
}

/** A short reading of the edge selection, so the button says what it holds. */
function edgeLabel(edges: string[]): string {
  if (!edges.length) return 'no edges';
  if (edges.length === 1) return edges[0]!;
  return `${edges.length} edge types`;
}

function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
