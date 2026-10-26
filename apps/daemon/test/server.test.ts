import { cp, mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '../src/server.ts';
import { readDiscovery, writeDiscovery } from '../src/discovery.ts';

const token = 't'.repeat(64);
const port = 4555;
const host = `127.0.0.1:${port}`;
let webRoot: string;

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), 'atlas-web-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Atlas</title>');
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
});

let lastServer: ReturnType<typeof buildServer>;
function server() {
  const db = openDb(':memory:');
  migrate(db);
  lastServer = buildServer({
    token,
    db,
    dataDir: '/tmp/x',
    webRoot,
    port: () => port,
    devOrigins: ['http://localhost:5173', 'http://evil.com'],
  });
  return lastServer.app;
}

describe('daemon security', () => {
  let app: ReturnType<typeof server>;
  beforeAll(() => {
    app = server();
  });
  afterAll(() => app.close());

  it('serves health without a token', async () => {
    const r = await app.inject({ url: '/healthz', headers: { host } });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });
  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const r = await app.inject({ url: '/healthz', headers: { host: `attacker.example:${port}` } });
    expect(r.statusCode).toBe(421);
    expect(
      (await app.inject({ url: '/healthz', headers: { host: '127.0.0.1:9999' } })).statusCode,
    ).toBe(421);
  });
  it('rejects cross-origin browser requests and non-loopback dev origins', async () => {
    const auth = { host, authorization: `Bearer ${token}` };
    expect(
      (
        await app.inject({
          url: '/api/v1/status',
          headers: { ...auth, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/v1/status', headers: { ...auth, origin: 'http://evil.com' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/v1/status',
          headers: { ...auth, origin: 'http://localhost:5173' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/status', headers: { ...auth, origin: `http://${host}` } }))
        .statusCode,
    ).toBe(200);
  });
  it('requires the bearer token for the API', async () => {
    expect((await app.inject({ url: '/api/v1/status', headers: { host } })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/v1/status', headers: { host, authorization: 'Bearer nope' } }))
        .statusCode,
    ).toBe(401);
    const ok = await app.inject({
      url: '/api/v1/status',
      headers: { host, authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBeTruthy();
  });
  it('serves the UI with a strict CSP and refuses path traversal', async () => {
    const index = await app.inject({ url: '/', headers: { host } });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    const js = await app.inject({ url: '/assets/app.js', headers: { host } });
    expect(js.headers['content-type']).toContain('javascript');
    const trav = await app.inject({ url: '/..%2f..%2f..%2fetc%2fpasswd', headers: { host } });
    expect(trav.body).not.toContain('root:');
  });
  it('does not fall back to the UI for unknown API routes', async () => {
    const r = await app.inject({
      url: '/api/v1/nope',
      headers: { host, authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('discovery record', () => {
  it('is written atomically with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-run-'));
    const file = join(dir, 'sub', 'daemon.json');
    await writeDiscovery(file, {
      pid: 1,
      port: 2,
      host: '127.0.0.1',
      token,
      version: 'x',
      startedAt: 'now',
      dataDir: dir,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'sub'))).mode & 0o777).toBe(0o700);
    expect((await readDiscovery(file))?.port).toBe(2);
  });
});

describe('project registration API', () => {
  const auth = { host, authorization: `Bearer ${token}` };
  let app: ReturnType<typeof server>;
  beforeAll(() => {
    app = server();
  });
  afterAll(() => app.close());

  it('registers a directory once and lists it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-proj-'));
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { rootPath: dir },
    });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { rootPath: dir },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().worktree.id).toBe(first.json().worktree.id);
    const list = await app.inject({ url: '/api/v1/projects', headers: auth });
    expect(list.json().projects).toHaveLength(1);
  });

  it('rejects relative or missing paths', async () => {
    const rel = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { rootPath: 'relative/dir' },
    });
    expect(rel.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { rootPath: '/definitely/not/here' },
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe('scan API', () => {
  const auth = { host, authorization: `Bearer ${token}` };
  let app: ReturnType<typeof server>;
  beforeAll(() => {
    app = server();
  });
  afterAll(() => app.close());

  it('scans a registered fixture and serves its latest snapshot with coverage', async () => {
    const rootPath = new URL('../../../fixtures/ts-web-service', import.meta.url).pathname.replace(
      /\/$/,
      '',
    );
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { rootPath },
    });
    const wt = reg.json().worktree.id as string;
    expect(
      (await app.inject({ url: `/api/v1/worktrees/${wt}/snapshot`, headers: auth })).statusCode,
    ).toBe(404);
    const job = await app.inject({
      method: 'POST',
      url: `/api/v1/worktrees/${wt}/scans`,
      headers: auth,
    });
    expect(job.statusCode).toBe(202);
    await lastServer.jobs.idle();
    const done = (await app.inject({ url: `/api/v1/jobs/${job.json().id}`, headers: auth })).json();
    expect(done).toMatchObject({ state: 'succeeded', snapshotState: 'ready' });
    const snap = (
      await app.inject({ url: `/api/v1/worktrees/${wt}/snapshot`, headers: auth })
    ).json();
    expect(snap.snapshot.id).toBe(done.snapshotId);
    expect(snap.counts.entitiesByKind).toEqual({
      system: 1,
      package: 11,
      module: 10,
      symbol: 9,
      endpoint: 3,
      'ui-surface': 2,
      queue: 1,
      table: 2,
      deployable: 3,
      database: 1,
      'infrastructure-resource': 1,
      entrypoint: 3,
    });
    expect(snap.coverage.totals.files).toBe(21);
  });

  it('serves the change summary of a rescan', async () => {
    const rootPath = join(await mkdtemp(join(tmpdir(), 'atlas-rescan-')), 'py-cli-api');
    await cp(new URL('../../../fixtures/py-cli-api', import.meta.url).pathname, rootPath, {
      recursive: true,
    });
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { rootPath },
    });
    const wt = reg.json().worktree.id as string;
    for (let i = 0; i < 2; i++) {
      if (i) await writeFile(join(rootPath, 'NOTES.md'), 'changed');
      await app.inject({ method: 'POST', url: `/api/v1/worktrees/${wt}/scans`, headers: auth });
      await lastServer.jobs.idle();
    }
    const snap = (
      await app.inject({ url: `/api/v1/worktrees/${wt}/snapshot`, headers: auth })
    ).json();
    expect(snap.changes.previousSnapshotId).toBeTruthy();
    const ch = (
      await app.inject({ url: `/api/v1/snapshots/${snap.snapshot.id}/changes`, headers: auth })
    ).json();
    expect(ch).toMatchObject({ changes: [], issues: [] });
    expect(ch.summary.entities.added).toBe(0);
    expect(
      (await app.inject({ url: '/api/v1/snapshots/snap_x/changes', headers: auth })).statusCode,
    ).toBe(404);
  });

  it('keeps reporting open reconciliation issues after later rescans', async () => {
    const { mkdtemp: mk, writeFile: wf, mkdir: md, rename: rn } = await import('node:fs/promises');
    const root = await mk(join(tmpdir(), 'atlas-issue-'));
    await wf(join(root, 'a.py'), 'X = 1\n');
    await wf(join(root, 'b.py'), 'X = 1\n');
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { rootPath: root },
    });
    const wt = reg.json().worktree.id as string;
    const scan = async () => {
      await app.inject({ method: 'POST', url: `/api/v1/worktrees/${wt}/scans`, headers: auth });
      await lastServer.jobs.idle();
      return (await app.inject({ url: `/api/v1/worktrees/${wt}/snapshot`, headers: auth })).json();
    };
    await scan();
    await md(join(root, 'sub'));
    await rn(join(root, 'a.py'), join(root, 'sub/a2.py'));
    await rn(join(root, 'b.py'), join(root, 'sub/b2.py'));
    expect((await scan()).openIssues).toBe(1);
    expect((await scan()).openIssues).toBe(1);
  });

  it('404s for unknown worktrees and jobs', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/worktrees/wt_0000000000000000/scans',
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: '/api/v1/jobs/job_x', headers: auth })).statusCode).toBe(404);
  });
});
