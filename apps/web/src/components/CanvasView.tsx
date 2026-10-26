import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type Viewport,
} from '@xyflow/react';
import { api, type OverlayDto, type ProjectionDto, type ProjectionNodeDto } from '../api.ts';
import { layoutInWorker } from '../layout.ts';
import { NODE_SIZE, nodeTypes, type AtlasNodeData } from './nodes.tsx';
import { edgeTypes, type AtlasEdgeData } from './edges.tsx';

export interface Location {
  canvasId: string;
  focus?: string;
}

export type Selection =
  | { type: 'node'; node: ProjectionNodeDto }
  | { type: 'edge'; edgeId: string; relationIds: string[]; label: string }
  | null;

interface Props {
  token: string;
  snapshotId: string;
  projectId: string;
  location: Location;
  refreshKey: number;
  onNavigate(loc: Location): void;
  onSelect(sel: Selection): void;
  onProjection(p: ProjectionDto | null, overlay: OverlayDto | null): void;
  overlayRef: React.MutableRefObject<OverlayDto | null>;
  persist(mutate: (o: OverlayDto) => OverlayDto): void;
}

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function edgeLabel(kinds: Record<string, number>): string {
  return Object.entries(kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(', ');
}

/** Absolute overlay position of a projection node, if the user placed it. */
function overlayPos(o: OverlayDto | null, n: ProjectionNodeDto) {
  if (!o) return undefined;
  return n.kind === 'entity' && n.entityId ? o.entityPositions[n.entityId] : o.nodePositions[n.id];
}

export function CanvasView(props: Props) {
  const {
    token,
    snapshotId,
    projectId,
    location,
    refreshKey,
    onNavigate,
    onSelect,
    onProjection,
    overlayRef,
    persist,
  } = props;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AtlasNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>();
  const projectionRef = useRef<ProjectionDto | null>(null);
  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const pendingViewport = useRef<{ viewport?: Viewport } | null>(null);

  // Fit (or restore the saved viewport) only once React Flow has measured the new nodes.
  useEffect(() => {
    if (!nodesInitialized || !pendingViewport.current) return;
    const target = pendingViewport.current;
    pendingViewport.current = null;
    if (target.viewport) void flow.setViewport(target.viewport, { duration: 0 });
    else void flow.fitView({ padding: 0.06, maxZoom: 1.1, duration: reducedMotion ? 0 : 200 });
  }, [nodesInitialized, flow]);

  // Load projection + overlay, lay out, render.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      const qs = location.focus ? `?focus=${encodeURIComponent(location.focus)}` : '';
      const p = await api<ProjectionDto>(
        `/snapshots/${snapshotId}/canvases/${location.canvasId}/projection${qs}`,
        token,
      );
      const overlay = await api<OverlayDto>(
        `/views/${p.viewId}/overlay?project=${projectId}`,
        token,
      );
      if (cancelled) return;
      projectionRef.current = p;
      overlayRef.current = overlay;
      const groupIds = new Set(p.nodes.filter((n) => n.kind === 'group').map((n) => n.id));
      const layout = await layoutInWorker({
        nodes: p.nodes.map((n) => {
          const size =
            n.kind === 'group'
              ? { width: 260, height: 80 }
              : (NODE_SIZE[n.kind] ?? NODE_SIZE.entity!);
          const fixed = n.parentId ? undefined : overlayPos(overlay, n);
          return {
            id: n.id,
            ...size,
            parentId: n.parentId && groupIds.has(n.parentId) ? n.parentId : undefined,
            fixed,
          };
        }),
        edges: p.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        direction: p.lens === 'changes' || p.lens === 'coverage' ? 'DOWN' : 'RIGHT',
      });
      if (cancelled) return;
      const abs = layout.positions;
      const pinned = new Set(overlay.pinnedIds);
      const noted = new Set(overlay.annotations.map((a) => a.targetId));
      const ordered = [...p.nodes].sort(
        (a, b) => Number(b.kind === 'group') - Number(a.kind === 'group'),
      );
      setNodes(
        ordered.map((n): Node<AtlasNodeData> => {
          const a = abs[n.id] ?? { x: 0, y: 0, width: 200, height: 60 };
          const parent = n.parentId ? abs[n.parentId] : undefined;
          const position = parent ? { x: a.x - parent.x, y: a.y - parent.y } : { x: a.x, y: a.y };
          const data: AtlasNodeData = {
            ...n,
            pinned: !!(n.entityId && pinned.has(n.entityId)) || !!overlay.nodePositions[n.id],
            note: !!(n.entityId && noted.has(n.entityId)),
          };
          if (n.kind === 'group') {
            return {
              id: n.id,
              type: 'group-box',
              position,
              data,
              style: { width: a.width, height: a.height },
              selectable: true,
              draggable: true,
              ariaLabel: `Group ${n.label}`,
            };
          }
          return {
            id: n.id,
            type: 'atlas',
            position,
            data,
            parentId: n.parentId && groupIds.has(n.parentId) ? n.parentId : undefined,
            extent: n.parentId && groupIds.has(n.parentId) ? 'parent' : undefined,
            ariaLabel: `${n.entityKind ?? n.kind} ${n.label}`,
          };
        }),
      );
      setEdges(
        p.edges.map((e): Edge<AtlasEdgeData> => ({
          id: e.id,
          type: 'atlas',
          source: e.source,
          target: e.target,
          className: `atlas-edge edge-${e.status}`,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          data: { relationIds: e.relationIds, status: e.status, label: edgeLabel(e.kinds) },
          ariaLabel: `${edgeLabel(e.kinds)} (${e.status})`,
        })),
      );
      onProjection(p, overlay);
      setStatus('ready');
      pendingViewport.current = {
        viewport: overlay.revision > 0 && overlay.viewport.zoom > 0 ? overlay.viewport : undefined,
      };
    })().catch((e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
      onProjection(null, null);
    });
    return () => {
      cancelled = true;
    };
  }, [token, snapshotId, projectId, location.canvasId, location.focus, refreshKey]);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node<AtlasNodeData>) => {
      const internal = flow.getInternalNode(node.id);
      const abs = internal?.internals.positionAbsolute ?? node.position;
      const pos = { x: Math.round(abs.x), y: Math.round(abs.y) };
      persist((o) => {
        if (node.data.kind === 'entity' && node.data.entityId) {
          return {
            ...o,
            entityPositions: { ...o.entityPositions, [node.data.entityId]: pos },
            pinnedIds: [...new Set([...o.pinnedIds, node.data.entityId])],
          };
        }
        return { ...o, nodePositions: { ...o.nodePositions, [node.id]: pos } };
      });
      setNodes((ns) =>
        ns.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, pinned: true } } : n)),
      );
    },
    [flow, persist, setNodes],
  );

  const onMoveEnd = useCallback(
    (event: MouseEvent | TouchEvent | null, vp: Viewport) => {
      // programmatic moves (fitView, restore) have no event; only remember what the user chose
      if (!event) return;
      persist((o) => ({
        ...o,
        viewport: {
          x: Math.round(vp.x),
          y: Math.round(vp.y),
          zoom: Math.round(vp.zoom * 1000) / 1000,
        },
      }));
    },
    [persist],
  );

  const open = useCallback(
    (n: ProjectionNodeDto) => {
      if (n.focus !== undefined) onNavigate({ canvasId: location.canvasId, focus: n.focus });
      else if (n.openCanvasId) onNavigate({ canvasId: n.openCanvasId });
    },
    [location.canvasId, onNavigate],
  );

  return (
    <div
      className="flow"
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        const sel = nodes.find((n) => n.selected);
        if (sel) open(sel.data);
      }}
    >
      <ReactFlow<Node<AtlasNodeData>, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onMoveEnd={onMoveEnd}
        onNodeClick={(_, n) => onSelect({ type: 'node', node: n.data })}
        onNodeDoubleClick={(_, n) => open(n.data)}
        onEdgeClick={(_, e) =>
          onSelect({
            type: 'edge',
            edgeId: e.id,
            relationIds: (e.data as AtlasEdgeData).relationIds,
            label: (e.data as AtlasEdgeData).label,
          })
        }
        onPaneClick={() => onSelect(null)}
        minZoom={0.1}
        maxZoom={2.5}
        nodesFocusable
        edgesFocusable
        elevateEdgesOnSelect
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable ariaLabel="Canvas overview" />
      </ReactFlow>
      {status === 'loading' && (
        <div className="canvas-status" role="status">
          Laying out…
        </div>
      )}
      {status === 'error' && (
        <div className="canvas-status error" role="alert">
          Could not load this canvas: {error}
        </div>
      )}
      {status === 'ready' && projectionRef.current?.nodes.length === 0 && (
        <div className="canvas-status" role="status">
          {projectionRef.current.lens === 'coverage'
            ? 'No coverage gaps recorded for this snapshot: every inventoried file was handled by an analyzer.'
            : projectionRef.current.lens === 'changes'
              ? 'No changes since the previous snapshot.'
              : 'Nothing to show in this view for this snapshot.'}
        </div>
      )}
    </div>
  );
}
