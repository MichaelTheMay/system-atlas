import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ProjectionNodeDto } from '../../api.ts';
import { isDetectedBox, useDesignEdits } from './useDesignEdits.tsx';
import './whiteboard.css';

/**
 * Whiteboard parts of design boxes (D02a): inline rename, the "planned — not in code" and stale
 * markers, agent ghosts with Accept / Reject, and sticky notes.
 */

type NodeData = ProjectionNodeDto & { staleBound?: boolean } & Record<string, unknown>;

/** Extra classes of a design box: unbound (dashed), agent ghost, stale binding. */
export function designNodeClasses(d: NodeData): string {
  return [d.unbound ? 'unbound' : '', d.ghost ? 'ghost' : '', d.staleBound ? 'stale-bound' : '']
    .filter(Boolean)
    .join(' ');
}

/** Boxes a person can rename: drawn boxes and subsystems, and detected boxes (via a bound box). */
export const renamable = (d: ProjectionNodeDto) =>
  !d.ghost &&
  (isDetectedBox(d) ||
    (d.id.startsWith('design:') && (d.kind === 'design' || d.kind === 'cluster')));

function InlineInput({
  initial,
  label,
  multiline,
  onDone,
}: {
  initial: string;
  label: string;
  multiline?: boolean;
  onDone(value: string | null): void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  const props = {
    ref,
    value: v,
    'aria-label': label,
    className: 'wb-inline nodrag nopan nowheel',
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) =>
      setV(e.target.value),
    onBlur: () => finish(v),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => {
      // Enter must not bubble to the canvas (it opens the selected box)
      e.stopPropagation();
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(v);
      }
    },
  };
  return multiline ? <textarea rows={4} {...props} /> : <input {...props} />;
}

/** The label of a design box; in edit mode a double-click renames it in place. */
export function EditableLabel({ data, nodeId }: { data: ProjectionNodeDto; nodeId: string }) {
  const ed = useDesignEdits();
  const editing = !!ed?.editMode && ed.renaming === nodeId;
  if (editing)
    return (
      <InlineInput
        initial={data.label}
        label={`Rename ${data.label}`}
        onDone={(v) => {
          ed.setRenaming(null);
          if (v !== null) void ed.rename(data, v);
        }}
      />
    );
  const can = !!ed?.editMode && renamable(data);
  return (
    <span
      className="node-label"
      title={can ? 'Double-click to rename' : undefined}
      onDoubleClick={
        can
          ? (e) => {
              e.stopPropagation();
              ed.setRenaming(nodeId);
            }
          : undefined
      }
    >
      {data.label}
    </span>
  );
}

/** Accept / Reject of an agent proposal (ghost). */
export function GhostActions({ elementId, label }: { elementId: string; label: string }) {
  const ed = useDesignEdits();
  if (!ed?.enabled) return null;
  return (
    <span className="wb-ghost-actions nodrag nopan">
      <button
        type="button"
        className="wb-mini primary"
        disabled={ed.busy}
        aria-label={`Accept ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          void ed.accept(elementId);
        }}
      >
        Accept
      </button>
      <button
        type="button"
        className="wb-mini"
        disabled={ed.busy}
        aria-label={`Reject ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          void ed.reject(elementId);
        }}
      >
        Reject
      </button>
    </span>
  );
}

/** Markers under a design box: planned (unbound), stale binding, agent authorship. */
export function DesignNodeTags({ data }: { data: NodeData }) {
  if (!data.unbound && !data.ghost && !data.staleBound) return null;
  return (
    <div className="wb-tags">
      {data.unbound && !data.ghost && (
        <span className="wb-tag planned" title="Drawn by a person; no code is bound to it yet">
          planned — not in code
        </span>
      )}
      {data.staleBound && data.lifecycle !== 'stale' && (
        <span className="tag tag-stale" title="Some code this box is bound to is gone">
          stale
        </span>
      )}
      {data.ghost && (
        <>
          <span className="wb-tag agent" title="Proposed by an agent; nothing is accepted yet">
            agent: {data.authorName ?? 'unknown'}
          </span>
          {data.designElementId && (
            <GhostActions elementId={data.designElementId} label={data.label} />
          )}
        </>
      )}
    </div>
  );
}

export type StickyFlowNode = Node<NodeData, 'sticky'>;

/** A sticky note: double-click (edit mode) to edit its text. */
export const StickyNode = memo(function StickyNode({
  id,
  data,
  selected,
}: NodeProps<StickyFlowNode>) {
  const ed = useDesignEdits();
  const editing = !!ed?.editMode && ed.renaming === id;
  return (
    <div
      className={`wb-sticky${selected ? ' selected' : ''}${data.ghost ? ' ghost' : ''}`}
      title={ed?.editMode ? 'Double-click to edit' : undefined}
      onDoubleClick={
        ed?.editMode && !data.ghost
          ? (e) => {
              e.stopPropagation();
              ed.setRenaming(id);
            }
          : undefined
      }
    >
      <Handle type="target" position={Position.Left} className="handle" isConnectable={false} />
      {editing && data.designElementId ? (
        <InlineInput
          multiline
          initial={data.text ?? data.label}
          label="Note text"
          onDone={(v) => {
            ed.setRenaming(null);
            if (v !== null) void ed.setStickyText(data.designElementId!, v);
          }}
        />
      ) : (
        <p className="wb-sticky-text">{data.text ?? data.label}</p>
      )}
      {data.ghost && data.designElementId && (
        <div className="wb-tags">
          <span className="wb-tag agent">agent: {data.authorName ?? 'unknown'}</span>
          <GhostActions elementId={data.designElementId} label="note" />
        </div>
      )}
      <Handle type="source" position={Position.Right} className="handle" isConnectable={false} />
    </div>
  );
});
