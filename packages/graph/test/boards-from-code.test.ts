import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import type { DesignBoard } from '@atlas/schema';
import {
  boardTreeFromDesign,
  createBoardFromCode,
  deleteBoard,
  getBoard,
  listBoards,
  loadPlannerGraph,
  persistBoardTree,
  registerRoot,
  scanWorktree,
  type BoardTree,
} from '../src/index.ts';
import { Repo } from './design-repo.ts';
import { fixture, freshDb } from './helpers.ts';

/**
 * Recursive "from code" import (D04): one board per design subsystem, linked from the subsystem
 * box of its parent. `monorepo-nested` is the scanned fixture that nests; the hand-built graphs
 * cover the cases it does not reach (a fourth level, an oversized canvas).
 */
async function scanned(name: string) {
  const db = freshDb();
  const { worktree } = await registerRoot(db, fixture(name));
  const r = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
  const graph = loadPlannerGraph(db, r.snapshot.id);
  return { db, graph, projectId: graph.projectId };
}

const child = (t: BoardTree, title: string) => {
  const c = t.children.find((x) => x.tree.spec.title === title);
  if (!c) throw new Error(`no sub-board "${title}" under "${t.spec.title}"`);
  return c;
};
const labels = (t: BoardTree) => t.spec.components.map((c) => c.label).sort();
const isStub = (label: string) => label.startsWith('outside: ');
const count = (t: BoardTree): number => 1 + t.children.reduce((n, c) => n + count(c.tree), 0);

describe('from-code board tree (D04)', () => {
  it('builds one board per design subsystem of monorepo-nested', async () => {
    const { graph } = await scanned('monorepo-nested');
    const tree = boardTreeFromDesign(graph)!;
    expect(count(tree)).toBe(8);
    expect(labels(tree)).toEqual([
      'Build & test tooling',
      'Fixtures & examples',
      'Third-party libraries',
      'apps',
      'db',
      'order-jobs',
      'packages',
      'queue',
    ]);
    expect(tree.children.map((c) => c.tree.spec.title).sort()).toEqual([
      'Build & test tooling',
      'Fixtures & examples',
      'apps',
      'packages',
    ]);
    // the linked component is the subsystem box of that name, drawn as a plain box
    for (const c of tree.children) {
      const box = tree.spec.components.find((x) => x.id === c.componentId)!;
      expect(box).toMatchObject({ label: c.tree.spec.title, type: 'box' });
    }
    const packages = child(tree, 'packages').tree;
    expect(packages.children.map((c) => c.tree.spec.title).sort()).toEqual([
      'commerce',
      'content',
      'platform',
    ]);
    const commerce = child(packages, 'commerce').tree;
    expect(labels(commerce).filter((l) => !isStub(l))).toEqual([
      '@shop/cart',
      '@shop/catalog',
      '@shop/orders',
      '@shop/payments',
      '@shop/pricing',
    ]);
    expect(commerce.children).toHaveLength(0);
    expect(commerce.spec.summary).toContain('Internals of "commerce"');
  });

  it('keeps flows that leave a sub-board as faded outside stubs in their own frame', async () => {
    const { graph } = await scanned('monorepo-nested');
    const apps = child(boardTreeFromDesign(graph)!, 'apps').tree;
    const stubs = apps.spec.components.filter((c) => isStub(c.label));
    // db exchanges nothing with apps itself: it is drawn because POST /orders runs through it
    expect(stubs.map((c) => c.label).sort()).toEqual([
      'outside: Third-party libraries',
      'outside: db',
      'outside: order-jobs',
      'outside: packages',
    ]);
    for (const s of stubs) {
      expect(s).toMatchObject({ type: 'box', origin: { author: 'code' }, entityIds: [] });
      expect(s.internalsBoardId).toBeUndefined();
    }
    const outside = apps.spec.frames.find((f) => f.label === 'Outside this board')!;
    expect([...outside.componentIds].sort()).toEqual(stubs.map((s) => s.id).sort());
    // the worker consumes order-jobs: that flow crosses the board edge and is kept
    const worker = apps.spec.components.find((c) => c.label === '@shop/worker')!;
    const queue = stubs.find((s) => s.label === 'outside: order-jobs')!;
    expect(
      apps.spec.connections.some(
        (k) => [k.from, k.to].includes(worker.id) && [k.from, k.to].includes(queue.id),
      ),
    ).toBe(true);
    // every component sits in exactly one frame
    const framed = apps.spec.frames.flatMap((f) => f.componentIds);
    expect(framed.sort()).toEqual(apps.spec.components.map((c) => c.id).sort());
  });

  it('leaves a repo that does not nest as one board, as before', async () => {
    const { graph } = await scanned('ts-web-service');
    const tree = boardTreeFromDesign(graph)!;
    expect(tree.children).toHaveLength(0);
    expect(tree.spec.frames).toHaveLength(1);
    expect(tree.spec.components.some((c) => isStub(c.label))).toBe(false);
  });

  it('draws subsystems below the lowest board in place, one frame each', () => {
    // packages/ > area > family > 14 boxes: four lens levels, but boards nest only three
    const r = new Repo();
    r.pkg('cli', 'apps/cli');
    for (const area of ['auth', 'billing'])
      for (const fam of ['core', 'web'])
        for (let i = 0; i < 7; i++)
          r.pkg(`${area}-${fam}-${i}`, `packages/${area}/${fam}/${area}-${fam}-${i}`);
    const tree = boardTreeFromDesign(r.graph())!;
    const auth = child(child(tree, 'packages').tree, 'auth').tree;
    // `auth` is the lowest board: its two families are frames on it, not boards
    expect(auth.children).toHaveLength(0);
    expect(auth.spec.frames.map((f) => f.label)).toEqual(['core', 'web']);
    for (const f of auth.spec.frames) expect(f.componentIds).toHaveLength(7);
    expect(labels(auth).filter((l) => !isStub(l))).toHaveLength(14);
    expect(labels(auth)).not.toContain('core');
  });
});

