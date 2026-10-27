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
import { DESIGN_NODE_SIZE, NODE_SIZE, nodeTypes, type AtlasNodeData } from './nodes.tsx';
import { isDesignLens } from './design/archetypes.tsx';
import { edgeTypes, type AtlasEdgeData } from './edges.tsx';
// whiteboard controls of the design lens (D02a)
import { DesignFlowEdge, designEdgeExtras, designNodeExtras } from './design/drift.tsx';
import { useWhiteboard } from './design/useWhiteboard.ts';
import { useDesignEdits } from './design/useDesignEdits.tsx';
import { WhiteboardLayer } from './design/Palette.tsx';

const EDGE_TYPES = { ...edgeTypes, 'design-flow': DesignFlowEdge };

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
  /** The selected entity (any view): its node is shown selected wherever it appears. */
  selectedEntityId?: string;
  /** Owner chain of the selected entity, nearest first, for canvases that only show an owner. */
  selectedAncestors?: string[];
  onProjection(p: ProjectionDto | null, overlay: OverlayDto | null): void;
  /** Design lens: double-clicking a box opens the architecture canvas that realizes it. */
  onRealizedBy?(canvasId: string, entityId?: string): void;
  overlayRef: React.MutableRefObject<OverlayDto | null>;
  persist(mutate: (o: OverlayDto) => OverlayDto): void;
  overlayDirty(): boolean;
}

