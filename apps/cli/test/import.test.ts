/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importBundle, importOtlp } from '@atlas/adapters';
import { ObjectStore } from '@atlas/evidence';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '@atlas/daemon';

const token = 'i'.repeat(64);
let port = 0;
let srv: ReturnType<typeof buildServer>;
let root: string;
const fixtures = new URL('../../../fixtures/otlp/', import.meta.url).pathname;
const daemon = () => ({ baseUrl: `http://127.0.0.1:${port}`, token });
const get = async (p: string) =>
  (await (
    await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as any;

beforeAll(async () => {
  const db = openDb(':memory:');
  migrate(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-import-'));
  srv = buildServer({
    token,
    db,
    dataDir,
    objects: new ObjectStore(join(dataDir, 'objects')),
    port: () => port,
  });
  await srv.app.listen({ host: '127.0.0.1', port: 0 });
  port = (srv.app.server.address() as { port: number }).port;
  root = join(mkdtempSync(join(tmpdir(), 'atlas-import-proj-')), 'svc');
  cpSync(new URL('../../../fixtures/py-cli-api', import.meta.url).pathname, root, {
    recursive: true,
  });
});
afterAll(() => srv.app.close());

const A = '4bf92f3577b34da6a3ce929d0e0e4736';
const B = '0af7651916cd43dd8448eb211c80319c';

describe('OTLP/JSON import (documented subset)', () => {
  let runA: string;

  it('maps traces to unbound runs, spans to steps and tool calls, and reports every incompatibility', async () => {
    const r = await importOtlp({
      daemon: daemon(),
      rootPath: root,
      text: readFileSync(join(fixtures, 'agent-trace.json'), 'utf8'),
      source: 'agent-trace.json',
    });
    const byTrace = Object.fromEntries(r.runs.map((x) => [x.traceId, x]));
    expect(Object.keys(byTrace).sort()).toEqual([B, A].sort());
    expect(byTrace[A]).toMatchObject({ existing: false, spans: 7, status: 'succeeded' });
    expect(byTrace[B]).toMatchObject({ spans: 1, status: 'unknown' }); // UNSET status is not success
    runA = byTrace[A]!.runId;
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'no-start-time',
        'no-end-time',
        'bytes-attribute',
        'links-counted',
        'orphan-span',
        'base64-ids',
      ]),
    );

    const d = await get(`/runs/${runA}`);
    expect(d.run).toMatchObject({ adapter: 'otlp', status: 'succeeded' });
    expect(d.run.snapshotId).toBeUndefined();
    const gaps = d.run.captureGaps.map((g: any) => g.kind);
    expect(gaps).toEqual(
      expect.arrayContaining(['imported', 'otlp-no-start-time', 'otlp-bytes-attribute']),
    );
    const types = d.events.map((e: any) => e.type);
    expect(types.filter((t: string) => t === 'tool.call.requested')).toHaveLength(2);
    expect(types).toContain('tool.call.completed');
    const summarize = d.events.find(
      (e: any) => e.type === 'tool.call.completed' && e.payload.tool === 'summarize',
    );
    expect(summarize.payload).toMatchObject({
      ok: false,
      status: 'error',
      error: 'timeout after 1.4 s',
    });
    expect(summarize.payload.events[0]).toMatchObject({
      name: 'exception',
      attributes: { 'exception.type': 'TimeoutError' },
    });
    // nesting follows spans: the page fetch is a child of the web_search call
    const search = d.events.find(
      (e: any) => e.type === 'tool.call.requested' && e.payload.tool === 'web_search',
    );
    const fetchStart = d.events.find(
      (e: any) => e.type === 'step.started' && e.payload.name.startsWith('GET '),
    );
    expect(fetchStart.parentEventId).toBe(search.id);
    expect(fetchStart.payload.attributes['raw.body']).toBe('[bytes omitted]');
    // the unfinished span has a start but no end
    expect(
      d.events.filter((e: any) => e.payload.name === 'write report').map((e: any) => e.type),
    ).toEqual(['step.started']);
  });

  it('dedupes a re-import and appends late spans to the same run', async () => {
    const again = await importOtlp({
      daemon: daemon(),
      rootPath: root,
      text: readFileSync(join(fixtures, 'agent-trace.json'), 'utf8'),
    });
    const a = again.runs.find((x) => x.traceId === A)!;
    expect(a).toMatchObject({ runId: runA, existing: true });
    expect(a.events.accepted).toBe(0);
    expect(a.events.duplicates).toBeGreaterThan(10);
    const late = await importOtlp({
      daemon: daemon(),
      rootPath: root,
      text: readFileSync(join(fixtures, 'agent-trace-late.jsonl'), 'utf8'),
    });
    expect(late.runs).toEqual([
      expect.objectContaining({
        runId: runA,
        existing: true,
        events: { accepted: 2, duplicates: 2, rejected: 0 },
      }),
    ]);
    const d = await get(`/runs/${runA}`);
    const publish = d.events.find(
      (e: any) => e.payload.name === 'publish summary' && e.type === 'step.started',
    );
    const rootStart = d.events.find(
      (e: any) => e.payload.name === 'research agent' && e.type === 'step.started',
    );
    expect(publish.parentEventId).toBe(rootStart.id);
  });

  it('refuses what is not OTLP/JSON traces with a diagnostic', async () => {
    expect(
      (await importOtlp({ daemon: daemon(), rootPath: root, text: '\u0000\u0001binary' }))
        .diagnostics[0]!.code,
    ).toBe('not-otlp-json');
    expect(
      (
        await importOtlp({ daemon: daemon(), rootPath: root, text: '{"resourceLogs":[]}' })
      ).diagnostics.map((d) => d.code),
    ).toContain('not-traces');
  });
});

