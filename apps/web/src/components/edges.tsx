import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';

export type AtlasEdgeData = {
  relationIds: string[];
  status: string;
  label: string;
  /** Design lens: the label is a whiteboard flow (HTTP, enqueue, reads/writes…), not relation kinds. */
  flow?: boolean;
};
export type AtlasFlowEdge = Edge<AtlasEdgeData, 'atlas'>;

/**
 * Point on a left-to-right bezier edge at t = 0.6: on the curve (labels sit on their line), past
 * the fan-out at the source so flows leaving one box do not stack, and clear of the target box.
 * Mirrors React Flow's control points for Right→Left handles when the target is to the right.
 */
function flowLabelPoint(p: { sourceX: number; sourceY: number; targetX: number; targetY: number }) {
  const t = 0.6;
  const d = p.targetX - p.sourceX;
  if (d <= 0) return undefined;
  const c1x = p.sourceX + d / 2;
  const c2x = p.targetX - d / 2;
  const u = 1 - t;
  return {
    x: u ** 3 * p.sourceX + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * p.targetX,
    y: (u ** 3 + 3 * u * u * t) * p.sourceY + (3 * u * t * t + t ** 3) * p.targetY,
  };
}

/**
 * Bezier edge whose label sits near the target end: edges leaving one node share a start point,
 * so mid-path labels collide; near the target they fan out.
 */
export const AtlasEdge = memo(function AtlasEdge(p: EdgeProps<AtlasFlowEdge>) {
  const [path] = getBezierPath(p);
  const t = 0.72;
  const flowAt = p.data?.flow ? flowLabelPoint(p) : undefined;
  const x = flowAt?.x ?? p.sourceX + (p.targetX - p.sourceX) * t;
  const y = flowAt?.y ?? p.sourceY + (p.targetY - p.sourceY) * (t + 0.12);
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={p.style} />
      {p.data?.label && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label ${p.selected ? 'selected' : ''} st-label-${p.data.status}${p.data.flow ? ' flow-label' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
            title={`${p.data.label} (${p.data.status})`}
          >
            {p.data.label}
            {/* a flow aggregates many relations; "mixed" support is in the tooltip and Inspector */}
            {p.data.status !== 'supported' && (!p.data.flow || p.data.status !== 'mixed') && (
              <span className="edge-status"> · {p.data.status}</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { atlas: AtlasEdge };
