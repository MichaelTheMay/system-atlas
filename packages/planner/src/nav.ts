import type { GraphEntity, GraphRelation, PlannerGraph } from './types.ts';

/**
 * Navigation model over the semantic ownership tree.
 * - The root package (a manifest at the registered root, owned by the system) is merged into the
 *   system for navigation, so the first canvas is not a one-child chain.
 * - External libraries are leaves owned by the system and are always aggregated in projections.
 */
export interface Nav {
  byId: Map<string, GraphEntity>;
  systemId: string;
  rootPackageId?: string;
  parent: Map<string, string | undefined>;
  children: Map<string, string[]>;
  /** entity id -> number of descendants (navigation tree) */
  subtreeSize: Map<string, number>;
  relationsByEntity: Map<string, GraphRelation[]>;
  isExternal(id: string): boolean;
  ancestors(id: string): string[];
  inSubtree(id: string, rootId: string): boolean;
}

export function buildNav(g: PlannerGraph): Nav {
  const byId = new Map(g.entities.map((e) => [e.id, e]));
  const system = g.entities.find((e) => e.kind === 'system');
  if (!system) throw new Error('snapshot has no system entity');
  const rootPkg = g.entities.find(
    (e) =>
      e.kind === 'package' &&
      e.ownerEntityId === system.id &&
      e.attributes.directory === '.' &&
      !e.attributes.external,
  );
  const parent = new Map<string, string | undefined>();
  const children = new Map<string, string[]>();
  for (const e of g.entities) {
    if (e.id === system.id || e.id === rootPkg?.id) continue;
    let p = e.ownerEntityId && byId.has(e.ownerEntityId) ? e.ownerEntityId : system.id;
    if (p === rootPkg?.id) p = system.id;
    parent.set(e.id, p);
    (children.get(p) ?? children.set(p, []).get(p)!).push(e.id);
  }
  for (const list of children.values()) list.sort();
  const subtreeSize = new Map<string, number>();
  const size = (id: string): number => {
    const cached = subtreeSize.get(id);
    if (cached !== undefined) return cached;
    const n = (children.get(id) ?? []).reduce((acc, c) => acc + 1 + size(c), 0);
    subtreeSize.set(id, n);
    return n;
  };
  size(system.id);
  const relationsByEntity = new Map<string, GraphRelation[]>();
  for (const r of g.relations) {
    for (const id of [r.fromId, r.toId])
      (relationsByEntity.get(id) ?? relationsByEntity.set(id, []).get(id)!).push(r);
  }
  const navOf = (id: string) => (id === rootPkg?.id ? system.id : id);
  return {
    byId,
    systemId: system.id,
    rootPackageId: rootPkg?.id,
    parent,
    children,
    subtreeSize,
    relationsByEntity,
    isExternal: (id) => byId.get(id)?.attributes.external === true,
    ancestors(id) {
      const out: string[] = [];
      let cur = parent.get(navOf(id));
      while (cur) {
        out.push(cur);
        cur = parent.get(cur);
      }
      return out;
    },
    inSubtree(id, rootId) {
      let cur: string | undefined = navOf(id);
      while (cur) {
        if (cur === rootId) return true;
        cur = parent.get(cur);
      }
      return false;
    },
  };
}

/** Descendant ids of a container in the navigation tree (excluding the container). */
export function descendants(nav: Nav, id: string): string[] {
  const out: string[] = [];
  const stack = [...(nav.children.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    stack.push(...(nav.children.get(c) ?? []));
  }
  return out;
}

export function pathOf(e: GraphEntity): string | undefined {
  const a = e.attributes;
  if (typeof a.path === 'string') return a.path;
  if (typeof a.directory === 'string' && a.directory !== '.') return a.directory;
  if (typeof a.dockerfile === 'string') return a.dockerfile;
  if (typeof a.declaredIn === 'string') return a.declaredIn;
  return undefined;
}
