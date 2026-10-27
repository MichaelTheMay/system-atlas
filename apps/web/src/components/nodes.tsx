import { memo } from 'react';
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import type { ProjectionNodeDto } from '../api.ts';
import { ARCHETYPE_ICON, archetypeLabel } from './design/archetypes.tsx';

export type AtlasNodeData = ProjectionNodeDto & {
  pinned?: boolean;
  note?: boolean;
  /** The selected entity is not on this canvas but lives inside this node. */
  containsSelection?: boolean;
} & Record<string, unknown>;
export type AtlasFlowNode = Node<AtlasNodeData, 'atlas'>;
export type GroupFlowNode = Node<AtlasNodeData, 'group-box'>;

const KIND_ICON: Record<string, string> = {
  system: '◈',
  package: '▣',
  module: '▤',
  symbol: 'ƒ',
  endpoint: '⇄',
  'ui-surface': '▭',
  queue: '≋',
  topic: '≋',
  job: '⚙',
  table: '▦',
  database: '⛁',
  'infrastructure-resource': '☁',
  deployable: '⬡',
  entrypoint: '▶',
  'external-system': '⬚',
};

/** Detail level follows zoom so dense canvases stay readable (plan §13). */
const useDetailed = () => useStore((s) => s.transform[2] >= 0.6);

export const AtlasNode = memo(function AtlasNode(props: NodeProps<AtlasFlowNode>) {
  return props.data.archetype ? <DesignNode {...props} /> : <CodeNode {...props} />;
});

const CodeNode = memo(function CodeNode({ data, selected }: NodeProps<AtlasFlowNode>) {
  const detailed = useDetailed();
  const k = data.kind;
  const icon =
    k === 'cluster'
      ? '⊞'
      : k === 'aggregate'
        ? '⊕'
        : k === 'port'
          ? '↗'
          : k === 'gap'
            ? '!'
            : (KIND_ICON[data.entityKind ?? ''] ?? '•');
  const classes = [
    'atlas-node',
    `k-${k}`,
    data.entityKind ? `ek-${data.entityKind}` : '',
    data.lifecycle ? `lc-${data.lifecycle}` : '',
    data.change ? `ch-${data.change}` : '',
    selected ? 'selected' : '',
    data.containsSelection ? 'contains-selection' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const drill = data.focus !== undefined || !!data.openCanvasId;
  return (
    <div className={classes} title={drill ? 'Double-click to open' : undefined}>
      <Handle type="target" position={Position.Left} className="handle" />
      <div className="node-row">
        <span className="node-icon" aria-hidden>
          {icon}
        </span>
        <span className="node-label">{data.label}</span>
        {data.pinned && (
          <span className="node-flag" title="Pinned position" aria-label="pinned">
            📌
          </span>
        )}
        {data.containsSelection && (
          <span
            className="node-flag"
            title="Contains the selected element"
            aria-label="contains selection"
          >
            ◎
          </span>
        )}
        {data.note && (
          <span className="node-flag" title="Has a note" aria-label="has note">
            ✎
          </span>
        )}
      </div>
      {detailed && (
        <div className="node-meta">
          {data.sublabel && <span className="node-sub">{data.sublabel}</span>}
          {data.lifecycle === 'stale' && <span className="tag tag-stale">stale</span>}
          {data.lifecycle === 'removed' && <span className="tag tag-removed">removed</span>}
          {data.change && <span className={`tag tag-${data.change}`}>{data.change}</span>}
          {data.memberCount !== undefined && k !== 'gap' && (
            <span className="tag">{data.memberCount}</span>
          )}
          {drill && (
            <span className="tag tag-open">{data.focus !== undefined ? 'expand' : 'open'}</span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
});

/**
 * Whiteboard box of the system-design lens: archetype icon and caption, rounder shape, fewer chips.
 * The caption is always shown (not zoom-gated) because it is the point of the lens; the reason the
 * archetype was chosen is the tooltip.
 */
const DesignNode = memo(function DesignNode({ data, selected }: NodeProps<AtlasFlowNode>) {
  const k = data.kind;
  const a = data.archetype!;
  const classes = [
    'atlas-node',
    'design-node',
    `k-${k}`,
    `arch-${a}`,
    data.provenance ? `from-${data.provenance}` : '',
    data.lifecycle ? `lc-${data.lifecycle}` : '',
    selected ? 'selected' : '',
    data.containsSelection ? 'contains-selection' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const drill = data.focus !== undefined || !!data.openCanvasId;
  const caption =
    k === 'cluster'
      ? `subsystem · ${data.memberCount ?? 0} box${data.memberCount === 1 ? '' : 'es'}`
      : k === 'port'
        ? `outside · ${archetypeLabel(a)}`
        : archetypeLabel(a);
  return (
    <div
      className={classes}
      title={`${data.archetypeReason ?? ''}${drill ? '\nDouble-click to open' : ''}`.trim()}
    >
      <Handle type="target" position={Position.Left} className="handle" />
      <div className="node-row">
        <span className="node-icon arch-icon" aria-hidden>
          {k === 'cluster' ? '⊞' : (ARCHETYPE_ICON[a] ?? '•')}
        </span>
        <span className="node-label">{data.label}</span>
        {data.pinned && (
          <span className="node-flag" title="Pinned position" aria-label="pinned">
            📌
          </span>
        )}
        {data.containsSelection && (
          <span
            className="node-flag"
            title="Contains the selected element"
            aria-label="contains selection"
          >
            ◎
          </span>
        )}
      </div>
      <div className="node-meta">
        <span className="node-archetype">{caption}</span>
        {data.provenance && data.provenance !== 'detected' && (
          <span className={`prov prov-${data.provenance}`}>{data.provenance}</span>
        )}
        {data.lifecycle === 'stale' && <span className="tag tag-stale">stale</span>}
      </div>
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
});

export const GroupNode = memo(function GroupNode({ data }: NodeProps<GroupFlowNode>) {
  return (
    <div className={`atlas-group ${data.change ? `ch-${data.change}` : ''}`}>
      <Handle type="target" position={Position.Left} className="handle" />
      <Handle type="source" position={Position.Right} className="handle" />
      <div className="group-label">
        <span aria-hidden>{data.entityKind ? (KIND_ICON[data.entityKind] ?? '▣') : '▣'}</span>{' '}
        {data.label}
        {data.sublabel && <span className="node-sub"> · {data.sublabel}</span>}
      </div>
    </div>
  );
});

export const nodeTypes = { atlas: AtlasNode, 'group-box': GroupNode };

export const NODE_SIZE: Record<string, { width: number; height: number }> = {
  entity: { width: 190, height: 56 },
  cluster: { width: 190, height: 56 },
  aggregate: { width: 190, height: 56 },
  port: { width: 170, height: 48 },
  gap: { width: 220, height: 56 },
};

/** Whiteboard boxes are wider and always two lines tall (see .design-node). */
export const DESIGN_NODE_SIZE: Record<string, { width: number; height: number }> = {
  entity: { width: 210, height: 64 },
  cluster: { width: 230, height: 70 },
  aggregate: { width: 210, height: 64 },
  port: { width: 190, height: 56 },
};
