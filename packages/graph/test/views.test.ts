import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import {
  planViews,
  projectView,
  MAX_VISIBLE,
  type Catalog,
  type PlannerGraph,
} from '@atlas/planner';
import type { Db } from '@atlas/store';
import {
  loadCatalog,
  loadPlannerGraph,
  registerRoot,
  scanWorktree,
  stableId,
} from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

async function scanned(name: string, copy = false) {
  let root = fixture(name);
  if (copy) {
    root = join(mkdtempSync(join(tmpdir(), 'atlas-views-')), name);
    cpSync(fixture(name), root, { recursive: true });
  }
  const db = freshDb();
  const { project, worktree } = await registerRoot(db, root);
  const scan = async () => {
    const r = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
    return {
      r,
      catalog: loadCatalog(db, r.snapshot.id),
      graph: loadPlannerGraph(db, r.snapshot.id),
    };
  };
  return { db, project, root, scan, ...(await scan()) };
}

const rootLenses = (c: Catalog) =>
  c.canvases
    .filter((x) => !x.ownerCanvasId)
    .map((x) => x.lens)
    .sort();
const strip = (v: unknown) =>
  JSON.parse(JSON.stringify(v).replaceAll(/snap_[0-9a-f]{32}/g, 'SNAP'));

function assertForest(c: Catalog) {
  const parents = new Map<string, string[]>();
  for (const l of c.links.filter((x) => x.relation === 'child'))
    (parents.get(l.toCanvasId) ?? parents.set(l.toCanvasId, []).get(l.toCanvasId)!).push(
      l.fromCanvasId,
    );
  for (const [, ps] of parents) expect(ps).toHaveLength(1);
  const ids = new Set(c.canvases.map((x) => x.id));
  for (const x of c.canvases) {
    // ownerCanvasId agrees with the child link, and walking up terminates at a root
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

describe('view catalog', () => {
  it('generates different, evidence-gated lenses for the TS and Python fixtures', async () => {
    const ts = await scanned('ts-web-service');
    const py = await scanned('py-cli-api');
    expect(rootLenses(ts.catalog)).toEqual([
      'api',
      'component',
      'coverage',
      'data',
      'deployables',
      'system-context',
      'ui-navigation',
      'workflow',
    ]);
    expect(rootLenses(py.catalog)).toEqual([
      'api',
      'component',
      'coverage',
      'data',
      'system-context',
    ]);
    const tsChildren = ts.catalog.canvases
      .filter((x) => x.ownerCanvasId)
      .map((x) => `${x.lens}:${x.title}`)
      .sort();
    expect(tsChildren).toEqual(
      expect.arrayContaining([
        'component:@reports/api',
        'component:@reports/web',
        'component:@reports/worker',
      ]),
    );
    for (const c of [...ts.catalog.canvases, ...py.catalog.canvases]) {
      expect(c.relevanceReason.length).toBeGreaterThan(10);
      expect(c.relevanceScore).toBeGreaterThanOrEqual(0);
    }
    assertForest(ts.catalog);
    assertForest(py.catalog);
  });

  it('opens with a meaningful system context, not a single box', async () => {
    const ts = await scanned('ts-web-service');
    const ctx = ts.catalog.canvases.find((c) => c.lens === 'system-context')!;
    const p = projectView(ts.graph, ts.catalog, ctx.id);
    const labels = p.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(
      expect.arrayContaining([
        'ts-web-service',
        'db',
        'queue',
        'report-jobs',
        'Third-party libraries',
      ]),
    );
    expect(p.edges.length).toBeGreaterThan(0);
    const structure = projectView(
      ts.graph,
      ts.catalog,
      ts.catalog.canvases.find((c) => c.lens === 'component' && !c.ownerCanvasId)!.id,
    );
    // root package merged into the system: its children are the first level
    expect(structure.nodes.map((n) => n.label)).toEqual(
      expect.arrayContaining([
        '@reports/api',
        '@reports/worker',
        '@reports/web',
        '@reports/shared',
      ]),
    );
    expect(structure.nodes.find((n) => n.label === 'report-service')).toBeUndefined();
    expect(structure.nodes.find((n) => n.label === '@reports/api')?.openCanvasId).toBeTruthy();
  });

  it('shows boundary ports for relations leaving a component, aggregated for third-party code', async () => {
    const ts = await scanned('ts-web-service');
    const api = ts.catalog.canvases.find(
      (c) => c.lens === 'component' && c.title === '@reports/api',
    )!;
    const p = projectView(ts.graph, ts.catalog, api.id);
    expect(
      p.nodes
        .filter((n) => n.kind === 'entity')
        .map((n) => n.label)
        .sort(),
    ).toEqual(['db.ts', 'queue.ts', 'reports.ts', 'server.ts']);
    const ports = p.nodes
      .filter((n) => n.kind === 'port')
      .map((n) => n.label)
      .sort();
    expect(ports).toEqual(
      expect.arrayContaining([
        '@reports/shared',
        'Third-party libraries',
        'reports',
        'report-jobs',
      ]),
    );
    expect(p.breadcrumbs.map((b) => b.title)).toEqual(['Project structure', '@reports/api']);
  });

  it('every supported projected edge resolves to relations with evidence', async () => {
    for (const name of ['ts-web-service', 'py-cli-api']) {
      const s = await scanned(name);
      for (const c of s.catalog.canvases) {
        const p = projectView(s.graph, s.catalog, c.id);
        for (const e of p.edges) {
          for (const rid of e.relationIds) {
            const rel = s.graph.relations.find((r) => r.id === rid)!;
            expect(rel).toBeTruthy();
            if (e.status === 'supported') expect(rel.evidenceIds.length).toBeGreaterThan(0);
            for (const ev of rel.evidenceIds)
              expect(
                s.db.prepare('SELECT 1 AS ok FROM evidence WHERE id = ?').get(ev),
              ).toBeTruthy();
          }
        }
      }
    }
  });
});

describe('view stability', () => {
  const allProjections = (g: PlannerGraph, c: Catalog) =>
    c.canvases.map((x) => projectView(g, c, x.id));

  it('identical rescans cause no catalog or projection churn', async () => {
    const s = await scanned('ts-web-service');
    const second = await s.scan();
    const third = await s.scan();
    expect(strip(third.catalog)).toEqual(strip(second.catalog));
    expect(strip(allProjections(third.graph, third.catalog))).toEqual(
      strip(allProjections(second.graph, second.catalog)),
    );
    // relative to the first scan, only the changes canvas is new (it exists once a previous snapshot does)
    const ids = (c: Catalog) => c.canvases.map((x) => x.lens + ':' + x.title);
    expect(ids(second.catalog).filter((x) => !ids(s.catalog).includes(x))).toEqual([
      'changes:Changes since previous snapshot',
    ]);
  });

  it('keeps the catalog stable across "edit, rescan, rescan"', async () => {
    const s = await scanned('ts-web-service', true);
    await s.scan();
    const f = join(s.root, 'packages/api/src/db.ts');
    writeFileSync(f, readFileSync(f, 'utf8') + '\n// touch\n');
    const afterEdit = await s.scan();
    const again = await s.scan();
    expect(afterEdit.catalog.canvases.map((c) => c.id)).toEqual(
      again.catalog.canvases.map((c) => c.id),
    );
    const changes = (x: typeof again) =>
      projectView(x.graph, x.catalog, x.catalog.canvases.find((c) => c.lens === 'changes')!.id);
    expect(changes(afterEdit).nodes.some((n) => n.change === 'changed')).toBe(true);
    expect(changes(again).nodes).toEqual([]);
  });
});

describe('clustering', () => {
  function bigGraph(n: number): PlannerGraph {
    const projectId = `proj_${'b'.repeat(32)}`;
    const sys = stableId('entity', projectId, 'system');
    const pkg = stableId('entity', projectId, 'pkg:app');
    const entities = [
      {
        id: sys,
        kind: 'system',
        canonicalName: 'system:x',
        displayName: 'x',
        lifecycle: 'active',
        attributes: {},
      },
      {
        id: pkg,
        kind: 'package',
        canonicalName: 'npm:app',
        displayName: 'app',
        ownerEntityId: sys,
        lifecycle: 'active',
        attributes: { directory: 'app' },
      },
    ];
    const relations = [];
    for (let i = 0; i < n; i++) {
      const dir = ['routes', 'models', 'services', 'util'][i % 4];
      const id = stableId('entity', projectId, `m${i}`);
      entities.push({
        id,
        kind: 'module',
        canonicalName: `ts:app/src/${dir}/m${i}.ts`,
        displayName: `m${i}.ts`,
        ownerEntityId: pkg,
        lifecycle: 'active',
        attributes: { path: `app/src/${dir}/m${i}.ts` },
      } as never);
      if (i > 0)
        relations.push({
          id: stableId('relation', projectId, `r${i}`),
          kind: 'imports',
          fromId: id,
          toId: stableId('entity', projectId, `m${i - 1}`),
          status: 'supported',
          confidence: 'resolved',
          evidenceIds: ['evd_1'],
        });
    }
    return {
      projectId,
      snapshotId: `snap_${'a'.repeat(32)}`,
      hasPrevious: false,
      entities,
      relations,
      gaps: [],
      changes: [],
    };
  }

  it('clusters large containers by directory and drills in with a distinct view id', () => {
    const g = bigGraph(120);
    const catalog = planViews(g);
    const app = catalog.canvases.find((c) => c.title === 'app')!;
    const top = projectView(g, catalog, app.id);
    expect(top.nodes.length).toBeLessThanOrEqual(MAX_VISIBLE);
    // all 120 modules share app/src: that level adds nothing, so clustering descends past it
    expect(
      top.nodes
        .filter((n) => n.kind === 'cluster')
        .map((n) => n.label)
        .sort(),
    ).toEqual(['models/', 'routes/', 'services/', 'util/']);
    const routes = top.nodes.find((n) => n.label === 'routes/')!;
    expect(routes.focus).toBe('src/routes');
    const leaf = projectView(g, catalog, app.id, routes.focus);
    expect(leaf.viewId).not.toBe(app.id);
    expect(leaf.nodes.filter((n) => n.kind === 'entity')).toHaveLength(30);
    expect(leaf.breadcrumbs.at(-1)).toMatchObject({ title: 'routes', focus: 'src/routes' });
    // determinism
    expect(projectView(g, catalog, app.id, routes.focus)).toEqual(leaf);
  });
});

describe('boundary ports', () => {
  it('folds ports beyond the cap into one node and keeps edges', () => {
    const projectId = `proj_${'c'.repeat(32)}`;
    const id = (k: string) => stableId('entity', projectId, k);
    const entities = [
      {
        id: id('system'),
        kind: 'system',
        canonicalName: 's',
        displayName: 's',
        lifecycle: 'active',
        attributes: {},
      },
    ];
    const relations = [];
    entities.push({
      id: id('pkg:hub'),
      kind: 'package',
      canonicalName: 'hub',
      displayName: 'hub',
      ownerEntityId: id('system'),
      lifecycle: 'active',
      attributes: { directory: 'hub' },
    } as never);
    for (const m of ['a', 'b'])
      entities.push({
        id: id(`hub/${m}`),
        kind: 'module',
        canonicalName: m,
        displayName: `${m}.ts`,
        ownerEntityId: id('pkg:hub'),
        lifecycle: 'active',
        attributes: { path: `hub/${m}.ts` },
      } as never);
    for (let i = 0; i < 30; i++) {
      entities.push({
        id: id(`pkg:p${i}`),
        kind: 'package',
        canonicalName: `p${i}`,
        displayName: `p${i}`,
        ownerEntityId: id('system'),
        lifecycle: 'active',
        attributes: { directory: `p${i}` },
      } as never);
      for (let j = 0; j <= i % 3; j++)
        relations.push({
          id: stableId('relation', projectId, `r${i}-${j}`),
          kind: 'depends-on',
          fromId: id('hub/a'),
          toId: id(`pkg:p${i}`),
          status: 'supported',
          confidence: 'exact',
          evidenceIds: ['evd_1'],
        });
    }
    const g: PlannerGraph = {
      projectId,
      snapshotId: `snap_${'d'.repeat(32)}`,
      hasPrevious: false,
      entities,
      relations,
      gaps: [],
      changes: [],
    };
    const catalog = planViews(g);
    const p = projectView(g, catalog, catalog.canvases.find((c) => c.title === 'hub')!.id);
    const ports = p.nodes.filter((n) => n.kind === 'port');
    expect(ports).toHaveLength(12);
    expect(ports.find((n) => n.id === 'port:others')?.memberCount).toBe(19);
    const total = p.edges.reduce(
      (n, e) => n + Object.values(e.kinds).reduce((a, b) => a + b, 0),
      0,
    );
    expect(total).toBe(relations.length);
  });
});

export type { Db };
