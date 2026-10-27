import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  buildDesignPrompt,
  connectAtlasTools,
  createAnthropicDesignRuntime,
  createClaudeCodeRuntime,
  createMockDesignRuntime,
  DEFAULT_ANTHROPIC_DESIGN_MODEL,
  DESIGN_PROMPT_TEMPLATE_VERSION,
  instrumentTools,
  type DesignRuntime,
  type DesignRuntimeAvailability,
  type DesignRuntimeResult,
  type DesignToolset,
} from '@atlas/agent-api';
import { appendEvents, correlateRun, createRun, finishRun } from '@atlas/evidence';
import { getSnapshot, getWorktree, rejectClaim } from '@atlas/graph';
import type { Catalog } from '@atlas/planner';
import type { DesignJobState } from '@atlas/schema';
import {
  DesignJobEvent,
  DesignJobRequest,
  DesignRuntimeId,
  newId,
  type DesignRuntimeId as RuntimeId,
} from '@atlas/schema';
import type { Db } from '@atlas/store';
import type { Enricher } from './enrich.ts';
import type { EventBus } from './events.ts';
import { apiKeyStore, type ApiKeyStore } from './secrets.ts';

/**
 * Design-agent jobs (D02c): manual only (an explicit POST; the watcher and scans never start one).
 * One job per project at a time. Each job is recorded as a run with adapter `design-agent` bound to
 * the snapshot it reads, its progress streams as `design.job` bus events, and every proposal goes
 * through the Atlas tools and their citation validator, so it lands as `proposed`. Non-mock
 * runtimes need recorded consent; the API-key runtime is held to the M02 daily token budget.
 */
