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
  changes: {
    entities: Record<string, number>;
    relations: Record<string, number>;
    issues: number;
    previousSnapshotId?: string;
  } | null;
  openIssues: number;
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

// ---- views -------------------------------------------------------------------------------

export interface CanvasSpecDto {
  id: string;
  lens: string;
  title: string;
  ownerCanvasId?: string;
  rootEntityId?: string;
  relevanceScore: number;
  relevanceReason: string;
  coverageSummary: { entityCount: number; gapCount: number; staleCount: number };
}

export interface CatalogDto {
  snapshotId: string;
  canvases: CanvasSpecDto[];
  links: {
    fromCanvasId: string;
    toCanvasId: string;
    relation: 'child' | 'sibling' | 'related' | 'evidence';
    viaEntityId?: string;
  }[];
}

export interface ProjectionNodeDto {
  id: string;
  kind: 'entity' | 'cluster' | 'port' | 'aggregate' | 'gap' | 'group';
  label: string;
  sublabel?: string;
  entityId?: string;
  entityKind?: string;
  lifecycle?: string;
  parentId?: string;
  openCanvasId?: string;
  focus?: string;
  memberCount?: number;
  counts?: Record<string, number>;
  change?: string;
}

export interface ProjectionEdgeDto {
  id: string;
  source: string;
  target: string;
  kinds: Record<string, number>;
  relationIds: string[];
  status: 'supported' | 'inferred' | 'stale' | 'mixed';
}

export interface ProjectionDto {
  viewId: string;
  canvasId: string;
  snapshotId: string;
  lens: string;
  title: string;
  focus?: string;
  relevanceReason: string;
  nodes: ProjectionNodeDto[];
  edges: ProjectionEdgeDto[];
  truncated: boolean;
  breadcrumbs: { canvasId: string; title: string; focus?: string }[];
  siblings: { canvasId: string; lens: string; title: string }[];
  children: { canvasId: string; title: string; viaEntityId?: string }[];
  stats: { entities: number; relations: number; hiddenNodes: number };
}

export interface EvidenceDto {
  id: string;
  sourceKind: string;
  repoRelativePath?: string;
  contentHash?: string;
  startLine?: number;
  endLine?: number;
  extractorId: string;
  extractorVersion: string;
  excerpt?: string;
  redactionState: string;
  freshness: 'current' | 'changed' | 'deleted' | 'unknown';
}

export interface EntityDetailsDto {
  snapshotId: string;
  latestSnapshotId?: string;
  entity: {
    id: string;
    kind: string;
    canonicalName: string;
    displayName: string;
    lifecycle: string;
    producer: string;
    firstSeenSnapshot: string;
    attributes: Record<string, unknown>;
  };
  owners: { id: string; displayName: string; kind: string }[];
  children: { kind: string; n: number }[];
  relations: {
    id: string;
    kind: string;
    direction: 'in' | 'out';
    other: { id: string; displayName: string };
    status: string;
    confidence: string;
    producer: string;
    evidenceCount: number;
  }[];
  evidence: EvidenceDto[];
  claims: { id: string; predicate: string; origin: string; status: string; value: unknown }[];
  runs: {
    id: string;
    status: string;
    startAt: string;
    adapter: string;
    commandSummary: string | null;
    method: string;
    correlation: string;
  }[];
  lastChange: {
    snapshotId: string;
    change: string;
    at: string;
    detail: Record<string, unknown>;
  } | null;
}

export interface RelationDetailsDto {
  id: string;
  kind: string;
  from: { id: string; displayName: string; kind: string };
  to: { id: string; displayName: string; kind: string };
  status: string;
  confidence: string;
  producer: string;
  qualifiers: Record<string, string>;
  evidence: EvidenceDto[];
}

export interface SourceDto {
  path: string;
  language: string;
  state: 'current' | 'changed' | 'deleted';
  text: string | null;
}

export interface OverlayDto {
  schemaVersion: 1;
  viewId: string;
  profileId: string;
  entityPositions: Record<string, { x: number; y: number }>;
  nodePositions: Record<string, { x: number; y: number }>;
  pinnedIds: string[];
  annotations: { id: string; targetId?: string; text: string; createdAt: string }[];
  displayOverrides: Record<string, { label?: string; collapsed?: boolean; hidden?: boolean }>;
  viewport: { x: number; y: number; zoom: number };
  revision: number;
}

export async function apiOptional<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** PUT with optimistic revision; returns the stored overlay, or the server's current one on conflict. */
export async function saveOverlay(
  token: string,
  overlay: OverlayDto,
): Promise<{ ok: boolean; overlay: OverlayDto }> {
  const res = await fetch(`/api/v1/views/${overlay.viewId}/overlay`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(overlay),
  });
  const body = (await res.json()) as OverlayDto & { current?: OverlayDto };
  if (res.status === 409 && body.current) return { ok: false, overlay: body.current };
  if (!res.ok) throw new Error(`overlay: HTTP ${res.status}`);
  return { ok: true, overlay: body };
}

// ---- outputs & audit ---------------------------------------------------------------------

export interface RunDto {
  id: string;
  projectId: string;
  worktreeId?: string;
  snapshotId?: string;
  adapter: string;
  commandSummary?: string;
  startAt: string;
  endAt?: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
  exitCode?: number;
  signal?: string;
  environmentSummary: Record<string, unknown>;
  instrumentationCapabilities: string[];
  captureGaps: { kind: string; detail: string }[];
}

export interface RunSummaryDto {
  run: RunDto;
  outcome: {
    process: RunDto['status'];
    task: 'passed' | 'failed' | 'unknown';
    assertions: { pass: number; fail: number; unknown: number };
  };
  counts: { events: number; artifacts: number; missingArtifacts: number; screenshots: number };
}

export interface EventDto {
  id: string;
  producerId: string;
  producerEventId: string;
  sequence?: number;
  occurredAt: string;
  receivedAt: string;
  type: string;
  parentEventId?: string;
  entityRefs: string[];
  payload: Record<string, unknown>;
}

export interface ArtifactDto {
  id: string;
  sha256: string;
  mediaType: string;
  byteLength: number;
  runId: string;
  eventId?: string;
  logicalName: string;
  role: string;
  capturedAt: string;
  bytesState: 'pending' | 'available' | 'deleted' | 'missing';
  redactionState: string;
  metadata: Record<string, unknown>;
}

export interface RunLinkDto {
  id: string;
  eventOrArtifactId: string;
  entityId: string;
  method: string;
  status: string;
  entity: { displayName: string; kind: string; canonicalName: string } | null;
}

export interface RunDetailDto extends RunSummaryDto {
  events: EventDto[];
  artifacts: ArtifactDto[];
  assertions: {
    id: string;
    outcome: 'pass' | 'fail' | 'unknown';
    description: string;
    eventId?: string;
    source: string;
  }[];
  links: RunLinkDto[];
  missingParents: string[];
}

export interface PreviewUrlDto {
  url: string;
  viewer: 'raw' | 'text';
  expiresAt: string;
  artifact: ArtifactDto;
}
