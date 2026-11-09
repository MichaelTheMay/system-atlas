import { describe, expect, it } from 'vitest';
import { routeAround, type Pt, type Rect } from '../src/boards/route.ts';

const crosses = (p: Pt, q: Pt, r: Rect) =>
  Math.max(p.x, q.x) > r.x &&
  Math.min(p.x, q.x) < r.x + r.width &&
  Math.max(p.y, q.y) > r.y &&
  Math.min(p.y, q.y) < r.y + r.height;

describe('orthogonal arrow routing around boxes', () => {
  it('goes around a box standing between the two ends, orthogonally, side to side', () => {
    const a = { x: 0, y: 0, width: 200, height: 100 };
    const b = { x: 600, y: 0, width: 200, height: 100 };
    const wall = { x: 300, y: -60, width: 200, height: 220 };
    const pts = routeAround(a, b, [wall]);
    expect(pts.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      expect(p.x === q.x || p.y === q.y, `segment ${i} is axis-parallel`).toBe(true);
      expect(crosses(p, q, wall), `segment ${i} crosses the wall`).toBe(false);
    }
    // starts on a's border, ends on b's border
    expect(pts[0]!.x === a.x + a.width || pts[0]!.y === a.y + a.height || pts[0]!.y === a.y).toBe(
      true,
    );
    expect(pts.at(-1)!.x === b.x || pts.at(-1)!.y === b.y || pts.at(-1)!.y === b.y + b.height).toBe(
      true,
    );
  });

  it('takes the straight line when nothing is in the way', () => {
    const pts = routeAround(
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 300, y: 0, width: 100, height: 60 },
      [],
    );
    expect(pts).toEqual([
      { x: 100, y: 30 },
      { x: 300, y: 30 },
    ]);
  });

  it('keeps off an existing arrow when another way is as short', () => {
    const a = { x: 0, y: 0, width: 100, height: 60 };
    const b = { x: 400, y: 300, width: 100, height: 60 };
    const free = routeAround(a, b, []);
    const busy = routeAround(a, b, [], { avoid: [free] });
    expect(busy).not.toEqual(free);
  });
});
