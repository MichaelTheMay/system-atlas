import { describe, expect, it } from 'vitest';
import {
  LAYOUT_SPLIT_ABOVE,
  planDesign,
  projectDesign,
  type Catalog,
  type GraphClaim,
  type PlannerGraph,
  type Projection,
} from '@atlas/planner';
import { Repo } from './design-repo.ts';

/**
 * Detected subsystems from the repository layout (D04), on hand-built graphs so each rule is
 * checked on its own. Scanned fixtures are all below the threshold and are covered by
 * `design.test.ts`, which must keep passing unchanged.
 */
const rootOf = (c: Catalog) => c.canvases.find((x) => x.lens === 'design-system')!;
const canvas = (c: Catalog, ...titles: string[]) => {
  let cur = rootOf(c);
  for (const t of titles) {
    const next = c.canvases.find((x) => x.ownerCanvasId === cur.id && x.title === t);
    if (!next) throw new Error(`no canvas "${t}" under "${cur.title}"`);
    cur = next;
  }
  return cur;
};
const view = (g: PlannerGraph, c: Catalog, ...titles: string[]) =>
  projectDesign(g, c, canvas(c, ...titles).id);
const labels = (p: Projection, kind?: 'port') =>
  p.nodes
    .filter((n) => (kind ? n.kind === 'port' : n.kind !== 'port'))
    .map((n) => n.label)
    .sort();

/** apps/ (2), packages/ (9), two fixtures, two root config files, a scripts folder, a queue. */
function monorepo() {
  const r = new Repo();
  const cli = r.pkg('cli', 'apps/cli');
  const server = r.pkg('server', 'apps/server');
  const libs = Array.from({ length: 9 }, (_, i) => r.pkg(`lib-${i}`, `packages/lib-${i}`));
  const shopApi = r.pkg('shop-api', 'fixtures/shop/api');
  const shopWeb = r.pkg('shop-web', 'fixtures/shop/web');
  const blog = r.pkg('blog', 'fixtures/blog');
  const orders = r.queue('orders');
  r.file('vitest.config.ts');
  r.file('eslint.config.js');
  r.file('scripts/release.ts');
  r.rel('imports', cli, libs[0]!);
  r.rel('imports', server, libs[1]!);
  r.rel('imports', libs[0]!, libs[1]!);
  r.rel('imports', shopWeb, shopApi);
  r.rel('publishes', shopApi, orders);
  r.rel('subscribes', shopWeb, orders);
  return { r, cli, server, libs, shopApi, shopWeb, blog, orders };
}

