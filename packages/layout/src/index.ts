import ElkBundled from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkApi, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';

// elk.bundled.js is CommonJS (`module.exports = ELK`). Its typings declare an ES default
// export, which NodeNext reads as `.default`; normalize both shapes.
type ElkCtor = new () => ElkApi;
const ELK: ElkCtor =
  (ElkBundled as unknown as { default?: ElkCtor }).default ?? (ElkBundled as unknown as ElkCtor);

/**
 * Layout behind an interface (ADR-0002). Input is sorted by id before layout so the same
 * graph always produces the same positions; LAYOUT_VERSION is recorded with results so a
 * change of engine/options is detectable rather than silently reshuffling user canvases.
 */
export const LAYOUT_VERSION = 'elkjs-0.12.0/layered-or-rectpacking/v5';

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
  /** Compound parent within the same canvas (e.g. a boundary group). */
  parentId?: string;
  /**
   * Fixed top-left position (a user pin, or where the node was last laid out). Fixed nodes keep
   * it exactly and carry their children along; other top-level nodes are placed so they do not
   * overlap them, which keeps a known map stable when nodes are added (plan §9).
   */
  fixed?: { x: number; y: number };
  /** Inner padding of a compound node (defaults to a 36px header band and 14px sides). */
  padding?: { top: number; left: number; bottom: number; right: number };
}

export interface LayoutEdgeInput {
  id: string;
  source: string;
  target: string;
  /** Size of the edge's label, so the layered layout reserves room for it between layers. */
  label?: { width: number; height: number };
}

export interface LayoutInput {
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  direction?: 'RIGHT' | 'DOWN';
  /** Spacing overrides (px); the defaults suit the architecture canvases and stay unchanged. */
  spacing?: { betweenLayers?: number; nodeNode?: number; edgeNode?: number };
  /** Also return ELK's orthogonal edge routes (absolute points, source end first); only meaningful
   * without `fixed` nodes, which are moved after routing. */
  routes?: boolean;
}

export interface LayoutResult {
  version: string;
  /** Absolute positions, top-left corner. */
  positions: Record<string, { x: number; y: number; width: number; height: number }>;
  /** Edge routes when `routes` was asked for: absolute bend points from source to target. */
  edges?: Record<string, { x: number; y: number }[]>;
}

