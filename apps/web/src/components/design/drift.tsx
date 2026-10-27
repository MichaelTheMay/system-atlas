import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { ProjectionDto, ProjectionEdgeDto, ProjectionNodeDto } from '../../api.ts';
import { flowLabelPoint, type AtlasEdgeData } from '../edges.tsx';
import { GhostActions } from './DesignElementNode.tsx';
import { useDesignEdits } from './useDesignEdits.tsx';
import './whiteboard.css';

/**
 * Drift between the board and the code, always visible on design canvases (D02a):
 * - a drawn flow with no matching code relation: "drawn, not found in code";
 * - a code flow the person left off a board they started drawing: a faint ghost edge to Adopt;
 * - a bound box whose code is gone: marked stale.
 */

export type DesignFlowData = AtlasEdgeData & {
  drawn?: boolean;
  designElementId?: string;
  /** Agent-proposed flow awaiting review. */
  ghost?: boolean;
  authorName?: string;
  /** Drawn, but no code relation matches it. */
  notInCode?: boolean;
  /** Code flow that is not drawn: ends to adopt it with. */
  undrawn?: { fromEntityId: string; toEntityId: string };
};
export type DesignFlowEdgeT = Edge<DesignFlowData, 'design-flow'>;

/** Node data additions: a bound box whose entities (some or all) are gone is stale. */
export function designNodeExtras(n: ProjectionNodeDto, p: ProjectionDto) {
  const stale = p.drift?.some(
    (d) => d.kind === 'bound-entity-missing' && d.elementId === n.designElementId,
  );
  return stale ? { staleBound: true } : {};
}

/** Edge type, class and data additions of a design-lens edge. */
export function designEdgeExtras(e: ProjectionEdgeDto, p: ProjectionDto) {
  const notInCode =
    !!e.designElementId &&
    !!p.drift?.some((d) => d.kind === 'flow-not-in-code' && d.elementId === e.designElementId);
  let undrawn: DesignFlowData['undrawn'];
  if (!e.drawn && !e.ghost && p.drift?.length) {
    const ent = new Map(p.nodes.map((n) => [n.id, n.entityId]));
    const a = ent.get(e.source);
    const b = ent.get(e.target);
    const d = p.drift.find(
      (x) => x.kind === 'code-flow-not-drawn' && x.fromEntityId === a && x.toEntityId === b,
    );
    if (d && d.kind === 'code-flow-not-drawn')
      undrawn = { fromEntityId: d.fromEntityId, toEntityId: d.toEntityId };
  }
  const classes = [
    e.drawn ? 'drawn-edge' : '',
    notInCode ? 'not-in-code' : '',
    undrawn ? 'undrawn-edge' : '',
    e.ghost ? 'ghost-edge' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    type: 'design-flow' as const,
    className: classes,
    data: {
      ...(e.drawn ? { drawn: true } : {}),
      ...(e.designElementId ? { designElementId: e.designElementId } : {}),
      ...(e.ghost ? { ghost: true, authorName: e.authorName } : {}),
      ...(notInCode ? { notInCode } : {}),
      ...(undrawn ? { undrawn } : {}),
    },
  };
}

function LabelEditor({ elementId, initial }: { elementId: string; initial: string }) {
  const ed = useDesignEdits()!;
  return (
    <input
      autoFocus
      defaultValue={initial}
      aria-label="Flow label"
      placeholder="label"
      maxLength={60}
      className="wb-inline wb-flow-input nodrag nopan"
      onKeyDown={(e) => {
        e.stopPropagation();
        const t = e.currentTarget;
        if (e.key === 'Escape') ed.setRenaming(null);
        else if (e.key === 'Enter') t.blur();
      }}
      onBlur={(e) => {
        if (ed.renaming !== `flow:${elementId}`) return;
        ed.setRenaming(null);
        void ed.setFlowLabel(elementId, e.currentTarget.value);
      }}
    />
  );
}

/** Whiteboard flow: label (editable when drawn), drift markers, Adopt and ghost review. */
export const DesignFlowEdge = memo(function DesignFlowEdge(p: EdgeProps<DesignFlowEdgeT>) {
  const ed = useDesignEdits();
  const [path] = getBezierPath(p);
  const d = p.data;
  const at = flowLabelPoint(p);
  const x = at?.x ?? (p.sourceX + p.targetX) / 2;
  const y = at?.y ?? (p.sourceY + p.targetY) / 2;
  const elementId = d?.designElementId;
  const editing = !!ed?.editMode && !!elementId && ed.renaming === `flow:${elementId}`;
  const editable = !!ed?.editMode && !!elementId && d?.drawn && !d.ghost;
  const label = d?.label ?? '';
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={p.style} />
      <EdgeLabelRenderer>
        <div
          className={[
            'edge-label flow-label wb-flow',
            p.selected ? 'selected' : '',
            `st-label-${d?.status ?? 'supported'}`,
            d?.undrawn ? 'undrawn' : '',
            d?.notInCode ? 'not-in-code' : '',
            d?.ghost ? 'ghost' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          title={
            d?.undrawn
              ? `${label}: in the code, not drawn on this board`
              : d?.notInCode
                ? `${label}: drawn, but no code relation matches it`
                : `${label} (${d?.status ?? ''})`
          }
          onDoubleClick={
            editable
              ? (e) => {
                  e.stopPropagation();
                  ed.setRenaming(`flow:${elementId}`);
                }
              : undefined
          }
        >
          {editing ? (
            <LabelEditor elementId={elementId} initial={label === 'flow' ? '' : label} />
          ) : (
            <span className="wb-flow-text">{label}</span>
          )}
          {d?.notInCode && !editing && (
            <span className="wb-drift" aria-label="drawn, not found in code">
              drawn, not found in code
            </span>
          )}
          {d?.status && d.status !== 'supported' && d.status !== 'mixed' && !d.notInCode && (
            <span className="edge-status"> · {d.status}</span>
          )}
          {d?.undrawn && ed?.enabled && (
            <button
              type="button"
              className="wb-mini wb-adopt nodrag nopan"
              disabled={ed.busy}
              title="Draw this code flow on the board"
              aria-label={`Adopt ${label} flow`}
              onClick={(e) => {
                e.stopPropagation();
                void ed.adopt(d.undrawn!.fromEntityId, d.undrawn!.toEntityId, label || undefined);
              }}
            >
              Adopt
            </button>
          )}
          {d?.ghost && elementId && (
            <>
              <span className="wb-tag agent">agent: {d.authorName ?? 'unknown'}</span>
              <GhostActions elementId={elementId} label={`${label} flow`} />
            </>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
