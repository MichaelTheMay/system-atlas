/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON */
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesignDrift } from '@atlas/schema';
import { migrate, openDb } from '@atlas/store';
import type { BusMessage } from '../src/events.ts';
import { buildServer } from '../src/server.ts';

const token = 'e'.repeat(64);
const port = 47997;
const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };

let srv: ReturnType<typeof buildServer> | undefined;
afterEach(async () => {
  await srv?.app.close();
  srv = undefined;
});

async function setup() {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-dsgapi-')), 'svc');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  const db = openDb(':memory:');
  migrate(db);
  srv = buildServer({ token, db, dataDir: '/tmp/x', port: () => port });
  const events: BusMessage[] = [];
  srv.bus.subscribe((m) => events.push(m));
  const app = srv.app;
  const req = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({
      method: method as 'GET',
      url,
      headers,
      payload: payload as object,
    });
    return { status: r.statusCode, body: r.json() as any };
  };
  const j = async (method: string, url: string, payload?: unknown) =>
    (await req(method, url, payload)).body;
  const reg = await j('POST', '/api/v1/projects', { rootPath: root });
  const wt = reg.worktree.id as string;
  const projectId = reg.project.id as string;
  const scan = async () => {
    await j('POST', `/api/v1/worktrees/${wt}/scans`);
    await srv!.jobs.idle();
    return (await j('GET', `/api/v1/worktrees/${wt}/snapshot`)).snapshot.id as string;
  };
  const snapshotId = await scan();
  const pkg = (name: string) =>
    db
      .prepare(
        "SELECT id FROM entities WHERE snapshot_id = ? AND kind = 'package' AND display_name = ?",
      )
      .get<{ id: string }>(snapshotId, name)!.id;
  const catalog = async (sid: string) =>
    (await j('GET', `/api/v1/snapshots/${sid}/canvases`)).canvases.filter(
      (c: any) => c.workspace === 'design',
    );
  const projection = async (sid: string, cid?: string) => {
    const id = cid ?? (await catalog(sid)).find((c: any) => c.lens === 'design-system').id;
    return j('GET', `/api/v1/snapshots/${sid}/canvases/${id}/projection`);
  };
  const counts = () =>
    ['entities', 'relations'].map(
      (t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get<{ n: number }>()!.n,
    );
  const base = `/api/v1/projects/${projectId}/design`;
  return {
    root,
    db,
    projectId,
    snapshotId,
    scan,
    req,
    j,
    events,
    catalog,
    projection,
    counts,
    base,
    api: pkg('@reports/api'),
    web: pkg('@reports/web'),
    worker: pkg('@reports/worker'),
  };
}

const designEvents = (events: BusMessage[]) => events.filter((e) => e.type === 'design.changed');