describe('Atlas run bundle import', () => {
  it('imports events with parents and artifacts, refuses escapes, records missing files, dedupes re-imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-bundle-'));
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out/report.json'), '{"ok":true}');
    const outside = join(mkdtempSync(join(tmpdir(), 'atlas-outside-')), 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dir, 'out/link.txt'));
    const manifest = {
      format: 'atlas-run-bundle',
      version: 1,
      producer: 'ci-agent',
      run: {
        key: 'nightly-42',
        name: 'nightly evaluation',
        status: 'failed',
        startedAt: '2026-10-26T01:00:00Z',
      },
      events: [
        {
          id: 'root',
          type: 'step.started',
          occurredAt: '2026-10-26T01:00:00Z',
          payload: { name: 'evaluate' },
        },
        {
          id: 'tool',
          type: 'tool.call.completed',
          occurredAt: '2026-10-26T01:00:05Z',
          parent: 'root',
          payload: { tool: 'grader' },
        },
        {
          id: 'check',
          type: 'assertion.result',
          occurredAt: '2026-10-26T01:00:06Z',
          parent: 'root',
          payload: { outcome: 'fail', description: 'score above 0.8' },
        },
        { id: 'bad', type: 'not.a.type', occurredAt: '2026-10-26T01:00:07Z' },
      ],
      artifacts: [
        { path: 'out/report.json', role: 'report', event: 'tool' },
        { path: 'out/missing.csv' },
        { path: '../../etc/hostname' },
        { path: 'out/link.txt' },
      ],
    };
    writeFileSync(join(dir, 'atlas-run.json'), JSON.stringify(manifest));
    const r = await importBundle({ daemon: daemon(), rootPath: root, bundleDir: dir });
    expect(r).toMatchObject({
      existing: false,
      events: { accepted: 3, duplicates: 0, rejected: 1 },
      artifacts: { uploaded: 1, missing: 1, refused: 2 },
    });
    const d = await get(`/runs/${r.runId}`);
    expect(d.run).toMatchObject({
      status: 'failed',
      adapter: 'bundle',
      startAt: '2026-10-26T01:00:00Z',
    });
    expect(d.outcome.task).toBe('failed');
    const rootEv = d.events.find((e: any) => e.producerEventId === 'root');
    expect(d.events.find((e: any) => e.producerEventId === 'tool').parentEventId).toBe(rootEv.id);
    const arts = Object.fromEntries(d.artifacts.map((a: any) => [a.logicalName, a.bytesState]));
    expect(arts).toEqual({
      'out/report.json': 'available',
      'out/missing.csv': 'missing',
      '../../etc/hostname': 'missing',
      'out/link.txt': 'missing',
    });
    expect(JSON.stringify(d)).not.toContain('secret');

    // the same bundle again: same run, nothing new; a newer copy with one more event adds only that
    const again = await importBundle({ daemon: daemon(), rootPath: root, bundleDir: dir });
    expect(again).toMatchObject({
      runId: r.runId,
      existing: true,
      events: { accepted: 0, duplicates: 3 },
    });
    manifest.events.push({
      id: 'late',
      type: 'step.completed',
      occurredAt: '2026-10-26T01:00:09Z',
      parent: 'root',
      payload: { name: 'evaluate' },
    } as any);
    manifest.artifacts = [];
    writeFileSync(join(dir, 'atlas-run.json'), JSON.stringify(manifest));
    expect(await importBundle({ daemon: daemon(), rootPath: root, bundleDir: dir })).toMatchObject({
      runId: r.runId,
      events: { accepted: 1, duplicates: 3 },
    });

    writeFileSync(join(dir, 'atlas-run.json'), '{"format":"something-else"}');
    expect(
      (await importBundle({ daemon: daemon(), rootPath: root, bundleDir: dir })).diagnostics[0]!
        .severity,
    ).toBe('error');
  });
});
