import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Workspace } from '@atlas/schema';
import {
  api,
  captureToken,
  latestSnapshot,
  subscribe,
  type DaemonStatus,
  type ProjectSummary,
  type ScanJob,
  type SnapshotSummary,
} from './api.ts';

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
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [worktreeId, setWorktreeId] = useState('');
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null | undefined>(undefined);
  const [scan, setScan] = useState<{ state: 'idle' | 'running' | 'failed'; message?: string }>({
    state: 'idle',
  });
  const [lastEvent, setLastEvent] = useState<BusEvent>();

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

  const refreshSnapshot = useCallback(async () => {
    if (!token || !worktreeId) return;
    setSnapshot(await latestSnapshot(token, worktreeId));
  }, [token, worktreeId]);

  useEffect(() => {
    setSnapshot(undefined);
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === 'project.registered') void loadProjects();
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

  const active = ROOTS.find((r) => r.id === root)!;
  const project = projects.find((p) => p.worktrees.some((w) => w.id === worktreeId));

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
            {scan.state === 'running' ? 'Scanning…' : snapshot ? 'Rescan' : 'Scan project'}
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
        <label className="field">
          <span className="field-label">Canvas catalog</span>
          <input
            type="search"
            placeholder="Search views"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <p className="empty-note">
          Generated views arrive with the view planner (A06). The snapshot summary is shown for now.
        </p>
      </aside>

      <main className="canvas" aria-label={`${active.label} canvas`}>
        <header className="canvas-header">
          <nav className="crumbs" aria-label="Breadcrumbs">
            <span>{active.label}</span>
            {project && <span className="crumb-sep"> / {project.project.displayName}</span>}
          </nav>
          {snapshot && (
            <span className={`badge ${snapshot.snapshot.state}`} title={snapshot.snapshot.id}>
              snapshot {snapshot.snapshot.state} ·{' '}
              {snapshot.snapshot.dirty
                ? 'uncommitted changes'
                : `HEAD ${snapshot.snapshot.headCommit?.slice(0, 8) ?? ''}`}
            </span>
          )}
        </header>
        <div className="flow">
          <ReactFlowProvider>
            <ReactFlow nodes={[]} edges={[]} fitView>
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
          <div className="empty-canvas" role="status">
            {root === 'outputs' ? (
              <>
                <h2>No runs recorded yet</h2>
                <p>Runs captured with atlas run or the Playwright capture helper appear here.</p>
                <code>atlas run -- npm test</code>
              </>
            ) : snapshot ? (
              <SnapshotCard s={snapshot} />
            ) : (
              <>
                <h2>No snapshot yet</h2>
                <p>Register and scan a repository to generate its architecture canvases.</p>
                <code>atlas scan /path/to/repo</code>
              </>
            )}
          </div>
        </div>
      </main>

      <aside className="inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        {snapshot && root === 'architecture' ? (
          <Coverage s={snapshot} />
        ) : (
          <p className="empty-note">
            Select an entity, relation or output to see its evidence, freshness and coverage.
          </p>
        )}
      </aside>

      <footer className="strip" aria-label="Status">
        <StatusLine conn={conn} />
        {scan.state === 'failed' && (
          <span className="status error">Scan failed: {scan.message}</span>
        )}
      </footer>
    </div>
  );
}

function SnapshotCard({ s }: { s: SnapshotSummary }) {
  const ents = Object.entries(s.counts.entitiesByKind);
  const rels = Object.entries(s.counts.relationsByKind);
  return (
    <>
      <h2>Snapshot {s.snapshot.state}</h2>
      <dl className="facts">
        <dt>Files analyzed</dt>
        <dd>{s.coverage.totals.files}</dd>
        <dt>Entities</dt>
        <dd>{ents.map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}</dd>
        <dt>Relations</dt>
        <dd>{rels.map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}</dd>
        <dt>Coverage gaps</dt>
        <dd>{s.coverage.gaps.length}</dd>
      </dl>
    </>
  );
}

function Coverage({ s }: { s: SnapshotSummary }) {
  return (
    <section aria-label="Coverage">
      <h3 className="sub">Languages</h3>
      <ul className="plain">
        {s.coverage.byLanguage.slice(0, 12).map((l) => (
          <li key={`${l.language}-${l.support}`}>
            <span>{l.language}</span>
            <span className={`support ${l.support}`}>{l.support}</span>
            <span className="num">{l.files}</span>
          </li>
        ))}
      </ul>
      <h3 className="sub">Coverage gaps</h3>
      {s.coverage.gaps.length === 0 ? (
        <p className="empty-note">No gaps reported for this snapshot.</p>
      ) : (
        <ul className="gaps">
          {s.coverage.gaps.slice(0, 30).map((g, i) => (
            <li key={i}>
              <span className="gap-kind">{g.kind}</span>
              {g.path && <code>{g.path}</code>}
              <span className="gap-detail">{g.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