export interface LayoutEngine {
  layout(input: LayoutInput): Promise<LayoutResult>;
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * @param injected An ELK API instance. Browsers pass `new ElkApi({ workerUrl })` (elk-api + ELK's own
 * worker script) so layout runs off the UI thread; Node uses the bundled synchronous build.
 */
export function createElkLayoutEngine(injected?: ElkApi): LayoutEngine {
  const elk = injected ?? new ELK();
  return {
    async layout(input) {
      const nodes = [...input.nodes].sort(byId);
      const known = new Set(nodes.map((n) => n.id));
      const edges = [...input.edges]
        .filter((e) => known.has(e.source) && known.has(e.target) && e.source !== e.target)
        .sort(byId);

      const elkNodes = new Map<string, ElkNode>();
      for (const n of nodes)
        elkNodes.set(n.id, { id: n.id, width: n.width, height: n.height, children: [] });
      const root: ElkNode = {
        id: '__root__',
        layoutOptions: {
          // edgeless canvases (module details, coverage) pack into a grid instead of one long column
          'elk.algorithm': edges.length === 0 ? 'rectpacking' : 'layered',
          'elk.direction': input.direction ?? 'RIGHT',
          'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
          'elk.layered.spacing.nodeNodeBetweenLayers': String(input.spacing?.betweenLayers ?? 56),
          'elk.spacing.nodeNode': String(input.spacing?.nodeNode ?? 28),
          ...(input.spacing?.edgeNode
            ? {
                'elk.spacing.edgeNode': String(input.spacing.edgeNode),
                'elk.layered.spacing.edgeNodeBetweenLayers': String(input.spacing.edgeNode),
              }
            : {}),
          // edge sections in root coordinates, whatever compound node the edge ends up in
          ...(input.routes ? { 'elk.json.edgeCoords': 'ROOT' } : {}),
          'elk.padding': '[top=40,left=20,bottom=20,right=20]',
          'elk.randomSeed': '1',
        },
        children: [],
        edges: edges.map((e): ElkExtendedEdge => ({
          id: e.id,
          sources: [e.source],
          targets: [e.target],
          ...(e.label ? { labels: [{ id: `${e.id}__label`, text: ' ', ...e.label }] } : {}),
        })),
      };
      for (const n of nodes) {
        const parent = n.parentId && elkNodes.get(n.parentId);
        (parent ? parent.children! : root.children!).push(elkNodes.get(n.id)!);
      }
      // compound nodes reserve a header band for their label
      for (const n of nodes) {
        const e = elkNodes.get(n.id)!;
        const p = n.padding;
        if (e.children?.length)
          e.layoutOptions = {
            'elk.padding': p
              ? `[top=${p.top},left=${p.left},bottom=${p.bottom},right=${p.right}]`
              : '[top=36,left=14,bottom=14,right=14]',
            // spacing options are per compound node in ELK: repeat the overrides inside groups
            ...(input.spacing?.betweenLayers
              ? {
                  'elk.layered.spacing.nodeNodeBetweenLayers': String(input.spacing.betweenLayers),
                }
              : {}),
            ...(input.spacing?.nodeNode
              ? { 'elk.spacing.nodeNode': String(input.spacing.nodeNode) }
              : {}),
            ...(input.spacing?.edgeNode
              ? {
                  'elk.spacing.edgeNode': String(input.spacing.edgeNode),
                  'elk.layered.spacing.edgeNodeBetweenLayers': String(input.spacing.edgeNode),
                }
              : {}),
          };
      }

      const out = await elk.layout(root);
      const positions: LayoutResult['positions'] = {};
      const walk = (node: ElkNode, ox: number, oy: number) => {
        for (const c of node.children ?? []) {
          const x = ox + (c.x ?? 0);
          const y = oy + (c.y ?? 0);
          positions[c.id] = { x, y, width: c.width ?? 0, height: c.height ?? 0 };
          walk(c, x, y);
        }
      };
      walk(out, 0, 0);
      anchor(nodes, positions);
      if (!input.routes) return { version: LAYOUT_VERSION, positions };
      const routes: NonNullable<LayoutResult['edges']> = {};
      const collect = (node: ElkNode) => {
        for (const e of node.edges ?? []) {
          const s = e.sections?.[0];
          if (s) routes[e.id] = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
        }
        for (const c of node.children ?? []) collect(c);
      };
      collect(out);
      return { version: LAYOUT_VERSION, positions, edges: routes };
    },
  };
}

const GAP = 24;

/** Moves fixed top-level nodes (and their descendants) to their positions, then moves other top-level nodes off them. */
function anchor(nodes: LayoutNodeInput[], positions: LayoutResult['positions']) {
  const children = new Map<string, string[]>();
  for (const n of nodes)
    if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  const shift = (id: string, dx: number, dy: number) => {
    const p = positions[id];
    if (p) {
      p.x += dx;
      p.y += dy;
    }
    for (const c of children.get(id) ?? []) shift(c, dx, dy);
  };
  const top = nodes.filter((n) => !n.parentId && positions[n.id]);
  const placed: { x: number; y: number; width: number; height: number }[] = [];
  for (const n of top) {
    if (!n.fixed) continue;
    const p = positions[n.id]!;
    shift(n.id, n.fixed.x - p.x, n.fixed.y - p.y);
    placed.push(p);
  }
  if (placed.length === 0) return; // nothing fixed: plain deterministic ELK layout
  const free = (x: number, y: number, w: number, h: number) =>
    placed.every(
      (q) =>
        x >= q.x + q.width + GAP ||
        q.x >= x + w + GAP ||
        y >= q.y + q.height + GAP ||
        q.y >= y + h + GAP,
    );
  const fresh = top
    .filter((n) => !n.fixed)
    .map((n) => n.id)
    .sort(
      (a, b) =>
        positions[a]!.y - positions[b]!.y || positions[a]!.x - positions[b]!.x || (a < b ? -1 : 1),
    );
  for (const id of fresh) {
    const p = positions[id]!;
    const spot = nearestFree(p, free);
    shift(id, spot.x - p.x, spot.y - p.y);
    placed.push(p);
  }
}

/** Closest free top-left position to `p` on a GAP-sized grid, searched ring by ring (deterministic). */
function nearestFree(
  p: { x: number; y: number; width: number; height: number },
  free: (x: number, y: number, w: number, h: number) => boolean,
): { x: number; y: number } {
  if (free(p.x, p.y, p.width, p.height)) return p;
  for (let r = 1; r <= 400; r++) {
    const ring: [number, number][] = [];
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
    ring.sort(
      (a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || a[1] - b[1] || a[0] - b[0],
    );
    for (const [dx, dy] of ring) {
      const x = p.x + dx * GAP;
      const y = p.y + dy * GAP;
      if (free(x, y, p.width, p.height)) return { x, y };
    }
  }
  return p;
}
