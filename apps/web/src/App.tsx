import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Workspace } from '@atlas/schema';
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
import { Inspector } from './components/Inspector.tsx';
import { ListView } from './components/ListView.tsx';
import { useOverlay } from './useOverlay.ts';
import { OutputsView } from './components/outputs/OutputsView.tsx';

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
    id: 'outputs',
    label: 'Outputs & Audit',
    hint: 'Runs, screenshots, command output and artifacts',
  },
];

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
  const [catalog, setCatalog] = useState<CatalogDto | null>(null);
  const [scan, setScan] = useState<{ state: 'idle' | 'running' | 'failed'; message?: string }>({
    state: 'idle',
  });
  const [lastEvent, setLastEvent] = useState<BusEvent>();
  const [history, setHistory] = useState<{ stack: Location[]; index: number }>({
    stack: [],
    index: -1,
  });
  const [selection, setSelection] = useState<Selection>(null);
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

  const navigate = useCallback((loc: Location) => {
    setSelection(null);
    setHistory((h) => {
      const cur = h.stack[h.index];
      if (cur && cur.canvasId === loc.canvasId && cur.focus === loc.focus) return h;
      const stack = [...h.stack.slice(0, h.index + 1), loc].slice(-100);
      return { stack, index: stack.length - 1 };
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
            setLastEvent({ type, data: (data ?? {}) as Record<string, unknown> });
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
  const refreshSnapshot = useCallback(async () => {
    if (!token || !worktreeId) return;
    const s = await latestSnapshot(token, worktreeId);
    setSummary(s);
    const shown = viewSnapshotId ?? s?.snapshot.id;
    const cat = shown ? await apiOptional<CatalogDto>(`/snapshots/${shown}/canvases`, token) : null;
    setCatalog(cat);
    setHistory((h) => {
      const cur = h.stack[h.index];
      if (cat && cur && cat.canvases.some((c) => c.id === cur.canvasId)) return h;
      const home = cat?.canvases.find((c) => c.lens === 'system-context');
      return home ? { stack: [{ canvasId: home.id }], index: 0 } : { stack: [], index: -1 };
    });
    setRefreshKey((k) => k + 1);
  }, [token, worktreeId, viewSnapshotId]);

  // a different worktree starts fresh; a different snapshot of the same worktree keeps navigation
  useEffect(() => {
    setSummary(undefined);
    setCatalog(null);
    setHistory({ stack: [], index: -1 });
    setViewSnapshotId(undefined);
    setRunId(undefined);
  }, [worktreeId]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === 'project.registered') void loadProjects();
    if (lastEvent.type.startsWith('run.')) setOutputsRefresh((k) => k + 1);
    if (lastEvent.data.worktreeId !== worktreeId) return;
    if (lastEvent.type === 'scan.started') setScan({ state: 'running' });
    if (lastEvent.type === 'snapshot.published') {
      setScan({ state: 'idle' });
      void refreshSnapshot();
    }
    if (lastEvent.type === 'scan.failed')
      setScan({ state: 'failed', message: String(lastEvent.data.error ?? '') });
  }, [lastEvent, worktreeId, loadProjects, refreshSnapshot]);

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

  return (
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
        {root === 'architecture' ? (
          <CatalogNav
            catalog={catalog}
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
      </aside>

      <main
        className="canvas"
        aria-label={
          root === 'architecture'
            ? `Architecture canvas${projection ? `: ${projection.title}` : ''}`
            : 'Outputs & Audit canvas'
        }
      >
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
            {root === 'architecture' && projection ? (
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
              <span>{root === 'architecture' ? 'Architecture' : 'Outputs & Audit'}</span>
            )}
          </nav>
          <div className="header-tools">
            {root === 'architecture' && projection && projection.siblings.length > 0 && (
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
            {root === 'architecture' && projection && (
              <button
                type="button"
                className="icon-btn"
                aria-pressed={listMode}
                onClick={() => setListMode((m) => !m)}
              >
                {listMode ? 'Canvas' : 'List'}
              </button>
            )}
            {viewSnapshotId && root === 'architecture' && (
              <span className="badge historical" title={viewSnapshotId}>
                viewing an earlier snapshot ({viewSnapshotId.slice(5, 13)}){' '}
                <button type="button" className="link" onClick={() => setViewSnapshotId(undefined)}>
                  back to latest
                </button>
              </span>
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
            text="Register and scan a repository to generate its architecture canvases."
            code="atlas scan /path/to/repo"
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
                onProjection={onProjection}
                overlayRef={overlayRef}
                persist={persist}
                overlayDirty={isDirty}
              />
            </ReactFlowProvider>
            {listMode && projection && (
              // the canvas stays mounted underneath: it owns projection loading and navigation
              <ListView
                projection={projection}
                onSelect={(n) => setSelection({ type: 'node', node: n })}
                onOpen={(n) =>
                  n.focus !== undefined
                    ? navigate({ canvasId: projection.canvasId, focus: n.focus })
                    : n.openCanvasId && navigate({ canvasId: n.openCanvasId })
                }
              />
            )}
          </div>
        )}
      </main>

      {snapshotId ? (
        <Inspector
          token={token!}
          snapshotId={snapshotId}
          rootPath={worktree?.rootPath}
          projection={root === 'architecture' ? projection : null}
          spec={spec}
          coverageCanvasId={coverageCanvasId}
          summary={summary ?? null}
          selection={selection}
          overlay={overlay}
          onEditOverlay={editOverlay}
          onNavigate={navigate}
          onOpenRun={openRun}
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
