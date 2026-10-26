import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectStore } from '@atlas/evidence';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '../src/server.ts';
import { buildPreviewServer } from '../src/preview.ts';

const token = 'r'.repeat(64);
const port = 4557;
const previewPort = 4558;
const host = `127.0.0.1:${port}`;
const auth = { host, authorization: `Bearer ${token}` };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let srv: ReturnType<typeof buildServer>;
let preview: ReturnType<typeof buildPreviewServer>;
let root: string;

beforeAll(() => {
  const db = openDb(':memory:');
  migrate(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-runs-'));
  const objects = new ObjectStore(join(dataDir, 'objects'));
  preview = buildPreviewServer({
    db,
    objects,
    port: () => previewPort,
    appOrigins: () => [`http://${host}`],
  });
  srv = buildServer({
    token,
    db,
    dataDir,
    objects,
    port: () => port,
    previewOrigin: () => `http://127.0.0.1:${previewPort}`,
    signPreview: (id, kind) => preview.sign(id, kind),
  });
  root = join(mkdtempSync(join(tmpdir(), 'atlas-runs-fx-')), 'py-cli-api');
  cpSync(new URL('../../../fixtures/py-cli-api', import.meta.url).pathname, root, {
    recursive: true,
  });
});
afterAll(async () => {
  await srv.app.close();
  await preview.app.close();
});

const req = (s: ReturnType<typeof buildServer>) => s.app.inject.bind(s.app);
async function newRun() {
  const r = await req(srv)({
    method: 'POST',
    url: '/api/v1/runs',
    headers: auth,
    payload: { rootPath: root, adapter: 'test', commandSummary: 'pytest' },
  });
  expect(r.statusCode).toBe(201);
  return r.json() as {
    run: { id: string; snapshotId?: string; projectId: string };
    ingestToken: string;
    snapshotBound: boolean;
  };
}

describe('run ingestion API', () => {
  it('binds a run to the snapshot of exactly its tree, scanning first when needed', async () => {
    const first = await newRun();
    expect(first.snapshotBound).toBe(false);
    await srv.jobs.idle();
    const bound = (await req(srv)({ url: `/api/v1/runs/${first.run.id}`, headers: auth })).json();
    expect(bound.run.snapshotId).toMatch(/^snap_/);
    const second = await newRun();
    expect(second.snapshotBound).toBe(true);
    expect(second.run.snapshotId).toBe(bound.run.snapshotId);
  });

  it('accepts a run token only for its own run', async () => {
    const a = await newRun();
    const b = await newRun();
    const ev = [
      {
        producerId: 'test',
        producerEventId: 'e1',
        type: 'step.started',
        occurredAt: new Date().toISOString(),
      },
    ];
    const ok = await req(srv)({
      method: 'POST',
      url: `/api/v1/runs/${a.run.id}/events`,
      headers: { host, 'x-atlas-run-token': a.ingestToken },
      payload: ev,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accepted).toHaveLength(1);
    const cross = await req(srv)({
      method: 'POST',
      url: `/api/v1/runs/${b.run.id}/events`,
      headers: { host, 'x-atlas-run-token': a.ingestToken },
      payload: ev,
    });
    expect(cross.statusCode).toBe(401);
    const none = await req(srv)({
      method: 'POST',
      url: `/api/v1/runs/${a.run.id}/events`,
      headers: { host },
      payload: ev,
    });
    expect(none.statusCode).toBe(401);
    // a run token never unlocks the rest of the API
    expect(
      (
        await req(srv)({
          url: '/api/v1/projects',
          headers: { host, 'x-atlas-run-token': a.ingestToken },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('uploads, verifies and finishes; failures stay visible', async () => {
    const { run, ingestToken } = await newRun();
    const h = { host, 'x-atlas-run-token': ingestToken };
    const bytes = Buffer.from('{"topic":"solar","sources":3}');
    const reserved = (
      await req(srv)({
        method: 'POST',
        url: `/api/v1/runs/${run.id}/artifacts`,
        headers: h,
        payload: {
          logicalName: 'report.json',
          mediaType: 'application/json',
          role: 'report',
          sha256: sha(bytes),
          byteLength: bytes.length,
        },
      })
    ).json();
    expect(reserved.uploadRequired).toBe(true);
    const up = await req(srv)({
      method: 'PUT',
      url: reserved.uploadPath,
      headers: { ...h, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ bytesState: 'available', mediaType: 'application/json' });
    const bad = (
      await req(srv)({
        method: 'POST',
        url: `/api/v1/runs/${run.id}/artifacts`,
        headers: h,
        payload: { logicalName: 'x.bin', sha256: 'a'.repeat(64) },
      })
    ).json();
    const mismatch = await req(srv)({
      method: 'PUT',
      url: bad.uploadPath,
      headers: { ...h, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope'),
    });
    expect(mismatch.statusCode).toBe(422);
    const shot = (
      await req(srv)({
        method: 'POST',
        url: `/api/v1/runs/${run.id}/artifacts`,
        headers: h,
        payload: { logicalName: 'step-3.png', role: 'screenshot' },
      })
    ).json();
    await req(srv)({
      method: 'POST',
      url: `/api/v1/artifacts/${shot.artifact.id}/missing`,
      headers: h,
      payload: { reason: 'page closed before capture' },
    });
    const fin = await req(srv)({
      method: 'POST',
      url: `/api/v1/runs/${run.id}/finish`,
      headers: h,
      payload: { status: 'succeeded', exitCode: 0 },
    });
    expect(fin.json().status).toBe('succeeded');
    const detail = (await get(`/api/v1/runs/${run.id}`)).json();
    expect(detail.counts).toMatchObject({ artifacts: 3, missingArtifacts: 2 });
    expect(
      detail.artifacts.find((a: { logicalName: string }) => a.logicalName === 'step-3.png'),
    ).toMatchObject({
      bytesState: 'missing',
      metadata: expect.objectContaining({ missingReason: 'page closed before capture' }),
    });
    const list = (await get(`/api/v1/projects/${run.projectId}/runs`)).json();
    expect(list.runs.length).toBeGreaterThanOrEqual(1);
  });
});

const get = (url: string) => srv.app.inject({ url, headers: auth });

describe('isolated preview server', () => {
  it('serves artifact bytes only via signed URLs, sandboxed and frameable only by the app', async () => {
    const { run, ingestToken } = await newRun();
    const h = { host, 'x-atlas-run-token': ingestToken };
    const html = Buffer.from(
      '<html><body><script>parent.document.body.innerHTML="PWNED"</script></body></html>',
    );
    const r = (
      await req(srv)({
        method: 'POST',
        url: `/api/v1/runs/${run.id}/artifacts`,
        headers: h,
        payload: { logicalName: 'report.png', mediaType: 'image/png', role: 'render' },
      })
    ).json();
    await req(srv)({
      method: 'PUT',
      url: r.uploadPath,
      headers: { ...h, 'content-type': 'application/octet-stream' },
      payload: html,
    });
    const signed = (await get(`/api/v1/artifacts/${r.artifact.id}/preview-url`)).json();
    expect(signed.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${previewPort}/a/art_`));
    const path = signed.url.replace(/^http:\/\/[^/]+/, '');
    const ph = { host: `127.0.0.1:${previewPort}` };
    const res = await preview.app.inject({ url: path, headers: ph });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`frame-ancestors http://${host}`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // the app (another loopback port) embeds these bytes; Chrome treats ports as cross-site for CORP
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(
      (
        await preview.app.inject({
          url: path.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`),
          headers: ph,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await preview.app.inject({ url: path.replace(/exp=\d+/, 'exp=1'), headers: ph })).statusCode,
    ).toBe(403);
    expect(
      (await preview.app.inject({ url: path, headers: { host: 'evil.example:4558' } })).statusCode,
    ).toBe(421);
    // the app origin never serves artifact bytes
    expect((await get(`/a/${r.artifact.id}`)).statusCode).toBe(404);
  });

  it('lets the UI frame and show images only from the preview origin', async () => {
    const { writeFileSync } = await import('node:fs');
    const webRoot = mkdtempSync(join(tmpdir(), 'atlas-web-csp-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html>');
    const db = openDb(':memory:');
    migrate(db);
    const s2 = buildServer({
      token,
      db,
      dataDir: webRoot,
      webRoot,
      port: () => port,
      previewOrigin: () => `http://127.0.0.1:${previewPort}`,
    });
    const csp = String(
      (await s2.app.inject({ url: '/', headers: { host } })).headers['content-security-policy'],
    );
    expect(csp).toContain(`frame-src http://127.0.0.1:${previewPort}`);
    expect(csp).toContain(`img-src 'self' data: blob: http://127.0.0.1:${previewPort}`);
    expect(csp).toContain("connect-src 'self'");
    await s2.app.close();
  });
});
