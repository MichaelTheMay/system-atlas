/**
 * Orthogonal arrow routing around boxes (D03 wave 1a), for arrows ELK did not route: connections
 * between frames (each frame is laid out on its own) and connections drawn later from the
 * inspector. A* over the sparse grid of lines running along the boxes' (inflated) edges, with a
 * penalty per bend, so arrows go around boxes rather than through them. Pure: unit-tested in node.
 */
export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BEND = 120;

/** Drops repeated and collinear interior points (so re-anchoring a label never accumulates points). */
export function simplifyRoute(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of points) {
    const prev = out.at(-1);
    if (prev && Math.abs(prev.x - p.x) < 0.01 && Math.abs(prev.y - p.y) < 0.01) continue;
    const before = out.at(-2);
    if (before && prev) {
      const cross = (prev.x - before.x) * (p.y - prev.y) - (prev.y - before.y) * (p.x - prev.x);
      if (Math.abs(cross) < 0.01) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** Does the axis-parallel segment p→q pass through the inside of r? */
function hits(p: Pt, q: Pt, r: Rect): boolean {
  const x0 = Math.min(p.x, q.x);
  const x1 = Math.max(p.x, q.x);
  const y0 = Math.min(p.y, q.y);
  const y1 = Math.max(p.y, q.y);
  return x1 > r.x && x0 < r.x + r.width && y1 > r.y && y0 < r.y + r.height;
}

/**
 * Route from box `a` to box `b`: leaves `a` from the middle of one side and enters `b` in the
 * middle of one side; no segment crosses an obstacle (inflated by `margin`). Falls back to a plain
 * elbow when no route exists.
 */
export function routeAround(
  a: Rect,
  b: Rect,
  obstacles: readonly Rect[],
  opts: { margin?: number; avoid?: readonly (readonly Pt[])[] } = {},
): Pt[] {
  const margin = opts.margin ?? 18;
  // other arrows: running along one costs extra, crossing one a little
  const others: [Pt, Pt][] = [];
  for (const r of opts.avoid ?? [])
    for (let i = 0; i + 1 < r.length; i++) others.push([r[i]!, r[i + 1]!]);
  const penalty = (p: Pt, q: Pt) => {
    let cost = 0;
    const vertical = p.x === q.x;
    const lo = vertical ? Math.min(p.y, q.y) : Math.min(p.x, q.x);
    const hi = vertical ? Math.max(p.y, q.y) : Math.max(p.x, q.x);
    for (const [u, v] of others) {
      const ov = Math.abs(u.x - v.x) < 0.5;
      const oh = Math.abs(u.y - v.y) < 0.5;
      if (vertical && ov && Math.abs(u.x - p.x) < 6) {
        const o = Math.min(hi, Math.max(u.y, v.y)) - Math.max(lo, Math.min(u.y, v.y));
        if (o > 0) cost += o * 3;
      } else if (!vertical && oh && Math.abs(u.y - p.y) < 6) {
        const o = Math.min(hi, Math.max(u.x, v.x)) - Math.max(lo, Math.min(u.x, v.x));
        if (o > 0) cost += o * 3;
      } else if (vertical && oh) {
        if (u.y > lo && u.y < hi && p.x > Math.min(u.x, v.x) && p.x < Math.max(u.x, v.x))
          cost += 40;
      } else if (!vertical && ov) {
        if (u.x > lo && u.x < hi && p.y > Math.min(u.y, v.y) && p.y < Math.max(u.y, v.y))
          cost += 40;
      }
    }
    return cost;
  };
  const inflate = (r: Rect, m: number): Rect => ({
    x: r.x - m,
    y: r.y - m,
    width: r.width + 2 * m,
    height: r.height + 2 * m,
  });
  const blocks = obstacles.map((r) => inflate(r, margin - 1));
  // the endpoints themselves block too (an arrow must not run back across its own boxes)
  const ends = [inflate(a, margin - 1), inflate(b, margin - 1)];
  const cx = (r: Rect) => r.x + r.width / 2;
  const cy = (r: Rect) => r.y + r.height / 2;
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const r of [a, b, ...obstacles]) {
    xs.add(r.x - margin);
    xs.add(r.x + r.width + margin);
    ys.add(r.y - margin);
    ys.add(r.y + r.height + margin);
  }
  for (const r of [a, b]) {
    xs.add(cx(r));
    ys.add(cy(r));
  }
  // midlines between neighbouring coordinates give routes room to stay off box edges
  const mids = (s: Set<number>) => {
    const v = [...s].sort((p, q) => p - q);
    for (let i = 0; i + 1 < v.length; i++)
      if (v[i + 1]! - v[i]! > 2 * margin) s.add((v[i]! + v[i + 1]!) / 2);
    return [...s].sort((p, q) => p - q);
  };
  const X = mids(xs);
  const Y = mids(ys);
  const free = (p: Pt) =>
    [...blocks, ...ends].every(
      (r) => !(p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height),
    );
  const clear = (p: Pt, q: Pt) => blocks.every((r) => !hits(p, q, r));
  const clearAll = (p: Pt, q: Pt) => clear(p, q) && ends.every((r) => !hits(p, q, r));

  // exits: one step out of each side of a; entries: one step out of each side of b
  const sides = (r: Rect) => [
    { on: { x: r.x + r.width, y: cy(r) }, out: { x: r.x + r.width + margin, y: cy(r) } },
    { on: { x: r.x, y: cy(r) }, out: { x: r.x - margin, y: cy(r) } },
    { on: { x: cx(r), y: r.y + r.height }, out: { x: cx(r), y: r.y + r.height + margin } },
    { on: { x: cx(r), y: r.y }, out: { x: cx(r), y: r.y - margin } },
  ];
  const key = (i: number, j: number) => i * Y.length + j;
  const xi = new Map(X.map((v, i) => [v, i]));
  const yj = new Map(Y.map((v, j) => [v, j]));
  const goals = new Map<number, Pt>();
  for (const s of sides(b)) {
    const i = xi.get(s.out.x);
    const j = yj.get(s.out.y);
    if (i !== undefined && j !== undefined && free(s.out) && clear(s.out, s.on))
      goals.set(key(i, j), s.on);
  }
  // A* over (grid point, direction); direction 0..3 = +x, -x, +y, -y
  type Node = { i: number; j: number; d: number; g: number; f: number; prev?: Node };
  const target = { x: cx(b), y: cy(b) };
  const h = (p: Pt) => Math.abs(p.x - target.x) + Math.abs(p.y - target.y);
  const open: Node[] = [];
  const best = new Map<number, number>();
  for (const s of sides(a)) {
    const i = xi.get(s.out.x);
    const j = yj.get(s.out.y);
    if (i === undefined || j === undefined || !free(s.out) || !clear(s.on, s.out)) continue;
    const d = s.out.x > s.on.x ? 0 : s.out.x < s.on.x ? 1 : s.out.y > s.on.y ? 2 : 3;
    const g = margin;
    open.push({ i, j, d, g, f: g + h(s.out), prev: { i: -1, j: -1, d, g: 0, f: 0 } });
    (open.at(-1)!.prev as Node & { at?: Pt }).at = s.on;
  }
  const steps: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let found: Node | undefined;
  let guard = 0;
  while (open.length && guard++ < 200_000) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k]!.f < open[bi]!.f) bi = k;
    const n = open.splice(bi, 1)[0]!;
    const sk = key(n.i, n.j) * 4 + n.d;
    if ((best.get(sk) ?? Infinity) < n.g) continue;
    if (goals.has(key(n.i, n.j))) {
      found = n;
      break;
    }
    const p = { x: X[n.i]!, y: Y[n.j]! };
    for (let d = 0; d < 4; d++) {
      const ni = n.i + steps[d]![0];
      const nj = n.j + steps[d]![1];
      if (ni < 0 || nj < 0 || ni >= X.length || nj >= Y.length) continue;
      const q = { x: X[ni]!, y: Y[nj]! };
      if (!free(q) || !clearAll(p, q)) continue;
      const g =
        n.g + Math.abs(q.x - p.x) + Math.abs(q.y - p.y) + (d === n.d ? 0 : BEND) + penalty(p, q);
      const k2 = key(ni, nj) * 4 + d;
      if (g >= (best.get(k2) ?? Infinity)) continue;
      best.set(k2, g);
      open.push({ i: ni, j: nj, d, g, f: g + h(q), prev: n });
    }
  }
  if (!found) {
    // no clean route: a plain elbow between the facing sides
    const right = cx(b) >= cx(a);
    const sx = right ? a.x + a.width : a.x;
    const ex = right ? b.x : b.x + b.width;
    const mx = (sx + ex) / 2;
    return [
      { x: sx, y: cy(a) },
      { x: mx, y: cy(a) },
      { x: mx, y: cy(b) },
      { x: ex, y: cy(b) },
    ];
  }
  const pts: Pt[] = [goals.get(key(found.i, found.j))!];
  for (let n: Node | undefined = found; n; n = n.prev) {
    if (n.i < 0) {
      pts.push((n as Node & { at?: Pt }).at!);
      break;
    }
    pts.push({ x: X[n.i]!, y: Y[n.j]! });
  }
  return simplifyRoute(pts.reverse());
}
