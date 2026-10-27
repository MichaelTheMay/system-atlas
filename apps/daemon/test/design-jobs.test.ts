/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON */
import { cpSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DesignRuntime, MessagesClient } from '@atlas/agent-api';
import { createAnthropicDesignRuntime } from '@atlas/agent-api';
import { migrate, openDb } from '@atlas/store';
import type { BusMessage } from '../src/events.ts';
import { buildServer, type ServerOptions } from '../src/server.ts';

const token = 'j'.repeat(64);
let srv: ReturnType<typeof buildServer> | undefined;
afterEach(async () => {
  await srv?.app.close();
  srv = undefined;
});

/** A real listening daemon: the job's in-process Atlas tools call it over loopback. */
async function setup(designAgent: ServerOptions['designAgent'] = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-djobs-')), 'svc');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-djobs-data-'));
  const db = openDb(':memory:');
  migrate(db);
  let port = 0;
  srv = buildServer({
    token,
    db,
    dataDir,
    port: () => port,
    designAgent: { secretTool: false, env: { PATH: '/nonexistent' }, ...designAgent },
  });
  await srv.app.listen({ host: '127.0.0.1', port: 0 });
  port = (srv.app.server.address() as { port: number }).port;
  const events: BusMessage[] = [];
  srv.bus.subscribe((m) => events.push(m));
  const s = srv;
  const req = async (method: string, url: string, payload?: unknown) => {
    const r = await s.app.inject({
      method: method as 'GET',
      url,
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` },
      payload: payload as object,
    });
    return { status: r.statusCode, body: r.body ? (r.json() as any) : undefined, raw: r.body };
  };
  const reg = (await req('POST', '/api/v1/projects', { rootPath: root })).body;
  const wt = reg.worktree.id as string;
  await req('POST', `/api/v1/worktrees/${wt}/scans`);
  await s.jobs.idle();
  const snapshotId = (await req('GET', `/api/v1/worktrees/${wt}/snapshot`)).body.snapshot
    .id as string;
  const projectId = reg.project.id as string;
  const jobsUrl = `/api/v1/projects/${projectId}/design/jobs`;
  const generate = (extra: Record<string, unknown> = {}) =>
    req('POST', jobsUrl, { kind: 'generate', runtime: 'mock', snapshotId, depth: 2, ...extra });
  const wait = async (jobId: string) => {
    await s.designJobs.idle(projectId);
    return (await req('GET', `${jobsUrl}/${jobId}`)).body;
  };
  return { db, dataDir, req, events, snapshotId, projectId, jobsUrl, generate, wait, srv: s };
}

const subsystems = async (t: Awaited<ReturnType<typeof setup>>) =>
  (await t.req('GET', `/api/v1/snapshots/${t.snapshotId}/canvases`)).body.canvases.filter(
    (c: any) => c.lens === 'design-subsystem',
  );

describe('design-agent jobs (D02c)', () => {
  it('mock generate proposes subsystems through the Atlas tools and records a design-agent run', async () => {
    const t = await setup();
    expect(await subsystems(t)).toEqual([]);
    const est = await t.req('GET', `${t.jobsUrl}/estimate?depth=2&runtime=mock`);
    expect(est.body).toMatchObject({
      snapshotId: t.snapshotId,
      runtime: 'mock',
      depth: 2,
      external: false,
      consented: true,
    });
    expect(est.body.units).toBeGreaterThan(0);
    expect(est.body.sends).toMatch(/Nothing leaves this machine/);

    const r = await t.generate();
    expect(r.status).toBe(202);
    expect(r.body.id).toMatch(/^djb_/);
    const job = await t.wait(r.body.id);
    expect(job).toMatchObject({ state: 'succeeded', runtime: 'mock', model: 'mock-design' });
    expect(job.proposedClaims).toBeGreaterThan(0);

    // proposals land as proposed design-subsystem canvases, never accepted
    const subs = await subsystems(t);
    expect(subs.length).toBeGreaterThan(1);
    expect(subs.every((c: any) => c.provenance === 'proposed')).toBe(true);
    expect(subs.map((c: any) => c.title)).toEqual(expect.arrayContaining(['Services', 'Data']));
    const claims = t.db
      .prepare(
        "SELECT origin, status, body FROM claims WHERE snapshot_id = ? AND predicate = 'subsystem'",
      )
      .all<{ origin: string; status: string; body: string }>(t.snapshotId);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.origin === 'model' && c.status === 'inferred')).toBe(true);
    expect(JSON.parse(claims[0]!.body).modelMetadata.model).toBe('mock-design');

    // recorded as a run bound to the snapshot it read
    const run = (await t.req('GET', `/api/v1/runs/${job.runId}`)).body;
    expect(run.run).toMatchObject({
      adapter: 'design-agent',
      status: 'succeeded',
      snapshotId: t.snapshotId,
    });
    const tools = run.events
      .filter((e: any) => e.type === 'tool.call.completed')
      .map((e: any) => e.payload.tool);
    expect(tools).toEqual(expect.arrayContaining(['atlas_list_views', 'atlas_propose_view']));
    expect(run.events.some((e: any) => e.type === 'model.enrichment')).toBe(true);

    // progress streamed as design.job bus events
    const dj = t.events.filter((m) => m.type === 'design.job').map((m) => m.data);
    expect(dj.map((d) => d.type)).toEqual(
      expect.arrayContaining(['state', 'progress', 'tool-call', 'done']),
    );
    expect(dj.at(-1)).toMatchObject({ type: 'done', jobId: job.id, runId: job.runId });
    expect(t.events.some((m) => m.type === 'run.finished')).toBe(true);

    // deterministic: replacing the proposals yields the same subsystems
    const again = await t.wait((await t.generate({ replaceProposals: true })).body.id);
    expect(again.state).toBe('succeeded');
    const subs2 = await subsystems(t);
    expect(subs2.map((c: any) => c.id).sort()).toEqual(subs.map((c: any) => c.id).sort());
    const rejected = t.db
      .prepare(
        "SELECT count(*) AS n FROM claims WHERE snapshot_id = ? AND predicate = 'subsystem' AND status = 'rejected'",
      )
      .get<{ n: number }>(t.snapshotId)!.n;
    expect(rejected).toBe(claims.length);

    const list = (await t.req('GET', t.jobsUrl)).body.jobs;
    expect(list.map((j: any) => j.id)).toEqual([again.id, job.id]);
  });

  it('refuses non-mock runtimes without consent; stores the API key 0600 and never echoes it', async () => {
    const t = await setup();
    const denied = await t.generate({ runtime: 'claude-code' });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'consent_required' });
    expect(denied.body.detail.sends).toMatch(/Claude account/);

    const view = (await t.req('GET', '/api/v1/settings/design-agent')).body;
    expect(view).toMatchObject({
      runtime: 'mock',
      hasApiKey: false,
      consented: { mock: true, 'claude-code': false, 'anthropic-api': false },
    });
    // the fake PATH has no claude: reported unavailable, nothing spawned
    expect(view.availability['claude-code']).toMatchObject({ available: false, external: true });
    expect(view.availability.mock.available).toBe(true);

    const key = 'sk-ant-test-' + 'x'.repeat(40);
    const put = await t.req('PUT', '/api/v1/settings/design-agent', {
      runtime: 'anthropic-api',
      apiKey: key,
      consent: true,
    });
    expect(put.status).toBe(200);
    expect(put.raw).not.toContain(key);
    expect(put.body).toMatchObject({
      runtime: 'anthropic-api',
      hasApiKey: true,
      model: 'claude-sonnet-5-5',
      consented: { 'anthropic-api': true, 'claude-code': false },
    });
    const file = join(t.dataDir, 'secrets', 'anthropic-api-key');
    expect(readFileSync(file, 'utf8').trim()).toBe(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(t.dataDir, 'secrets')).mode & 0o777).toBe(0o700);
    expect((await t.req('GET', '/api/v1/settings/design-agent')).raw).not.toContain(key);
    expect(
      (await t.req('PUT', '/api/v1/settings/design-agent', { apiKey: 'not a key' })).status,
    ).toBe(400);
    // claude-code still needs its own consent
    expect((await t.generate({ runtime: 'claude-code' })).status).toBe(403);
  });

  it('cancels a running job, allows one job per project, and records the run as cancelled', async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const slow: DesignRuntime = {
      id: 'mock',
      check: async () => ({ available: true, detail: 'slow', external: false }),
      run: (_req, ctx) =>
        new Promise((_resolve, reject) => {
          started();
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        }),
    };
    const t = await setup({ runtimes: { mock: () => slow } });
    const r = await t.generate();
    expect(r.status).toBe(202);
    await running;
    const busy = await t.generate();
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: 'job_running', detail: { jobId: r.body.id } });

    const del = await t.req('DELETE', `${t.jobsUrl}/${r.body.id}`);
    expect(del.status).toBe(202);
    const job = await t.wait(r.body.id);
    expect(job).toMatchObject({ state: 'canceled', error: 'canceled' });
    const run = (await t.req('GET', `/api/v1/runs/${job.runId}`)).body;
    expect(run.run.status).toBe('cancelled');
    expect((await t.req('DELETE', `${t.jobsUrl}/${r.body.id}`)).status).toBe(409);
    expect((await t.req('DELETE', `${t.jobsUrl}/djb_${'0'.repeat(32)}`)).status).toBe(404);
  });

  it('holds the anthropic-api runtime to the daily budget and ledgers its usage', async () => {
    const calls: any[] = [];
    const client: MessagesClient = {
      messages: {
        async create(params) {
          calls.push(structuredClone(params));
          if (calls.length === 1)
            return {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5-5',
              stop_reason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_1',
                  name: 'atlas_list_views',
                  input: { workspace: 'design' },
                },
              ],
              usage: { input_tokens: 500, output_tokens: 40 },
            } as any;
          return {
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5-5',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done.' }],
            usage: { input_tokens: 700, output_tokens: 20 },
          } as any;
        },
      },
    };
    const t = await setup({
      runtimes: { 'anthropic-api': () => createAnthropicDesignRuntime({ client }) },
    });
    await t.req('PUT', '/api/v1/settings/design-agent', {
      runtime: 'anthropic-api',
      consent: true,
    });
    await t.req('PUT', '/api/v1/settings/enrichment', { maxTokensPerDay: 100 });
    const over = await t.generate({ runtime: 'anthropic-api' });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('budget_exceeded');
    expect(calls).toHaveLength(0);

    await t.req('PUT', '/api/v1/settings/enrichment', { maxTokensPerDay: 1_000_000 });
    const job = await t.wait((await t.generate({ runtime: 'anthropic-api' })).body.id);
    expect(job).toMatchObject({ state: 'succeeded', model: 'claude-sonnet-5-5' });
    expect(job.usage).toMatchObject({ inputTokens: 1200, outputTokens: 60 });
    expect(calls).toHaveLength(2);
    expect(calls[0].tools.map((x: any) => x.name)).toContain('atlas_propose_view');
    expect(calls[0].tools.map((x: any) => x.name)).not.toContain('atlas_refresh');
    expect(calls[1].messages.at(-1).content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      is_error: false,
    });
    const usage = (await t.req('GET', `/api/v1/projects/${t.projectId}/enrichment`)).body.usage;
    expect(usage.recent.map((r: any) => r.status)).toEqual(['completed', 'skipped-budget']);
    expect(usage.recent[0]).toMatchObject({ provider: 'anthropic-api', reportedTokens: 1260 });
  });

  it('rejects invalid requests and snapshots of other projects', async () => {
    const t = await setup();
    expect((await t.generate({ depth: 9 })).status).toBe(400);
    expect((await t.generate({ snapshotId: `snap_${'0'.repeat(32)}` })).status).toBe(404);
    expect(
      (
        await t.req('POST', `/api/v1/projects/proj_${'0'.repeat(32)}/design/jobs`, {
          kind: 'generate',
          runtime: 'mock',
          snapshotId: t.snapshotId,
        })
      ).status,
    ).toBe(404);
  });
});