describe('system design lens: detected layout subsystems (D04)', () => {
  it('leaves a whiteboard at or below the threshold exactly flat', () => {
    const r = new Repo();
    for (let i = 0; i < LAYOUT_SPLIT_ABOVE; i++) r.pkg(`lib-${i}`, `packages/lib-${i}`);
    const g = r.graph();
    const c = planDesign(g);
    expect(c.canvases).toHaveLength(1);
    expect(projectDesign(g, c, rootOf(c).id).nodes).toHaveLength(LAYOUT_SPLIT_ABOVE);
  });

  it('groups a crowded root by fixtures, tooling and top-level folders', () => {
    const { r } = monorepo();
    const g = r.graph();
    const c = planDesign(g);
    const root = projectDesign(g, c, rootOf(c).id);
    expect(labels(root)).toEqual([
      'Build & test tooling',
      'Fixtures & examples',
      'apps',
      'packages',
    ]);
    for (const n of root.nodes) {
      expect(n.provenance).toBe('detected');
      expect(n.openCanvasId).toBeTruthy();
    }
    expect(canvas(c, 'packages')).toMatchObject({
      lens: 'design-subsystem',
      provenance: 'detected',
      relevanceReason: expect.stringContaining('9 box(es) under packages/'),
    });
    expect(labels(view(g, c, 'apps'))).toEqual(['cli', 'server']);
    expect(labels(view(g, c, 'Build & test tooling'))).toEqual([
      'eslint.config',
      'scripts',
      'vitest.config',
    ]);
    expect(canvas(c, 'Fixtures & examples').relevanceReason).toContain(
      'not part of the running system',
    );
  });

  it('places a queue with the only boxes that use it', () => {
    const { r } = monorepo();
    const g = r.graph();
    const c = planDesign(g);
    // `orders` has no folder of its own; both users are under fixtures/shop
    expect(labels(view(g, c, 'Fixtures & examples'))).toEqual([
      'blog',
      'orders',
      'shop-api',
      'shop-web',
    ]);
    expect(labels(projectDesign(g, c, rootOf(c).id))).not.toContain('orders');
  });

  it('draws another subsystem as one port, not one port per box', () => {
    const { r } = monorepo();
    const g = r.graph();
    const c = planDesign(g);
    const apps = view(g, c, 'apps');
    expect(labels(apps, 'port')).toEqual(['packages']);
    const port = apps.nodes.find((n) => n.kind === 'port')!;
    expect(port.openCanvasId).toBe(canvas(c, 'packages').id);
    expect(port.memberCount).toBe(9);
    // both app flows into packages/ meet at that one port
    expect(apps.edges.filter((e) => e.target === port.id)).toHaveLength(2);
  });

  it('splits a group that is still crowded by the next folder level', () => {
    const r = new Repo();
    r.pkg('cli', 'apps/cli');
    for (const area of ['auth', 'billing', 'search'])
      for (let i = 0; i < 5; i++) r.pkg(`${area}-${i}`, `packages/${area}/${area}-${i}`);
    const g = r.graph();
    const c = planDesign(g);
    expect(labels(projectDesign(g, c, rootOf(c).id))).toEqual(['cli', 'packages']);
    expect(labels(view(g, c, 'packages'))).toEqual(['auth', 'billing', 'search']);
    expect(labels(view(g, c, 'packages', 'billing'))).toEqual(
      [0, 1, 2, 3, 4].map((i) => `billing-${i}`),
    );
    expect(canvas(c, 'packages', 'billing').relevanceReason).toContain('under packages/billing/');
  });

  it('groups a flat folder of many siblings into name families', () => {
    const r = new Repo();
    r.pkg('cli', 'apps/cli');
    for (let i = 0; i < 8; i++) r.pkg(`client-ui-${i}`, `packages/client-ui-w${i}`);
    for (let i = 0; i < 5; i++) r.pkg(`client-store-${i}`, `packages/client-store-s${i}`);
    r.pkg('client-web', 'packages/client-web');
    const g = r.graph();
    const c = planDesign(g);
    expect(labels(view(g, c, 'packages'))).toEqual(['client-store', 'client-ui', 'client-web']);
    expect(labels(view(g, c, 'packages', 'client-ui'))).toHaveLength(8);
    expect(canvas(c, 'packages', 'client-ui').relevanceReason).toContain('named client-ui-…');
  });

  it('keeps detected subsystems when a person groups some boxes (no claims cliff)', () => {
    const { r, libs } = monorepo();
    const pkgOf = (moduleId: string) => r.entities.find((e) => e.id === moduleId)!.ownerEntityId!;
    const human = (id: string, subjectId: string): GraphClaim => ({
      id,
      subjectId,
      predicate: 'subsystem',
      value: 'Core',
      origin: 'human',
      status: 'supported',
    });
    const g = r.graph([human('clm_a', pkgOf(libs[0]!)), human('clm_b', pkgOf(libs[1]!))]);
    const c = planDesign(g);
    const root = projectDesign(g, c, rootOf(c).id);
    expect(labels(root)).toEqual([
      'Build & test tooling',
      'Core',
      'Fixtures & examples',
      'apps',
      'packages',
    ]);
    expect(canvas(c, 'Core').provenance).toBe('accepted');
    expect(canvas(c, 'packages').provenance).toBe('detected');
    expect(labels(view(g, c, 'Core'))).toEqual(['lib-0', 'lib-1']);
    // the two grouped boxes left packages/; the other seven stayed
    expect(labels(view(g, c, 'packages'))).toHaveLength(7);
  });

  it('is deterministic and keeps the navigation tree a forest', () => {
    const { r } = monorepo();
    const g = r.graph();
    const before = JSON.stringify(g);
    const c = planDesign(g);
    expect(JSON.stringify(planDesign(g))).toBe(JSON.stringify(c));
    expect(JSON.stringify(g)).toBe(before);
    const ids = new Set(c.canvases.map((x) => x.id));
    expect(ids.size).toBe(c.canvases.length);
    for (const x of c.canvases) if (x.ownerCanvasId) expect(ids.has(x.ownerCanvasId)).toBe(true);
    const children = c.links.filter((l) => l.relation === 'child');
    expect(new Set(children.map((l) => l.toCanvasId)).size).toBe(children.length);
    for (const x of c.canvases)
      expect(JSON.stringify(projectDesign(g, c, x.id))).toBe(
        JSON.stringify(projectDesign(g, c, x.id)),
      );
  });
});

describe('system design lens: tables join the database of their own project (D04)', () => {
  it('gives a database only the tables declared in its project', () => {
    const r = new Repo();
    r.pkg('store', 'packages/store');
    r.pkg('shop', 'fixtures/shop');
    r.database('db', 'fixtures/shop/docker-compose.yml');
    r.table('orders', 'fixtures/shop/db/001_init.sql');
    r.table('snapshots', 'packages/store/migrations/0001_init.sql');
    r.table('runs', 'packages/store/migrations/0001_init.sql');
    const g = r.graph();
    const c = planDesign(g);
    const by = new Map(projectDesign(g, c, rootOf(c).id).nodes.map((n) => [n.label, n]));
    expect(by.get('db')!.archetypeReason).toContain('holding 1 table(s)');
    expect(by.get('store tables')).toMatchObject({
      archetype: 'datastore',
      sublabel: '2 table(s)',
    });
  });

  it('still gives one root database every table of a single project', () => {
    const r = new Repo();
    r.pkg('api', 'packages/api');
    r.database('db', 'docker-compose.yml');
    r.table('users', 'packages/api/migrations/001.sql');
    r.table('audit', 'db/schema.sql');
    const g = r.graph();
    const c = planDesign(g);
    const p = projectDesign(g, c, rootOf(c).id);
    expect(p.nodes.find((n) => n.label === 'db')!.archetypeReason).toContain('holding 2 table(s)');
    expect(p.nodes.filter((n) => n.archetype === 'datastore')).toHaveLength(1);
  });

  it('keeps a compose file in deploy/ with migrations elsewhere in the same project', () => {
    const r = new Repo();
    r.database('db', 'deploy/docker-compose.yml');
    r.table('users', 'db/migrations/001.sql');
    const g = r.graph();
    const c = planDesign(g);
    const p = projectDesign(g, c, rootOf(c).id);
    expect(p.nodes.find((n) => n.label === 'db')!.archetypeReason).toContain('holding 1 table(s)');
  });
});
