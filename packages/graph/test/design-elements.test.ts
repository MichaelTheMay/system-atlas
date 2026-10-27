import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import {
  designElementCanvasId,
  planDesign,
  projectDesign,
  type PlannerGraph,
  type Projection,
} from '@atlas/planner';
import { DesignDrift } from '@atlas/schema';
import {
  acceptDesignElement,
  createDesignElement,
  deleteDesignElement,
  getDesignElement,
  groupIntoSubsystem,
  hideDetectedBox,
  listDesignElements,
  listOverrides,
  listProposals,
  loadPlannerGraph,
  patchDesignElement,
  proposeClaims,
  registerRoot,
  scanWorktree,
} from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

async function setup() {
  const db = freshDb();
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-dsg-')), 'svc');
  cpSync(fixture('ts-web-service'), root, { recursive: true });
  const { worktree, project } = await registerRoot(db, root);
  const scan = async () =>
    (await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() })).snapshot.id;
  const snapshotId = await scan();
  const g0 = loadPlannerGraph(db, snapshotId);
  const pkg = (name: string) =>
    g0.entities.find((e) => e.kind === 'package' && e.displayName === name)!.id;
  const mod = (path: string) => g0.entities.find((e) => e.attributes.path === path)!;
  const counts = () =>
    ['entities', 'relations', 'evidence'].map(
      (t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get<{ n: number }>()!.n,
    );
  const view = (sid: string, canvas?: string) => {
    const g = loadPlannerGraph(db, sid);
    const cat = planDesign(g);
    const root = cat.canvases.find((c) => c.lens === 'design-system')!;
    return { g, cat, p: projectDesign(g, cat, canvas ?? root.id), rootId: root.id };
  };
  return {
    db,
    root,
    project,
    projectId: project.id,
    scan,
    snapshotId,
    api: pkg('@reports/api'),
    web: pkg('@reports/web'),
    worker: pkg('@reports/worker'),
    mod,
    counts,
    view,
  };
}

const box = (label: string, extra: Record<string, unknown> = {}) => ({
  body: { kind: 'box', label, archetype: 'service', ...extra },
});
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const node = (p: Projection, pred: (n: Projection['nodes'][number]) => boolean) =>
  p.nodes.find(pred);

