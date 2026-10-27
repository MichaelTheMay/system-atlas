import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CatalogDto, EntityDetailsDto, ProjectionDto, ProjectionNodeDto } from '../../api.ts';
import type { Selection } from '../CanvasView.tsx';
import './design-agent.css';
import { ConsentScreen } from './DesignAgentSettings.tsx';
import { canvasPath, claimsUnder, promotePath, rejectClaims } from './ReviewSheet.tsx';
import {
  call,
  errorText,
  isTerminal,
  RUNTIME_LABEL,
  type DesignAgentSettingsDto,
  type DesignClaimDto,
  type DesignJobDto,
  type DesignJobKind,
  type DesignJobsApi,
} from './useDesignJobs.ts';

/**
 * Design copilot (D02b), docked right of the System design canvas.
 * - Suggestions are deterministic (no model, free), computed here from the projection, its drift
 *   and the snapshot's design claims; each has Apply and Dismiss (dismissals kept per project).
 * - Ask actions run the configured agent runtime, only on click; results are labeled with the
 *   model and its citations and stay proposed until a person accepts them.
 */

const LAYER: Record<string, string> = {
  client: 'Clients',
  'api-service': 'Services',
  service: 'Services',
  worker: 'Workers',
  queue: 'Messaging',
  datastore: 'Data',
  cache: 'Data',
  'external-api': 'External systems',
  library: 'Shared libraries',
};
/** Archetypes whose coupling suggests a subsystem (stores and queues are shared, not owned). */
const COMPUTE = new Set(['client', 'api-service', 'service', 'worker']);

