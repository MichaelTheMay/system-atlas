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
});