export interface DesignAgentOptions {
  /** Runtime factories (tests inject a fake-PATH claude-code runtime or a fake API client). */
  runtimes?: Partial<Record<RuntimeId, () => DesignRuntime>>;
  /** Environment for runtimes and key lookup (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Try the OS keychain (`secret-tool`) for the API key (default true). */
  secretTool?: boolean;
  /** How Claude Code starts `atlas mcp <root>` (default: this checkout's CLI under this node). */
  atlasMcp?: (rootPath: string) => {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

export interface DesignJob {
  id: string;
  projectId: string;
  kind: DesignJobRequest['kind'];
  runtime: RuntimeId;
  model?: string;
  request: DesignJobRequest;
  state: z.infer<typeof DesignJobState>;
  runId?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  proposedClaims?: number;
  output?: DesignRuntimeResult['output'];
  usage?: DesignRuntimeResult['usage'];
}

const SETTINGS_KEY = 'design-agent';
const CONSENT_KEY = (r: string) => `design-agent.consent.${r}`;
const PRODUCER = 'atlas-design-agent';

export const DesignAgentSettings = z.object({
  runtime: DesignRuntimeId.default('mock'),
  model: z.string().trim().min(1).max(100).optional(),
});
export const DesignAgentSettingsPatch = z
  .object({
    runtime: DesignRuntimeId.optional(),
    model: z.string().trim().max(100).nullable().optional(),
    consent: z.boolean().optional(),
    apiKey: z.string().max(500).optional(),
  })
  .strict();

/** What a runtime sends off this machine, for the consent screen and the confirm dialog. */
export const SENDS: Record<RuntimeId, string> = {
  mock: 'Nothing leaves this machine: the deterministic mock runs locally and costs nothing.',
  'claude-code':
    'Claude Code sends the versioned design prompt and what the agent reads through the Atlas tools (entity and file names, relations, redacted excerpts of at most 400 characters) to Anthropic under your Claude account; usage counts against your Claude plan.',
  'anthropic-api':
    'Atlas sends the versioned design prompt and what the agent reads through the Atlas tools (entity and file names, relations, redacted excerpts of at most 400 characters) to the Anthropic API with your key; it is billed to your API account and held to the daily token budget.',
};

const nowIso = () => new Date().toISOString();

function defaultAtlasMcp(env: NodeJS.ProcessEnv) {
  const cli = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
  // only the variables that locate the Atlas data/runtime dirs (and with them the daemon record)
  const pass = Object.fromEntries(
    Object.entries(env).filter(
      ([k, v]) =>
        v !== undefined &&
        /^(ATLAS_DATA_DIR|ATLAS_RUNTIME_DIR|XDG_DATA_HOME|XDG_RUNTIME_DIR|XDG_STATE_HOME|HOME)$/.test(
          k,
        ),
    ),
  ) as Record<string, string>;
  return (rootPath: string) => ({
    command: process.execPath,
    args: [cli, 'mcp', rootPath],
    env: pass,
  });
}

type StartResult =
  { ok: true; job: DesignJob } | { ok: false; status: number; error: string; detail?: unknown };

export class DesignJobs {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly enricher: Enricher;
  private readonly daemon: () => { baseUrl: string; token: string };
  private readonly catalog: (snapshotId: string) => Catalog;
  private readonly runtimes: Record<RuntimeId, () => DesignRuntime>;
  private readonly keys: ApiKeyStore;
  private readonly atlasMcp: NonNullable<DesignAgentOptions['atlasMcp']>;
  private readonly active = new Map<string, { job: DesignJob; ctrl: AbortController }>();
  private readonly memory = new Map<string, DesignJob>();
  private seq = 0;

  constructor(deps: {
    db: Db;
    bus: EventBus;
    enricher: Enricher;
    dataDir: string;
    daemon: () => { baseUrl: string; token: string };
    catalog: (snapshotId: string) => Catalog;
    options?: DesignAgentOptions;
  }) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.enricher = deps.enricher;
    this.daemon = deps.daemon;
    this.catalog = deps.catalog;
    const o = deps.options ?? {};
    const env = o.env ?? process.env;
    this.keys = apiKeyStore({ dataDir: deps.dataDir, env, secretTool: o.secretTool });
    this.atlasMcp = o.atlasMcp ?? defaultAtlasMcp(env);
    this.runtimes = {
      mock: o.runtimes?.mock ?? (() => createMockDesignRuntime()),
      'claude-code': o.runtimes?.['claude-code'] ?? (() => createClaudeCodeRuntime({ env })),
      'anthropic-api':
        o.runtimes?.['anthropic-api'] ??
        (() =>
          createAnthropicDesignRuntime({
            apiKey: () => this.keys.read(),
            model: this.settings().model,
          })),
    };
    // a daemon restart interrupts running jobs: never leave them looking alive
    this.db
      .prepare(
        "UPDATE design_jobs SET state = 'failed', error = 'interrupted: the daemon stopped while the job ran', finished_at = ? WHERE state IN ('queued', 'running')",
      )
      .run(nowIso());
  }

  // ------------------------------------------------------------------ settings

  private getSetting(key: string): unknown {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get<{ value: string }>(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  private putSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  settings(): z.infer<typeof DesignAgentSettings> {
    return DesignAgentSettings.parse(this.getSetting(SETTINGS_KEY) ?? {});
  }

  consented(runtime: RuntimeId): boolean {
    return runtime === 'mock' || !!this.getSetting(CONSENT_KEY(runtime));
  }

  async availability(): Promise<Record<RuntimeId, DesignRuntimeAvailability>> {
    const ids = DesignRuntimeId.options;
    const out = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.runtimes[id]().check();
        } catch (e) {
          return {
            available: false,
            detail: (e as Error).message.slice(0, 200),
            external: id !== 'mock',
          };
        }
      }),
    );
    return Object.fromEntries(ids.map((id, i) => [id, out[i]!])) as Record<
      RuntimeId,
      DesignRuntimeAvailability
    >;
  }

  /** Settings view for the UI: never includes the key, only whether one is configured. */
  async settingsView() {
    const s = this.settings();
    return {
      runtime: s.runtime,
      model: s.model ?? (s.runtime === 'anthropic-api' ? DEFAULT_ANTHROPIC_DESIGN_MODEL : null),
      consented: Object.fromEntries(DesignRuntimeId.options.map((r) => [r, this.consented(r)])),
      hasApiKey: await this.keys.has(),
      availability: await this.availability(),
      sends: SENDS,
      promptTemplateVersion: DESIGN_PROMPT_TEMPLATE_VERSION,
    };
  }

  async setSettings(body: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const p = DesignAgentSettingsPatch.safeParse(body ?? {});
    if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? 'invalid settings' };
    const cur = this.settings();
    const runtime = p.data.runtime ?? cur.runtime;
    if (p.data.apiKey !== undefined) {
      const w = await this.keys.write(p.data.apiKey);
      if (!w.ok) return w;
    }
    const model = p.data.model === null ? undefined : (p.data.model ?? cur.model);
    this.putSetting(SETTINGS_KEY, { runtime, ...(model ? { model } : {}) });
    if (p.data.consent === true && runtime !== 'mock')
      this.putSetting(CONSENT_KEY(runtime), { consentedAt: nowIso(), sends: SENDS[runtime] });
    if (p.data.consent === false)
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(CONSENT_KEY(runtime));
    return { ok: true };
  }

  // ------------------------------------------------------------------ estimate

  estimate(projectId: string, q: { snapshotId?: string; depth?: number; runtime?: string }) {
    const snapshotId =
      q.snapshotId ??
      this.db
        .prepare(
          "SELECT id FROM snapshots WHERE project_id = ? AND state IN ('ready','partial') ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .get<{ id: string }>(projectId)?.id;
    if (!snapshotId) return { ok: false as const, status: 404, error: 'no_snapshot' };
    const snap = getSnapshot(this.db, snapshotId);
    if (!snap || snap.projectId !== projectId)
      return { ok: false as const, status: 404, error: 'unknown_snapshot' };
    const depth = Math.min(3, Math.max(1, Number(q.depth ?? 3) || 3));
    const runtime = DesignRuntimeId.safeParse(q.runtime ?? this.settings().runtime);
    const rt: RuntimeId = runtime.success ? runtime.data : 'mock';
    const root = this.catalog(snapshotId).canvases.find((c) => c.lens === 'design-system');
    const units = root?.coverageSummary.entityCount ?? 0;
    const tokens = this.estimateTokens(units, depth);
    const s = this.enricher.settings();
    const counted = this.enricher.usage(projectId).tokensCounted;
    return {
      ok: true as const,
      body: {
        snapshotId,
        runtime: rt,
        model:
          rt === 'mock'
            ? 'mock-design'
            : (this.settings().model ??
              (rt === 'anthropic-api' ? DEFAULT_ANTHROPIC_DESIGN_MODEL : null)),
        units,
        depth,
        maxSubsystemsPerLevel: 8,
        estimatedInputTokens: tokens.input,
        estimatedOutputTokens: tokens.output,
        estimated: true,
        dailyBudget: {
          maxTokensPerDay: s.maxTokensPerDay,
          tokensCounted: counted,
          remaining: Math.max(0, s.maxTokensPerDay - counted),
          appliesTo: 'anthropic-api',
        },
        sends: SENDS[rt],
        external: rt !== 'mock',
        consented: this.consented(rt),
        promptTemplateVersion: DESIGN_PROMPT_TEMPLATE_VERSION,
      },
    };
  }

  /** A rough upper estimate: tool reads per box per level plus the resent conversation. */
  private estimateTokens(units: number, depth: number) {
    return { input: 8_000 + units * 900 * depth, output: 1_000 + units * 120 * depth };
  }

  // ------------------------------------------------------------------ jobs

  private row(j: DesignJob) {
    this.db
      .prepare(
        `INSERT INTO design_jobs (id, project_id, kind, runtime, model, request, state, run_id, error, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET model = excluded.model, state = excluded.state, run_id = excluded.run_id,
           error = excluded.error, finished_at = excluded.finished_at`,
      )
      .run(
        j.id,
        j.projectId,
        j.kind,
        j.runtime,
        j.model ?? null,
        JSON.stringify(j.request),
        j.state,
        j.runId ?? null,
        j.error ?? null,
        j.createdAt,
        j.finishedAt ?? null,
      );
  }

  private fromRow(r: Record<string, string | null>): DesignJob {
    const mem = this.memory.get(String(r.id));
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      kind: r.kind as DesignJob['kind'],
      runtime: r.runtime as RuntimeId,
      model: r.model ?? undefined,
      request: JSON.parse(String(r.request)) as DesignJobRequest,
      state: r.state as DesignJob['state'],
      runId: r.run_id ?? undefined,
      error: r.error ?? undefined,
      createdAt: String(r.created_at),
      finishedAt: r.finished_at ?? undefined,
      proposedClaims: mem?.proposedClaims,
      output: mem?.output ?? this.outputFromRun(r.run_id ?? null),
      usage: mem?.usage,
    };
  }

  /** Copilot answers are kept in the run (the audit record), so they survive a restart. */
  private outputFromRun(runId: string | null): DesignJob['output'] {
    if (!runId) return undefined;
    const r = this.db
      .prepare(
        "SELECT body FROM events WHERE run_id = ? AND type = 'model.enrichment' ORDER BY occurred_at DESC LIMIT 1",
      )
      .get<{ body: string }>(runId);
    return r
      ? (JSON.parse(r.body) as { payload?: { output?: DesignJob['output'] } }).payload?.output
      : undefined;
  }

  list(projectId: string, limit = 20): DesignJob[] {
    return this.db
      .prepare(
        'SELECT * FROM design_jobs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all<Record<string, string | null>>(projectId, Math.min(Math.max(limit, 1), 100))
      .map((r) => this.fromRow(r));
  }

  get(projectId: string, jobId: string): DesignJob | undefined {
    const r = this.db
      .prepare('SELECT * FROM design_jobs WHERE id = ? AND project_id = ?')
      .get<Record<string, string | null>>(jobId, projectId);
    return r ? this.fromRow(r) : undefined;
  }

  cancel(projectId: string, jobId: string): StartResult {
    const a = this.active.get(projectId);
    if (!a || a.job.id !== jobId) {
      const j = this.get(projectId, jobId);
      return j
        ? { ok: false, status: 409, error: `job already ${j.state}` }
        : { ok: false, status: 404, error: 'unknown_job' };
    }
    a.ctrl.abort(new Error('canceled by the user'));
    return { ok: true, job: a.job };
  }

  /** Resolves when the project's running job (if any) has finished (tests, CLI). */
  async idle(projectId: string): Promise<void> {
    while (this.active.has(projectId)) await new Promise((r) => setTimeout(r, 20));
  }

  async start(projectId: string, body: unknown): Promise<StartResult> {
    const parsed = DesignJobRequest.safeParse(body);
    if (!parsed.success)
      return { ok: false, status: 400, error: 'invalid_body', detail: parsed.error.issues };
    const request = parsed.data;
    if (!this.db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(projectId))
      return { ok: false, status: 404, error: 'unknown_project' };
    const snap = getSnapshot(this.db, request.snapshotId);
    if (!snap || snap.projectId !== projectId)
      return { ok: false, status: 404, error: 'unknown_snapshot' };
    if (snap.state !== 'ready' && snap.state !== 'partial')
      return { ok: false, status: 409, error: `snapshot is ${snap.state}` };
    const wt = getWorktree(this.db, snap.worktreeId);
    if (!wt) return { ok: false, status: 404, error: 'unknown_worktree' };
    if (!this.consented(request.runtime))
      return {
        ok: false,
        status: 403,
        error: 'consent_required',
        detail: { runtime: request.runtime, sends: SENDS[request.runtime] },
      };
    if (this.active.has(projectId))
      return {
        ok: false,
        status: 409,
        error: 'job_running',
        detail: { jobId: this.active.get(projectId)!.job.id },
      };

    const model =
      request.runtime === 'mock'
        ? 'mock-design'
        : (request.model ??
          this.settings().model ??
          (request.runtime === 'anthropic-api' ? DEFAULT_ANTHROPIC_DESIGN_MODEL : undefined));
    const units =
      this.catalog(snap.id).canvases.find((c) => c.lens === 'design-system')?.coverageSummary
        .entityCount ?? 0;
    const est = this.estimateTokens(units, request.depth);
    const budget = this.enricher.settings();
    const counted = this.enricher.usage(projectId).tokensCounted;
    if (
      request.runtime === 'anthropic-api' &&
      counted + est.input + est.output > budget.maxTokensPerDay
    ) {
      this.ledger(
        projectId,
        'design-job',
        model ?? '',
        'skipped-budget',
        { input: 0, output: 0 },
        undefined,
        `daily budget of ${budget.maxTokensPerDay} tokens reached`,
      );
      return {
        ok: false,
        status: 429,
        error: 'budget_exceeded',
        detail: {
          maxTokensPerDay: budget.maxTokensPerDay,
          tokensCounted: counted,
          estimated: est.input + est.output,
        },
      };
    }

    const job: DesignJob = {
      id: newId('designJob'),
      projectId,
      kind: request.kind,
      runtime: request.runtime,
      model,
      request,
      state: 'queued',
      createdAt: nowIso(),
    };
    const { run } = createRun(this.db, {
      projectId,
      worktreeId: wt.id,
      snapshotId: snap.id,
      sourceManifestDigest: snap.dirtyTreeDigest,
      adapter: 'design-agent',
      commandSummary: `design ${request.kind} (${request.runtime}${model ? `, ${model}` : ''})`,
      environmentSummary: {
        jobId: job.id,
        runtime: request.runtime,
        model: model ?? 'unknown',
        promptTemplateVersion: DESIGN_PROMPT_TEMPLATE_VERSION,
        depth: request.depth,
        maxSubsystemsPerLevel: request.maxSubsystemsPerLevel,
        replaceProposals: request.replaceProposals,
      },
      instrumentationCapabilities: ['agent-events'],
    });
    job.runId = run.id;
    this.row(job);
    this.bus.publish({
      type: 'run.started',
      data: { runId: run.id, projectId, worktreeId: wt.id },
    });
    const ctrl = new AbortController();
    this.active.set(projectId, { job, ctrl });
    this.memory.set(job.id, job);
    if (this.memory.size > 50) this.memory.delete(this.memory.keys().next().value!);
    void this.execute(job, wt.rootPath, est, ctrl).finally(() => this.active.delete(projectId));
    return { ok: true, job };
  }

  private record(job: DesignJob, type: string, payload: Record<string, unknown>) {
    if (!job.runId) return;
    const r = appendEvents(this.db, job.runId, [
      {
        producerId: PRODUCER,
        producerEventId: `${job.id}:${++this.seq}`,
        type,
        occurredAt: nowIso(),
        payload,
      },
    ]);
    if (r.accepted.length)
      this.bus.publish({ type: 'run.updated', data: { runId: job.runId, events: 1 } });
  }

  private emit(job: DesignJob, e: DesignJobEvent) {
    const ev = DesignJobEvent.safeParse(e);
    if (!ev.success) return;
    this.bus.publish({ type: 'design.job', data: { ...ev.data, projectId: job.projectId } });
    if (ev.data.type === 'tool-call') {
      if (/^atlas_propose_/.test(ev.data.tool))
        job.proposedClaims = (job.proposedClaims ?? 0) + ev.data.accepted;
      this.record(job, 'tool.call.completed', {
        tool: ev.data.tool,
        accepted: ev.data.accepted,
        rejected: ev.data.rejected,
      });
    } else if (ev.data.type === 'progress')
      this.record(job, 'step.completed', { level: ev.data.level, message: ev.data.message });
  }

  private ledger(
    projectId: string,
    jobId: string,
    model: string,
    status: string,
    est: { input: number; output: number },
    reported?: DesignRuntimeResult['usage'],
    detail?: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO model_usage (id, project_id, subject_id, provider, model, digest, status, est_input_tokens, est_output_tokens,
           reported_input_tokens, reported_output_tokens, reported_cost_usd, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('usage'),
        projectId,
        jobId,
        'anthropic-api',
        model,
        `design-job:${jobId}`,
        status,
        est.input,
        est.output,
        reported?.inputTokens ?? null,
        reported?.outputTokens ?? null,
        reported?.costUsd ?? null,
        detail?.slice(0, 500) ?? null,
        nowIso(),
      );
  }

  /** Earlier agent proposals for this snapshot are rejected (audited); human/accepted work stays. */
  private replaceProposals(job: DesignJob) {
    const rows = this.db
      .prepare(
        "SELECT id FROM claims WHERE snapshot_id = ? AND origin = 'model' AND status = 'inferred' AND predicate IN ('subsystem', 'responsibility')",
      )
      .all<{ id: string }>(job.request.snapshotId);
    let n = 0;
    for (const r of rows)
      if (rejectClaim(this.db, r.id, `replaced by design job ${job.id}`).ok) n++;
    if (n) {
      this.bus.publish({
        type: 'claims.reviewed',
        data: { projectId: job.projectId, replaced: n },
      });
      this.record(job, 'step.completed', { message: `rejected ${n} earlier proposed claim(s)` });
    }
  }

  private async execute(
    job: DesignJob,
    rootPath: string,
    est: { input: number; output: number },
    ctrl: AbortController,
  ) {
    const setState = (state: DesignJob['state']) => {
      job.state = state;
      this.row(job);
      this.emit(job, { type: 'state', jobId: job.id, state });
    };
    let tools: DesignToolset | undefined;
    let result: DesignRuntimeResult | undefined;
    try {
      setState('running');
      this.record(job, 'step.started', { kind: job.kind, runtime: job.runtime });
      if (job.kind === 'generate' && job.request.replaceProposals) this.replaceProposals(job);
      tools = instrumentTools(
        await connectAtlasTools({
          daemon: this.daemon(),
          rootPath,
          clientName: `atlas-design-${job.runtime}`,
        }),
        job.id,
        (e) => this.emit(job, e),
      );
      const s = this.enricher.settings();
      const remaining = Math.max(
        0,
        s.maxTokensPerDay - this.enricher.usage(job.projectId).tokensCounted,
      );
      const maxOutputTokens = Math.min(16_000, Math.max(1_000, Math.floor(remaining / 10)));
      const runtime = this.runtimes[job.runtime]();
      result = await runtime.run(job.request, {
        jobId: job.id,
        projectId: job.projectId,
        rootPath,
        tools,
        atlasMcp: this.atlasMcp(rootPath),
        prompt: buildDesignPrompt({ request: job.request, snapshotId: job.request.snapshotId }),
        promptTemplateVersion: DESIGN_PROMPT_TEMPLATE_VERSION,
        budget: { maxInputTokens: Math.max(0, remaining - maxOutputTokens), maxOutputTokens },
        emit: (e) => this.emit(job, e),
        signal: ctrl.signal,
      });
      ctrl.signal.throwIfAborted();
      job.model = result.model ?? job.model;
      job.usage = result.usage;
      job.output = result.output;
      this.record(job, 'model.enrichment', {
        runtime: job.runtime,
        model: job.model ?? 'unknown',
        promptTemplateVersion: DESIGN_PROMPT_TEMPLATE_VERSION,
        usage: result.usage,
        proposedClaims: job.proposedClaims ?? 0,
        ...(result.output ? { output: result.output as Record<string, unknown> } : {}),
      });
      if (job.runtime === 'anthropic-api')
        this.ledger(job.projectId, job.id, job.model ?? '', 'completed', est, result.usage);
      job.finishedAt = nowIso();
      setState('succeeded');
    } catch (e) {
      const canceled = ctrl.signal.aborted;
      job.error = canceled
        ? 'canceled'
        : (e instanceof Error ? e.message : String(e)).slice(0, 2_000);
      if (job.runtime === 'anthropic-api')
        this.ledger(
          job.projectId,
          job.id,
          job.model ?? '',
          canceled ? 'cancelled' : 'failed',
          est,
          undefined,
          job.error,
        );
      this.record(job, canceled ? 'run.cancelled' : 'step.failed', { error: job.error });
      job.finishedAt = nowIso();
      setState(canceled ? 'canceled' : 'failed');
    } finally {
      await tools?.close();
      if (job.runId) {
        const f = finishRun(this.db, job.runId, {
          status:
            job.state === 'succeeded'
              ? 'succeeded'
              : job.state === 'canceled'
                ? 'cancelled'
                : 'failed',
        });
        if (f.ok) {
          correlateRun(this.db, job.runId);
          this.bus.publish({
            type: 'run.finished',
            data: { runId: job.runId, status: f.run.status, projectId: job.projectId },
          });
        }
      }
      this.emit(job, {
        type: 'done',
        jobId: job.id,
        runId: job.runId,
        proposedElements: 0,
        proposedClaims: job.proposedClaims ?? 0,
        ...(job.error ? { error: job.error } : {}),
      });
    }
  }
}
