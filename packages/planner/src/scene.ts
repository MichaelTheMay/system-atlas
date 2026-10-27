import type { CanvasSpec } from '@atlas/schema';
import { shortHash } from './ids.ts';
import type { Nav } from './nav.ts';
import type { Catalog, PlannerGraph, Projection, ProjectionEdge, ProjectionNode } from './types.ts';

/** Boundary ports shown individually; the rest are folded into one node. */
export const MAX_PORTS = 12;

export interface Ctx {
  g: PlannerGraph;
  nav: Nav;
  catalog: Catalog;
  canvasByOwner: Map<string, string>;
  spec: CanvasSpec;
}

/** Visible-node assignment: entity id -> node id, plus node definitions. */
export class Scene {
  nodes = new Map<string, ProjectionNode>();
  owner = new Map<string, string>();
  hidden = 0;
  add(n: ProjectionNode, members: Iterable<string> = []) {
    if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
    for (const m of members) if (!this.owner.has(m)) this.owner.set(m, n.id);
  }
}

/** Breadcrumbs (child-link chain plus focus steps), siblings and children of a canvas in a catalog. */
export function catalogNav(
  catalog: Catalog,
  spec: CanvasSpec,
  focus?: string,
): Pick<Projection, 'breadcrumbs' | 'siblings' | 'children'> {
  const links = catalog.links;
  const parentOf = new Map(
    links.filter((l) => l.relation === 'child').map((l) => [l.toCanvasId, l.fromCanvasId]),
  );
  const crumbs: Projection['breadcrumbs'] = [];
  let cur: string | undefined = spec.id;
  const titleOf = new Map(catalog.canvases.map((c) => [c.id, c.title]));
  while (cur) {
    crumbs.unshift({ canvasId: cur, title: titleOf.get(cur) ?? cur });
    cur = parentOf.get(cur);
  }
  if (focus) {
    const parts = focus.split('/');
    for (let i = 0; i < parts.length; i++)
      crumbs.push({
        canvasId: spec.id,
        title: parts[i]!.replace(/^kind:/, ''),
        focus: parts.slice(0, i + 1).join('/'),
      });
  }
  return {
    breadcrumbs: crumbs,
    siblings: links
      .filter((l) => l.relation === 'sibling' && l.fromCanvasId === spec.id)
      .map((l) => ({
        canvasId: l.toCanvasId,
        lens: catalog.canvases.find((c) => c.id === l.toCanvasId)!.lens,
        title: titleOf.get(l.toCanvasId)!,
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    children: links
      .filter((l) => l.relation === 'child' && l.fromCanvasId === spec.id)
      .map((l) => ({
        canvasId: l.toCanvasId,
        title: titleOf.get(l.toCanvasId)!,
        viaEntityId: l.viaEntityId,
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  };
}

export function buildEdges(
  ctx: Ctx,
  scene: Scene,
  rootId: string,
  withPorts: boolean,
): ProjectionEdge[] {
  const { nav, g } = ctx;
  const agg = new Map<string, ProjectionEdge & { statuses: Set<string> }>();
  const portFor = (outside: string): string => {
    if (nav.isExternal(outside)) {
      scene.add({
        id: 'port:external',
        kind: 'port',
        label: 'Third-party libraries',
        sublabel: 'outside this view',
      });
      return 'port:external';
    }
    // anchor: the ancestor of `outside` directly below its lowest common ancestor with the root
    const rootChain = new Set([rootId, ...nav.ancestors(rootId)]);
    const chain = [outside, ...nav.ancestors(outside)];
    let anchor = outside;
    for (let i = 0; i < chain.length; i++) {
      if (rootChain.has(chain[i]!)) {
        anchor = i > 0 ? chain[i - 1]! : outside;
        break;
      }
    }
    const a = nav.byId.get(anchor)!;
    const id = `port:${anchor}`;
    const open =
      ctx.canvasByOwner.get(anchor) ??
      (nav.parent.get(anchor) ? ctx.canvasByOwner.get(nav.parent.get(anchor)!) : undefined);
    scene.add({
      id,
      kind: 'port',
      label: a.displayName,
      sublabel: `${a.kind} · outside this view`,
      entityId: anchor,
      entityKind: a.kind,
      openCanvasId: open,
    });
    return id;
  };
  const selfIds = new Set([
    rootId,
    ...(rootId === nav.systemId && nav.rootPackageId ? [nav.rootPackageId] : []),
  ]);
  for (const r of g.relations) {
    if (r.kind === 'contains') continue;
    // the view's own root (and the root package merged into the system) is the frame, not a neighbor
    if (withPorts && (selfIds.has(r.fromId) || selfIds.has(r.toId))) continue;
    let s = scene.owner.get(r.fromId);
    let t = scene.owner.get(r.toId);
    if (!s && !t) continue;
    if (withPorts) {
      if (!s && nav.inSubtree(r.toId, rootId)) s = portFor(r.fromId);
      if (!t && nav.inSubtree(r.fromId, rootId)) t = portFor(r.toId);
    }
    if (!s || !t || s === t) continue;
    const key = `${s}|${t}`;
    const e = agg.get(key) ?? {
      id: `e:${shortHash(key)}`,
      source: s,
      target: t,
      kinds: {},
      relationIds: [],
      status: 'supported',
      statuses: new Set<string>(),
    };
    e.kinds[r.kind] = (e.kinds[r.kind] ?? 0) + 1;
    if (e.relationIds.length < 50) e.relationIds.push(r.id);
    e.statuses.add(
      r.status === 'supported' ? 'supported' : r.status === 'stale' ? 'stale' : 'inferred',
    );
    agg.set(key, e);
  }
  // Bound ports (plan §8 complexity limits): keep the most-connected targets, fold the rest.
  const portWeight = new Map<string, number>();
  for (const e of agg.values()) {
    const n = Object.values(e.kinds).reduce((a, b) => a + b, 0);
    for (const end of [e.source, e.target])
      if (end.startsWith('port:')) portWeight.set(end, (portWeight.get(end) ?? 0) + n);
  }
  if (portWeight.size > MAX_PORTS) {
    const ranked = [...portWeight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const folded = new Set(ranked.slice(MAX_PORTS - 1).map(([id]) => id));
    scene.add({
      id: 'port:others',
      kind: 'port',
      label: `${folded.size} other targets`,
      sublabel: 'outside this view',
      memberCount: folded.size,
    });
    for (const id of folded) scene.nodes.delete(id);
    const merged = new Map<string, ProjectionEdge & { statuses: Set<string> }>();
    for (const e of agg.values()) {
      const s = folded.has(e.source) ? 'port:others' : e.source;
      const t = folded.has(e.target) ? 'port:others' : e.target;
      const key = `${s}|${t}`;
      const m = merged.get(key) ?? {
        id: `e:${shortHash(key)}`,
        source: s,
        target: t,
        kinds: {},
        relationIds: [],
        status: 'supported',
        statuses: new Set<string>(),
      };
      for (const [k, n] of Object.entries(e.kinds)) m.kinds[k] = (m.kinds[k] ?? 0) + n;
      for (const r of e.relationIds) if (m.relationIds.length < 50) m.relationIds.push(r);
      for (const st of e.statuses) m.statuses.add(st);
      merged.set(key, m);
    }
    agg.clear();
    for (const [k, v] of merged) agg.set(k, v);
  }
  return [...agg.values()]
    .map(({ statuses, ...e }) => ({
      ...e,
      relationIds: e.relationIds.sort(),
      status: (statuses.size === 1 ? [...statuses][0] : 'mixed') as ProjectionEdge['status'],
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