const name = (s: string) => s.replace(/\//g, '-').slice(0, 38);
const list = (xs: string[], max = 4) =>
  xs.slice(0, max).join(', ') + (xs.length > max ? ` and ${xs.length - max} more` : '');

interface Suggestion {
  id: string;
  title: string;
  detail?: string;
  applyLabel?: string;
  apply?: () => Promise<string | undefined>;
  /** Apply runs "Suggest responsibilities" for these boxes (an explicit click on the agent). */
  ask?: string[];
}

const dismissKey = (projectId: string) => `atlas.copilot.dismissed.${projectId}`;
function loadDismissed(projectId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(dismissKey(projectId)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

const isBox = (n: ProjectionNodeDto) =>
  !!n.entityId && (n.kind === 'entity' || n.kind === 'aggregate') && !n.ghost && !n.openCanvasId;

export function CopilotPanel({
  token,
  projectId,
  snapshotId,
  latestSnapshotId,
  projection,
  selection,
  settings,
  jobs,
  onSettingsChanged,
  onOpenRun,
  onChanged,
  onClose,
}: {
  token: string;
  projectId: string;
  /** Snapshot shown; suggestions apply only when it is the latest. */
  snapshotId: string;
  latestSnapshotId?: string;
  projection: ProjectionDto | null;
  selection: Selection;
  settings: DesignAgentSettingsDto | null;
  jobs: DesignJobsApi;
  onSettingsChanged(s: DesignAgentSettingsDto): void;
  onOpenRun(runId: string): void;
  onChanged(): void;
  onClose(): void;
}) {
  const [claims, setClaims] = useState<DesignClaimDto[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed(projectId));
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [picked, setPicked] = useState<string[]>([]);
  const [needConsent, setNeedConsent] = useState(false);
  const [askError, setAskError] = useState<string>();
  const historical = !!latestSnapshotId && snapshotId !== latestSnapshotId;
  const design =
    projection && (projection.lens === 'design-system' || projection.lens === 'design-subsystem')
      ? projection
      : null;

  useEffect(() => {
    setDismissed(loadDismissed(projectId));
  }, [projectId]);

  const loadClaims = useCallback(async () => {
    const r = await call<{ claims: DesignClaimDto[] }>(
      token,
      'GET',
      `/snapshots/${snapshotId}/design/claims`,
    );
    if (r.ok) setClaims(r.body.claims);
  }, [token, snapshotId]);
  // projection changes when claims or elements change: reload the claims with it
  useEffect(() => {
    void loadClaims();
  }, [loadClaims, projection]);

  const boxes = useMemo(() => (design ? design.nodes.filter(isBox) : []), [design]);
  const byNode = useMemo(() => new Map(design?.nodes.map((n) => [n.id, n]) ?? []), [design]);
  const labelOf = useCallback(
    (entityId: string) => design?.nodes.find((n) => n.entityId === entityId)?.label ?? 'a box',
    [design],
  );

  // keep the pick list in step with the canvas and the selected box
  useEffect(() => {
    setPicked([]);
  }, [design?.canvasId]);
  const selectedEntity =
    selection?.type === 'node' && selection.node.entityId && !selection.node.openCanvasId
      ? selection.node.entityId
      : undefined;
  useEffect(() => {
    if (selectedEntity && boxes.some((b) => b.entityId === selectedEntity))
      setPicked((p) => (p.includes(selectedEntity) ? p : [...p, selectedEntity]));
  }, [selectedEntity, boxes]);

  const group = useCallback(
    async (path: string, entityIds: string[]) => {
      if (!latestSnapshotId) return 'no snapshot';
      const r = await call<{ accepted: unknown[]; rejected: { reasons: string[] }[] }>(
        token,
        'POST',
        `/projects/${projectId}/design/group`,
        { snapshotId: latestSnapshotId, path, entityIds },
      );
      if (!r.ok) return errorText(r);
      return r.body.rejected?.length
        ? `Grouped ${r.body.accepted.length}; refused ${r.body.rejected.length}: ${r.body.rejected[0]?.reasons.join('; ')}`
        : undefined;
    },
    [token, projectId, latestSnapshotId],
  );

  const element = useCallback(
    async (elementId: string) => {
      const r = await call<{
        elements: { id: string; revision: number; boundEntityIds: string[] }[];
      }>(token, 'GET', `/projects/${projectId}/design/elements`);
      return r.ok ? r.body.elements.find((e) => e.id === elementId) : undefined;
    },
    [token, projectId],
  );

  // ---- deterministic suggestions --------------------------------------------------------------
  const suggestions = useMemo((): Suggestion[] => {
    if (!design) return [];
    const out: Suggestion[] = [];
    // 1. drift between the board and the code
    for (const d of design.drift ?? []) {
      if (d.kind === 'code-flow-not-drawn') {
        const a = labelOf(d.fromEntityId);
        const b = labelOf(d.toEntityId);
        out.push({
          id: `adopt:${d.fromEntityId}:${d.toEntityId}`,
          title: `Code flow ${a} → ${b} is not on the board`,
          detail: `${d.relationIds.length} detected relation${d.relationIds.length === 1 ? '' : 's'}.`,
          applyLabel: 'Adopt flow',
          apply: async () => {
            const r = await call(token, 'POST', `/projects/${projectId}/design/elements`, {
              body: {
                kind: 'flow',
                from: { entityId: d.fromEntityId },
                to: { entityId: d.toEntityId },
              },
              boundEntityIds: [],
            });
            return r.ok ? undefined : errorText(r);
          },
        });
      } else if (d.kind === 'flow-not-in-code') {
        const e = design.edges.find((x) => x.designElementId === d.elementId);
        const what = e
          ? `${byNode.get(e.source)?.label ?? '?'} → ${byNode.get(e.target)?.label ?? '?'}`
          : 'a drawn flow';
        out.push({
          id: `drawn:${d.elementId}`,
          title: `Drawn flow ${what} is not found in code`,
          detail: 'Keep it as a plan, or remove it from the board.',
          applyLabel: 'Remove flow',
          apply: async () => {
            const el = await element(d.elementId);
            if (!el) return 'the flow is gone already';
            const r = await call(
              token,
              'DELETE',
              `/projects/${projectId}/design/elements/${d.elementId}?revision=${el.revision}`,
            );
            return r.ok ? undefined : errorText(r);
          },
        });
      } else {
        out.push({
          id: `missing:${d.elementId}`,
          title: `A box is bound to code that no longer exists`,
          detail: `${d.entityIds.length} bound entit${d.entityIds.length === 1 ? 'y is' : 'ies are'} missing from this snapshot.`,
          applyLabel: 'Unbind',
          apply: async () => {
            const el = await element(d.elementId);
            if (!el) return 'the box is gone already';
            const r = await call(
              token,
              'PATCH',
              `/projects/${projectId}/design/elements/${d.elementId}`,
              {
                boundEntityIds: el.boundEntityIds.filter((x) => !d.entityIds.includes(x)),
                revision: el.revision,
              },
            );
            return r.ok ? undefined : errorText(r);
          },
        });
      }
    }

    // 2. likely groupings from coupling: compute boxes that share many flows
    const neighbors = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      neighbors.get(a)!.add(b);
    };
    for (const e of design.edges) {
      link(e.source, e.target);
      link(e.target, e.source);
    }
    const compute = boxes.filter((b) => COMPUTE.has(b.archetype ?? ''));
    const pairs: { a: ProjectionNodeDto; b: ProjectionNodeDto; shared: number; direct: boolean }[] =
      [];
    for (let i = 0; i < compute.length; i++)
      for (let j = i + 1; j < compute.length; j++) {
        const a = compute[i]!;
        const b = compute[j]!;
        const na = neighbors.get(a.id) ?? new Set();
        const nb = neighbors.get(b.id) ?? new Set();
        const shared = [...na].filter((x) => nb.has(x)).length;
        const direct = na.has(b.id);
        if (shared + (direct ? 1 : 0) >= 3) pairs.push({ a, b, shared, direct });
      }
    pairs.sort((x, y) => y.shared - x.shared || x.a.label.localeCompare(y.a.label));
    for (const p of pairs.slice(0, 3)) {
      const path = `${name(p.a.label)} & ${name(p.b.label)}`;
      const ids = [p.a.entityId!, p.b.entityId!];
      out.push({
        id: `couple:${[...ids].sort().join(':')}`,
        title: `Group ${p.a.label} and ${p.b.label}`,
        detail: `They share ${p.shared} neighbor${p.shared === 1 ? '' : 's'}${p.direct ? ' and talk to each other' : ''}. Suggested subsystem: “${path}”.`,
        applyLabel: 'Group',
        apply: () => group(path, ids),
      });
    }

    // 3. boxes not in any subsystem (the root only), by architectural layer
    if (design.lens === 'design-system' && boxes.length) {
      const layers = new Map<string, ProjectionNodeDto[]>();
      for (const b of boxes) {
        const k = LAYER[b.archetype ?? ''] ?? 'Other';
        layers.set(k, [...(layers.get(k) ?? []), b]);
      }
      const singles: string[] = [];
      for (const [layer, bs] of [...layers].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (bs.length < 2) {
          singles.push(...bs.map((b) => b.label));
          continue;
        }
        const ids = bs.map((b) => b.entityId!);
        out.push({
          id: `layer:${layer}:${[...ids].sort().join(':')}`,
          title: `${list(bs.map((b) => b.label))} are not in any subsystem`,
          detail: `Group them as “${layer}”.`,
          applyLabel: `Group as ${layer}`,
          apply: () => group(layer, ids),
        });
      }
      if (singles.length)
        out.push({
          id: `unplaced:${[...singles].sort().join(':')}`,
          title: `${singles.length} box${singles.length === 1 ? ' is' : 'es are'} not in any subsystem`,
          detail: `${list(singles, 6)}. Draw a subsystem around ${singles.length === 1 ? 'it' : 'them'}, or Generate design.`,
        });
    }

    // 4. boxes without a responsibility (ask the agent, on click)
    const has = new Set(
      claims.filter((c) => c.predicate === 'responsibility').map((c) => c.subjectId),
    );
    const missing = boxes.filter((b) => !has.has(b.entityId!));
    if (missing.length)
      out.push({
        id: `resp:${missing
          .map((b) => b.entityId)
          .sort()
          .join(':')}`,
        title: `${missing.length} box${missing.length === 1 ? ' has' : 'es have'} no responsibility`,
        detail: `${list(
          missing.map((b) => b.label),
          6,
        )}.`,
        applyLabel: 'Ask agent',
        ask: missing.map((b) => b.entityId!).slice(0, 25),
      });
    return out;
  }, [design, boxes, byNode, claims, labelOf, group, element, token, projectId]);

  const dismiss = (id: string) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    localStorage.setItem(dismissKey(projectId), JSON.stringify([...next].slice(-500)));
  };

  const apply = async (s: Suggestion) => {
    if (s.ask) return ask('suggest-responsibilities', s.ask);
    if (!s.apply) return;
    setBusy(s.id);
    setMessage(undefined);
    try {
      const err = await s.apply();
      setMessage(err ?? `Applied: ${s.title}.`);
      if (!err) onChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  // ---- ask actions ----------------------------------------------------------------------------
  const runtime = settings?.runtime ?? 'mock';
  const consented = runtime === 'mock' || !!settings?.consented[runtime];
  async function ask(kind: DesignJobKind, targetIds: string[]) {
    setAskError(undefined);
    if (!consented) {
      setNeedConsent(true);
      return;
    }
    if (!latestSnapshotId) return;
    const err = await jobs.start({
      kind,
      runtime,
      ...(settings?.model && runtime !== 'mock' ? { model: settings.model } : {}),
      snapshotId: latestSnapshotId,
      targetIds,
    });
    if (err) setAskError(err);
  }
  const agree = async () => {
    const r = await call<DesignAgentSettingsDto>(token, 'PUT', '/settings/design-agent', {
      runtime,
      consent: true,
    });
    if (r.ok) {
      onSettingsChanged(r.body);
      setNeedConsent(false);
    } else setAskError(errorText(r));
  };

  const flowEnds = useMemo(() => {
    if (selection?.type !== 'edge' || !design) return undefined;
    const e = design.edges.find((x) => x.id === selection.edgeId);
    const a = e && byNode.get(e.source);
    const b = e && byNode.get(e.target);
    return a?.entityId && b?.entityId ? [a, b] : undefined;
  }, [selection, design, byNode]);
  const subsystemNode =
    selection?.type === 'node' && selection.node.openCanvasId ? selection.node : undefined;
  const nameTargets = async (): Promise<string[]> => {
    if (subsystemNode?.openCanvasId) {
      const r = await call<ProjectionDto>(
        token,
        'GET',
        `/snapshots/${snapshotId}/canvases/${subsystemNode.openCanvasId}/projection`,
      );
      return r.ok ? r.body.nodes.filter(isBox).map((n) => n.entityId!) : [];
    }
    if (design?.lens === 'design-subsystem') return boxes.map((b) => b.entityId!);
    return picked;
  };

  const askJob = jobs.active && jobs.active.job.kind !== 'generate' ? jobs.active : null;
  // asks wait for a running job, and for the settings (the configured runtime) to load
  const running = (!!jobs.active && !isTerminal(jobs.active.job.state)) || !settings;
  const shown = suggestions.filter((s) => !dismissed.has(s.id));

  if (!design)
    return (
      <aside className="copilot" aria-label="Design copilot">
        <Header onClose={onClose} />
        <p className="muted small">The copilot works on System design canvases.</p>
      </aside>
    );

  return (
    <aside className="copilot" aria-label="Design copilot">
      <Header onClose={onClose} />
      <section aria-label="Suggestions">
        <h3 className="da-h">
          Suggestions <span className="muted small">no model · free</span>
        </h3>
        {historical && (
          <p className="muted small">
            Viewing an earlier snapshot: suggestions apply to the latest.
          </p>
        )}
        {shown.length === 0 ? (
          <p className="muted small">Nothing to suggest on this canvas.</p>
        ) : (
          <ul className="copilot-list">
            {shown.map((s) => (
              <li key={s.id} className="copilot-item" aria-label={s.title}>
                <p className="copilot-title">{s.title}</p>
                {s.detail && <p className="muted small">{s.detail}</p>}
                <div className="da-buttons">
                  {(s.apply || s.ask) && (
                    <button
                      type="button"
                      className="action-sm primary"
                      disabled={!!busy || historical || (s.applyLabel === 'Ask agent' && running)}
                      onClick={() => void apply(s)}
                    >
                      {busy === s.id ? 'Applying…' : s.applyLabel}
                    </button>
                  )}
                  <button type="button" className="action-sm" onClick={() => dismiss(s.id)}>
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {message && (
          <p className="muted small" role="status">
            {message}
          </p>
        )}
      </section>

      <section aria-label="Ask the agent">
        <h3 className="da-h">Ask the agent</h3>
        <p className="muted small">
          Runs on {RUNTIME_LABEL[runtime]}
          {settings?.model && runtime !== 'mock' ? ` (${settings.model})` : ''}, only when you
          click. Results stay proposed until you accept them.
        </p>
        {boxes.length > 0 && (
          <div className="copilot-picks" role="group" aria-label="Boxes to ask about">
            {boxes.map((b) => {
              const on = picked.includes(b.entityId!);
              return (
                <button
                  key={b.id}
                  type="button"
                  className="copilot-chip"
                  aria-pressed={on}
                  onClick={() =>
                    setPicked((p) => (on ? p.filter((x) => x !== b.entityId) : [...p, b.entityId!]))
                  }
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        )}
        <div className="copilot-asks">
          <button
            type="button"
            className="action-sm"
            disabled={running || historical || picked.length < 2}
            title="Select two or more boxes"
            onClick={() => void ask('propose-grouping', picked)}
          >
            Propose a grouping
          </button>
          <button
            type="button"
            className="action-sm"
            disabled={
              running ||
              historical ||
              (!subsystemNode && design.lens !== 'design-subsystem' && picked.length < 1)
            }
            title="A subsystem, or the boxes you picked"
            onClick={() => void nameTargets().then((t) => ask('name-subsystem', t))}
          >
            Name this subsystem
          </button>
          <button
            type="button"
            className="action-sm"
            disabled={running || historical || !flowEnds}
            title="Select a flow between two boxes"
            onClick={() =>
              flowEnds &&
              void ask(
                'explain-flow',
                flowEnds.map((n) => n.entityId!),
              )
            }
          >
            Explain this flow
          </button>
          <button
            type="button"
            className="action-sm"
            disabled={running || historical || picked.length < 1}
            onClick={() => void ask('suggest-responsibilities', picked)}
          >
            Suggest responsibilities
          </button>
        </div>
        {needConsent && settings && runtime !== 'mock' && (
          <ConsentScreen
            runtime={runtime}
            sends={settings.sends[runtime]}
            onAgree={() => void agree()}
            onCancel={() => setNeedConsent(false)}
          />
        )}
        {askError && (
          <p className="da-error" role="alert">
            {askError}
          </p>
        )}
        {askJob && (
          <AskResult
            key={askJob.job.id}
            token={token}
            projectId={projectId}
            snapshotId={latestSnapshotId ?? snapshotId}
            canvasId={design.canvasId}
            job={askJob.job}
            progress={askJob.progress}
            labelOf={labelOf}
            onCancel={() => void jobs.cancel()}
            onDone={() => jobs.clear()}
            onOpenRun={onOpenRun}
            onChanged={onChanged}
            group={group}
          />
        )}
      </section>
    </aside>
  );
}

function Header({ onClose }: { onClose(): void }) {
  return (
    <div className="copilot-head">
      <h2>Copilot</h2>
      <button type="button" className="icon-btn" aria-label="Close copilot" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

const ASK_TITLE: Record<DesignJobKind, string> = {
  generate: 'Generate design',
  'propose-grouping': 'Proposed grouping',
  'name-subsystem': 'Subsystem name',
  'explain-flow': 'Flow explanation',
  'suggest-responsibilities': 'Suggested responsibilities',
};

/** One Ask result: labeled "agent: <model>", with citations, Accept and Reject. */
function AskResult({
  token,
  projectId,
  snapshotId,
  canvasId,
  job,
  progress,
  labelOf,
  onCancel,
  onDone,
  onOpenRun,
  onChanged,
  group,
}: {
  token: string;
  projectId: string;
  snapshotId: string;
  canvasId: string;
  job: DesignJobDto;
  progress: string[];
  labelOf(entityId: string): string;
  onCancel(): void;
  onDone(): void;
  onOpenRun(runId: string): void;
  onChanged(): void;
  group(path: string, ids: string[]): Promise<string | undefined>;
}) {
  const [claims, setClaims] = useState<DesignClaimDto[]>([]);
  const [cites, setCites] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<string>();
  const [busy, setBusy] = useState(false);
  const data = (job.output?.data ?? {}) as {
    name?: string;
    responsibility?: string;
    explanation?: string;
    evidenceIds?: string[];
    result?: { accepted?: { claimId?: string }[] };
  };
  const targets = job.request.targetIds ?? [];
  const done = job.state === 'succeeded';

  useEffect(() => {
    if (!done) return;
    let cancelled = false;
    void (async () => {
      const r = await call<{ claims: DesignClaimDto[] }>(
        token,
        'GET',
        `/snapshots/${snapshotId}/design/claims`,
      );
      const all = r.ok ? r.body.claims : [];
      const accepted = new Set((data.result?.accepted ?? []).map((a) => a.claimId));
      const mine =
        job.kind === 'propose-grouping'
          ? claimsUnder(all, [data.name ?? '']).filter((c) => targets.includes(c.subjectId))
          : job.kind === 'suggest-responsibilities'
            ? all.filter(
                (c) =>
                  c.predicate === 'responsibility' &&
                  c.origin === 'model' &&
                  c.status === 'inferred' &&
                  (accepted.has(c.id) || (!accepted.size && targets.includes(c.subjectId))),
              )
            : [];
      // citations: resolve evidence ids to file:line through the targets' entity details
      const map: Record<string, string> = {};
      for (const id of targets.slice(0, 10)) {
        const d = await call<EntityDetailsDto>(
          token,
          'GET',
          `/snapshots/${snapshotId}/entities/${id}`,
        );
        if (d.ok)
          for (const ev of d.body.evidence)
            map[ev.id] =
              `${ev.repoRelativePath ?? ev.sourceKind}${ev.startLine ? `:${ev.startLine}` : ''}`;
      }
      if (!cancelled) {
        setClaims(mine);
        setCites(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [done, job.id, token, snapshotId]);

  const evidence = [
    ...new Set([...(data.evidenceIds ?? []), ...claims.flatMap((c) => c.evidenceIds)]),
  ];

  const act = async (accept: boolean) => {
    setBusy(true);
    let err: string | undefined;
    try {
      if (job.kind === 'propose-grouping') {
        if (accept) {
          const cat = await call<CatalogDto>(token, 'GET', `/snapshots/${snapshotId}/canvases`);
          const c = cat.ok
            ? cat.body.canvases.find(
                (x) =>
                  x.lens === 'design-subsystem' &&
                  canvasPath(cat.body, x).join('/').toLowerCase() ===
                    (data.name ?? '').toLowerCase(),
              )
            : undefined;
          err = c
            ? await promotePath(token, projectId, snapshotId, c.id, data.name ?? '')
            : 'the proposed subsystem is not on the board any more';
        } else await rejectClaims(token, claims, 'rejected in the copilot');
      } else if (job.kind === 'suggest-responsibilities') {
        if (accept) {
          const r = await call<{ accepted: unknown[]; rejected: { reasons: string[] }[] }>(
            token,
            'POST',
            '/proposals/claims',
            {
              snapshotId,
              origin: 'human',
              claims: claims.map((c) => ({
                subjectId: c.subjectId,
                predicate: 'responsibility',
                value: c.value,
                citations: c.evidenceIds.slice(0, 10).map((evidenceId) => ({ evidenceId })),
              })),
            },
          );
          err = !r.ok
            ? errorText(r)
            : r.body.rejected?.length
              ? `${r.body.rejected.length} refused by the validator`
              : undefined;
        } else await rejectClaims(token, claims, 'rejected in the copilot');
      } else if (job.kind === 'name-subsystem') {
        if (accept && data.name) err = await group(data.name, targets);
      } else if (job.kind === 'explain-flow') {
        if (accept && data.explanation) {
          const r = await call(token, 'POST', `/projects/${projectId}/design/elements`, {
            body: {
              kind: 'sticky',
              text: `${data.explanation} (agent: ${job.model ?? 'unknown'}; ${evidence.map((e) => cites[e] ?? e).join(', ')})`.slice(
                0,
                2000,
              ),
              canvasId,
            },
            boundEntityIds: [],
          });
          err = r.ok ? undefined : errorText(r);
        }
      }
    } finally {
      setBusy(false);
    }
    setOutcome(err ?? (accept ? 'Accepted.' : 'Rejected.'));
    if (!err) onChanged();
  };

  return (
    <div className="ask-result" role="region" aria-label="Agent result">
      <div className="ask-head">
        <strong>{ASK_TITLE[job.kind]}</strong>
        <span className="da-agent">agent: {job.model ?? 'unknown'}</span>
      </div>
      {!isTerminal(job.state) && (
        <>
          <p className="muted small" role="status">
            <span className="da-spinner" aria-hidden /> Asking… ({job.state})
          </p>
          <ol className="da-log">
            {progress.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
          <button type="button" className="action-sm" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
      {(job.state === 'failed' || job.state === 'canceled') && (
        <p className="da-error" role="alert">
          {job.state}
          {job.error ? `: ${job.error}` : ''}
        </p>
      )}
      {done && (
        <div className="ask-body">
          {job.kind === 'propose-grouping' && (
            <p>
              Group <strong>{list(targets.map(labelOf))}</strong> as “{data.name}”.{' '}
              <span className="tag st-inferred">proposed</span>
            </p>
          )}
          {job.kind === 'name-subsystem' && (
            <p>
              <strong>{data.name}</strong>
              {data.responsibility ? `: ${data.responsibility}` : ''}
            </p>
          )}
          {job.kind === 'explain-flow' && <p>{data.explanation ?? job.output?.text}</p>}
          {job.kind === 'suggest-responsibilities' && (
            <ul className="plain-list">
              {claims.map((c) => (
                <li key={c.id}>
                  <strong>{c.subjectName}</strong>: {String(c.value)}
                </li>
              ))}
              {claims.length === 0 && <li className="muted">No suggestions were accepted.</li>}
            </ul>
          )}
          <div className="ask-cites" aria-label="Citations">
            <span className="muted small">Citations:</span>{' '}
            {evidence.length ? (
              evidence.map((e) => (
                <code key={e} title={e}>
                  {cites[e] ?? e.slice(0, 12)}
                </code>
              ))
            ) : (
              <span className="muted small">none</span>
            )}
          </div>
          {outcome ? (
            <p className="muted small" role="status">
              {outcome}{' '}
              <button type="button" className="link" onClick={onDone}>
                Clear
              </button>
            </p>
          ) : (
            <div className="da-buttons">
              <button
                type="button"
                className="action-sm primary"
                disabled={busy}
                onClick={() => void act(true)}
              >
                {job.kind === 'explain-flow' ? 'Accept as note' : 'Accept'}
              </button>
              <button
                type="button"
                className="action-sm"
                disabled={busy}
                onClick={() => void act(false)}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}
      {job.runId && (
        <button type="button" className="link" onClick={() => onOpenRun(job.runId!)}>
          Open run
        </button>
      )}
    </div>
  );
}
