import { cpSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDb } from '@atlas/store';
import { stableId } from '@atlas/graph';
import { buildServer } from '../src/server.ts';

const token = 'i'.repeat(64);
const port = 4556;
const auth = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
let srv: ReturnType<typeof buildServer>;
let root: string;
let wt: string;
let projectId: string;
let snap: string;
let database: ReturnType<typeof openDb>;

beforeAll(async () => {
  const db = openDb(':memory:');
  migrate(db);
  database = db;
  srv = buildServer({ token, db, dataDir: '/tmp/x', port: () => port });
  root = join(mkdtempSync(join(tmpdir(), 'atlas-insp-')), 'ts-web-service');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  const reg = (
    await srv.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { rootPath: root },
    })
  ).json();
  wt = reg.worktree.id;
  projectId = reg.project.id;
  await srv.app.inject({ method: 'POST', url: `/api/v1/worktrees/${wt}/scans`, headers: auth });
  await srv.jobs.idle();
  snap = (await srv.app.inject({ url: `/api/v1/worktrees/${wt}/snapshot`, headers: auth })).json()
    .snapshot.id;
});
afterAll(() => srv.app.close());

const get = (url: string) => srv.app.inject({ url, headers: auth });

describe('inspector API', () => {
  it('returns entity details with ownership, relations and fresh evidence', async () => {
    const id = stableId('entity', projectId, 'ts:module:packages/api/src/db.ts');
    const d = (await get(`/api/v1/snapshots/${snap}/entities/${id}`)).json();
    expect(d.entity).toMatchObject({ kind: 'module', displayName: 'db.ts', producer: 'ts-js' });
    expect(d.owners.map((o: { displayName: string }) => o.displayName)).toEqual([
      'ts-web-service',
      'report-service',
      '@reports/api',
    ]);
    expect(
      d.relations.map(
        (r: { kind: string; other: { displayName: string } }) => `${r.kind} ${r.other.displayName}`,
      ),
    ).toEqual(expect.arrayContaining(['imports index.ts', 'writes reports', 'reads reports']));
    expect(d.evidence[0]).toMatchObject({
      repoRelativePath: 'packages/api/src/db.ts',
      freshness: 'current',
      extractorId: 'ts-js',
    });
    expect(d.children).toEqual([{ kind: 'symbol', n: 2 }]);
  });

  it('explains an edge through its relations and evidence', async () => {
    const from = stableId('entity', projectId, 'ts:module:packages/api/src/queue.ts');
    const d = (await get(`/api/v1/snapshots/${snap}/entities/${from}`)).json();
    const pub = d.relations.find((r: { kind: string }) => r.kind === 'publishes');
    const rel = (await get(`/api/v1/snapshots/${snap}/relations?ids=${pub.id},not-an-id`)).json()
      .relations;
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({
      kind: 'publishes',
      status: 'supported',
      confidence: 'resolved',
      to: { displayName: 'report-jobs' },
    });
    expect(rel[0].evidence[0].excerpt).toContain('new Queue');
  });

  it('serves source only for manifest files, and refuses changed or escaping paths', async () => {
    const ok = (await get(`/api/v1/snapshots/${snap}/source?path=packages/api/src/db.ts`)).json();
    expect(ok).toMatchObject({ state: 'current', language: 'typescript' });
    expect(ok.text).toContain('insertReport');
    expect((await get(`/api/v1/snapshots/${snap}/source?path=../../etc/passwd`)).statusCode).toBe(
      400,
    );
    expect((await get(`/api/v1/snapshots/${snap}/source?path=%2Fetc%2Fpasswd`)).statusCode).toBe(
      400,
    );
    expect((await get(`/api/v1/snapshots/${snap}/source?path=.env`)).statusCode).toBe(404);
    appendFileSync(join(root, 'packages/api/src/db.ts'), '\n// edited after the snapshot\n');
    const changed = (
      await get(`/api/v1/snapshots/${snap}/source?path=packages/api/src/db.ts`)
    ).json();
    expect(changed).toMatchObject({ state: 'changed', text: null });
  });
});

describe('overlay API', () => {
  const viewId = `cvs_${'e'.repeat(32)}`;
  const base = {
    schemaVersion: 1,
    viewId,
    profileId: 'local',
    pinnedIds: [],
    annotations: [],
    displayOverrides: {},
    viewport: { x: 0, y: 0, zoom: 1 },
  };

  it('round-trips with optimistic revisions and rejects invalid bodies', async () => {
    const empty = (await get(`/api/v1/views/${viewId}/overlay`)).json();
    expect(empty.revision).toBe(0);
    const e = stableId('entity', projectId, 'ts:module:packages/api/src/db.ts');
    const put = (body: unknown) =>
      srv.app.inject({
        method: 'PUT',
        url: `/api/v1/views/${viewId}/overlay`,
        headers: auth,
        payload: body as object,
      });
    const r1 = await put({
      ...base,
      entityPositions: { [e]: { x: 10, y: 20 } },
      nodePositions: { 'cluster:src': { x: 1, y: 2 } },
      revision: 0,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().revision).toBe(1);
    const stale = await put({ ...base, entityPositions: {}, revision: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current.revision).toBe(1);
    expect(
      (await put({ ...base, entityPositions: { 'not-an-entity': { x: 1, y: 1 } }, revision: 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await put({ ...base, viewId: `cvs_${'f'.repeat(32)}`, entityPositions: {}, revision: 1 }))
        .statusCode,
    ).toBe(400);
    expect((await get(`/api/v1/views/${viewId}/overlay`)).json().entityPositions[e]).toEqual({
      x: 10,
      y: 20,
    });
  });

  it('follows accepted rename aliases only relative to the viewed snapshot', async () => {
    const goneId = `ent_${'1'.repeat(32)}`; // not in this snapshot (e.g. a file that moved)
    const liveId = stableId('entity', projectId, 'ts:module:packages/api/src/db.ts'); // in this snapshot
    const v2 = `cvs_${'9'.repeat(32)}`;
    await srv.app.inject({
      method: 'PUT',
      url: `/api/v1/views/${v2}/overlay`,
      headers: auth,
      payload: {
        ...base,
        viewId: v2,
        entityPositions: { [goneId]: { x: 5, y: 6 } },
        pinnedIds: [goneId],
        revision: 0,
      },
    });
    // reconciliation writes this row when a file moves with identical content
    database
      .prepare(
        'INSERT INTO entity_aliases (project_id, old_id, new_id, method, snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(projectId, goneId, liveId, 'content-hash', snap, 'now');
    const remapped = (
      await get(`/api/v1/views/${v2}/overlay?project=${projectId}&snapshot=${snap}`)
    ).json();
    expect(remapped.entityPositions).toEqual({ [liveId]: { x: 5, y: 6 } });
    expect(remapped.pinnedIds).toEqual([liveId]);
    // without a snapshot context nothing is remapped
    expect(
      (await get(`/api/v1/views/${v2}/overlay?project=${projectId}`)).json().entityPositions,
    ).toEqual({ [goneId]: { x: 5, y: 6 } });
  });
});
