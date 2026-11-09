import { describe, expect, it } from 'vitest';
import { createElkLayoutEngine, LAYOUT_VERSION } from '../src/index.ts';

const graph = {
  nodes: [
    { id: 'c', width: 120, height: 40 },
    { id: 'a', width: 120, height: 40 },
    { id: 'b', width: 120, height: 40 },
    { id: 'g', width: 300, height: 200 },
    { id: 'g1', width: 100, height: 40, parentId: 'g' },
  ],
  edges: [
    { id: 'e2', source: 'b', target: 'c' },
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e3', source: 'c', target: 'a' },
    { id: 'dangling', source: 'a', target: 'missing' },
  ],
};

describe('elk layout', () => {
  it('is deterministic regardless of input order and tolerates cycles', async () => {
    const engine = createElkLayoutEngine();
    const r1 = await engine.layout(graph);
    const r2 = await engine.layout({
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });
    expect(r1.version).toBe(LAYOUT_VERSION);
    expect(r1.positions).toEqual(r2.positions);
    expect(Object.keys(r1.positions).sort()).toEqual(['a', 'b', 'c', 'g', 'g1']);
  });
  it('keeps compound children inside their parent and honors fixed positions', async () => {
    const engine = createElkLayoutEngine();
    const r = await engine.layout({
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'a' ? { ...n, fixed: { x: 999, y: 7 } } : n)),
    });
    const g = r.positions.g!;
    const g1 = r.positions.g1!;
    expect(g1.x).toBeGreaterThanOrEqual(g.x);
    expect(g1.y).toBeGreaterThanOrEqual(g.y);
    expect(r.positions.a).toMatchObject({ x: 999, y: 7 });
  });

  it('keeps a known map stable: fixed nodes stay put and new nodes take free space', async () => {
    const engine = createElkLayoutEngine();
    const before = await engine.layout(graph);
    // remember every top-level position, then add a node connected into the middle of the graph
    const fixed = Object.fromEntries(
      ['a', 'b', 'c', 'g'].map((id) => [
        id,
        { x: before.positions[id]!.x, y: before.positions[id]!.y },
      ]),
    );
    const after = await engine.layout({
      nodes: [
        ...graph.nodes.map((n) => (fixed[n.id] ? { ...n, fixed: fixed[n.id] } : n)),
        { id: 'new', width: 120, height: 40 },
      ],
      edges: [
        ...graph.edges,
        { id: 'e4', source: 'b', target: 'new' },
        { id: 'e5', source: 'new', target: 'g1' },
      ],
    });
    for (const id of ['a', 'b', 'c', 'g']) expect(after.positions[id]).toMatchObject(fixed[id]!);
    // a fixed group carries its children: same offset inside the group as before
    expect(after.positions.g1!.x - after.positions.g!.x).toBe(
      before.positions.g1!.x - before.positions.g!.x,
    );
    const n = after.positions.new!;
    for (const id of ['a', 'b', 'c', 'g']) {
      const q = after.positions[id]!;
      const overlaps =
        n.x < q.x + q.width && q.x < n.x + n.width && n.y < q.y + q.height && q.y < n.y + n.height;
      expect(overlaps, `new overlaps ${id}`).toBe(false);
    }
    // deterministic
    const again = await engine.layout({
      nodes: [
        { id: 'new', width: 120, height: 40 },
        ...graph.nodes.map((x) => (fixed[x.id] ? { ...x, fixed: fixed[x.id] } : x)).reverse(),
      ],
      edges: [
        ...graph.edges,
        { id: 'e4', source: 'b', target: 'new' },
        { id: 'e5', source: 'new', target: 'g1' },
      ],
    });
    expect(again.positions).toEqual(after.positions);
  });

  it('returns edge routes in absolute coordinates that start and end on the node borders', async () => {
    const engine = createElkLayoutEngine();
    const r = await engine.layout({
      nodes: [
        { id: 'a', width: 100, height: 60 },
        { id: 'zone', width: 10, height: 10 },
        { id: 'b', width: 100, height: 60, parentId: 'zone' },
        { id: 'c', width: 100, height: 60, parentId: 'zone' },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', label: { width: 120, height: 20 } },
        // both ends share a compound parent: ELK nests the edge there
        { id: 'e2', source: 'b', target: 'c' },
      ],
      spacing: { betweenLayers: 140 },
      routes: true,
    });
    const onBorder = (p: { x: number; y: number }, id: string) => {
      const n = r.positions[id]!;
      const within = (v: number, lo: number, hi: number) => v >= lo - 1 && v <= hi + 1;
      return (
        within(p.x, n.x, n.x + n.width) &&
        within(p.y, n.y, n.y + n.height) &&
        (Math.abs(p.x - n.x) < 1.5 ||
          Math.abs(p.x - n.x - n.width) < 1.5 ||
          Math.abs(p.y - n.y) < 1.5 ||
          Math.abs(p.y - n.y - n.height) < 1.5)
      );
    };
    for (const [id, s, t] of [
      ['e1', 'a', 'b'],
      ['e2', 'b', 'c'],
    ] as const) {
      const pts = r.edges?.[id];
      expect(pts && pts.length >= 2, id).toBe(true);
      expect(onBorder(pts![0]!, s), `${id} start`).toBe(true);
      expect(onBorder(pts!.at(-1)!, t), `${id} end`).toBe(true);
    }
    // layer spacing is honoured; the default stays for callers that do not ask
    expect(r.positions.zone!.x - (r.positions.a!.x + 100)).toBeGreaterThanOrEqual(139);
    expect(
      (await engine.layout({ nodes: [{ id: 'x', width: 1, height: 1 }], edges: [] })).edges,
    ).toBe(undefined);
  });
});
