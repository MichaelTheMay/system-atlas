import { memo } from 'react';
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import type { ProjectionNodeDto } from '../api.ts';

export type AtlasNodeData = ProjectionNodeDto & { pinned?: boolean; note?: boolean } & Record<
    string,
    unknown
  >;
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

export const AtlasNode = memo(function AtlasNode({ data, selected }: NodeProps<AtlasFlowNode>) {
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
