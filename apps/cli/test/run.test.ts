import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess } from '@atlas/adapters';
import { ObjectStore } from '@atlas/evidence';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '@atlas/daemon';

const token = 'c'.repeat(64);
let port = 0;
let srv: ReturnType<typeof buildServer>;
let baseUrl: string;
let root: string;

beforeAll(async () => {
  const db = openDb(':memory:');
  migrate(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-cli-run-'));
  srv = buildServer({
    token,
    db,
    dataDir,
    objects: new ObjectStore(join(dataDir, 'objects')),
    port: () => port,
  });
  await srv.app.listen({ host: '127.0.0.1', port: 0 });
  port = (srv.app.server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
  root = join(mkdtempSync(join(tmpdir(), 'atlas-demo-')), 'research-demo');
  cpSync(new URL('../../../fixtures/research-demo', import.meta.url).pathname, root, {
    recursive: true,
  });
});
afterAll(() => srv.app.close());

const daemon = () => ({ baseUrl, token });
interface RunDetail {
  run: { snapshotId?: string; status: string; captureGaps: { kind: string; detail: string }[] };
  outcome: { process: string; task: string; assertions: Record<string, number> };
  events: { type: string; producerId: string; payload: { text: string; kind?: string } }[];
  artifacts: {
    logicalName: string;
    bytesState: string;
    byteLength: number;
    mediaType: string;
    role: string;
    metadata: Record<string, unknown>;
  }[];
}
const detail = async (runId: string): Promise<RunDetail> =>
  (await (
    await fetch(`${baseUrl}/api/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as RunDetail;

describe('atlas run (process wrapper)', () => {
  it('records the demo worker: logs, tool events, outputs, a failed assertion despite exit 0, and missing outputs', async () => {
    const r = await runProcess({
      daemon: daemon(),
      rootPath: root,
      cwd: root,
      command: process.execPath,
      args: ['worker/generate-report.mjs', '--sources', '2', '--out', 'out'],
      outputs: ['out/report.json', 'out/chart.png', 'out/report.html', 'out/missing.csv'],
      name: 'demo',
    });
    expect(r).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      snapshotBound: true,
      ingestionErrors: [],
    });
    const d = await detail(r.runId);
    expect(d.run.snapshotId).toMatch(/^snap_/);
    expect(d.outcome).toEqual({
      process: 'succeeded',
      task: 'failed',
      assertions: { pass: 0, fail: 1, unknown: 0 },
    });
    const types = d.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'run.started',
        'command.stdout',
        'command.stderr',
        'tool.call.requested',
        'tool.call.completed',
        'assertion.result',
        'command.exit',
        'file.produced',
      ]),
    );
    const stdout = d.events
      .filter((e: { type: string }) => e.type === 'command.stdout')
      .map((e: { payload: { text: string } }) => e.payload.text)
      .join('');
    expect(stdout).toContain('researching "solar storage"');
    const stderr = d.events
      .filter((e: { type: string }) => e.type === 'command.stderr')
      .map((e: { payload: { text: string } }) => e.payload.text)
      .join('');
    expect(stderr).toContain('warning: only 2 source(s)');
    const byName = Object.fromEntries(d.artifacts.map((a) => [a.logicalName, a]));
    expect(byName['out/report.json']).toMatchObject({
      bytesState: 'available',
      mediaType: 'application/json',
      role: 'output-file',
    });
    expect(byName['out/chart.png']).toMatchObject({
      bytesState: 'available',
      mediaType: 'image/png',
    });
    expect(byName['out/report.html']).toMatchObject({
      bytesState: 'available',
      mediaType: 'text/html',
    });
    expect(byName['out/report.json']?.metadata.producedDuringRun).toBe(true);
    expect(byName['out/missing.csv']).toMatchObject({
      bytesState: 'missing',
      metadata: expect.objectContaining({ missingReason: 'declared output was not produced' }),
    });
    expect(byName['stdout.log']).toMatchObject({ role: 'log', bytesState: 'available' });
    expect(byName['stderr.log']).toMatchObject({ role: 'log', bytesState: 'available' });
  });

  it('reports non-zero exits, spawn failures and cancellation as process outcomes', async () => {
    const fail = await runProcess({
      daemon: daemon(),
      rootPath: root,
      cwd: root,
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
    });
    expect(fail).toMatchObject({ status: 'failed', exitCode: 3 });
    const missing = await runProcess({
      daemon: daemon(),
      rootPath: root,
      cwd: root,
      command: 'definitely-not-a-command-atlas',
      args: [],
    });
    expect(missing.status).toBe('failed');
    expect((await detail(missing.runId)).run.captureGaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'spawn-failed' })]),
    );
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const cancelled = await runProcess({
      daemon: daemon(),
      rootPath: root,
      cwd: root,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      signal: ctrl.signal,
    });
    expect(cancelled.status).toBe('cancelled');
    expect((await detail(cancelled.runId)).run.status).toBe('cancelled');
  });

  it('caps inline logs but always attaches the full output', async () => {
    const r = await runProcess({
      daemon: daemon(),
      rootPath: root,
      cwd: root,
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(200000))"],
      inlineLogCapBytes: 50_000,
    });
    const d = await detail(r.runId);
    const inline = d.events
      .filter((e: { type: string }) => e.type === 'command.stdout')
      .reduce((n: number, e: { payload: { text: string } }) => n + e.payload.text.length, 0);
    expect(inline).toBeLessThanOrEqual(50_000);
    expect(
      d.events.some(
        (e: { type: string; payload: { kind?: string } }) =>
          e.type === 'capture.gap' && e.payload.kind === 'log-truncated',
      ),
    ).toBe(true);
    expect(d.artifacts.find((a) => a.logicalName === 'stdout.log')?.byteLength).toBe(200000);
  });

  it('lets an instrumented child record steps, assertions and artifacts through the SDK', async () => {
    const sdk = new URL('../../../packages/adapters/src/sdk.ts', import.meta.url).pathname;
    const script = `
      import { writeFileSync } from 'node:fs';
      import { recorderFromEnv } from ${JSON.stringify(sdk)};
      const atlas = recorderFromEnv('child-sdk');
      await atlas.step('compute', async () => writeFileSync('sdk-out.txt', 'hello'));
      await atlas.recordArtifact('sdk-out.txt', { role: 'output-file' });
      await atlas.assert('output written', true);
      console.log('enabled=' + atlas.enabled);
    `;
    const r = await runProcess({
      daemon: daemon(),
      rootPath: root,
      cwd: root,
      command: process.execPath,
      args: ['--input-type=module', '-e', script],
    });
    expect(r.status).toBe('succeeded');
    const d = await detail(r.runId);
    expect(d.outcome.task).toBe('passed');
    expect(
      d.events
        .filter((e: { producerId: string }) => e.producerId === 'child-sdk')
        .map((e: { type: string }) => e.type),
    ).toEqual(['step.started', 'step.completed', 'file.produced', 'assertion.result']);
    expect(
      d.artifacts.find((a: { logicalName: string }) => a.logicalName === 'sdk-out.txt'),
    ).toMatchObject({ bytesState: 'available', byteLength: 5 });
    // outside Atlas the SDK is a no-op
    const { recorderFromEnv } = await import('@atlas/adapters');
    const saved = { ...process.env };
    delete process.env.ATLAS_INGEST_URL;
    expect(recorderFromEnv().enabled).toBe(false);
    Object.assign(process.env, saved);
  });
});