function edgeLabel(kinds: Record<string, number>): string {
  return Object.entries(kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(', ');
}

/** Extra horizontal room per design box (see the layout call). */
const DESIGN_FLOW_GAP = 90;
const padded = (s: { width: number; height: number }) => ({
  width: s.width + DESIGN_FLOW_GAP,
  height: s.height + 14,
});

/** Overlay key of a node: entity id (follows renames) or projection node id. */
const keyOf = (n: ProjectionNodeDto) => (n.kind === 'entity' && n.entityId ? n.entityId : n.id);

function samePositions(
  a: Record<string, { x: number; y: number }> | undefined,
  b: Record<string, { x: number; y: number }>,
) {
  const ka = Object.keys(a ?? {});
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => b[k] && b[k].x === a![k]!.x && b[k].y === a![k]!.y)
  );
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
    selectedEntityId,
    selectedAncestors,
    onProjection,
    overlayRef,
    persist,
    overlayDirty,
    onRealizedBy,
  } = props;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AtlasNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>();
  const projectionRef = useRef<ProjectionDto | null>(null);
  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const pendingViewport = useRef<{ viewport?: Viewport } | null>(null);
  /** View currently on screen: a live refresh of the same view keeps the user's viewport. */
  const shownViewId = useRef<string | null>(null);
  const multiSelect = !!useDesignEdits()?.editMode;
  const selectedEntityRef = useRef(selectedEntityId);
  /** Nodes on screen, so a live refresh of the same view keeps what the person had selected. */
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  selectedEntityRef.current = selectedEntityId;

  // one selection across views: whichever node shows the selected entity is selected here too;
  // if the canvas only shows an owner of it, the nearest visible owner is marked instead
  useEffect(() => {
    setNodes((ns) => {
      // a multi-selection in whiteboard edit mode is React Flow's own; do not collapse it
      if (multiSelect && ns.filter((n) => n.selected).length > 1) return ns;
      const present = ns.some((n) => n.data.entityId && n.data.entityId === selectedEntityId);
      const visible = new Set(ns.map((n) => n.data.entityId).filter(Boolean));
      const holder = present ? undefined : selectedAncestors?.find((a) => visible.has(a));
      let changed = false;
      const next = ns.map((n) => {
        if (!n.data.entityId) return n;
        const sel = n.data.entityId === selectedEntityId;
        const holds = n.data.entityId === holder;
        if (n.selected === sel && !!n.data.containsSelection === holds) return n;
        changed = true;
        return { ...n, selected: sel, data: { ...n.data, containsSelection: holds } };
      });
      // returning the same array when nothing changed keeps this effect from looping
      return changed ? next : ns;
    });
  }, [selectedEntityId, selectedAncestors, nodes, setNodes, multiSelect]);

  // Fit (or restore the saved viewport) only once React Flow has measured every node of this canvas.
  // `useNodesInitialized` can stay true across canvas switches, so check measurements directly.
  useEffect(() => {
    if (!pendingViewport.current || !nodesInitialized || nodes.length === 0) return;
    if (!nodes.every((n) => n.measured?.width && n.measured?.height)) return;
    const target = pendingViewport.current;
    pendingViewport.current = null;
    if (target.viewport) void flow.setViewport(target.viewport, { duration: 0 });
    // instant fit: an animated fit races with the user's first drag
    else void flow.fitView({ padding: 0.06, maxZoom: 1.1, duration: 0 });
  }, [nodesInitialized, nodes, flow]);

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
      const stored = await api<OverlayDto>(
        `/views/${p.viewId}/overlay?project=${projectId}&snapshot=${snapshotId}`,
        token,
      );
      // a re-projection while edits are still being saved must not drop them
      const local = overlayRef.current;
      const overlay = local && local.viewId === p.viewId && overlayDirty() ? local : stored;
      if (cancelled) return;
      projectionRef.current = p;
      overlayRef.current = overlay;
      const groupIds = new Set(p.nodes.filter((n) => n.kind === 'group').map((n) => n.id));
      const design = isDesignLens(p.lens);
      const sizes = design ? DESIGN_NODE_SIZE : NODE_SIZE;
      const layout = await layoutInWorker({
        nodes: p.nodes.map((n) => {
          const size =
            n.kind === 'group'
              ? { width: 260, height: 80 }
              : design
                ? // whiteboard flows need room for their labels between columns: ELK's layer
                  // spacing is fixed, so the box is laid out wider than it is drawn
                  padded(sizes[n.kind] ?? sizes.entity!)
                : (sizes[n.kind] ?? sizes.entity!);
          // user pins win; otherwise keep the node where it was last laid out (stable map)
          const fixed = n.parentId
            ? undefined
            : (overlayPos(overlay, n) ?? overlay.autoPositions?.[keyOf(n)]);
          return {
            id: n.id,
            ...size,
            parentId: n.parentId && groupIds.has(n.parentId) ? n.parentId : undefined,
            fixed,
          };
        }),
        edges: p.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        // design lenses read left to right like a whiteboard: clients → services → stores
        direction: p.lens === 'changes' || p.lens === 'coverage' ? 'DOWN' : 'RIGHT',
      });
      if (cancelled) return;
      const abs = layout.positions;
      const keepSelected = new Set(
        shownViewId.current === p.viewId
          ? nodesRef.current.filter((n) => n.selected).map((n) => n.id)
          : [],
      );
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
            ...(design ? designNodeExtras(n, p) : {}),
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
            type: n.kind === 'sticky' ? 'sticky' : 'atlas',
            position,
            data,
            selected:
              (!!n.entityId && n.entityId === selectedEntityRef.current) || keepSelected.has(n.id),
            parentId: n.parentId && groupIds.has(n.parentId) ? n.parentId : undefined,
            extent: n.parentId && groupIds.has(n.parentId) ? 'parent' : undefined,
            ariaLabel: `${n.entityKind ?? n.kind} ${n.label}`,
          };
        }),
      );
      setEdges(
        p.edges.map((e): Edge<AtlasEdgeData> => {
          const flowLabel = design ? e.flow : undefined;
          const label = flowLabel ?? edgeLabel(e.kinds);
          const wb = design ? designEdgeExtras(e, p) : undefined;
          return {
            id: e.id,
            type: wb?.type ?? 'atlas',
            source: e.source,
            target: e.target,
            className: `atlas-edge edge-${e.status}${flowLabel ? ' flow-edge' : ''}${wb?.className ? ` ${wb.className}` : ''}`,
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
            data: {
              relationIds: e.relationIds,
              status: e.status,
              label,
              flow: !!flowLabel,
              ...wb?.data,
            },
            ariaLabel: `${label} (${e.status})`,
          };
        }),
      );
      onProjection(p, overlay);
      setStatus('ready');
      // remember where unpinned top-level nodes landed, so later additions do not move them
      const auto: Record<string, { x: number; y: number }> = {};
      for (const n of p.nodes) {
        const a = abs[n.id];
        if (n.parentId || !a || overlayPos(overlay, n)) continue;
        auto[keyOf(n)] = { x: a.x, y: a.y };
      }
      if (!samePositions(overlay.autoPositions, auto))
        persist((o) => ({ ...o, autoPositions: auto }));
      const sameView = shownViewId.current === p.viewId;
      shownViewId.current = p.viewId;
      if (sameView) return; // a refresh of the view on screen keeps the viewport
      // the default viewport means "never set by the user" (e.g. only pins were saved): fit instead
      const v = overlay.viewport;
      const userViewport = v.zoom > 0 && !(v.x === 0 && v.y === 0 && v.zoom === 1);
      pendingViewport.current = { viewport: userViewport ? v : undefined };
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

  const wb = useWhiteboard({ nodes, setNodes, persist, onSelect });
  const onNodeDragStop = useCallback(
    (_: unknown, node: Node<AtlasNodeData>) => {
      // edit mode: dropping a box onto a subsystem moves it in (the box is re-projected there)
      if (wb.onDragStopInto(node)) return;
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
    [flow, persist, setNodes, wb],
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
      else if (n.realizedByCanvasId && onRealizedBy) onRealizedBy(n.realizedByCanvasId, n.entityId);
    },
    [location.canvasId, onNavigate, onRealizedBy],
  );

  return (
    <div
      className={isDesignLens(projectionRef.current?.lens) ? 'flow design-board' : 'flow'}
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
        edgeTypes={EDGE_TYPES}
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
        // double-click means "open" here; React Flow's default double-click zoom would also move
        // (and persist) the viewport of the canvas being left
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2.5}
        nodesFocusable
        edgesFocusable
        elevateEdgesOnSelect
        proOptions={{ hideAttribution: false }}
        {...wb.flowProps}
      >
        <WhiteboardLayer place={wb.place} clearSelection={wb.clearSelection} />
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
