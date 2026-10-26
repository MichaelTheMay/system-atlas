import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';

export type AtlasEdgeData = { relationIds: string[]; status: string; label: string };
export type AtlasFlowEdge = Edge<AtlasEdgeData, 'atlas'>;

/**
 * Bezier edge whose label sits near the target end: edges leaving one node share a start point,
 * so mid-path labels collide; near the target they fan out.
 */
export const AtlasEdge = memo(function AtlasEdge(p: EdgeProps<AtlasFlowEdge>) {
  const [path] = getBezierPath(p);
  const t = 0.72;
  const x = p.sourceX + (p.targetX - p.sourceX) * t;
  const y = p.sourceY + (p.targetY - p.sourceY) * (t + 0.12);
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={p.style} />
      {p.data?.label && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label ${p.selected ? 'selected' : ''} st-label-${p.data.status}`}
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
            title={`${p.data.label} (${p.data.status})`}
          >
            {p.data.label}
            {p.data.status !== 'supported' && (
              <span className="edge-status"> · {p.data.status}</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { atlas: AtlasEdge };
