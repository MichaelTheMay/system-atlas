import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow, type Connection, type Edge, type Node } from '@xyflow/react';
import type { OverlayDto, ProjectionNodeDto } from '../../api.ts';
import { PALETTE_MIME, type PaletteTool } from './Palette.tsx';
import { isDetectedBox, isDrawn, useDesignEdits } from './useDesignEdits.tsx';

type N = Node<ProjectionNodeDto & Record<string, unknown>>;

/**
 * Canvas wiring of the whiteboard (D02a) for CanvasView: connect, palette drop, multi-selection,
 * drop-into-subsystem, and the Delete / Escape keys. Everything is inert outside edit mode, except
 * that React Flow never deletes nodes locally (deletion always goes through the API).
 */
export function useWhiteboard({
  nodes,
  setNodes,
  persist,
  onSelect,
}: {
  nodes: N[];
  setNodes: (f: (ns: N[]) => N[]) => void;
  persist(mutate: (o: OverlayDto) => OverlayDto): void;
  onSelect(sel: null): void;
}) {
  const ed = useDesignEdits();
  const flow = useReactFlow();
  const editMode = !!ed?.editMode;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const place = useCallback(
    (nodeId: string, pos: { x: number; y: number }) => {
      persist((o) => ({ ...o, nodePositions: { ...o.nodePositions, [nodeId]: pos } }));
      // re-project once the save has had a chance to land (the SSE refresh may have come first)
      setTimeout(() => ed?.refresh(), 600);
    },
    [persist, ed],
  );

  const clearSelection = useCallback(() => {
    setNodes((ns) =>
      ns.some((n) => n.selected) ? ns.map((n) => ({ ...n, selected: false })) : ns,
    );
    ed?.setSelectedNodes([]);
    onSelect(null);
  }, [setNodes, ed, onSelect]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!ed?.editMode) return;
      const a = nodesRef.current.find((n) => n.id === c.source)?.data;
      const b = nodesRef.current.find((n) => n.id === c.target)?.data;
      if (a && b) void ed.connect(a, b);
    },
    [ed],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!editMode || !e.dataTransfer.types.includes(PALETTE_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    [editMode],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!ed?.editMode) return;
      const raw = e.dataTransfer.getData(PALETTE_MIME);
      if (!raw) return;
      e.preventDefault();
      const tool = JSON.parse(raw) as PaletteTool;
      const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id =
        tool.kind === 'box'
          ? await ed.addBox(tool.archetype)
          : tool.kind === 'subsystem'
            ? await ed.addSubsystem()
            : await ed.addSticky();
      if (id) place(id, { x: Math.round(pos.x - 100), y: Math.round(pos.y - 30) });
    },
    [ed, flow, place],
  );

  const onSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: N[]; edges: Edge[] }) => {
      if (!ed) return;
      const next = sel.map((n) => n.data);
      const same =
        next.length === ed.selectedNodes.length &&
        next.every((n, i) => n.id === ed.selectedNodes[i]?.id);
      if (!same) ed.setSelectedNodes(next);
    },
    [ed],
  );

  /** Dropping a box onto a subsystem moves it in (drawn subsystem) or groups it (claim subsystem). */
  const onDragStopInto = useCallback(
    (node: N) => {
      if (!ed?.editMode || !ed.projection) return false;
      const d = node.data;
      if (!(isDetectedBox(d) || (isDrawn(d) && d.kind === 'design'))) return false;
      const hit = flow
        .getIntersectingNodes(node)
        .find(
          (n) => n.id !== node.id && (n.data as unknown as ProjectionNodeDto).kind === 'cluster',
        );
      if (!hit) return false;
      const sub = hit.data as unknown as ProjectionNodeDto;
      if (sub.ghost) return false;
      if (isDrawn(sub) && sub.designElementId) {
        void ed.moveTo([d], sub.designElementId);
        return true;
      }
      if (sub.id.startsWith('subsystem:') && isDetectedBox(d) && !ed.canvasElementId) {
        void ed.group([d], sub.label);
        return true;
      }
      return false;
    },
    [ed, flow],
  );

  // Delete/Backspace deletes (drawn) or hides (detected) the selection; Escape clears it
  useEffect(() => {
    if (!editMode || !ed) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'Escape') {
        if (ed.renaming) ed.setRenaming(null);
        else clearSelection();
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const sel = nodesRef.current
        .filter((n) => n.selected)
        .map((n) => n.data)
        .filter((n) => isDetectedBox(n) || !!n.designElementId);
      // a selected drawn flow (a code flow is not the person's to delete)
      const flows = flow
        .getEdges()
        .filter((x) => x.selected)
        .map((x) => x.data as { designElementId?: string; drawn?: boolean; label?: string })
        .filter((d) => d.drawn && d.designElementId)
        .map((d) => ({ elementId: d.designElementId!, label: d.label ?? 'flow' }));
      if (!sel.length && !flows.length) return;
      e.preventDefault();
      if (sel.length) void ed.remove(sel);
      else void ed.removeFlows(flows);
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editMode, ed, clearSelection, flow]);

  return {
    place,
    clearSelection,
    onDragStopInto,
    editMode,
    flowProps: {
      nodesConnectable: editMode,
      deleteKeyCode: null,
      onConnect,
      onDragOver,
      onDrop: (e: React.DragEvent) => void onDrop(e),
      onSelectionChange,
    },
  };
}
