import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Workspace } from '@atlas/schema';
import { BoardsRoot } from './boards/index.tsx';
import { BOARD_INSPECTOR_SLOT } from './boards/BoardView.tsx';
import {
  api,
  apiOptional,
  captureToken,
  latestSnapshot,
  subscribe,
  type CatalogDto,
  type DaemonStatus,
  type OverlayDto,
  type ProjectionDto,
  type ProjectSummary,
  type ScanJob,
  type SnapshotSummary,
} from './api.ts';
import { CanvasView, type Location, type Selection } from './components/CanvasView.tsx';
import { CatalogNav } from './components/CatalogNav.tsx';
import { IssuesPanel } from './components/IssuesPanel.tsx';
import { Inspector } from './components/Inspector.tsx';
import { ListView } from './components/ListView.tsx';
import { useOverlay } from './useOverlay.ts';
import { OutputsView } from './components/outputs/OutputsView.tsx';
import { DesignToolbar } from './components/design/DesignToolbar.tsx';
import { DesignEditsProvider } from './components/design/useDesignEdits.tsx';
// D02b: design copilot, Generate design dialog and design-agent settings
import { CopilotPanel } from './components/design/CopilotPanel.tsx';
import { GenerateDialog } from './components/design/GenerateDialog.tsx';
import { SettingsDialog } from './components/design/DesignAgentSettings.tsx';
import {
  publishDesignJobEvent,
  useDesignJobs,
  useDesignSettings,
} from './components/design/useDesignJobs.ts';

type Conn =
  | { state: 'no-token' }
  | { state: 'connecting' }
  | { state: 'connected'; status: DaemonStatus; live: boolean }
  | { state: 'error'; message: string };

const ROOTS: { id: Workspace; label: string; hint: string }[] = [
  {
    id: 'architecture',
    label: 'Architecture',
    hint: 'System context, boundaries, components and coverage',
  },
  {
    id: 'design',
    label: 'System design',
    hint: 'Boxes and flows: clients, services, workers, queues, stores',
  },
  {
    id: 'outputs',
    label: 'Outputs & Audit',
    hint: 'Runs, screenshots, command output and artifacts',
  },
];

/** Roots that show canvases; each keeps its own navigation history. */
type CanvasRoot = 'architecture' | 'design';
interface History {
  stack: Location[];
  index: number;
}
const EMPTY_HISTORY: History = { stack: [], index: -1 };
/** Home canvas of a root: the system context, or the system-design whiteboard. */
const HOME_LENS: Record<CanvasRoot, string> = {
  architecture: 'system-context',
  design: 'design-system',
};
const workspaceOf = (c: { workspace?: string } | undefined): CanvasRoot =>
  c?.workspace === 'design' ? 'design' : 'architecture';

interface BusEvent {
  type: string;
  data: Record<string, unknown>;
}

