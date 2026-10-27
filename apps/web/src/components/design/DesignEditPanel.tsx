import { useEffect, useState } from 'react';
import type { ProjectionNodeDto } from '../../api.ts';
import { archetypeLabel } from './archetypes.tsx';
import { ARCHETYPES, type Archetype } from './designApi.ts';
import { renamable } from './DesignElementNode.tsx';
import { isDetectedBox, isDrawn, useDesignEdits } from './useDesignEdits.tsx';

/**
 * Inspector part of the whiteboard (D02a) for a selected design box: who drew it, rename, archetype,
 * the drawn subsystem it sits in, delete (drawn) or hide (detected), and review of agent ghosts.
 */
export function DesignBoxEditor({ node }: { node: ProjectionNodeDto }) {
  const ed = useDesignEdits();
  const [label, setLabel] = useState(node.label);
  useEffect(() => {
    setLabel(node.label);
  }, [node.id, node.label]);
  if (!ed?.enabled) return null;
  const el = ed.element(node.designElementId);
  const author =
    el?.author === 'agent'
      ? `agent: ${el.authorName ?? 'unknown'}${el.status === 'proposed' ? ' (proposed)' : ' (accepted by a person)'}`
      : el
        ? 'drawn by you'
        : undefined;
  // the element's own status: the selection may predate an accept
  const proposed = el ? el.status === 'proposed' : !!node.ghost;
  if (proposed && node.designElementId)
    return (
      <section className="wb-insp" aria-label="Proposal review">
        <h4 className="sub">Proposal</h4>
        <p className="muted small">
          {author}. Nothing on the board changes until you accept it; rejecting keeps it in the
          audit trail only.
        </p>
        <div className="design-buttons">
          <button
            type="button"
            className="action-sm primary"
            disabled={ed.busy}
            onClick={() => void ed.accept(node.designElementId!)}
          >
            Accept
          </button>
          <button
            type="button"
            className="action-sm"
            disabled={ed.busy}
            onClick={() => void ed.reject(node.designElementId!)}
          >
            Reject
          </button>
        </div>
      </section>
    );
  if (!ed.editMode) return author ? <p className="muted small wb-author">{author}</p> : null;
  const canRename = renamable(node);
  const isBox = isDetectedBox(node) || (isDrawn(node) && node.kind === 'design');
  const parentId =
    el && (el.body.kind === 'box' || el.body.kind === 'subsystem') ? el.body.parentId : undefined;
  const moveTargets = ed.subsystems.filter((s) => s.id !== node.designElementId);
  return (
    <section className="wb-insp" aria-label="Edit box">
      <h4 className="sub">Edit</h4>
      {author && <p className="muted small wb-author">{author}</p>}
      {canRename && (
        <label className="wb-field">
          <span>Label</span>
          <input
            value={label}
            maxLength={120}
            aria-label="Box label"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void ed.rename(node, label);
            }}
            onBlur={() => label !== node.label && void ed.rename(node, label)}
          />
        </label>
      )}
      {isBox && (
        <label className="wb-field">
          <span>Archetype</span>
          <select
            aria-label="Archetype"
            value={node.archetype ?? 'service'}
            disabled={ed.busy}
            onChange={(e) => void ed.setArchetype(node, e.target.value as Archetype)}
          >
            {ARCHETYPES.map((a) => (
              <option key={a} value={a}>
                {archetypeLabel(a)}
              </option>
            ))}
          </select>
        </label>
      )}
      {ed.canDrawBoxes && (isBox || (isDrawn(node) && node.kind === 'cluster')) && (
        <label className="wb-field">
          <span>In subsystem</span>
          <select
            aria-label="In subsystem"
            value={parentId ?? ''}
            disabled={ed.busy}
            onChange={(e) => void ed.moveTo([node], e.target.value || undefined)}
          >
            <option value="">(top level)</option>
            {moveTargets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.body.kind === 'subsystem' ? s.body.label : s.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="design-buttons">
        {isDetectedBox(node) ? (
          <button
            type="button"
            className="action-sm"
            disabled={ed.busy}
            title="Hide this box from the design views. The code facts are kept."
            onClick={() => void ed.remove([node])}
          >
            Hide box
          </button>
        ) : node.designElementId ? (
          <button
            type="button"
            className="action-sm danger"
            disabled={ed.busy}
            title={
              node.kind === 'cluster'
                ? 'Dissolve: the subsystem goes, what is inside moves up a level'
                : 'Delete this drawn element and the flows drawn to it'
            }
            onClick={() => void ed.remove([node])}
          >
            {node.kind === 'cluster' ? 'Dissolve subsystem' : 'Delete'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
