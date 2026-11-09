import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Design-agent client state (D02b): settings, the project's one running job, and its progress from
 * `design.job` SSE events. Jobs start only from an explicit click; nothing here schedules one.
 * Copilot answers come back on GET job (`output`), also kept in the job's run record.
 */

export type RuntimeId = 'claude-code' | 'anthropic-api' | 'mock';
export const RUNTIMES: RuntimeId[] = ['claude-code', 'anthropic-api', 'mock'];
export const RUNTIME_LABEL: Record<RuntimeId, string> = {
  'claude-code': 'Claude Code (your Claude account)',
  'anthropic-api': 'Anthropic API key',
  mock: 'Mock (local, free)',
};

export type DesignJobKind =
  'generate' | 'propose-grouping' | 'name-subsystem' | 'explain-flow' | 'suggest-responsibilities';

export interface DesignJobDto {
  id: string;
  projectId: string;
  kind: DesignJobKind;
  runtime: RuntimeId;
  model?: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  runId?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  proposedClaims?: number;
  output?: { text?: string; data?: unknown };
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  request: { targetIds?: string[]; depth?: number };
}

export interface DesignAgentSettingsDto {
  runtime: RuntimeId;
  model: string | null;
  consented: Record<RuntimeId, boolean>;
  hasApiKey: boolean;
  availability: Record<RuntimeId, { available: boolean; detail: string; external: boolean }>;
  sends: Record<RuntimeId, string>;
  promptTemplateVersion: string;
}

export interface EstimateDto {
  snapshotId: string;
  runtime: RuntimeId;
  model: string | null;
  units: number;
  depth: number;
  maxSubsystemsPerLevel: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  dailyBudget: {
    maxTokensPerDay: number;
    tokensCounted: number;
    remaining: number;
    appliesTo: string;
  };
  sends: string;
  external: boolean;
  consented: boolean;
}

export interface DesignClaimDto {
  id: string;
  subjectId: string;
  subjectName: string;
  predicate: 'subsystem' | 'responsibility';
  value: unknown;
  origin: string;
  status: string;
  evidenceIds: string[];
  model?: string;
}

export interface JobEvent {
  type: 'state' | 'progress' | 'tool-call' | 'usage' | 'done';
  jobId: string;
  projectId?: string;
  state?: DesignJobDto['state'];
  level?: number;
  message?: string;
  tool?: string;
  accepted?: number;
  rejected?: number;
  error?: string;
}

// ---- tiny bus: App forwards `design.job` SSE events here --------------------------------------

const listeners = new Set<(e: JobEvent) => void>();
export function publishDesignJobEvent(data: unknown) {
  for (const l of listeners) l(data as JobEvent);
}

// ---- fetch helpers ------------------------------------------------------------------------------

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: T & { error?: string; detail?: unknown };
}

export async function call<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as ApiResult<T>['body'];
  return { ok: res.ok, status: res.status, body: json };
}

export function errorText(r: ApiResult<unknown>): string {
  const b = r.body;
  if (b.error === 'consent_required') return 'This runtime needs your consent first (Settings).';
  if (b.error === 'budget_exceeded') return 'The daily token budget would be exceeded.';
  if (b.error === 'job_running') return 'Another design job is running for this project.';
  return b.error ? String(b.error) : `HTTP ${r.status}`;
}

export const isTerminal = (s?: DesignJobDto['state']) =>
  s === 'succeeded' || s === 'failed' || s === 'canceled';

/**
 * Settings are loaded only once a design-agent surface is open (`enabled`): reading them checks
 * every runtime's availability, which runs `claude --version`.
 */
export function useDesignSettings(token: string | null, enabled: boolean) {
  const [settings, setSettings] = useState<DesignAgentSettingsDto | null>(null);
  const reload = useCallback(async () => {
    if (!token) return;
    const r = await call<DesignAgentSettingsDto>(token, 'GET', '/settings/design-agent');
    if (r.ok) setSettings(r.body);
  }, [token]);
  const loaded = settings !== null;
  useEffect(() => {
    if (enabled && !loaded) void reload();
  }, [reload, enabled, loaded]);
  return { settings, reload, setSettings };
}

export interface ActiveJob {
  job: DesignJobDto;
  progress: string[];
}

/** One design job at a time per project (the daemon enforces it); Generate and Ask share it. */
export function useDesignJobs(token: string | null, projectId: string | undefined) {
  const [active, setActive] = useState<ActiveJob | null>(null);
  const activeId = useRef<string | undefined>(undefined);

  const refresh = useCallback(
    async (jobId: string) => {
      if (!token || !projectId) return;
      const r = await call<DesignJobDto>(
        token,
        'GET',
        `/projects/${projectId}/design/jobs/${jobId}`,
      );
      if (r.ok && activeId.current === jobId)
        setActive((a) => (a && a.job.id === jobId ? { ...a, job: r.body } : a));
    },
    [token, projectId],
  );

  useEffect(() => {
    const onEvent = (e: JobEvent) => {
      if (!e || e.jobId !== activeId.current) return;
      const line =
        e.type === 'progress'
          ? e.message
          : e.type === 'tool-call'
            ? `${e.tool}: ${e.accepted ?? 0} accepted, ${e.rejected ?? 0} rejected`
            : e.type === 'state'
              ? `job ${e.state}`
              : undefined;
      setActive((a) => {
        if (!a || a.job.id !== e.jobId) return a;
        const job = e.type === 'state' && e.state ? { ...a.job, state: e.state } : a.job;
        return { job, progress: line ? [...a.progress, line].slice(-50) : a.progress };
      });
      if (e.type === 'done' || (e.type === 'state' && isTerminal(e.state))) void refresh(e.jobId);
    };
    listeners.add(onEvent);
    return () => {
      listeners.delete(onEvent);
    };
  }, [refresh]);

  // a different project starts with no active job
  useEffect(() => {
    activeId.current = undefined;
    setActive(null);
  }, [projectId]);

  const attach = useCallback(
    async (jobId: string) => {
      if (!token || !projectId) return;
      activeId.current = jobId;
      const r = await call<DesignJobDto>(
        token,
        'GET',
        `/projects/${projectId}/design/jobs/${jobId}`,
      );
      if (r.ok && activeId.current === jobId) setActive({ job: r.body, progress: [] });
    },
    [token, projectId],
  );

  /** Start a job (explicit user action). Returns an error message, or undefined on success. */
  const start = useCallback(
    async (body: Record<string, unknown>): Promise<string | undefined> => {
      if (!token || !projectId) return 'no project';
      const r = await call<DesignJobDto>(token, 'POST', `/projects/${projectId}/design/jobs`, body);
      if (!r.ok) {
        const running = (r.body.detail as { jobId?: string } | undefined)?.jobId;
        if (r.status === 409 && running) await attach(running);
        return errorText(r);
      }
      activeId.current = r.body.id;
      setActive({ job: r.body, progress: [] });
      // the mock can finish before the POST resolves: read the job once after starting
      await refresh(r.body.id);
      return undefined;
    },
    [token, projectId, attach, refresh],
  );

  const cancel = useCallback(async () => {
    if (!token || !projectId || !activeId.current) return;
    const id = activeId.current;
    await call(token, 'DELETE', `/projects/${projectId}/design/jobs/${id}`);
    await refresh(id);
  }, [token, projectId, refresh]);

  const clear = useCallback(() => {
    activeId.current = undefined;
    setActive(null);
  }, []);

  return { active, start, cancel, clear, refresh };
}

export type DesignJobsApi = ReturnType<typeof useDesignJobs>;
