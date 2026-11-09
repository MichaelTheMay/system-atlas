import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import { planDesign, projectDesign, type Catalog, type PlannerGraph } from '@atlas/planner';
import type { BoardDocument, DesignBoard } from '@atlas/schema';
import {
  boardTreeFromDesign,
  createBoardFromCode,
  documentFromSpec,
  getBoard,
  listBoards,
  loadPlannerGraph,
  registerRoot,
  scanWorktree,
  type BoardTree,
} from '../src/index.ts';
import { Repo } from './design-repo.ts';
import { fixture, freshDb } from './helpers.ts';

/**
 * Request flows derived from code (D04). The expected flows below were written from the fixtures'
 * source (`fixtures/ts-web-service`, `fixtures/monorepo-nested`), not from the planner's output.
 */
async function scanned(name: string) {
  const db = freshDb();
  const { worktree } = await registerRoot(db, fixture(name));
  const r = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
  const graph = loadPlannerGraph(db, r.snapshot.id);
  return { db, graph, projectId: graph.projectId };
}

/** Flows of a canvas as readable lines: "a -> b: text" for a hop, "[a]: text" inside a box. */
function flowsOf(g: PlannerGraph, c: Catalog, ...titles: string[]) {
  let cur = c.canvases.find((x) => x.lens === 'design-system')!;
  for (const t of titles)
    cur = c.canvases.find((x) => x.ownerCanvasId === cur.id && x.title === t)!;
  const p = projectDesign(g, c, cur.id, { flows: true });
  const label = new Map(p.nodes.map((n) => [n.id, n.label]));
  return new Map(
    p.flows!.map((f) => [
      f.name,
      f.steps.map((s) =>
        s.target
          ? `${label.get(s.source)} -> ${label.get(s.target)}: ${s.text}`
          : `[${label.get(s.source)}]: ${s.text}`,
      ),
    ]),
  );
}

describe('flows derived from code (D04)', () => {
  it('tells POST /reports of ts-web-service from the page to the worker', async () => {
    const { graph } = await scanned('ts-web-service');
    const flows = flowsOf(graph, planDesign(graph));
    // NewReport.tsx posts /reports; routes/reports.ts inserts the report (db.ts) and enqueues it
    // (queue.ts); the worker consumes report-jobs and writes the result (generate.ts)
    expect(flows.get('POST /reports')).toEqual([
      'web -> api: web calls POST /reports on api.',
      'api -> db: api writes reports and reads reports in db.',
      'api -> report-jobs: api enqueues on report-jobs.',
      'worker -> report-jobs: worker consumes report-jobs.',
      'worker -> db: worker writes report_sources and reports and reads reports in db.',
    ]);
    // a GET is assumed safe: the same module's insert and enqueue are left out
    expect(flows.get('GET /reports/:id')).toEqual([
      'web -> api: web calls GET /reports/:id on api.',
      'api -> db: api reads reports in db.',
    ]);
    // GET /health reaches nothing: no flow
    expect([...flows.keys()].sort()).toEqual(['GET /reports/:id', 'POST /reports']);
  });

  it('tells the same flow at each level of monorepo-nested, in the boxes of that level', async () => {
    const { graph } = await scanned('monorepo-nested');
    const c = planDesign(graph);
    expect(flowsOf(graph, c).get('POST /orders')).toEqual([
      '[apps]: @shop/storefront calls POST /orders on @shop/api.',
      'apps -> packages: @shop/api uses @shop/orders. @shop/worker uses @shop/orders.',
      'packages -> db: @shop/orders writes order_items and orders and reads orders in db.',
      'packages -> order-jobs: @shop/orders enqueues on order-jobs.',
      'apps -> order-jobs: @shop/worker consumes order-jobs.',
    ]);
    // on a sub-board the hops between two outside boxes are kept, so the flow has no hole:
    // packages -> db and packages -> order-jobs happen outside apps
    expect(flowsOf(graph, c, 'apps').get('POST /orders')).toEqual([
      '@shop/storefront -> @shop/api: @shop/storefront calls POST /orders on @shop/api.',
      '@shop/api -> packages: @shop/api uses @shop/orders.',
      'packages -> db: @shop/orders writes order_items and orders and reads orders in db.',
      'packages -> order-jobs: @shop/orders enqueues on order-jobs.',
      '@shop/worker -> order-jobs: @shop/worker consumes order-jobs.',
      '@shop/worker -> packages: @shop/worker uses @shop/orders.',
    ]);
    expect(flowsOf(graph, c, 'packages', 'commerce').get('POST /orders')).toEqual([
      '[apps]: @shop/storefront calls POST /orders on @shop/api.',
      'apps -> @shop/orders: @shop/api uses @shop/orders. @shop/worker uses @shop/orders.',
      '@shop/orders -> db: @shop/orders writes order_items and orders and reads orders in db.',
      '@shop/orders -> order-jobs: @shop/orders enqueues on order-jobs.',
      'apps -> order-jobs: @shop/worker consumes order-jobs.',
    ]);
    // products.ts only lists and searches: one read, through @shop/catalog
    expect(flowsOf(graph, c).get('GET /products')).toEqual([
      '[apps]: @shop/storefront calls GET /products on @shop/api.',
      'apps -> packages: @shop/api uses @shop/catalog.',
      'packages -> db: @shop/catalog reads products in db.',
    ]);
    // nothing in content/ or platform/ touches a table or a queue
    expect(flowsOf(graph, c, 'packages', 'platform').size).toBe(0);
  });

  it('is off unless asked for, deterministic, and never reads as a fact', async () => {
    const { graph } = await scanned('monorepo-nested');
    const c = planDesign(graph);
    const root = c.canvases.find((x) => x.lens === 'design-system')!.id;
    expect(projectDesign(graph, c, root).flows).toBeUndefined();
    const a = projectDesign(graph, c, root, { flows: true }).flows!;
    expect(JSON.stringify(projectDesign(graph, c, root, { flows: true }).flows)).toBe(
      JSON.stringify(a),
    );
    for (const f of a) {
      expect(f.description).toContain('Derived from code');
      expect(f.description).toContain('may be reachable without being taken');
      expect(f.id).toMatch(/^flow-[a-z0-9-]+$/);
    }
    expect(a.find((f) => f.name === 'GET /products')!.description).toContain(
      'GET is assumed to be safe',
    );
  });

  it('groups routes that reach exactly the same things into one flow', () => {
    // two POST routes exposed by one module, which writes one table
    const r = new Repo();
    const api = r.pkg('api', 'api');
    const web = r.pkg('web', 'web');
    r.database('db', 'docker-compose.yml');
    const users = r.table('users', 'migrations/001.sql');
    const a = r.endpoint('POST /users', 'POST', api);
    const b = r.endpoint('POST /users/invite', 'POST', api);
    r.rel('writes', api, users);
    r.rel('calls', web, a);
    r.rel('calls', web, b);
    const g = r.graph();
    const flows = flowsOf(g, planDesign(g));
    expect([...flows.keys()]).toEqual(['POST /users, POST /users/invite']);
    expect(flows.get('POST /users, POST /users/invite')).toEqual([
      'web -> api: web calls POST /users on api. web calls POST /users/invite on api.',
      'api -> db: api writes users in db.',
    ]);
  });
});

