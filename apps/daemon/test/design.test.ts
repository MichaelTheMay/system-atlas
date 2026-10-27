/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON */
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import { loadPlannerGraph, registerRoot, scanWorktree } from '@atlas/graph';
import type * as planner from '@atlas/planner';
import { planDesign, type Catalog, type PlannerGraph } from '@atlas/planner';
import type { CanvasSpec } from '@atlas/schema';
import { migrate, openDb } from '@atlas/store';
import type { BusMessage } from '../src/events.ts';
import { buildServer } from '../src/server.ts';

// planDesign is wrapped in a spy that runs the real planner unless a test swaps the implementation
vi.mock('@atlas/planner', async (importOriginal) => {
  const orig = await importOriginal<typeof planner>();
  return { ...orig, planDesign: vi.fn(orig.planDesign) };
});
const { planDesign: realPlanDesign } = await vi.importActual<typeof planner>('@atlas/planner');
const spy = vi.mocked(planDesign);

const fixtureRoot = () => {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-design-')), 'svc');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  return root;
};

/** Whether the real design planner (D01 part A) is merged: it plans ≥1 canvas for the fixture. */
const designPlannerImplemented = await (async () => {
  const db = openDb(':memory:');
  migrate(db);
  const { worktree } = await registerRoot(db, fixtureRoot());
  const r = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
  return realPlanDesign(loadPlannerGraph(db, r.snapshot.id)).canvases.length > 0;
})();

const token = 'd'.repeat(64);
const port = 47996;
const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
const meta = {
  provider: 'mcp-client',
  model: 'test-agent',
  promptTemplateVersion: 'agent-authored',
};

/** Stand-in planner for the plumbing tests: one canvas per subsystem name, overrides applied. */
function fakeDesign(g: PlannerGraph): Catalog {
  const suppressed = new Set(
    (g.overrides ?? []).filter((o) => o.action === 'suppress').map((o) => o.targetId),
  );
  const byName = new Map<string, { origins: Set<string>; members: number }>();
  for (const c of g.claims ?? []) {
    if (c.predicate !== 'subsystem' || c.status === 'rejected' || c.status === 'stale') continue;
    const e = byName.get(String(c.value)) ?? { origins: new Set(), members: 0 };
    e.origins.add(c.origin);
    e.members++;
    byName.set(String(c.value), e);
  }
  const canvases: CanvasSpec[] = [];
  for (const [name, e] of byName) {
    const id = `cvs_${createHash('sha256').update(`${g.projectId}\0design\0${name}`).digest('hex').slice(0, 32)}`;
    if (suppressed.has(id)) continue;
    canvases.push({
      schemaVersion: 1,
      id,
      workspace: 'design',
      lens: 'design-subsystem',
      title: name,
      query: { limit: 50 } as CanvasSpec['query'],
      relevanceReason: 'test',
      relevanceScore: 1,
      scoringPolicyVersion: 'test',
      snapshotId: g.snapshotId,
      generationVersion: 'test',
      state: 'cataloged',
      provenance: e.origins.has('human') ? 'accepted' : 'proposed',
      coverageSummary: { entityCount: e.members, gapCount: 0, staleCount: 0 },
    });
  }
  return { canvases, links: [] };
}

let srv: ReturnType<typeof buildServer> | undefined;
beforeEach(() => {
  spy.mockClear();
  spy.mockImplementation(realPlanDesign);
});
afterEach(async () => {
  await srv?.app.close();
  srv = undefined;
});

async function setup() {
  const root = fixtureRoot();
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
  const scan = async () => {
    await j('POST', `/api/v1/worktrees/${wt}/scans`);
    await srv!.jobs.idle();
    return (await j('GET', `/api/v1/worktrees/${wt}/snapshot`)).snapshot.id as string;
  };
  const snapshotId = await scan();
  const find = async (q: string, path: string) =>
    (await j('GET', `/api/v1/snapshots/${snapshotId}/search?q=${q}&kind=module`)).hits.find(
      (h: any) => h.path === path,
    ).id as string;
  const dbId = await find('db', 'packages/api/src/db.ts');
  const serverId = await find('server', 'packages/api/src/server.ts');
  const proposeSubsystem = (sid: string, name: string, members: [string, string][]) =>
    j('POST', '/api/v1/proposals/claims', {
      snapshotId: sid,
      origin: 'model',
      modelMetadata: meta,
      claims: members.map(([subjectId, path]) => ({
        subjectId,
        predicate: 'subsystem',
        value: name,
        citations: [{ path, startLine: 1, endLine: 1 }],
      })),
    });
  const design = async (sid = snapshotId) =>
    (await j('GET', `/api/v1/snapshots/${sid}/canvases`)).canvases.filter(
      (c: any) => c.workspace === 'design',
    );
  return {
    root,
    db,
    wt,
    projectId: reg.project.id as string,
    snapshotId,
    dbId,
    serverId,
    req,
    j,
    scan,
    events,
    proposeSubsystem,
    design,
  };
}