describe('from-code board tree: storing it (D04)', () => {
  const tree = (b: DesignBoard, all: Map<string, DesignBoard>): unknown => ({
    name: b.name,
    children: Object.values(b.document.components)
      .filter((c) => c.internalsBoardId)
      .map((c) => tree(all.get(c.internalsBoardId!)!, all)),
  });

  it('creates the linked tree and removes it with its root', async () => {
    const { db, projectId } = await scanned('monorepo-nested');
    const r = createBoardFromCode(db, projectId, { name: 'Shop as built' });
    if (!r.ok) throw new Error(r.error);
    expect(r.boards).toBe(8);
    const rows = listBoards(db, projectId);
    expect(rows).toHaveLength(8);
    expect(rows.filter((b) => !b.parentBoardId).map((b) => b.name)).toEqual(['Shop as built']);
    const all = new Map(rows.map((b) => [b.id, getBoard(db, b.id)!]));
    for (const b of all.values()) {
      expect(b.source).toBe('code');
      for (const c of Object.values(b.document.components)) {
        if (!c.internalsBoardId) continue;
        // a link points at a board whose parent is this one
        expect(all.get(c.internalsBoardId)?.parentBoardId).toBe(b.id);
      }
    }
    const packages = [...all.values()].find((b) => b.name === 'packages — internals')!;
    expect(packages.parentBoardId).toBe(r.board.id);
    expect([...all.values()].find((b) => b.name === 'commerce — internals')!.parentBoardId).toBe(
      packages.id,
    );
    expect(JSON.stringify(tree(r.board, all))).toContain('platform — internals');
    const del = deleteBoard(db, r.board.id);
    expect(del.ok && del.deleted).toHaveLength(8);
    expect(listBoards(db, projectId)).toHaveLength(0);
  });

  it('stores nothing when any board of the tree is refused', async () => {
    const { db, graph, projectId } = await scanned('monorepo-nested');
    const good = boardTreeFromDesign(graph)!;
    // hang a fourth level under commerce: createBoard refuses it
    const packages = child(good, 'packages').tree;
    const commerce = child(packages, 'commerce').tree;
    const tooDeep: BoardTree = {
      ...commerce,
      children: [
        { componentId: commerce.spec.components[0]!.id, tree: { ...commerce, children: [] } },
      ],
    };
    const bad: BoardTree = {
      ...good,
      children: good.children.map((c) =>
        c.tree !== packages
          ? c
          : {
              ...c,
              tree: {
                ...packages,
                children: packages.children.map((k) =>
                  k.tree === commerce ? { ...k, tree: tooDeep } : k,
                ),
              },
            },
      ),
    };
    const r = persistBoardTree(db, projectId, bad, 'Refused');
    expect(r).toMatchObject({ ok: false, status: 400, error: 'boards nest at most three levels' });
    expect(listBoards(db, projectId)).toHaveLength(0);
    // and the same database still accepts the valid tree
    expect(persistBoardTree(db, projectId, good, 'Accepted')).toMatchObject({
      ok: true,
      boards: 8,
    });
  });

  it('keeps the heaviest flows when a canvas has more than a board can hold', () => {
    // 40 packages that all import each other: 1,560 flows on one canvas
    const r = new Repo();
    const mods = Array.from({ length: 40 }, (_, i) => r.pkg(`p${i}`, `p${i}`));
    for (const a of mods) for (const b of mods) if (a !== b) r.rel('imports', a, b);
    // one pair is heavier than the rest
    for (let i = 0; i < 5; i++) r.rel('imports', mods[38]!, mods[39]!);
    const tree = boardTreeFromDesign(r.graph())!;
    expect(tree.spec.connections).toHaveLength(600);
    expect(tree.spec.summary).toContain('960 lighter flow(s) of 1560 were left out');
    const id = (label: string) => tree.spec.components.find((c) => c.label === label)!.id;
    expect(tree.spec.connections.some((k) => k.from === id('p38') && k.to === id('p39'))).toBe(
      true,
    );
  });
});
