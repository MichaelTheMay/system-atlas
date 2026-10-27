import { useEffect, useState } from 'react';
import { api, type CanvasSpecDto, type ProjectionDto, type ProjectionNodeDto } from '../../api.ts';
import {
  ARCHETYPE_ICON,
  archetypeLabel,
  PROVENANCE_TEXT,
  ProvenanceBadge,
  type Provenance,
} from './archetypes.tsx';
import { DesignBoxEditor } from './DesignEditPanel.tsx';

/**
 * Inspector parts of the system-design lens (D01c): what a box is and why, where it is realized in
 * code, and the view overrides (pin / suppress / promote) of a subsystem canvas. Overrides change
 * views only; promote re-proposes the agent's claims as human claims through the validator.
 */

type OverrideAction = 'pin' | 'suppress' | 'promote';

interface OverrideRow {
  targetId: string;
  action: OverrideAction;
}

/** Overrides of a project, reloaded whenever `reloadKey` changes (views.changed, claims events). */
export function useOverrides(token: string, projectId: string | undefined, reloadKey: number) {
  const [rows, setRows] = useState<OverrideRow[]>([]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api<{ overrides: OverrideRow[] }>(`/projects/${projectId}/overrides`, token)
      .then((r) => {
        if (!cancelled) setRows(r.overrides);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token, projectId, reloadKey]);
  return rows;
}

export interface DesignContext {
  token: string;
  projectId?: string;
  /** Latest snapshot: promote is validated against it. */
  latestSnapshotId?: string;
  /** Viewing an earlier snapshot: overrides are disabled. */
  historical: boolean;
  overrides: OverrideRow[];
  onChanged(): void;
}

/** Subsystem path of a design canvas: breadcrumb titles below the "System design" root. */
export function subsystemPathOf(projection: ProjectionDto, extra?: string): string {
  return [...projection.breadcrumbs.slice(1).map((b) => b.title), ...(extra ? [extra] : [])].join(
    '/',
  );
}

interface PromoteRejection {
  subjectId: string;
  reasons: string[];
}

export function DesignViewControls({
  ctx,
  canvasId,
  title,
  provenance,
  subsystemPath,
  onSuppressed,
  only,
}: {
  ctx: DesignContext;
  canvasId: string;
  title: string;
  provenance?: Provenance;
  subsystemPath: string;
  onSuppressed?(): void;
  /** Restrict to one action (the "Suppressed here" list only offers Unsuppress). */
  only?: OverrideAction;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [rejected, setRejected] = useState<PromoteRejection[]>([]);
  useEffect(() => {
    setMessage(undefined);
    setRejected([]);
  }, [canvasId]);
  const on = (a: OverrideAction) =>
    ctx.overrides.some((o) => o.targetId === canvasId && o.action === a);

  const send = async (action: OverrideAction, enabled: boolean) => {
    if (!ctx.projectId) return;
    setBusy(true);
    setMessage(undefined);
    setRejected([]);
    try {
      const res = await fetch(`/api/v1/views/${canvasId}/override`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          enabled,
          projectId: ctx.projectId,
          ...(action === 'promote' && enabled
            ? { snapshotId: ctx.latestSnapshotId, subsystemPath }
            : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        accepted?: unknown[];
        rejected?: PromoteRejection[];
      };
      if (res.status === 409 && body.error === 'promotion_rejected') {
        setRejected(body.rejected ?? []);
        setMessage(
          `Promotion refused by the claim validator: ${body.accepted?.length ?? 0} accepted, ${body.rejected?.length ?? 0} rejected.`,
        );
      } else if (res.status === 409) {
        setMessage('A newer snapshot exists. Open the latest snapshot and try again.');
      } else if (!res.ok) {
        setMessage(body.error ?? `HTTP ${res.status}`);
      } else {
        if (action === 'promote' && enabled)
          setMessage(`Promoted: ${body.accepted?.length ?? 0} claim(s) re-proposed as accepted.`);
        if (action === 'suppress' && enabled) onSuppressed?.();
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      ctx.onChanged();
    }
  };

  const disabled = busy || ctx.historical || !ctx.projectId;
  const pinned = on('pin');
  const suppressed = on('suppress');
  return (
    <div className="design-controls" role="group" aria-label={`View controls for ${title}`}>
      <div className="design-buttons">
        {/* pin keeps claim-based subsystems whose evidence changed; detected ones have no claims */}
        {provenance !== 'detected' && (!only || only === 'pin') && (
          <button
            type="button"
            className="action-sm"
            aria-pressed={pinned}
            disabled={disabled}
            title="Keep this subsystem when the evidence of its claims changes (it is marked stale instead of dropped)."
            onClick={() => void send('pin', !pinned)}
          >
            {pinned ? 'Unpin' : 'Pin'}
          </button>
        )}
        {(!only || only === 'suppress') && (
          <button
            type="button"
            className="action-sm"
            aria-pressed={suppressed}
            disabled={disabled}
            title="Hide this subsystem from the design views. Claims and code facts are kept."
            onClick={() => void send('suppress', !suppressed)}
          >
            {suppressed ? 'Unsuppress' : 'Suppress'}
          </button>
        )}
        {provenance === 'proposed' && !only && (
          <button
            type="button"
            className="action-sm primary"
            disabled={disabled || !ctx.latestSnapshotId}
            title="Accept this grouping: the agent's subsystem claims are re-proposed as your claims, citing the same evidence, through the validator."
            onClick={() => void send('promote', true)}
          >
            Promote
          </button>
        )}
      </div>
      {ctx.historical && (
        <p className="muted small">Overrides apply to the latest snapshot only.</p>
      )}
      {message && (
        <p className={rejected.length ? 'warn' : 'muted small'} role="status">
          {message}
        </p>
      )}
      {rejected.length > 0 && (
        <ul className="plain-list rejections" aria-label="Validator reasons">
          {rejected.map((r) => (
            <li key={r.subjectId} title={`Claim subject ${r.subjectId}`}>
              {r.reasons.join('; ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A selected whiteboard box: archetype and reason, provenance, and where code realizes it. */
export function DesignBoxInfo({
  node,
  ctx,
  projection,
  onOpenCanvas,
  onRealizedBy,
}: {
  node: ProjectionNodeDto;
  ctx: DesignContext;
  projection: ProjectionDto;
  onOpenCanvas(canvasId: string): void;
  onRealizedBy?(canvasId: string, entityId?: string): void;
}) {
  const a = node.archetype ?? 'service';
  const isSubsystem = node.kind === 'cluster' && !!node.openCanvasId;
  const prov = node.provenance;
  return (
    <section aria-label="Design box" className="insp">
      <h3 className="insp-title">
        <span className="arch-icon" aria-hidden>
          {isSubsystem ? '⊞' : (ARCHETYPE_ICON[a] ?? '•')}
        </span>{' '}
        {node.label}
      </h3>
      <p className="muted">
        {isSubsystem
          ? (node.sublabel ?? 'subsystem')
          : `${node.kind === 'port' ? 'outside this subsystem' : 'box'}${node.sublabel ? ` · ${node.sublabel}` : ''}`}
      </p>
      <h4 className="sub">{isSubsystem ? 'Dominant archetype' : 'Archetype'}</h4>
      <p>
        <span className={`arch-chip arch-${a}`}>
          {ARCHETYPE_ICON[a] ?? '•'} {archetypeLabel(a)}
        </span>
      </p>
      {node.archetypeReason && <p className="arch-reason">{node.archetypeReason}</p>}
      {/* a planned (drawn, unbound) box is the person's own: its Edit section says so */}
      {prov && !node.unbound && (
        <>
          <h4 className="sub">Provenance</h4>
          <p>
            <ProvenanceBadge provenance={prov} />
          </p>
          <p className="muted small">{PROVENANCE_TEXT[prov]}</p>
        </>
      )}
      {/* whiteboard (D02a): rename, archetype, subsystem, delete/hide, proposal review */}
      <DesignBoxEditor node={node} />
      {isSubsystem && (
        <>
          <button
            type="button"
            className="action-sm"
            onClick={() => onOpenCanvas(node.openCanvasId!)}
          >
            Open {node.label}
          </button>
          <DesignViewControls
            ctx={ctx}
            canvasId={node.openCanvasId!}
            title={node.label}
            provenance={prov}
            subsystemPath={subsystemPathOf(projection, node.label)}
          />
        </>
      )}
      {node.realizedByCanvasId && onRealizedBy && (
        <>
          <h4 className="sub">Realized by</h4>
          <p className="muted small">
            The architecture canvas that holds the code behind this box.
          </p>
          <button
            type="button"
            className="link"
            onClick={() => onRealizedBy(node.realizedByCanvasId!, node.entityId)}
          >
            Open {node.label} in Architecture
          </button>
        </>
      )}
    </section>
  );
}

/** Canvas-level details of a design canvas (no selection). */
export function DesignCanvasInfo({
  projection,
  spec,
  ctx,
  hidden,
  onOpenCanvas,
}: {
  projection: ProjectionDto;
  spec?: CanvasSpecDto;
  ctx: DesignContext;
  /** Suppressed subsystems directly below this canvas, so they can be brought back. */
  hidden: CanvasSpecDto[];
  onOpenCanvas(canvasId: string): void;
}) {
  const subsystem = projection.lens === 'design-subsystem';
  const prov = spec?.provenance;
  const children = projection.children.filter((ch) => !hidden.some((h) => h.id === ch.canvasId));
  return (
    <section aria-label="Canvas details" className="insp">
      <h3 className="insp-title">{projection.title}</h3>
      <p className="muted">
        {subsystem ? 'subsystem' : 'system design'} ·{' '}
        {projection.nodes.filter((n) => n.kind !== 'port' && n.kind !== 'sticky').length} box(es) ·{' '}
        {projection.edges.length} flow(s)
        {projection.truncated && ' · truncated to 200 boxes'}
      </p>
      {prov && (
        <p>
          <ProvenanceBadge provenance={prov} />
          {spec?.state === 'stale' && <span className="tag tag-stale">stale</span>}
        </p>
      )}
      {prov && <p className="muted small">{PROVENANCE_TEXT[prov]}</p>}
      <h4 className="sub">Why this canvas?</h4>
      <p>{projection.relevanceReason}</p>
      {subsystem && (
        <>
          <h4 className="sub">View controls</h4>
          <DesignViewControls
            ctx={ctx}
            canvasId={projection.canvasId}
            title={projection.title}
            provenance={prov}
            subsystemPath={subsystemPathOf(projection)}
            onSuppressed={() => spec?.ownerCanvasId && onOpenCanvas(spec.ownerCanvasId)}
          />
        </>
      )}
      {children.length > 0 && (
        <>
          <h4 className="sub">Subsystems</h4>
          <ul className="plain-list">
            {children.map((ch) => (
              <li key={ch.canvasId}>
                <button type="button" className="link" onClick={() => onOpenCanvas(ch.canvasId)}>
                  {ch.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {hidden.length > 0 && (
        <>
          <h4 className="sub">Suppressed here</h4>
          <ul className="plain-list">
            {hidden.map((c) => (
              <li key={c.id}>
                {c.title} <ProvenanceBadge provenance={c.provenance} />
                <DesignViewControls
                  ctx={ctx}
                  canvasId={c.id}
                  title={c.title}
                  provenance={c.provenance}
                  subsystemPath=""
                  only="suppress"
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted hint">
        Boxes are views over detected code, not new facts. Hover a box for why it got its archetype;
        double-click a subsystem to open it, or a box to open the code that realizes it.
      </p>
    </section>
  );
}