const lastGraph = () => spy.mock.calls.at(-1)![0];

describe('system-design lens API (D01b)', () => {
  it('merges design canvases into the catalog and replans when claims change, without rescan', async () => {
    spy.mockImplementation(fakeDesign);
    const t = await setup();
    expect(await t.design()).toEqual([]);
    expect(lastGraph()).toMatchObject({ claims: [], overrides: [] });
    const calls = spy.mock.calls.length;
    await t.design();
    expect(spy.mock.calls.length).toBe(calls); // cached while nothing changes

    const p = await t.proposeSubsystem(t.snapshotId, 'Persistence', [
      [t.dbId, 'packages/api/src/db.ts'],
      [t.serverId, 'packages/api/src/server.ts'],
    ]);
    expect(p.accepted).toHaveLength(2);
    const [canvas, ...rest] = await t.design();
    expect(rest).toEqual([]);
    expect(canvas).toMatchObject({
      title: 'Persistence',
      lens: 'design-subsystem',
      provenance: 'proposed',
    });
    expect(lastGraph().claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId: t.dbId, value: 'Persistence', model: 'test-agent' }),
        expect.objectContaining({ subjectId: t.serverId, value: 'Persistence', origin: 'model' }),
      ]),
    );
    // the worktree route and the projection route see the same merged catalog
    const wtCat = await t.j('GET', `/api/v1/worktrees/${t.wt}/canvases`);
    expect(wtCat.canvases.map((c: any) => c.id)).toContain(canvas.id);
    expect(wtCat.canvases.some((c: any) => c.workspace === 'architecture')).toBe(true);
    const proj = await t.req(
      'GET',
      `/api/v1/snapshots/${t.snapshotId}/canvases/${canvas.id}/projection`,
    );
    expect(proj.status).toBe(200);
    expect(proj.body).toMatchObject({ canvasId: canvas.id, lens: 'design-subsystem' });
    // design canvases are never persisted
    expect(
      t.db
        .prepare(`SELECT count(*) AS n FROM canvases WHERE body LIKE '%"workspace":"design"%'`)
        .get<{ n: number }>()!.n,
    ).toBe(0);

    // a review is a change too: rejecting both claims removes the proposal
    for (const c of lastGraph().claims!)
      expect((await t.req('POST', `/api/v1/claims/${c.id}/reject`, { reason: 'no' })).status).toBe(
        200,
      );
    expect(t.events.filter((e) => e.type === 'claims.reviewed').at(-1)?.data.projectId).toBe(
      t.projectId,
    );
    expect(await t.design()).toEqual([]);
  });

  it('validates override input and feeds overrides to the planner', async () => {
    spy.mockImplementation(fakeDesign);
    const t = await setup();
    await t.proposeSubsystem(t.snapshotId, 'Persistence', [[t.dbId, 'packages/api/src/db.ts']]);
    const [canvas] = await t.design();
    const url = `/api/v1/views/${canvas.id}/override`;
    const ok = { action: 'suppress', enabled: true, projectId: t.projectId };
    const bad: [string, unknown, number][] = [
      ['/api/v1/views/not-a-canvas/override', ok, 400],
      [url, { ...ok, action: 'hide' }, 400],
      [url, { ...ok, enabled: 'yes' }, 400],
      [url, { action: 'pin', enabled: true }, 400],
      [url, { ...ok, extra: 1 }, 400],
      [url, { ...ok, projectId: 'proj_' + '0'.repeat(32) }, 404],
      [url, { ...ok, action: 'promote' }, 400],
      [
        url,
        { ...ok, action: 'promote', snapshotId: t.snapshotId, subsystemPath: 'x'.repeat(81) },
        400,
      ],
      [
        url,
        { ...ok, action: 'promote', snapshotId: 'snap_' + '0'.repeat(32), subsystemPath: 'p' },
        404,
      ],
    ];
    for (const [u, body, status] of bad) {
      const r = await t.req('PUT', u, body);
      expect([u, body, r.status]).toEqual([u, body, status]);
    }
    expect(
      (await t.req('GET', '/api/v1/projects/proj_' + '0'.repeat(32) + '/overrides')).status,
    ).toBe(404);

    const r = await t.req('PUT', url, ok);
    expect(r.status).toBe(200);
    expect(r.body.overrides).toEqual([
      expect.objectContaining({ targetId: canvas.id, action: 'suppress' }),
    ]);
    expect(t.events.at(-1)).toEqual({ type: 'views.changed', data: { projectId: t.projectId } });
    expect(await t.design()).toEqual([]);
    expect(lastGraph().overrides).toEqual([{ targetId: canvas.id, action: 'suppress' }]);
    expect((await t.j('GET', `/api/v1/projects/${t.projectId}/overrides`)).overrides).toHaveLength(
      1,
    );

    await t.req('PUT', url, { ...ok, enabled: false });
    expect((await t.design()).map((c: any) => c.id)).toEqual([canvas.id]);
    expect((await t.j('GET', `/api/v1/projects/${t.projectId}/overrides`)).overrides).toEqual([]);
  });

  it('promote re-proposes model subsystem claims as supported human claims', async () => {
    spy.mockImplementation(fakeDesign);
    const t = await setup();
    await t.proposeSubsystem(t.snapshotId, 'Backend/Persistence', [
      [t.dbId, 'packages/api/src/db.ts'],
      [t.serverId, 'packages/api/src/server.ts'],
    ]);
    const [canvas] = await t.design();
    const r = await t.req('PUT', `/api/v1/views/${canvas.id}/override`, {
      action: 'promote',
      enabled: true,
      projectId: t.projectId,
      snapshotId: t.snapshotId,
      subsystemPath: ' backend ',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rejected: [], overrideRecorded: true });
    expect(r.body.accepted.map((a: any) => a.status)).toEqual(['supported', 'supported']);
    const [after] = await t.design();
    expect(after).toMatchObject({ id: canvas.id, provenance: 'accepted' });
    expect(
      lastGraph()
        .claims!.filter((c) => c.origin === 'human')
        .map((c) => [c.subjectId, c.status, c.value])
        .sort(),
    ).toEqual(
      [
        [t.dbId, 'supported', 'Backend/Persistence'],
        [t.serverId, 'supported', 'Backend/Persistence'],
      ].sort(),
    );
    expect(lastGraph().overrides).toEqual([{ targetId: canvas.id, action: 'promote' }]);
    expect(t.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['claims.proposed', 'views.changed']),
    );
    expect(
      t.db
        .prepare("SELECT count(*) AS n FROM claims WHERE origin = 'model' AND status = 'supported'")
        .get<{ n: number }>()!.n,
    ).toBe(0);
  });

  it('promote of claims whose cited file changed and was rescanned fails with the validator reasons', async () => {
    spy.mockImplementation(fakeDesign);
    const t = await setup();
    await t.proposeSubsystem(t.snapshotId, 'Persistence', [[t.dbId, 'packages/api/src/db.ts']]);
    const [canvas] = await t.design();
    appendFileSync(join(t.root, 'packages/api/src/db.ts'), '\n// edited\n');
    const next = await t.scan();
    expect(next).not.toBe(t.snapshotId);
    const r = await t.req('PUT', `/api/v1/views/${canvas.id}/override`, {
      action: 'promote',
      enabled: true,
      projectId: t.projectId,
      snapshotId: next,
      subsystemPath: 'Persistence',
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      error: 'promotion_rejected',
      accepted: [],
      overrideRecorded: false,
    });
    expect(r.body.rejected[0].reasons).toEqual([
      expect.stringMatching(/describes a different version of packages\/api\/src\/db\.ts/),
    ]);
    expect((await t.j('GET', `/api/v1/projects/${t.projectId}/overrides`)).overrides).toEqual([]);
  });

  it.skipIf(!designPlannerImplemented)(
    'end to end: a subsystem proposal makes a design-subsystem canvas appear without rescan',
    async () => {
      const t = await setup();
      const before = await t.design();
      expect(before.some((c: any) => c.lens === 'design-system')).toBe(true);
      expect(before.some((c: any) => c.lens === 'design-subsystem')).toBe(false);
      await t.proposeSubsystem(t.snapshotId, 'Persistence', [
        [t.dbId, 'packages/api/src/db.ts'],
        [t.serverId, 'packages/api/src/server.ts'],
      ]);
      const sub = (await t.design()).find(
        (c: any) => c.lens === 'design-subsystem' && /persistence/i.test(c.title),
      );
      expect(sub).toMatchObject({ provenance: 'proposed' });
      const proj = await t.j(
        'GET',
        `/api/v1/snapshots/${t.snapshotId}/canvases/${sub.id}/projection`,
      );
      expect(proj.nodes.map((n: any) => n.entityId)).toEqual(
        expect.arrayContaining([t.dbId, t.serverId]),
      );
      // promoting it makes it accepted
      await t.j('PUT', `/api/v1/views/${sub.id}/override`, {
        action: 'promote',
        enabled: true,
        projectId: t.projectId,
        snapshotId: t.snapshotId,
        subsystemPath: 'Persistence',
      });
      expect((await t.design()).find((c: any) => c.id === sub.id)).toMatchObject({
        provenance: 'accepted',
      });
    },
  );
});
