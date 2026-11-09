import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import {
  planDesign,
  projectDesign,
  type Catalog,
  type GraphClaim,
  type PlannerGraph,
  type Projection,
  type ViewOverrideRow,
} from '@atlas/planner';
import { loadCatalog, loadPlannerGraph, registerRoot, scanWorktree } from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

const cache = new Map<string, Promise<{ g: PlannerGraph; arch: Catalog }>>();
function scanned(name: string) {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const db = freshDb();
      const { worktree } = await registerRoot(db, fixture(name));
      const r = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
      return { g: loadPlannerGraph(db, r.snapshot.id), arch: loadCatalog(db, r.snapshot.id) };
    })();
    cache.set(name, p);
  }
  return p;
}

const merged = (a: Catalog, b: Catalog): Catalog => ({
  canvases: [...a.canvases, ...b.canvases],
  links: [...a.links, ...b.links],
});
const root = (c: Catalog) => c.canvases.find((x) => x.lens === 'design-system')!;
const byLabel = (p: Projection) => new Map(p.nodes.map((n) => [n.label, n]));
const flow = (p: Projection, from: string, to: string) => {
  const ids = byLabel(p);
  return p.edges.find((e) => e.source === ids.get(from)?.id && e.target === ids.get(to)?.id);
};
const entityId = (g: PlannerGraph, kind: string, name: string) =>
  g.entities.find((e) => e.kind === kind && e.displayName === name)!.id;

function withInputs(
  g: PlannerGraph,
  claims: GraphClaim[],
  overrides: ViewOverrideRow[] = [],
): PlannerGraph {
  return { ...g, claims, overrides };
}
const claim = (
  id: string,
  subjectId: string,
  value: string,
  extra: Partial<GraphClaim> = {},
): GraphClaim => ({
  id,
  subjectId,
  predicate: 'subsystem',
  value,
  origin: 'model',
  status: 'inferred',
  model: 'test-model',
  ...extra,
});

function assertForest(c: Catalog) {
  const parents = new Map<string, string[]>();
  for (const l of c.links.filter((x) => x.relation === 'child'))
    (parents.get(l.toCanvasId) ?? parents.set(l.toCanvasId, []).get(l.toCanvasId)!).push(
      l.fromCanvasId,
    );
  for (const [, ps] of parents) expect(ps).toHaveLength(1);
  const ids = new Set(c.canvases.map((x) => x.id));
  for (const x of c.canvases) {
    expect(parents.get(x.id)?.[0]).toBe(x.ownerCanvasId);
    const seen = new Set<string>();
    let cur: string | undefined = x.id;
    while (cur) {
      expect(seen.has(cur)).toBe(false);
      seen.add(cur);
      expect(ids.has(cur)).toBe(true);
      cur = parents.get(cur)?.[0];
    }
  }
}