describe('design elements (D02a)', () => {
  it('creates, patches with optimistic revisions, refuses bad references and deletes', async () => {
    const t = await setup();
    const before = t.counts();
    const a = ok(createDesignElement(t.db, t.projectId, box('Billing'))).element;
    expect(a).toMatchObject({
      author: 'user',
      status: 'active',
      revision: 0,
      boundEntityIds: [],
      citations: [],
    });
    expect(a.id).toMatch(/^dsg_/);
    expect(listDesignElements(t.db, t.projectId).map((e) => e.id)).toEqual([a.id]);

    const p1 = ok(
      patchDesignElement(t.db, t.projectId, a.id, { ...box('Payments'), revision: 0 }),
    ).element;
    expect(p1).toMatchObject({ revision: 1, body: { label: 'Payments' } });
    // a stale revision is a conflict that returns what is stored
    const stale = patchDesignElement(t.db, t.projectId, a.id, { ...box('Other'), revision: 0 });
    expect(stale).toMatchObject({
      ok: false,
      status: 409,
      current: { revision: 1, body: { label: 'Payments' } },
    });
    // the kind never changes; status of a user element never changes
    expect(
      patchDesignElement(t.db, t.projectId, a.id, {
        body: { kind: 'subsystem', label: 'X' },
        revision: 1,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      patchDesignElement(t.db, t.projectId, a.id, { status: 'proposed', revision: 1 }),
    ).toMatchObject({ ok: false, status: 400 });

    // references must be live elements/entities of this project
    expect(createDesignElement(t.db, t.projectId, box('Orphan', { parentId: a.id }))).toMatchObject(
      { ok: false, status: 400, error: expect.stringContaining('not a subsystem') },
    );
    expect(
      createDesignElement(t.db, t.projectId, {
        ...box('Ghost'),
        boundEntityIds: ['ent_' + 'f'.repeat(32)],
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('boundEntityIds') });
    expect(
      createDesignElement(t.db, t.projectId, {
        body: { kind: 'flow', from: { elementId: a.id }, to: { elementId: a.id } },
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(createDesignElement(t.db, t.projectId, { body: { kind: 'box' } })).toMatchObject({
      ok: false,
      status: 400,
    });

    // subsystems nest, but never cyclically
    const s1 = ok(
      createDesignElement(t.db, t.projectId, { body: { kind: 'subsystem', label: 'Outer' } }),
    ).element;
    const s2 = ok(
      createDesignElement(t.db, t.projectId, {
        body: { kind: 'subsystem', label: 'Inner', parentId: s1.id },
      }),
    ).element;
    expect(
      patchDesignElement(t.db, t.projectId, s1.id, {
        body: { kind: 'subsystem', label: 'Outer', parentId: s2.id },
        revision: 0,
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('cyclic') });

    // deleting a subsystem moves its children up; flows ending at a deleted box go with it
    const inner = ok(
      createDesignElement(t.db, t.projectId, box('Inside', { parentId: s2.id })),
    ).element;
    const flow = ok(
      createDesignElement(t.db, t.projectId, {
        body: { kind: 'flow', from: { elementId: inner.id }, to: { entityId: t.api } },
      }),
    ).element;
    const del = ok(deleteDesignElement(t.db, t.projectId, s2.id));
    expect(del).toMatchObject({ deleted: [s2.id], reparented: [inner.id] });
    expect(getDesignElement(t.db, t.projectId, inner.id)!.body).toMatchObject({
      parentId: s1.id,
    });
    expect(deleteDesignElement(t.db, t.projectId, inner.id, 99)).toMatchObject({ status: 409 });
    expect(ok(deleteDesignElement(t.db, t.projectId, inner.id))).toMatchObject({
      deleted: [inner.id, flow.id],
    });
    expect(getDesignElement(t.db, t.projectId, flow.id)).toBeUndefined();
    expect(deleteDesignElement(t.db, t.projectId, inner.id)).toMatchObject({ status: 404 });
    expect(t.counts()).toEqual(before); // never touches entities, relations or evidence
  });

  it('validates agent citations, accepts proposals and soft-deletes agent elements', async () => {
    const t = await setup();
    const before = t.counts();
    const agent = (citations: string[]) => ({
      authorName: 'test-model',
      snapshotId: t.snapshotId,
      citations,
    });
    const invented = 'evd_' + 'a'.repeat(32);
    const bad = createDesignElement(t.db, t.projectId, box('Cache'), agent([invented]));
    expect(bad).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining(`evidence ${invented} does not exist in this project`),
    });
    expect(createDesignElement(t.db, t.projectId, box('Cache'), agent([]))).toMatchObject({
      ok: false,
      status: 400,
    });
    const real = (t.mod('packages/api/src/db.ts').attributes.evidenceIds as string[])[0]!;
    const ghost = ok(createDesignElement(t.db, t.projectId, box('Cache'), agent([real]))).element;
    expect(ghost).toMatchObject({
      author: 'agent',
      authorName: 'test-model',
      status: 'proposed',
      citations: [real],
    });
    const { p } = t.view(t.snapshotId);
    expect(node(p, (n) => n.designElementId === ghost.id)).toMatchObject({
      kind: 'design',
      ghost: true,
      authorName: 'test-model',
      provenance: 'proposed',
      unbound: true,
    });

    // a flow to a ghost cannot be accepted before the ghost
    const flow = ok(
      createDesignElement(
        t.db,
        t.projectId,
        { body: { kind: 'flow', from: { entityId: t.api }, to: { elementId: ghost.id } } },
        agent([real]),
      ),
    ).element;
    expect(acceptDesignElement(t.db, t.projectId, flow.id)).toMatchObject({ status: 409 });
    expect(acceptDesignElement(t.db, t.projectId, ghost.id, 5)).toMatchObject({ status: 409 });
    const acc = ok(acceptDesignElement(t.db, t.projectId, ghost.id, 0)).element;
    expect(acc).toMatchObject({ status: 'active', author: 'agent', revision: 1 });
    expect(acceptDesignElement(t.db, t.projectId, ghost.id)).toMatchObject({ status: 409 });
    const { p: p2 } = t.view(t.snapshotId);
    expect(node(p2, (n) => n.designElementId === ghost.id)).toMatchObject({
      provenance: 'accepted',
      author: 'agent',
    });
    expect(node(p2, (n) => n.designElementId === ghost.id)!.ghost).toBeUndefined();
    expect(p2.edges.find((e) => e.designElementId === flow.id)).toMatchObject({ ghost: true });

    // deleting agent work only rejects it (audited), including accepted elements
    const del = ok(deleteDesignElement(t.db, t.projectId, ghost.id));
    expect(del).toMatchObject({ deleted: [], rejected: [ghost.id, flow.id] });
    expect(getDesignElement(t.db, t.projectId, ghost.id)!.status).toBe('rejected');
    expect(listDesignElements(t.db, t.projectId)).toEqual([]);
    expect(listDesignElements(t.db, t.projectId, { includeRejected: true })).toHaveLength(2);
    expect(listProposals(t.db, t.projectId).filter((x) => x.kind === 'design-review')).toHaveLength(
      2,
    );
    expect(t.counts()).toEqual(before);
  });

  it('draws unbound boxes, stickies and drawn subsystems with their own canvases', async () => {
    const t = await setup();
    const sub = ok(
      createDesignElement(t.db, t.projectId, {
        body: { kind: 'subsystem', label: 'Reporting', responsibility: 'Builds reports' },
      }),
    ).element;
    const planned = ok(
      createDesignElement(t.db, t.projectId, box('Renderer', { parentId: sub.id })),
    ).element;
    // a box bound to exactly one detected box places that box in the drawn subsystem
    const workerBox = ok(
      createDesignElement(t.db, t.projectId, {
        ...box('Report worker', { parentId: sub.id, archetype: 'worker' }),
        boundEntityIds: [t.worker],
      }),
    ).element;
    const { cat, p, rootId } = t.view(t.snapshotId);
    const canvas = cat.canvases.find((c) => c.id === designElementCanvasId(t.projectId, sub.id))!;
    expect(canvas).toMatchObject({
      lens: 'design-subsystem',
      title: 'Reporting',
      provenance: 'accepted',
      ownerCanvasId: rootId,
    });
    expect(cat.links).toContainEqual(
      expect.objectContaining({ fromCanvasId: rootId, toCanvasId: canvas.id, relation: 'child' }),
    );
    // root: the drawn subsystem is a cluster that owns the worker's flows; the worker box left
    const cluster = node(p, (n) => n.id === `design:${sub.id}`)!;
    expect(cluster).toMatchObject({ kind: 'cluster', openCanvasId: canvas.id, label: 'Reporting' });
    expect(node(p, (n) => n.id === `box:${t.worker}`)).toBeUndefined();
    expect(p.edges.some((e) => e.source === cluster.id)).toBe(true);
    expect(node(p, (n) => n.designElementId === planned.id)).toBeUndefined();

    const sticky = ok(
      createDesignElement(t.db, t.projectId, {
        body: { kind: 'sticky', text: 'Ask about retries\nand timeouts', canvasId: canvas.id },
      }),
    ).element;
    const inner = t.view(t.snapshotId, canvas.id).p;
    expect(inner.breadcrumbs.map((b) => b.title)).toEqual(['System design', 'Reporting']);
    expect(node(inner, (n) => n.designElementId === planned.id)).toMatchObject({
      kind: 'design',
      unbound: true,
      label: 'Renderer',
      sublabel: 'planned · not in code yet',
      provenance: 'accepted',
      author: 'user',
    });
    expect(node(inner, (n) => n.id === `box:${t.worker}`)).toMatchObject({
      label: 'Report worker',
      archetype: 'worker',
      designElementId: workerBox.id,
      provenance: 'accepted',
    });
    expect(node(inner, (n) => n.id === `sticky:${sticky.id}`)).toMatchObject({
      kind: 'sticky',
      label: 'Ask about retries',
      text: 'Ask about retries\nand timeouts',
    });
    // the worker's partners outside the drawn subsystem are context ports
    expect(inner.nodes.some((n) => n.kind === 'port')).toBe(true);
    // deterministic and side-effect free
    const g = loadPlannerGraph(t.db, t.snapshotId);
    const c2 = planDesign(g);
    expect(projectDesign(g, c2, canvas.id)).toEqual(
      projectDesign(structuredClone(g), planDesign(structuredClone(g)), canvas.id),
    );
  });

  it('computes drift: drawn-not-in-code, code-not-drawn and missing bound entities', async () => {
    const t = await setup();
    const { p: plain } = t.view(t.snapshotId);
    expect(plain.drift).toBeUndefined(); // no design layer: projection unchanged

    // a drawn flow that matches code is merged into the code flow
    const http = ok(
      createDesignElement(t.db, t.projectId, {
        body: { kind: 'flow', from: { entityId: t.web }, to: { entityId: t.api }, label: 'REST' },
      }),
    ).element;
    // a drawn flow with no code behind it
    const backwards = ok(
      createDesignElement(t.db, t.projectId, {
        body: { kind: 'flow', from: { entityId: t.api }, to: { entityId: t.web } },
      }),
    ).element;
    const { p } = t.view(t.snapshotId);
    for (const d of p.drift!) DesignDrift.parse(d);
    const merged = p.edges.find((e) => e.designElementId === http.id)!;
    expect(merged).toMatchObject({
      source: `box:${t.web}`,
      target: `box:${t.api}`,
      drawn: true,
      flow: 'REST',
      author: 'user',
    });
    expect(merged.relationIds.length).toBeGreaterThan(0);
    expect(p.edges.find((e) => e.designElementId === backwards.id)).toMatchObject({
      id: `flow:${backwards.id}`,
      drawn: true,
      status: 'inferred',
      relationIds: [],
    });
    expect(p.drift).toContainEqual({ kind: 'flow-not-in-code', elementId: backwards.id });
    expect(p.drift).not.toContainEqual({ kind: 'flow-not-in-code', elementId: http.id });
    const notDrawn = p.drift!.filter((d) => d.kind === 'code-flow-not-drawn');
    expect(notDrawn.length).toBe(p.edges.filter((e) => !e.drawn).length);
    expect(notDrawn).toContainEqual(
      expect.objectContaining({ fromEntityId: t.api, relationIds: expect.any(Array) }),
    );
    expect(notDrawn.some((d) => d.fromEntityId === t.web && d.toEntityId === t.api)).toBe(false);

    // a box bound to a file that disappears survives the rescan and reports the missing entity
    const dbModule = t.mod('packages/api/src/db.ts').id;
    const bound = ok(
      createDesignElement(t.db, t.projectId, { ...box('Data access'), boundEntityIds: [dbModule] }),
    ).element;
    rmSync(join(t.root, 'packages/api/src/db.ts'));
    const next = await t.scan();
    expect(next).not.toBe(t.snapshotId);
    expect(listDesignElements(t.db, t.projectId).map((e) => e.id)).toContain(bound.id);
    const after = t.view(next).p;
    expect(after.drift).toContainEqual({
      kind: 'bound-entity-missing',
      elementId: bound.id,
      entityIds: [dbModule],
    });
    expect(node(after, (n) => n.designElementId === bound.id)).toMatchObject({
      kind: 'design',
      lifecycle: 'stale',
      sublabel: 'stale · bound code is gone',
    });
  });

  it('groups detected boxes with human subsystem claims and moves them when regrouped', async () => {
    const t = await setup();
    const before = t.counts();
    const r = await groupIntoSubsystem(t.db, {
      snapshotId: t.snapshotId,
      path: ' Backend ',
      entityIds: [t.api, t.worker],
    });
    const g1 = ok(r);
    expect(g1.accepted.map((a) => a.entityId).sort()).toEqual([t.api, t.worker].sort());
    expect(g1.rejected).toEqual([]);
    const claims = t.db
      .prepare(
        "SELECT subject_id, origin, status, body FROM claims WHERE snapshot_id = ? AND predicate = 'subsystem'",
      )
      .all<{ subject_id: string; origin: string; status: string; body: string }>(t.snapshotId);
    expect(claims).toHaveLength(2);
    for (const c of claims) {
      expect(c).toMatchObject({ origin: 'human', status: 'supported' });
      expect(JSON.parse(c.body)).toMatchObject({
        value: 'Backend',
        evidenceIds: expect.arrayContaining([expect.stringMatching(/^evd_/)]),
      });
    }
    const { cat } = t.view(t.snapshotId);
    const backend = cat.canvases.find((c) => c.title === 'Backend')!;
    expect(backend).toMatchObject({ lens: 'design-subsystem', provenance: 'accepted' });

    // idempotent
    const again = ok(
      await groupIntoSubsystem(t.db, {
        snapshotId: t.snapshotId,
        path: 'backend',
        entityIds: [t.api],
      }),
    );
    expect(again).toMatchObject({ accepted: [], alreadyGrouped: [t.api] });

    // regrouping moves the box: the old human claim is rejected
    const moved = ok(
      await groupIntoSubsystem(t.db, {
        snapshotId: t.snapshotId,
        path: 'Jobs/Workers',
        entityIds: [t.worker],
      }),
    );
    expect(moved.moved).toHaveLength(1);
    const { cat: cat2 } = t.view(t.snapshotId);
    const workers = cat2.canvases.find((c) => c.title === 'Workers')!;
    expect(workers.provenance).toBe('accepted');
    const inner = t.view(t.snapshotId, workers.id).p;
    expect(node(inner, (n) => n.id === `box:${t.worker}`)?.kind).toBe('entity');
    const back = t.view(t.snapshotId, cat2.canvases.find((c) => c.title === 'Backend')!.id).p;
    expect(node(back, (n) => n.id === `box:${t.worker}`)?.kind).not.toBe('entity');

    expect(
      await groupIntoSubsystem(t.db, {
        snapshotId: t.snapshotId,
        path: 'a/b/c/d',
        entityIds: [t.api],
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await groupIntoSubsystem(t.db, {
        snapshotId: t.snapshotId,
        path: 'x',
        entityIds: ['ent_' + 'e'.repeat(32)],
      }),
    ).toMatchObject({ ok: true, accepted: [], rejected: [{ reasons: [expect.any(String)] }] });
    const [entities, relations] = t.counts();
    expect([entities, relations]).toEqual(before.slice(0, 2));
  });

  it('hides a detected box with a suppress override on its entity id', async () => {
    const t = await setup();
    const before = t.counts();
    expect(ok(hideDetectedBox(t.db, t.projectId, t.worker, true))).toMatchObject({
      targetId: t.worker,
    });
    expect(listOverrides(t.db, t.projectId)).toContainEqual(
      expect.objectContaining({ targetId: t.worker, action: 'suppress' }),
    );
    const { p, g } = t.view(t.snapshotId);
    expect(node(p, (n) => n.entityId === t.worker)).toBeUndefined();
    expect(
      p.edges.some((e) => e.source === `box:${t.worker}` || e.target === `box:${t.worker}`),
    ).toBe(false);
    expect(p.stats.hiddenNodes).toBeGreaterThan(0);
    expect(g.entities.some((e) => e.id === t.worker)).toBe(true); // facts untouched
    expect(hideDetectedBox(t.db, t.projectId, 'ent_' + '0'.repeat(32), true)).toMatchObject({
      status: 404,
    });
    ok(hideDetectedBox(t.db, t.projectId, t.worker, false));
    expect(node(t.view(t.snapshotId).p, (n) => n.entityId === t.worker)).toBeDefined();
    expect(t.counts()).toEqual(before);
  });

  it('ignores cyclic parents in the planner (acyclic navigation)', async () => {
    const t = await setup();
    const g: PlannerGraph = loadPlannerGraph(t.db, t.snapshotId);
    const a = 'dsg_' + '1'.repeat(32);
    const b = 'dsg_' + '2'.repeat(32);
    g.designElements = [
      {
        id: a,
        body: { kind: 'subsystem', label: 'A', parentId: b },
        boundEntityIds: [],
        author: 'user',
        status: 'active',
        citations: [],
      },
      {
        id: b,
        body: { kind: 'subsystem', label: 'B', parentId: a },
        boundEntityIds: [],
        author: 'user',
        status: 'active',
        citations: [],
      },
    ];
    const cat = planDesign(g);
    const root = cat.canvases.find((c) => c.lens === 'design-system')!;
    for (const id of [a, b])
      expect(
        cat.canvases.find((c) => c.id === designElementCanvasId(t.projectId, id)),
      ).toMatchObject({ ownerCanvasId: root.id });
    for (const c of cat.canvases)
      expect(projectDesign(g, cat, c.id).breadcrumbs.length).toBeLessThan(4);
  });
  it('a person grouping a box wins over an agent proposal for it', async () => {
    const t = await setup();
    const proposed = await proposeClaims(t.db, {
      snapshotId: t.snapshotId,
      origin: 'model',
      modelMetadata: { provider: 'mcp-client', model: 'test-model', promptTemplateVersion: 'x' },
      claims: [
        {
          subjectId: t.worker,
          predicate: 'subsystem',
          value: 'Analytics',
          citations: [{ path: 'packages/worker/src/main.ts', startLine: 1, endLine: 1 }],
        },
      ],
    });
    expect(ok(proposed).accepted).toHaveLength(1);
    ok(
      await groupIntoSubsystem(t.db, {
        snapshotId: t.snapshotId,
        path: 'Backend',
        entityIds: [t.worker],
      }),
    );
    const { cat } = t.view(t.snapshotId);
    const backend = cat.canvases.find((c) => c.title === 'Backend')!;
    expect(backend.provenance).toBe('accepted');
    const inner = t.view(t.snapshotId, backend.id).p;
    expect(node(inner, (n) => n.id === `box:${t.worker}`)?.kind).toBe('entity');
  });

  it('keeps user work independent of ghosts; rejecting by PATCH cascades like DELETE', async () => {
    const t = await setup();
    const real = (t.mod('packages/api/src/db.ts').attributes.evidenceIds as string[])[0]!;
    const agent = { authorName: 'test-model', snapshotId: t.snapshotId, citations: [real] };
    const ghost = ok(createDesignElement(t.db, t.projectId, box('Cache'), agent)).element;
    // a person cannot hang a flow (or a box) off a ghost: accept it first
    expect(
      createDesignElement(t.db, t.projectId, {
        body: { kind: 'flow', from: { entityId: t.api }, to: { elementId: ghost.id } },
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('accept it first') });
    const ghostFlow = ok(
      createDesignElement(
        t.db,
        t.projectId,
        { body: { kind: 'flow', from: { entityId: t.api }, to: { elementId: ghost.id } } },
        agent,
      ),
    ).element;
    expect(
      patchDesignElement(t.db, t.projectId, ghost.id, { status: 'rejected', revision: 3 }),
    ).toMatchObject({ ok: false, status: 409 });
    const rejected = ok(
      patchDesignElement(t.db, t.projectId, ghost.id, { status: 'rejected', revision: 0 }),
    ).element;
    expect(rejected.status).toBe('rejected');
    expect(getDesignElement(t.db, t.projectId, ghostFlow.id)!.status).toBe('rejected');
    expect(listDesignElements(t.db, t.projectId)).toEqual([]);
  });
  it('keeps a grouping on the board (shown stale) when its cited manifest changes', async () => {
    const t = await setup();
    ok(
      await groupIntoSubsystem(t.db, {
        snapshotId: t.snapshotId,
        path: 'Backend',
        entityIds: [t.api],
      }),
    );
    const before = t.view(t.snapshotId).cat.canvases.find((c) => c.title === 'Backend')!;
    expect(before).toMatchObject({ state: 'cataloged', provenance: 'accepted' });
    expect(listOverrides(t.db, t.projectId)).toContainEqual(
      expect.objectContaining({ targetId: before.id, action: 'pin' }),
    );
    appendFileSync(join(t.root, 'packages/api/package.json'), '\n');
    const next = await t.scan();
    const after = t.view(next).cat.canvases.find((c) => c.title === 'Backend')!;
    expect(after).toMatchObject({ id: before.id, state: 'stale', provenance: 'accepted' });
    expect(after.relevanceReason).toContain('Pinned');
  });
});
