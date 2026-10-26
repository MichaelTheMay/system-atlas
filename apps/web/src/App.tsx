import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Workspace } from '@atlas/schema';
import { api, captureToken, subscribe, type DaemonStatus, type ProjectSummary } from './api.ts';

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

export function App() {
  const token = useMemo(() => captureToken(), []);
  const [conn, setConn] = useState<Conn>(token ? { state: 'connecting' } : { state: 'no-token' });
  const [root, setRoot] = useState<Workspace>('architecture');
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [worktreeId, setWorktreeId] = useState<string>('');

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    const loadProjects = () =>
      api<{ projects: ProjectSummary[] }>('/projects', token).then(({ projects }) => {
        setProjects(projects);
        setWorktreeId((cur) => cur || projects[0]?.worktrees[0]?.id || '');
      });
    api<DaemonStatus>('/status', token)
      .then(async (status) => {
        setConn({ state: 'connected', status, live: false });
        await loadProjects();
        return subscribe(
          token,
          (type) => {
            if (type === 'hello')
              setConn((c) => (c.state === 'connected' ? { ...c, live: true } : c));
            if (type === 'project.registered') void loadProjects();
          },
          ctrl.signal,
        );
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted)
          setConn({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [token]);

  const active = ROOTS.find((r) => r.id === root)!;

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
        <p className="empty-note">No views yet. The catalog fills after the first scan.</p>
      </aside>

      <main className="canvas" aria-label={`${active.label} canvas`}>
        <header className="canvas-header">
          <nav className="crumbs" aria-label="Breadcrumbs">
            <span>{active.label}</span>
          </nav>
        </header>
        <div className="flow">
          <ReactFlowProvider>
            <ReactFlow nodes={[]} edges={[]} fitView proOptions={{ hideAttribution: false }}>
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
          <div className="empty-canvas" role="status">
            <h2>{root === 'architecture' ? 'No snapshot yet' : 'No runs recorded yet'}</h2>
            <p>
              {root === 'architecture'
                ? 'Register and scan a repository to generate its architecture canvases.'
                : 'Runs captured with atlas run or the Playwright capture helper appear here.'}
            </p>
            <code>
              {root === 'architecture' ? 'atlas scan /path/to/repo' : 'atlas run -- npm test'}
            </code>
          </div>
        </div>
      </main>

      <aside className="inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="empty-note">
          Select an entity, relation or output to see its evidence, freshness and coverage.
        </p>
      </aside>

      <footer className="strip" aria-label="Status">
        <StatusLine conn={conn} />
      </footer>
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