describe('system design lens: baseline', () => {
  it('draws ts-web-service as client, API, worker, queue, store and libraries with flows', async () => {
    const { g, arch } = await scanned('ts-web-service');
    const d = planDesign(g);
    expect(d.canvases).toHaveLength(1);
    const r = root(d);
    expect(r).toMatchObject({
      workspace: 'design',
      title: 'System design',
      provenance: 'detected',
      relevanceScore: 1,
      rootEntityId: g.entities.find((e) => e.kind === 'system')!.id,
    });
    const p = projectDesign(g, merged(arch, d), r.id);
    const n = byLabel(p);
    expect(n.get('web')?.archetype).toBe('client');
    expect(n.get('web')?.archetypeReason).toMatch(/UI route/);
    expect(n.get('api')?.archetype).toBe('api-service');
    expect(n.get('api')?.archetypeReason).toMatch(/Exposes 3 endpoint/);
    expect(n.get('worker')?.archetype).toBe('worker');
    expect(n.get('worker')?.archetypeReason).toMatch(/Consumes report-jobs/);
    expect(n.get('report-jobs')?.archetype).toBe('queue');
    expect(n.get('db')?.archetype).toBe('datastore');
    expect(n.get('db')?.archetypeReason).toMatch(/2 table/);
    expect(n.get('Third-party libraries')?.archetype).toBe('library');
    expect(n.get('@reports/shared')?.archetype).toBe('library');
    // tables are rolled into the database box, not drawn on their own
    expect(n.has('reports')).toBe(false);
    for (const node of p.nodes) {
      expect(node.archetypeReason).toBeTruthy();
      expect(node.entityId).toBeTruthy();
    }

    expect(flow(p, 'web', 'api')?.flow).toBe('HTTP');
    expect(flow(p, 'api', 'report-jobs')?.flow).toBe('enqueue');
    expect(flow(p, 'worker', 'report-jobs')?.flow).toBe('consume');
    expect(flow(p, 'api', 'db')?.flow).toBe('reads/writes');
    expect(flow(p, 'api', '@reports/shared')?.flow).toBe('uses');
    expect(flow(p, 'web', 'api')?.status).toBe('mixed');
    expect(flow(p, 'api', 'report-jobs')?.status).toBe('supported');
    expect(p.edges.every((e) => e.source !== e.target)).toBe(true);
    expect(p.breadcrumbs).toEqual([{ canvasId: r.id, title: 'System design' }]);
  });

  it('treats a Go main that reaches HTTP handlers as an API service, not a worker', async () => {
    const { g, arch } = await scanned('go-service');
    const d = planDesign(g);
    const p = projectDesign(g, merged(arch, d), root(d).id);
    const n = byLabel(p);
    expect(n.get('orders')?.archetype).toBe('api-service');
    expect(n.get('orders')?.archetypeReason).toMatch(/starts an HTTP server/);
    expect(n.get('api')?.archetype).toBe('api-service');
    expect(n.get('store')?.archetype).toBe('library');
    expect(n.get('Database tables')?.archetype).toBe('datastore');
    expect(flow(p, 'store', 'Database tables')?.flow).toBe('reads/writes');
    expect(flow(p, 'store', 'Database tables')?.status).toBe('inferred');
    expect(flow(p, 'orders', 'api')?.flow).toBe('uses');
  });

  it('links every box to an existing architecture canvas of its entity', async () => {
    const { g, arch } = await scanned('ts-web-service');
    const d = planDesign(g);
    const cat = merged(arch, d);
    const p = projectDesign(g, cat, root(d).id);
    const archIds = new Set(arch.canvases.map((c) => c.id));
    for (const node of p.nodes) expect(archIds.has(node.realizedByCanvasId!)).toBe(true);
    const api = byLabel(p).get('api')!;
    const apiCanvas = arch.canvases.find((c) => c.id === api.realizedByCanvasId)!;
    expect(apiCanvas).toMatchObject({ lens: 'component', rootEntityId: api.entityId });
    expect(api.entityId).toBe(entityId(g, 'package', '@reports/api'));
  });

  it('is deterministic and does not mutate its inputs', async () => {
    const { g, arch } = await scanned('ts-web-service');
    const gg = withInputs(g, [claim('clm_a', entityId(g, 'package', '@reports/api'), 'Core')]);
    const before = JSON.stringify(gg);
    const archBefore = JSON.stringify(arch);
    const a = planDesign(gg);
    const b = planDesign(structuredClone(gg));
    expect(a).toEqual(b);
    const cat = merged(arch, a);
    for (const c of a.canvases)
      expect(projectDesign(gg, cat, c.id)).toEqual(projectDesign(structuredClone(gg), cat, c.id));
    expect(JSON.stringify(gg)).toBe(before);
    expect(JSON.stringify(arch)).toBe(archBefore);
  });

  it('every fixture yields a small credible diagram', async () => {
    for (const name of [
      'ts-web-service',
      'py-cli-api',
      'go-service',
      'java-service',
      'research-demo',
      'elixir-unsupported',
    ]) {
      const { g, arch } = await scanned(name);
      const d = planDesign(g);
      assertForest(d);
      const p = projectDesign(g, merged(arch, d), root(d).id);
      expect(p.nodes.length).toBeGreaterThan(0);
      expect(p.nodes.length).toBeLessThanOrEqual(12);
      for (const node of p.nodes) expect(node.entityId).toBeTruthy();
    }
  });

  it('groups a deployable that runs several packages into a detected subsystem', async () => {
    const { g, arch } = await scanned('ts-web-service');
    const container = entityId(g, 'entrypoint', 'api container');
    const shared = entityId(g, 'module', 'index.ts');
    const gg: PlannerGraph = {
      ...g,
      relations: [
        ...g.relations,
        {
          id: 'rel_synthetic_runs_shared',
          kind: 'calls',
          fromId: container,
          toId: shared,
          status: 'supported',
          confidence: 'high',
          evidenceIds: [],
        },
      ],
    };
    const d = planDesign(gg);
    const sub = d.canvases.find((c) => c.lens === 'design-subsystem')!;
    expect(sub).toMatchObject({ title: 'api', provenance: 'detected', ownerCanvasId: root(d).id });
    const p = projectDesign(gg, merged(arch, d), root(d).id);
    const box = p.nodes.find((n) => n.openCanvasId === sub.id)!;
    expect(box).toMatchObject({ label: 'api', provenance: 'detected' });
    expect(byLabel(p).has('@reports/shared')).toBe(false);
  });
});