describe('flows on from-code boards (D04)', () => {
  const docOf = (t: BoardTree): BoardDocument => documentFromSpec(t.spec, 'code');
  const child = (t: BoardTree, title: string) =>
    t.children.find((x) => x.tree.spec.title === title)!.tree;

  it('become scenarios bound to the hops of the board', async () => {
    const { graph } = await scanned('monorepo-nested');
    const tree = boardTreeFromDesign(graph)!;
    for (const t of [tree, child(tree, 'apps'), child(child(tree, 'packages'), 'commerce')]) {
      const doc = docOf(t);
      expect(doc.scenarios.map((s) => s.name).sort()).toEqual([
        'GET /orders/:id',
        'GET /products',
        'POST /orders',
      ]);
      for (const s of doc.scenarios) {
        expect(s.origin.author).toBe('code');
        expect(s.steps.length).toBeGreaterThanOrEqual(2);
        for (const st of s.steps)
          expect(
            (st.connectionId && doc.connections[st.connectionId]) ||
              (st.componentId && doc.components[st.componentId]),
          ).toBeTruthy();
      }
    }
    // a repo that does not nest gets its flows too
    const flat = boardTreeFromDesign((await scanned('ts-web-service')).graph)!;
    expect(
      docOf(flat)
        .scenarios.map((s) => s.name)
        .sort(),
    ).toEqual(['GET /reports/:id', 'POST /reports']);
  });

  it('link each level to the same flow one level down', async () => {
    const { db, projectId } = await scanned('monorepo-nested');
    const r = createBoardFromCode(db, projectId, {});
    if (!r.ok) throw new Error(r.error);
    const all = new Map(
      listBoards(db, projectId).map((b) => [b.name, getBoard(db, b.id) as DesignBoard]),
    );
    const drills = (b: DesignBoard, flow: string) =>
      b.document.scenarios
        .find((s) => s.name === flow)!
        .steps.map((st) => {
          const to = st.drillInto && [...all.values()].find((x) => x.id === st.drillInto!.boardId);
          if (to)
            // the target board has that scenario
            expect(to.document.scenarios.some((s) => s.id === st.drillInto!.scenarioId)).toBe(true);
          return to?.name ?? '-';
        });
    // root: the step inside apps opens apps; the hop into packages opens packages; nothing else
    expect(drills(all.get('As built (from code)')!, 'POST /orders')).toEqual([
      'apps — internals',
      'packages — internals',
      '-',
      '-',
      '-',
    ]);
    // packages: the hop into commerce opens commerce
    expect(drills(all.get('packages — internals')!, 'POST /orders')).toEqual([
      '-',
      'commerce — internals',
      '-',
      '-',
      '-',
    ]);
    // the lowest board has nowhere further to go
    expect(drills(all.get('commerce — internals')!, 'POST /orders')).toEqual([
      '-',
      '-',
      '-',
      '-',
      '-',
    ]);
  });
});
