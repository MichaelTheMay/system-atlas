/** Daemon client for the UI. The token arrives once in the URL fragment and is kept in sessionStorage. */
const TOKEN_KEY = 'atlas.token';

export function captureToken(): string | null {
  const m = /(?:^#|&)token=([0-9a-f]{16,128})/.exec(window.location.hash);
  if (m?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export interface DaemonStatus {
  version: string;
  pid: number;
  startedAt: string;
  dataDir: string;
  node: string;
}

export async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** SSE over fetch so the token can be sent as a header instead of a URL parameter. */
export async function subscribe(
  token: string,
  onEvent: (type: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/v1/stream', {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let type = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) type = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) onEvent(type, JSON.parse(data));
    }
  }
}

export interface ProjectSummary {
  project: { id: string; displayName: string; remoteUrl?: string };
  worktrees: { id: string; rootPath: string; git?: { branch?: string; subPath: string } }[];
}

export interface CoverageGap {
  kind: string;
  path?: string;
  analyzerId?: string;
  detail: string;
  count?: number;
}

export interface SnapshotSummary {
  snapshot: {
    id: string;
    state: string;
    dirty: boolean;
    headCommit?: string;
    publishedAt?: string;
  };
  coverage: {
    totals: { files: number; bytes: number };
    byLanguage: { language: string; files: number; support: string }[];
    analyzers: { id: string; status: string; filesAnalyzed: number }[];
    gaps: CoverageGap[];
  };
  counts: { entitiesByKind: Record<string, number>; relationsByKind: Record<string, number> };
}

export interface ScanJob {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error?: string;
}

/** Latest snapshot for a worktree, or null when none has been published. */
export async function latestSnapshot(
  token: string,
  worktreeId: string,
): Promise<SnapshotSummary | null> {
  const res = await fetch(`/api/v1/worktrees/${worktreeId}/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`snapshot: HTTP ${res.status}`);
  return (await res.json()) as SnapshotSummary;
}