export function App() {
  const token = useMemo(() => captureToken(), []);
  const [conn, setConn] = useState<Conn>(token ? { state: 'connecting' } : { state: 'no-token' });
  const [root, setRoot] = useState<Workspace>('architecture');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [worktreeId, setWorktreeId] = useState('');
  const [summary, setSummary] = useState<SnapshotSummary | null | undefined>(undefined);
  const [watching, setWatching] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [claimsKey, setClaimsKey] = useState(0);
  const [enrichmentProvider, setEnrichmentProvider] = useState<string>('none');
  const [catalog, setCatalog] = useState<CatalogDto | null>(null);
  const [scan, setScan] = useState<{ state: 'idle' | 'running' | 'failed'; message?: string }>({
    state: 'idle',
  });
  /**
   * Daemon events queue up here and are drained together on the next render. A single "last
   * event" slot would lose events that arrive in the same render (other projects' scans and runs
   * share the stream), leaving the UI stuck on "Scanning…".
   */
  const pendingEvents = useRef<BusEvent[]>([]);
  const [eventTick, setEventTick] = useState(0);
  const [histories, setHistories] = useState<Record<CanvasRoot, History>>({
    architecture: EMPTY_HISTORY,
    design: EMPTY_HISTORY,
  });
  const canvasRoot: CanvasRoot = root === 'design' ? 'design' : 'architecture';
  const history = histories[canvasRoot];
  const setHistory = (f: (h: History) => History) =>
    setHistories((all) => ({ ...all, [canvasRoot]: f(all[canvasRoot]) }));
  /** Catalog for navigate(): a canvas opens under the root of its workspace. */
  const catalogRef = useRef<CatalogDto | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedAncestors, setSelectedAncestors] = useState<string[]>([]);
  const [projection, setProjection] = useState<ProjectionDto | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [listMode, setListMode] = useState(false);
  const { overlayRef, overlay, persist, reset, isDirty } = useOverlay(token);
  const [runId, setRunId] = useState<string>();
  const [outputsRefresh, setOutputsRefresh] = useState(0);
  /** When set, the architecture shows this (earlier) snapshot instead of the latest. */
  const [viewSnapshotId, setViewSnapshotId] = useState<string>();

  const location = history.index >= 0 ? history.stack[history.index] : undefined;
  const worktree = projects
    .flatMap((p) => p.worktrees.map((w) => ({ ...w, project: p.project })))
    .find((w) => w.id === worktreeId);
  const projectId = worktree?.project.id;
  // D02b: design agent (one job per project; dialogs and the copilot share it)
  const designJobs = useDesignJobs(token, projectId);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // D03: the design root has two tabs; boards are design-first, the derived lens comes from code
  const [designTab, setDesignTab] = useState<'code' | 'boards'>('code');
  const designSettings = useDesignSettings(token, copilotOpen || generateOpen || settingsOpen);

  const navigate = useCallback((loc: Location) => {
    // selection is an entity, not a node of one canvas: it follows the user across views
    setSelection((s) => (s?.type === 'node' && s.node.entityId ? s : null));
    const ws = workspaceOf(catalogRef.current?.canvases.find((c) => c.id === loc.canvasId));
    setRoot((r) => (r === ws ? r : ws));
    setHistories((all) => {
      const h = all[ws];
      const cur = h.stack[h.index];
      if (cur && cur.canvasId === loc.canvasId && cur.focus === loc.focus) return all;
      const stack = [...h.stack.slice(0, h.index + 1), loc].slice(-100);
      return { ...all, [ws]: { stack, index: stack.length - 1 } };
    });
  }, []);

  const loadProjects = useCallback(async () => {
    if (!token) return;
    const { projects } = await api<{ projects: ProjectSummary[] }>('/projects', token);
    setProjects(projects);
    setWorktreeId((cur) => cur || projects[0]?.worktrees[0]?.id || '');
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    api<DaemonStatus>('/status', token)
      .then(async (status) => {
        setConn({ state: 'connected', status, live: false });
        await loadProjects();
        return subscribe(
          token,
          (type, data) => {
            if (type === 'hello')
              setConn((c) => (c.state === 'connected' ? { ...c, live: true } : c));
            pendingEvents.current.push({ type, data: (data ?? {}) as Record<string, unknown> });
            setEventTick((t) => t + 1);
          },
          ctrl.signal,
        );
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted)
          setConn({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [token, loadProjects]);

  /** Latest snapshot + catalog for the selected worktree; keeps the current canvas if it still exists. */
  const refreshSeq = useRef(0);
  const refreshSnapshot = useCallback(async () => {
    if (!token || !worktreeId) return;
    // a refresh that finishes after a newer one (e.g. after switching projects) is dropped, so a
    // snapshot of one worktree is never paired with a canvas of another
    const seq = ++refreshSeq.current;
    const s = await latestSnapshot(token, worktreeId);
    if (seq !== refreshSeq.current) return;
    setSummary(s);
    const shown = viewSnapshotId ?? s?.snapshot.id;
    const cat = shown ? await apiOptional<CatalogDto>(`/snapshots/${shown}/canvases`, token) : null;
    if (seq !== refreshSeq.current) return;
    catalogRef.current = cat;
    setCatalog(cat);
    const keep = (ws: CanvasRoot, h: History): History => {
      const cur = h.stack[h.index];
      if (cat && cur && cat.canvases.some((c) => c.id === cur.canvasId)) return h;
      const home = cat?.canvases.find((c) => c.lens === HOME_LENS[ws]);
      return home ? { stack: [{ canvasId: home.id }], index: 0 } : EMPTY_HISTORY;
    };
    setHistories((all) => ({
      architecture: keep('architecture', all.architecture),
      design: keep('design', all.design),
    }));
    setRefreshKey((k) => k + 1);
  }, [token, worktreeId, viewSnapshotId]);

  // a different worktree starts fresh; a different snapshot of the same worktree keeps navigation
  useEffect(() => {
    refreshSeq.current++;
    setSummary(undefined);
    setCatalog(null);
    catalogRef.current = null;
    setHistories({ architecture: EMPTY_HISTORY, design: EMPTY_HISTORY });
    setViewSnapshotId(undefined);
    setRunId(undefined);
  }, [worktreeId]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    const batch = pendingEvents.current.splice(0);
    let refresh = false;
    for (const ev of batch) {
      if (ev.type === 'project.registered') void loadProjects();
      if (ev.type.startsWith('run.')) setOutputsRefresh((k) => k + 1);
      if (ev.type === 'design.job' && ev.data.projectId === projectId)
        publishDesignJobEvent(ev.data);
      // linking a rename changes counts and where pins resolve
      if (ev.type === 'issue.resolved') refresh = true;
      if (ev.type.startsWith('claims.') || ev.type === 'views.changed') {
        setClaimsKey((k) => k + 1);
        // design canvases are replanned from claims and view overrides without a rescan
        if (ev.data.projectId && ev.data.projectId === projectId) refresh = true;
      }
      // whiteboard edits (D02a) replan the design canvases of the project without a rescan
      if (ev.type === 'design.changed' && ev.data.projectId === projectId) refresh = true;
      if (ev.data.worktreeId !== worktreeId) continue;
      if (ev.type === 'scan.started') setScan({ state: 'running' });
      if (ev.type === 'snapshot.published') {
        setScan({ state: 'idle' });
        // a no-op rescan returns the same snapshot: refresh only if it is not the one shown
        if (!ev.data.noop || ev.data.snapshotId !== summary?.snapshot.id) refresh = true;
      }
      if (ev.type === 'scan.cancelled') setScan({ state: 'idle' });
      if (ev.type === 'watch.enabled') setWatching(true);
      if (ev.type === 'scan.failed')
        setScan({ state: 'failed', message: String(ev.data.error ?? '') });
    }
    if (refresh) void refreshSnapshot();
  }, [eventTick, worktreeId, projectId, loadProjects, refreshSnapshot]);

  useEffect(() => {
    if (!token || !worktreeId) return;
    let cancelled = false;
    api<{ watching: boolean }>(`/worktrees/${worktreeId}/watch`, token)
      .then((w) => {
        if (!cancelled) setWatching(w.watching);
      })
      .catch(() => {
        if (!cancelled) setWatching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, worktreeId]);

  useEffect(() => {
    if (!token) return;
    api<{ provider: string }>('/settings/enrichment', token)
      .then((s) => setEnrichmentProvider(s.provider))
      .catch(() => setEnrichmentProvider('none'));
  }, [token]);

  const toggleWatch = async () => {
    if (!token || !worktreeId) return;
    const w = await api<{ watching: boolean }>(`/worktrees/${worktreeId}/watch`, token, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !watching }),
    });
    setWatching(w.watching);
  };

  const startScan = async () => {
    if (!token || !worktreeId) return;
    setScan({ state: 'running' });
    try {
      await api<ScanJob>(`/worktrees/${worktreeId}/scans`, token, { method: 'POST' });
    } catch (e) {
      setScan({ state: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onProjection = useCallback(
    (p: ProjectionDto | null, o: OverlayDto | null) => {
      setProjection(p);
      reset(o);
    },
    [reset],
  );

  const editOverlay = useCallback(
    (mutate: (o: OverlayDto) => OverlayDto) => {
      persist(mutate);
      // pins and notes change node decoration/layout: re-project once the save has had a chance to land
      setTimeout(() => setRefreshKey((k) => k + 1), 600);
    },
    [persist],
  );

  /** Jump from an output to the component that produced it, in the run's own snapshot. */
  const openEntity = useCallback(
    async (snapshotId: string, entityId: string) => {
      if (!token) return;
      setRoot('architecture');
      setViewSnapshotId(snapshotId === summary?.snapshot.id ? undefined : snapshotId);
      const target = await apiOptional<{ canvasId: string }>(
        `/snapshots/${snapshotId}/entities/${entityId}/canvas`,
        token,
      );
      if (!target) return;
      navigate({ canvasId: target.canvasId });
      setSelection({
        type: 'node',
        node: { id: `n:${entityId}`, kind: 'entity', entityId, label: '' },
      });
    },
    [token, summary?.snapshot.id, navigate],
  );

  /** Design box -> the architecture canvas that realizes it, with its entity selected. */
  const openRealizedBy = useCallback(
    (canvasId: string, entityId?: string) => {
      setRoot('architecture');
      navigate({ canvasId });
      if (entityId)
        setSelection({
          type: 'node',
          node: { id: `n:${entityId}`, kind: 'entity', entityId, label: '' },
        });
    },
    [navigate],
  );

  const openRun = useCallback((id: string | undefined) => {
    setRoot('outputs');
    setRunId(id);
  }, []);

  const spec = catalog?.canvases.find((c) => c.id === location?.canvasId);
  const coverageCanvasId = catalog?.canvases.find(
    (c) => c.lens === 'coverage' && !c.ownerCanvasId,
  )?.id;
  const latestSnapshotId = summary?.snapshot.id;
  const snapshotId = viewSnapshotId ?? latestSnapshotId;
  const selectedEntity = selection?.type === 'node' ? selection.node.entityId : undefined;

  // owners of the selected entity, so canvases that only show an owner can point at it
  useEffect(() => {
    if (!token || !snapshotId || !selectedEntity) {
      setSelectedAncestors([]);
      return;
    }
    let cancelled = false;
    api<{ owners: { id: string }[] }>(`/snapshots/${snapshotId}/entities/${selectedEntity}`, token)
      .then((d) => {
        if (!cancelled) setSelectedAncestors(d.owners.map((o) => o.id).reverse());
      })
      .catch(() => {
        if (!cancelled) setSelectedAncestors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token, snapshotId, selectedEntity]);

  const shell = (
    <div className="shell">
      <aside className="nav" aria-label="Navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◈
          </span>{' '}
          System Atlas
        </div>
        <label className="field">
          <span className="field-label">Project</span>
          <select
            aria-label="Project"
            disabled={projects.length === 0}
            value={worktreeId}
            onChange={(e) => setWorktreeId(e.target.value)}
          >
            {projects.length === 0 && <option value="">No projects registered</option>}
            {projects.map((p) => (
              <optgroup key={p.project.id} label={p.project.displayName}>
                {p.worktrees.map((w) => (
                  <option key={w.id} value={w.id}>
                    {p.project.displayName}
                    {w.git?.branch ? ` · ${w.git.branch}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {worktreeId && (
          <button
            type="button"
            className="action"
            onClick={startScan}
            disabled={scan.state === 'running'}
          >
            {scan.state === 'running' ? 'Scanning…' : summary ? 'Rescan' : 'Scan project'}
          </button>
        )}
        {worktreeId && (
          <button
            type="button"
            className={`action watch${watching ? ' on' : ''}`}
            aria-pressed={watching}
            title={
              watching
                ? 'Atlas rescans after edits (750 ms after the last change). Click to stop.'
                : 'Rescan automatically after edits'
            }
            onClick={() => void toggleWatch()}
          >
            {watching ? 'Live' : 'Watch'}
          </button>
        )}
        <nav className="roots" aria-label="Workspace roots">
          {ROOTS.map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === root ? 'root active' : 'root'}
              aria-current={r.id === root ? 'page' : undefined}
              onClick={() => setRoot(r.id)}
            >
              <span className="root-label">{r.label}</span>
              <span className="root-hint">{r.hint}</span>
            </button>
          ))}
        </nav>
        {root !== 'outputs' ? (
          <CatalogNav
            catalog={catalog}
            workspace={root}
            currentCanvasId={location?.canvasId}
            onOpen={(id) => navigate({ canvasId: id })}
          />
        ) : (
          <p className="empty-note">
            Runs recorded with <code>atlas run</code>, the Playwright capture helper or the SDK.
            Select a run to see its steps, screenshots, output and audit trail; linked components
            open in the architecture at the run's own snapshot.
          </p>
        )}
        {token && (
          // D02b: Settings → Design agent
          <button
            type="button"
            className="icon-btn nav-settings"
            onClick={() => {
              void designSettings.reload();
              setSettingsOpen(true);
            }}
          >
            Settings
          </button>
        )}
      </aside>

      <main
        className="canvas"
        aria-label={
          root === 'architecture'
            ? `Architecture canvas${projection ? `: ${projection.title}` : ''}`
            : root === 'design'
              ? `System design canvas${projection ? `: ${projection.title}` : ''}`
              : 'Outputs & Audit canvas'
        }
      >
        {root === 'design' && (
          <nav className="design-tabs" aria-label="Design views">
            <button
              type="button"
              aria-pressed={designTab === 'boards'}
              onClick={() => setDesignTab('boards')}
            >
              Boards
            </button>
            <button
              type="button"
              aria-pressed={designTab === 'code'}
              onClick={() => setDesignTab('code')}
            >
              From code
            </button>
          </nav>
        )}
        {root === 'design' && designTab === 'boards' ? (
          projectId && token ? (
            <BoardsRoot token={token} projectId={projectId} />
          ) : (
            <EmptyState
              title="No projects registered"
              text="Run atlas open /path/to/folder (it can be empty) to own design boards."
            />
          )
        ) : (
          <>
            <header className="canvas-header">
              <div className="nav-buttons">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Back"
                  disabled={history.index <= 0}
                  onClick={() => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }))}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Forward"
                  disabled={history.index >= history.stack.length - 1}
                  onClick={() =>
                    setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }))
                  }
                >
                  →
                </button>
              </div>
              <nav className="crumbs" aria-label="Breadcrumbs">
                {root !== 'outputs' && projection ? (
                  projection.breadcrumbs.map((b, i) => (
                    <span key={`${b.canvasId}-${b.focus ?? ''}`}>
                      {i > 0 && <span className="crumb-sep"> / </span>}
                      {i === projection.breadcrumbs.length - 1 ? (
                        <span aria-current="location">{b.title}</span>
                      ) : (
                        <button
                          type="button"
                          className="crumb"
                          onClick={() => navigate({ canvasId: b.canvasId, focus: b.focus })}
                        >
                          {b.title}
                        </button>
                      )}
                    </span>
                  ))
                ) : (
                  <span>{ROOTS.find((r) => r.id === root)?.label}</span>
                )}
              </nav>
              <div className="header-tools">
                {/* whiteboard tools of the design root (D02a adds palette and generation here) */}
                {root === 'design' && (
                  <DesignToolbar>
                    {/* D02b */}
                    {projection && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-pressed={copilotOpen}
                        onClick={() => setCopilotOpen((o) => !o)}
                      >
                        Copilot
                      </button>
                    )}
                    {projection && latestSnapshotId && !viewSnapshotId && (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setGenerateOpen(true)}
                      >
                        Generate design…
                      </button>
                    )}
                  </DesignToolbar>
                )}
                {root !== 'outputs' && projection && projection.siblings.length > 0 && (
                  <label className="lens-switch">
                    <span className="sr-only">Switch lens</span>
                    <select
                      aria-label="Switch lens"
                      value=""
                      onChange={(e) => e.target.value && navigate({ canvasId: e.target.value })}
                    >
                      <option value="">Lens: {projection.lens}</option>
                      {projection.siblings.map((s) => (
                        <option key={s.canvasId} value={s.canvasId}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {root !== 'outputs' && projection && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-pressed={listMode}
                    onClick={() => setListMode((m) => !m)}
                  >
                    {listMode ? 'Canvas' : 'List'}
                  </button>
                )}
                {root !== 'outputs' && projection && !listMode && (
                  <button
                    type="button"
                    className="icon-btn"
                    title="Lay out unpinned nodes again. Nodes otherwise keep their place when the map changes."
                    onClick={() => editOverlay((o) => ({ ...o, autoPositions: {} }))}
                  >
                    Re-layout
                  </button>
                )}
                {viewSnapshotId && root !== 'outputs' && (
                  <span className="badge historical" title={viewSnapshotId}>
                    viewing an earlier snapshot ({viewSnapshotId.slice(5, 13)}){' '}
                    <button
                      type="button"
                      className="link"
                      onClick={() => setViewSnapshotId(undefined)}
                    >
                      back to latest
                    </button>
                  </span>
                )}
                {summary && summary.openIssues > 0 && (
                  <button
                    type="button"
                    className="badge issues"
                    aria-expanded={issuesOpen}
                    onClick={() => setIssuesOpen((o) => !o)}
                  >
                    {summary.openIssues} rename {summary.openIssues === 1 ? 'issue' : 'issues'} to
                    review
                  </button>
                )}
                {summary && (
                  <span className={`badge ${summary.snapshot.state}`} title={summary.snapshot.id}>
                    snapshot {summary.snapshot.state} ·{' '}
                    {summary.snapshot.dirty
                      ? 'uncommitted changes'
                      : `HEAD ${summary.snapshot.headCommit?.slice(0, 8) ?? ''}`}
                  </span>
                )}
              </div>
            </header>
            {issuesOpen && worktree && token && (
              <IssuesPanel
                token={token}
                projectId={worktree.project.id}
                onClose={() => setIssuesOpen(false)}
                onChanged={() => {
                  void refreshSnapshot();
                  setRefreshKey((k) => k + 1);
                }}
              />
            )}
            {root === 'outputs' ? (
              worktree && token ? (
                <OutputsView
                  token={token}
                  projectId={worktree.project.id}
                  latestSnapshotId={latestSnapshotId}
                  runId={runId}
                  refreshKey={outputsRefresh}
                  onOpenRun={openRun}
                  onOpenEntity={(sid, eid) => void openEntity(sid, eid)}
                />
              ) : (
                <EmptyState
                  title="No projects registered"
                  text="Run atlas open /path/to/repo to register one."
                />
              )
            ) : summary === null ? (
              <EmptyState
                title="No snapshot yet"
                text={
                  root === 'design'
                    ? 'Scan a repository to draw its system design: clients, services, workers, queues and stores, derived from detected code.'
                    : 'Register and scan a repository to generate its architecture canvases.'
                }
                code="atlas scan /path/to/repo"
              />
            ) : root === 'design' &&
              catalog &&
              !catalog.canvases.some((c) => c.workspace === 'design') ? (
              <EmptyState
                title="No system design for this snapshot"
                text="No deployables, packages, stores or queues were detected, so there are no boxes to draw. The Architecture root still shows what was scanned."
              />
            ) : !location || !snapshotId || !worktree ? (
              <EmptyState
                title={projects.length ? 'Loading…' : 'No projects registered'}
                text={projects.length ? '' : 'Run atlas open /path/to/repo to register one.'}
              />
            ) : (
              <div className="canvas-body">
                <ReactFlowProvider>
                  <CanvasView
                    token={token!}
                    snapshotId={snapshotId}
                    projectId={worktree.project.id}
                    location={location}
                    refreshKey={refreshKey}
                    onNavigate={navigate}
                    onSelect={setSelection}
                    selectedEntityId={
                      selection?.type === 'node' ? selection.node.entityId : undefined
                    }
                    selectedAncestors={selectedAncestors}
                    onProjection={onProjection}
                    onRealizedBy={openRealizedBy}
                    overlayRef={overlayRef}
                    persist={persist}
                    overlayDirty={isDirty}
                  />
                </ReactFlowProvider>
                {listMode && projection && (
                  // the canvas stays mounted underneath: it owns projection loading and navigation
                  <ListView
                    projection={projection}
                    selectedEntityId={
                      selection?.type === 'node' ? selection.node.entityId : undefined
                    }
                    onSelect={(n) => setSelection({ type: 'node', node: n })}
                    onOpen={(n) =>
                      n.focus !== undefined
                        ? navigate({ canvasId: projection.canvasId, focus: n.focus })
                        : n.openCanvasId && navigate({ canvasId: n.openCanvasId })
                    }
                  />
                )}
                {/* D02b: design copilot, docked right of the System design canvas */}
                {root === 'design' && copilotOpen && token && (
                  <CopilotPanel
                    token={token}
                    projectId={worktree.project.id}
                    snapshotId={snapshotId}
                    latestSnapshotId={latestSnapshotId}
                    projection={projection}
                    selection={selection}
                    settings={designSettings.settings}
                    jobs={designJobs}
                    onSettingsChanged={designSettings.setSettings}
                    onOpenRun={openRun}
                    onChanged={() => void refreshSnapshot()}
                    onClose={() => setCopilotOpen(false)}
                  />
                )}
              </div>
            )}
          </>
        )}
      </main>
      {/* D02b: Generate design… and Settings dialogs */}
      {generateOpen && token && projectId && latestSnapshotId && (
        <GenerateDialog
          token={token}
          projectId={projectId}
          snapshotId={latestSnapshotId}
          settings={designSettings.settings}
          jobs={designJobs}
          onSettingsChanged={designSettings.setSettings}
          onOpenRun={(id) => {
            setGenerateOpen(false);
            openRun(id);
          }}
          onChanged={() => void refreshSnapshot()}
          onClose={() => setGenerateOpen(false)}
        />
      )}
      {settingsOpen && token && (
        <SettingsDialog
          token={token}
          settings={designSettings.settings}
          onSaved={designSettings.setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* right panel: the Inspector; D02b's design copilot panel mounts beside it on the design root */}
      {root === 'design' && designTab === 'boards' ? (
        <aside className="inspector" aria-label="Inspector">
          {/* an open board portals its inspector (BoardInspector) into this slot */}
          <div id={BOARD_INSPECTOR_SLOT} className="board-inspector-slot" />
          <div className="board-inspector-empty">
            <h2>Inspector</h2>
            <p className="empty-note">Open a board to edit its components and connections.</p>
          </div>
        </aside>
      ) : snapshotId ? (
        <Inspector
          token={token!}
          snapshotId={snapshotId}
          rootPath={worktree?.rootPath}
          projection={root !== 'outputs' ? projection : null}
          spec={spec}
          coverageCanvasId={coverageCanvasId}
          summary={summary ?? null}
          selection={selection}
          overlay={overlay}
          onEditOverlay={editOverlay}
          onNavigate={navigate}
          onOpenRun={openRun}
          claimsKey={claimsKey}
          worktreeId={worktreeId}
          enrichmentProvider={enrichmentProvider}
          projectId={projectId}
          latestSnapshotId={latestSnapshotId}
          suppressedCanvases={catalog?.canvases.filter((c) => c.state === 'suppressed')}
          onRealizedBy={openRealizedBy}
        />
      ) : (
        <aside className="inspector" aria-label="Inspector">
          <h2>Inspector</h2>
          <p className="empty-note">
            Select an entity, relation or output to see its evidence, freshness and coverage.
          </p>
        </aside>
      )}

      <footer className="strip" aria-label="Status">
        <StatusLine conn={conn} />
        {scan.state === 'failed' && (
          <span className="status error">Scan failed: {scan.message}</span>
        )}
      </footer>
    </div>
  );

  // whiteboard edits (D02a): shared by the design toolbar, the canvas and the Inspector
  return (
    <DesignEditsProvider
      token={token}
      projectId={projectId}
      snapshotId={latestSnapshotId}
      historical={!!viewSnapshotId}
      projection={root === 'design' ? projection : null}
      reloadKey={refreshKey}
      onChanged={() => void refreshSnapshot()}
    >
      {shell}
    </DesignEditsProvider>
  );
}

function EmptyState({ title, text, code }: { title: string; text: string; code?: string }) {
  return (
    <div className="flow">
      <div className="empty-canvas" role="status">
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        {code && <code>{code}</code>}
      </div>
    </div>
  );
}

function StatusLine({ conn }: { conn: Conn }) {
  switch (conn.state) {
    case 'no-token':
      return (
        <span className="status warn">
          Not connected. Start with <code>atlas open</code> and use the URL it prints.
        </span>
      );
    case 'connecting':
      return <span className="status">Connecting to the local daemon…</span>;
    case 'error':
      return <span className="status error">Daemon unavailable: {conn.message}</span>;
    case 'connected':
      return (
        <span className="status ok">
          <span className={conn.live ? 'dot live' : 'dot'} aria-hidden />
          Daemon {conn.status.version} · pid {conn.status.pid} ·{' '}
          {conn.live ? 'live updates on' : 'connecting stream'}
        </span>
      );
  }
}
