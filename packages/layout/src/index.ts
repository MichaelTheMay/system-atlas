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
export const LAYOUT_VERSION = 'elkjs-0.12.0/layered/v3';

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
  /** Compound parent within the same canvas (e.g. a boundary group). */
  parentId?: string;
  /** Fixed position from a user overlay; the engine treats it as a hint for pinned nodes. */
  fixed?: { x: number; y: number };
}

export interface LayoutEdgeInput {
  id: string;
  source: string;
  target: string;
}

export interface LayoutInput {
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  direction?: 'RIGHT' | 'DOWN';
}

export interface LayoutResult {
  version: string;
  /** Absolute positions, top-left corner. */
  positions: Record<string, { x: number; y: number; width: number; height: number }>;
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
          'elk.algorithm': 'layered',
          'elk.direction': input.direction ?? 'RIGHT',
          'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
          'elk.layered.spacing.nodeNodeBetweenLayers': '56',
          'elk.spacing.nodeNode': '28',
          'elk.padding': '[top=40,left=20,bottom=20,right=20]',
          'elk.randomSeed': '1',
        },
        children: [],
        edges: edges.map((e): ElkExtendedEdge => ({
          id: e.id,
          sources: [e.source],
          targets: [e.target],
        })),
      };
      for (const n of nodes) {
        const parent = n.parentId && elkNodes.get(n.parentId);
        (parent ? parent.children! : root.children!).push(elkNodes.get(n.id)!);
      }
      // compound nodes reserve a header band for their label
      for (const n of elkNodes.values()) {
        if (n.children?.length)
          n.layoutOptions = { 'elk.padding': '[top=36,left=14,bottom=14,right=14]' };
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
      for (const n of nodes)
        if (n.fixed && positions[n.id]) Object.assign(positions[n.id]!, n.fixed);
      return { version: LAYOUT_VERSION, positions };
    },
  };
}