describe('system design lens: subsystem claims and overrides', () => {
  it('builds one subsystem per normalized name and draws its members as one box', async () => {
    const { g, arch } = await scanned('ts-web-service');
    const gg = withInputs(g, [
      claim('clm_1', entityId(g, 'package', '@reports/api'), 'Ingestion'),
      claim('clm_2', entityId(g, 'package', '@reports/worker'), '  ingestion '),
      claim('clm_3', entityId(g, 'module', 'generate.ts'), 'INGESTION'),
    ]);
    const d = planDesign(gg);
    const subs = d.canvases.filter((c) => c.lens === 'design-subsystem');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      title: 'Ingestion',
      provenance: 'proposed',
      state: 'cataloged',
      ownerCanvasId: root(d).id,
    });
    expect(subs[0]!.relevanceReason).toMatch(/^Proposed by test-model/);
    expect(d.links).toContainEqual(
      expect.objectContaining({
        fromCanvasId: root(d).id,
        toCanvasId: subs[0]!.id,
        relation: 'child',
      }),
    );
    const cat = merged(arch, d);
    const p = projectDesign(gg, cat, root(d).id);
    const n = byLabel(p);
    expect(n.has('api')).toBe(false);
    expect(n.has('worker')).toBe(false);
    const box = n.get('Ingestion')!;
    expect(box).toMatchObject({
      kind: 'cluster',
      openCanvasId: subs[0]!.id,
      provenance: 'proposed',
      memberCount: 2,
    });
    expect(['api-service', 'worker']).toContain(box.archetype);
    expect(flow(p, 'web', 'Ingestion')?.flow).toBe('HTTP');
    expect(flow(p, 'Ingestion', 'db')?.flow).toBe('reads/writes');
    expect(p.children).toEqual([{ canvasId: subs[0]!.id, title: 'Ingestion' }]);

    const inner = projectDesign(gg, cat, subs[0]!.id);
    expect(inner.breadcrumbs.map((b) => b.title)).toEqual(['System design', 'Ingestion']);
    const i = byLabel(inner);
    expect(i.get('api')).toMatchObject({ kind: 'entity', archetype: 'api-service' });
    expect(i.get('worker')).toMatchObject({ kind: 'entity', archetype: 'worker' });
    // outside boxes with flows show as context ports
    expect(i.get('db')?.kind).toBe('port');
    expect(flow(inner, 'api', 'report-jobs')?.flow).toBe('enqueue');
  });

  it('nests "A/B" paths and keeps the navigation tree acyclic', async () => {
    const { g, arch } = await scanned('ts-web-service');
    const gg = withInputs(g, [
      claim('clm_1', entityId(g, 'package', '@reports/api'), 'Backend/API'),
      claim('clm_2', entityId(g, 'database', 'db'), 'Backend/Storage/Primary/Extra'),
      // a unit claimed twice: the lexicographically first normalized path wins
      claim('clm_3', entityId(g, 'package', '@reports/worker'), 'Workers'),
      claim('clm_4', entityId(g, 'package', '@reports/worker'), 'backend/api'),
    ]);
    const d = planDesign(gg);
    assertForest(d);
    const byTitle = new Map(d.canvases.map((c) => [c.title, c]));
    expect([...byTitle.keys()].sort()).toEqual([
      'API',
      'Backend',
      'Primary',
      'Storage',
      'System design',
    ]);
    expect(byTitle.get('API')!.ownerCanvasId).toBe(byTitle.get('Backend')!.id);
    expect(byTitle.get('Primary')!.ownerCanvasId).toBe(byTitle.get('Storage')!.id);
    const cat = merged(arch, d);
    const api = projectDesign(gg, cat, byTitle.get('API')!.id);
    expect(api.breadcrumbs.map((b) => b.title)).toEqual(['System design', 'Backend', 'API']);
    expect(byLabel(api).get('worker')?.kind).toBe('entity');
    const backend = projectDesign(gg, cat, byTitle.get('Backend')!.id);
    expect([...byLabel(backend).keys()]).toEqual(expect.arrayContaining(['API', 'Storage']));
    const top = projectDesign(gg, cat, root(d).id);
    expect(byLabel(top).has('Workers')).toBe(false);
  });

  it('ignores rejected claims, and stale claims unless the canvas is pinned', async () => {
    const { g } = await scanned('ts-web-service');
    const api = entityId(g, 'package', '@reports/api');
    expect(
      planDesign(withInputs(g, [claim('clm_r', api, 'Core', { status: 'rejected' })])).canvases,
    ).toHaveLength(1);
    expect(
      planDesign(withInputs(g, [claim('clm_s', api, 'Core', { status: 'stale' })])).canvases,
    ).toHaveLength(1);
    const coreId = planDesign(withInputs(g, [claim('clm_s', api, 'Core')])).canvases.find(
      (c) => c.title === 'Core',
    )!.id;
    const pinned = planDesign(
      withInputs(
        g,
        [claim('clm_s', api, 'Core', { status: 'stale' })],
        [{ targetId: coreId, action: 'pin' }],
      ),
    ).canvases.find((c) => c.id === coreId)!;
    expect(pinned).toMatchObject({ title: 'Core', provenance: 'proposed', state: 'stale' });
    expect(pinned.relevanceReason).toMatch(/[Pp]inned/);
  });

  it('suppress keeps the canvas but draws its members individually; promote and human accept', async () => {
    const { g, arch } = await scanned('ts-web-service');
    const claims = [
      claim('clm_1', entityId(g, 'package', '@reports/api'), 'Core'),
      claim('clm_2', entityId(g, 'package', '@reports/worker'), 'Core'),
    ];
    const coreId = planDesign(withInputs(g, claims)).canvases.find((c) => c.title === 'Core')!.id;

    const sg = withInputs(g, claims, [{ targetId: coreId, action: 'suppress' }]);
    const sd = planDesign(sg);
    expect(sd.canvases.find((c) => c.id === coreId)!.state).toBe('suppressed');
    const sp = projectDesign(sg, merged(arch, sd), root(sd).id);
    const n = byLabel(sp);
    expect(n.has('Core')).toBe(false);
    expect(n.get('api')?.archetype).toBe('api-service');
    expect(n.get('worker')?.archetype).toBe('worker');

    const promoted = planDesign(withInputs(g, claims, [{ targetId: coreId, action: 'promote' }]));
    const pc = promoted.canvases.find((c) => c.id === coreId)!;
    expect(pc.provenance).toBe('accepted');
    expect(pc.relevanceReason).toMatch(/^Accepted/);

    const human = planDesign(
      withInputs(g, [{ ...claims[0]!, origin: 'human', model: undefined }, claims[1]!]),
    );
    expect(human.canvases.find((c) => c.id === coreId)!.provenance).toBe('accepted');
  });

  it('after a promote, a human claim and the model claim on one subject count once and accept', async () => {
    const { g, arch } = await scanned('ts-web-service');
    const api = entityId(g, 'package', '@reports/api');
    const worker = entityId(g, 'package', '@reports/worker');
    const gg = withInputs(g, [
      claim('clm_1', api, 'ingestion pipeline'),
      claim('clm_2', worker, 'ingestion pipeline'),
      claim('clm_9', api, ' Ingestion  Pipeline ', {
        origin: 'human',
        status: 'supported',
        model: undefined,
      }),
    ]);
    const d = planDesign(gg);
    const subs = d.canvases.filter((c) => c.lens === 'design-subsystem');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ title: 'Ingestion Pipeline', provenance: 'accepted' });
    const p = projectDesign(gg, merged(arch, d), root(d).id);
    const box = byLabel(p).get('Ingestion Pipeline')!;
    expect(box).toMatchObject({ provenance: 'accepted', memberCount: 2 });
    expect(box.entityId).toBeTruthy();
  });
});