describe('design elements API (D02a)', () => {
  it('CRUD with optimistic revisions; every write publishes design.changed and replans', async () => {
    const t = await setup();
    const before = t.counts();
    expect(await t.j('GET', `${t.base}/elements`)).toEqual({
      projectId: t.projectId,
      elements: [],
    });
    await t.catalog(t.snapshotId); // warm the design catalog cache

    const created = await t.req('POST', `${t.base}/elements`, {
      body: { kind: 'subsystem', label: 'Reporting' },
    });
    expect(created.status).toBe(201);
    const sub = created.body;
    expect(sub).toMatchObject({ author: 'user', status: 'active', revision: 0 });
    expect(designEvents(t.events).at(-1)!.data).toMatchObject({
      projectId: t.projectId,
      action: 'create',
      elementIds: [sub.id],
    });
    // the cached catalog moved: the drawn subsystem is a canvas now, without a rescan
    const canvas = (await t.catalog(t.snapshotId)).find((c: any) => c.title === 'Reporting');
    expect(canvas).toMatchObject({ lens: 'design-subsystem', provenance: 'accepted' });

    // the UI path cannot impersonate an agent or skip review
    const forged = await t.req('POST', `${t.base}/elements`, {
      body: { kind: 'box', label: 'X', archetype: 'service' },
      author: 'agent',
      status: 'proposed',
    });
    expect(forged.status).toBe(201);
    expect(forged.body).toMatchObject({ author: 'user', status: 'active' });

    const patched = await t.req('PATCH', `${t.base}/elements/${sub.id}`, {
      body: { kind: 'subsystem', label: 'Reports' },
      revision: 0,
    });
    expect(patched).toMatchObject({ status: 200, body: { revision: 1 } });
    const conflict = await t.req('PATCH', `${t.base}/elements/${sub.id}`, {
      body: { kind: 'subsystem', label: 'Late' },
      revision: 0,
    });
    expect(conflict).toMatchObject({
      status: 409,
      body: { error: 'revision conflict', current: { revision: 1, body: { label: 'Reports' } } },
    });
    expect((await t.catalog(t.snapshotId)).some((c: any) => c.title === 'Reports')).toBe(true);

    expect((await t.req('POST', `${t.base}/elements`, { body: { kind: 'nope' } })).status).toBe(
      400,
    );
    const unknownProject = `/api/v1/projects/proj_${'0'.repeat(32)}/design/elements`;
    expect((await t.req('GET', unknownProject)).status).toBe(404);
    expect((await t.req('PATCH', `${t.base}/elements/nope`, { revision: 0 })).status).toBe(404);
    expect((await t.req('POST', `${t.base}/elements/${sub.id}/accept`, {})).status).toBe(409);
    expect((await t.req('DELETE', `${t.base}/elements/${sub.id}?revision=0`)).status).toBe(409);

    const del = await t.req('DELETE', `${t.base}/elements/${sub.id}?revision=1`);
    expect(del).toMatchObject({ status: 200, body: { deleted: [sub.id] } });
    expect((await t.catalog(t.snapshotId)).some((c: any) => c.title === 'Reports')).toBe(false);
    expect(designEvents(t.events).map((e) => e.data.action)).toEqual([
      'create',
      'create',
      'update',
      'delete',
    ]);

    expect(t.counts()).toEqual(before); // the design layer never writes facts

    // survives a rescan (keyed by project, not snapshot)
    const kept = (await t.j('GET', `${t.base}/elements`)).elements.map((e: any) => e.id);
    appendFileSync(join(t.root, 'packages/shared/src/index.ts'), '\nexport const touched = 1;\n');
    const next = await t.scan();
    expect(next).not.toBe(t.snapshotId);
    expect((await t.j('GET', `${t.base}/elements`)).elements.map((e: any) => e.id)).toEqual(kept);
    expect(
      (await t.projection(next)).nodes.some((n: any) => n.designElementId === forged.body.id),
    ).toBe(true);
  });

  it('groups boxes into an accepted subsystem canvas and hides detected boxes', async () => {
    const t = await setup();
    const before = t.counts();
    await t.catalog(t.snapshotId);
    const grouped = await t.req('POST', `${t.base}/group`, {
      snapshotId: t.snapshotId,
      path: 'Backend',
      entityIds: [t.api, t.worker],
    });
    expect(grouped.status).toBe(200);
    expect(grouped.body.accepted).toHaveLength(2);
    expect(t.events.some((e) => e.type === 'claims.proposed')).toBe(true);
    const claims = t.db
      .prepare("SELECT origin, status FROM claims WHERE predicate = 'subsystem'")
      .all<{ origin: string; status: string }>();
    expect(claims).toEqual([
      { origin: 'human', status: 'supported' },
      { origin: 'human', status: 'supported' },
    ]);
    const backend = (await t.catalog(t.snapshotId)).find((c: any) => c.title === 'Backend');
    expect(backend).toMatchObject({ lens: 'design-subsystem', provenance: 'accepted' });
    const root = await t.projection(t.snapshotId);
    expect(root.nodes.find((n: any) => n.openCanvasId === backend.id)).toMatchObject({
      kind: 'cluster',
      provenance: 'accepted',
    });
    expect(
      (
        await t.req('POST', `${t.base}/group`, {
          snapshotId: t.snapshotId,
          path: '',
          entityIds: [],
        })
      ).status,
    ).toBe(400);

    const hide = await t.req('POST', `${t.base}/hide`, { entityId: t.web, enabled: true });
    expect(hide).toMatchObject({
      status: 200,
      body: { targetId: t.web, action: 'suppress', enabled: true },
    });
    expect(designEvents(t.events).at(-1)!.data.action).toBe('hide');
    const hidden = await t.projection(t.snapshotId);
    expect(hidden.nodes.some((n: any) => n.entityId === t.web)).toBe(false);
    expect(hidden.stats.hiddenNodes).toBeGreaterThan(0);
    expect((await t.req('POST', `${t.base}/hide`, { entityId: 'x', enabled: true })).status).toBe(
      400,
    );
    await t.req('POST', `${t.base}/hide`, { entityId: t.web, enabled: false });
    expect((await t.projection(t.snapshotId)).nodes.some((n: any) => n.entityId === t.web)).toBe(
      true,
    );
    expect(t.counts()).toEqual(before);
  });

  it('returns drift in the projection and labels drawn flows', async () => {
    const t = await setup();
    const before = t.counts();
    const planned = (
      await t.req('POST', `${t.base}/elements`, {
        body: { kind: 'box', label: 'Notifier', archetype: 'worker' },
      })
    ).body;
    const drawn = (
      await t.req('POST', `${t.base}/elements`, {
        body: {
          kind: 'flow',
          from: { entityId: t.worker },
          to: { elementId: planned.id },
          label: 'notify',
        },
      })
    ).body;
    const bound = (
      await t.req('POST', `${t.base}/elements`, {
        body: { kind: 'box', label: 'Front end', archetype: 'client' },
        boundEntityIds: [t.web],
      })
    ).body;
    const p = await t.projection(t.snapshotId);
    for (const d of p.drift) DesignDrift.parse(d);
    expect(p.nodes.find((n: any) => n.designElementId === planned.id)).toMatchObject({
      kind: 'design',
      unbound: true,
    });
    expect(p.nodes.find((n: any) => n.id === `box:${t.web}`)).toMatchObject({
      label: 'Front end',
      archetype: 'client',
      designElementId: bound.id,
    });
    expect(p.edges.find((e: any) => e.designElementId === drawn.id)).toMatchObject({
      drawn: true,
      flow: 'notify',
      status: 'inferred',
    });
    expect(p.drift).toContainEqual({ kind: 'flow-not-in-code', elementId: drawn.id });
    expect(p.drift.some((d: any) => d.kind === 'code-flow-not-drawn')).toBe(true);

    // the bound package disappears: the box stays and is reported stale
    rmSync(join(t.root, 'packages/web'), { recursive: true });
    const next = await t.scan();
    const after = await t.projection(next);
    expect(after.drift).toContainEqual({
      kind: 'bound-entity-missing',
      elementId: bound.id,
      entityIds: [t.web],
    });
    expect(t.counts()[0]).toBeGreaterThan(before[0]!); // only the rescan added rows
  });

  it('rejects writes for invented references', async () => {
    const t = await setup();
    const r = await t.req('POST', `${t.base}/elements`, {
      body: { kind: 'box', label: 'X', archetype: 'service' },
      boundEntityIds: [`ent_${'9'.repeat(32)}`],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('boundEntityIds');
    expect(designEvents(t.events)).toEqual([]);
  });
});
