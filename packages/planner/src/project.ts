import { projectDesign } from './design.ts';
import { canvasId } from './ids.ts';
import { buildEdges, catalogNav, Scene, type Ctx } from './scene.ts';
import { buildNav, descendants, pathOf } from './nav.ts';
import type { Catalog, GraphEntity, PlannerGraph, Projection, ProjectionNode } from './types.ts';

/** Default detail target (plan §8): above this, children are clustered. */
export const MAX_VISIBLE = 40;
/** Container members shown individually before clustering (plan §8 target 10-30); ports add up to MAX_PORTS. */
export const MEMBER_TARGET = 30;
/** Hard cap on detailed nodes per projection (plan §16). */
export const HARD_NODE_CAP = 200;
export { MAX_PORTS } from './scene.ts';

export function projectView(
  g: PlannerGraph,
  catalog: Catalog,
  canvasIdArg: string,
  focus?: string,
): Projection {
  const spec = catalog.canvases.find((c) => c.id === canvasIdArg);
  if (!spec) throw new Error(`unknown canvas ${canvasIdArg}`);
  if (spec.workspace === 'design') return projectDesign(g, catalog, canvasIdArg);
  const nav = buildNav(g);
  const canvasByOwner = new Map<string, string>();
  for (const c of catalog.canvases)
    if ((c.lens === 'component' || c.lens === 'module-detail') && c.rootEntityId)
      canvasByOwner.set(c.rootEntityId, c.id);
  const ctx: Ctx = { g, nav, catalog, canvasByOwner, spec };
  const scene = new Scene();
  const root = spec.rootEntityId ?? nav.systemId;
  const scopedToPackage = root !== nav.systemId;

  switch (spec.lens) {
    case 'component':
    case 'module-detail':
      containerScene(ctx, scene, root, focus);
      break;
    case 'system-context':
      contextScene(ctx, scene, focus);
      break;
    case 'coverage':
      coverageScene(ctx, scene);
      break;
    case 'changes':
      changesScene(ctx, scene);
      break;
    case 'deployables':
      kindScene(ctx, scene, ['deployable', 'database', 'infrastructure-resource'], {
        childKinds: ['entrypoint'],
      });
      break;
    case 'api':
      kindScene(ctx, scene, ['endpoint'], {
        scope: scopedToPackage ? root : undefined,
        consumers: ['calls'],
        groupByPackage: true,
      });
      break;
    case 'data':
      kindScene(ctx, scene, ['table', 'database'], {
        scope: scopedToPackage ? root : undefined,
        consumers: ['reads', 'writes'],
        rollUpConsumers: !scopedToPackage,
        includeTargets: true,
      });
      break;
    case 'workflow':
      kindScene(ctx, scene, ['queue', 'topic', 'job', 'workflow'], {
        consumers: ['publishes', 'subscribes'],
        groupByPackage: true,
      });
      break;
    case 'ui-navigation':
      kindScene(ctx, scene, ['ui-surface'], {
        consumers: ['exposes'],
        groupByPackage: true,
        followCalls: true,
      });
      break;
    default:
      break;
  }

  const edges =
    spec.lens === 'coverage' || spec.lens === 'changes'
      ? []
      : buildEdges(ctx, scene, root, spec.lens === 'component' || spec.lens === 'module-detail');
  let nodes = [...scene.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  let truncated = false;
  if (nodes.length > HARD_NODE_CAP) {
    truncated = true;
    const keep = new Set(nodes.slice(0, HARD_NODE_CAP).map((n) => n.id));
    nodes = nodes.filter((n) => keep.has(n.id));
  }
  const keepIds = new Set(nodes.map((n) => n.id));
  const keptEdges = edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));
  const { breadcrumbs: crumbs, siblings, children } = catalogNav(catalog, spec, focus);
  return {
    viewId: focus ? canvasId(g.projectId, spec.id, 'focus', focus) : spec.id,
    canvasId: spec.id,
    snapshotId: g.snapshotId,
    lens: spec.lens,
    title: focus ? `${spec.title} / ${focus}` : spec.title,
    focus,
    relevanceReason: spec.relevanceReason,
    nodes,
    edges: keptEdges,
    truncated,
    breadcrumbs: crumbs,
    siblings,
    children,
    stats: {
      entities: nodes.filter((n) => n.kind === 'entity').length,
      relations: keptEdges.reduce(
        (n, e) => n + Object.values(e.kinds).reduce((a, b) => a + b, 0),
        0,
      ),
      hiddenNodes: scene.hidden,
    },
  };
}

// ---------------------------------------------------------------------------------------------

function entityNode(ctx: Ctx, e: GraphEntity, parentId?: string): ProjectionNode {
  const sub =
    e.kind === 'module'
      ? dirLabel(pathOf(e))
      : e.kind === 'package' && e.attributes.external
        ? 'third-party'
        : e.kind;
  return {
    id: `n:${e.id}`,
    kind: 'entity',
    label: e.displayName,
    sublabel: sub,
    entityId: e.id,
    entityKind: e.kind,
    lifecycle: e.lifecycle,
    openCanvasId:
      ctx.canvasByOwner.get(e.id) ??
      (e.id === ctx.nav.systemId ? ctx.canvasByOwner.get(e.id) : undefined),
    parentId,
    counts: childCounts(ctx, e.id),
  };
}

function dirLabel(p?: string): string | undefined {
  if (!p || !p.includes('/')) return undefined;
  return p.slice(0, p.lastIndexOf('/'));
}

function childCounts(ctx: Ctx, id: string): Record<string, number> | undefined {
  const kids = ctx.nav.children.get(id);
  if (!kids?.length) return undefined;
  const out: Record<string, number> = {};
  for (const k of kids) {
    const kind = ctx.nav.byId.get(k)!.kind;
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

function baseDir(ctx: Ctx, id: string): string {
  if (id === ctx.nav.systemId) return '';
  const e = ctx.nav.byId.get(id)!;
  const p = pathOf(e);
  if (!p) return '';
  return e.kind === 'module' ? p : p;
}

/** Group key of an entity at a container level, relative to `prefix` (container dir + focus path). */
function groupKey(e: GraphEntity, prefix: string): string | undefined {
  const p = pathOf(e);
  if (!p) return `kind:${e.kind}`;
  const rel = prefix ? (p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : undefined) : p;
  if (rel === undefined) return `kind:${e.kind}`;
  return rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : undefined;
}

function containerScene(ctx: Ctx, scene: Scene, rootId: string, focus?: string) {
  const { nav } = ctx;
  const kids = nav.children.get(rootId) ?? [];
  const externals = kids.filter((k) => nav.isExternal(k));
  const internal = kids.filter((k) => !nav.isExternal(k));
  const dir = baseDir(ctx, rootId);

  if (focus === 'external' || focus?.startsWith('external/')) {
    const scope = focus === 'external' ? undefined : focus.slice('external/'.length);
    const members = externals.filter((k) => !scope || scopeOf(nav.byId.get(k)!) === scope);
    if (members.length > MAX_VISIBLE && !scope) {
      const byScope = new Map<string, string[]>();
      for (const m of members) {
        const s = scopeOf(nav.byId.get(m)!);
        (byScope.get(s) ?? byScope.set(s, []).get(s)!).push(m);
      }
      for (const [s, ms] of [...byScope].sort()) {
        if (ms.length === 1) scene.add(entityNode(ctx, nav.byId.get(ms[0]!)!), ms);
        else
          scene.add(
            {
              id: `cluster:external/${s}`,
              kind: 'cluster',
              label: s,
              sublabel: 'third-party libraries',
              memberCount: ms.length,
              focus: `external/${s}`,
            },
            ms,
          );
      }
    } else {
      for (const m of members) scene.add(entityNode(ctx, nav.byId.get(m)!), [m]);
    }
    return;
  }

  // focus narrows to a directory path or kind group, possibly nested (a/b/kind:x not used)
  const focusPrefix = focus
    ? focus.startsWith('kind:')
      ? undefined
      : dir
        ? `${dir}/${focus}`
        : focus
    : dir;
  const members = internal.filter((k) => {
    if (!focus) return true;
    const e = nav.byId.get(k)!;
    if (focus.startsWith('kind:')) return !pathOf(e) && `kind:${e.kind}` === focus;
    const p = pathOf(e);
    return !!p && p.startsWith(`${focusPrefix}/`);
  });

  if (members.length <= MEMBER_TARGET) {
    for (const m of members)
      scene.add(entityNode(ctx, nav.byId.get(m)!), [m, ...descendants(nav, m)]);
  } else {
    let groups: Map<string, string[]>;
    let singles: string[];
    let prefix = focusPrefix ?? '';
    // focus path relative to the container, extended when descending through single directories
    let focusPath = focus && !focus.startsWith('kind:') ? focus : '';
    for (;;) {
      groups = new Map();
      singles = [];
      for (const m of members) {
        const key = groupKey(nav.byId.get(m)!, prefix);
        if (key === undefined) singles.push(m);
        else (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
      }
      const only = groups.size === 1 && singles.length === 0 ? [...groups.keys()][0]! : undefined;
      // a level where everything sits in one directory adds no information: descend (plan §8)
      if (!only || only.startsWith('kind:')) break;
      prefix = prefix ? `${prefix}/${only}` : only;
      focusPath = focusPath ? `${focusPath}/${only}` : only;
    }
    // direct files at this level: group by kind when there are too many
    if (singles.length > MEMBER_TARGET / 2) {
      for (const s of singles) {
        const key = `kind:${nav.byId.get(s)!.kind}s-here`;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
      }
      singles.length = 0;
    }
    let entries = [...groups.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    const budget = MEMBER_TARGET - singles.length;
    if (entries.length > budget && budget > 1) {
      const head = entries.slice(0, budget - 1);
      const rest = entries.slice(budget - 1).flatMap(([, ms]) => ms);
      entries = [...head, ['other', rest]];
    }
    for (const s of singles)
      scene.add(entityNode(ctx, nav.byId.get(s)!), [s, ...descendants(nav, s)]);
    for (const [key, ms] of entries) {
      const all = ms.flatMap((m) => [m, ...descendants(nav, m)]);
      if (ms.length === 1) {
        scene.add(entityNode(ctx, nav.byId.get(ms[0]!)!), all);
        continue;
      }
      const isKind = key.startsWith('kind:');
      const nextFocus =
        key === 'other' || key.endsWith('s-here')
          ? undefined
          : isKind
            ? key
            : focusPath
              ? `${focusPath}/${key}`
              : key;
      scene.add(
        {
          id: `cluster:${key}`,
          kind: 'cluster',
          label: isKind
            ? key.slice(5).replace(/s-here$/, '') + 's'
            : key === 'other'
              ? 'other'
              : `${key}/`,
          sublabel: `${ms.length} items`,
          memberCount: ms.length,
          focus: nextFocus,
          counts: kindCounts(ctx, ms),
        },
        all,
      );
    }
    scene.hidden += members.length;
  }
  if (!focus && externals.length) {
    scene.add(
      {
        id: 'aggregate:external',
        kind: 'aggregate',
        label: 'Third-party libraries',
        sublabel: `${externals.length} packages`,
        memberCount: externals.length,
        focus: 'external',
      },
      externals,
    );
  }
}

function scopeOf(e: GraphEntity): string {
  const n = e.displayName;
  return n.startsWith('@')
    ? n.split('/')[0]!
    : (String(e.attributes.ecosystem ?? 'other') as string);
}

function kindCounts(ctx: Ctx, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const k = ctx.nav.byId.get(id)!.kind;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const INFRA_KINDS = new Set([
  'database',
  'infrastructure-resource',
  'queue',
  'topic',
  'external-system',
]);

function contextScene(ctx: Ctx, scene: Scene, focus?: string) {
  const { nav, g } = ctx;
  if (focus === 'external' || focus?.startsWith('external/')) {
    containerScene(ctx, scene, nav.systemId, focus);
    return;
  }
  const sys = nav.byId.get(nav.systemId)!;
  const internal: string[] = [];
  const infra: string[] = [];
  const externals: string[] = [];
  for (const e of g.entities) {
    if (e.id === nav.systemId) continue;
    if (nav.isExternal(e.id)) externals.push(e.id);
    else if (INFRA_KINDS.has(e.kind)) infra.push(e.id);
    else internal.push(e.id);
  }
  scene.add(
    {
      ...entityNode(ctx, sys),
      label: sys.displayName,
      sublabel: 'this system',
      openCanvasId: viewOf(ctx, 'component'),
    },
    internal,
  );
  if (nav.rootPackageId) scene.owner.set(nav.rootPackageId, `n:${nav.systemId}`);
  if (infra.length <= MAX_VISIBLE - 2)
    for (const i of infra.sort()) scene.add(entityNode(ctx, nav.byId.get(i)!), [i]);
  else {
    const byKind = new Map<string, string[]>();
    for (const i of infra)
      (
        byKind.get(nav.byId.get(i)!.kind) ??
        byKind.set(nav.byId.get(i)!.kind, []).get(nav.byId.get(i)!.kind)!
      ).push(i);
    for (const [k, ms] of byKind)
      scene.add(
        {
          id: `cluster:kind:${k}`,
          kind: 'cluster',
          label: `${k}s`,
          sublabel: `${ms.length} items`,
          memberCount: ms.length,
        },
        ms,
      );
  }
  if (externals.length)
    scene.add(
      {
        id: 'aggregate:external',
        kind: 'aggregate',
        label: 'Third-party libraries',
        sublabel: `${externals.length} packages`,
        memberCount: externals.length,
        focus: 'external',
      },
      externals,
    );
  if (g.gaps.length)
    scene.add({
      id: 'gap:summary',
      kind: 'gap',
      label: 'Unknowns & coverage gaps',
      sublabel: `${g.gaps.length} gap(s)`,
      memberCount: g.gaps.length,
      openCanvasId: viewOf(ctx, 'coverage'),
    });
}

function viewOf(ctx: Ctx, lens: string): string | undefined {
  return ctx.catalog.canvases.find((c) => c.lens === lens && !c.ownerCanvasId)?.id;
}

function packageAnchor(ctx: Ctx, id: string): string {
  // nearest navigation ancestor (or self) that is a package or deployable
  const { nav } = ctx;
  for (const a of [id, ...nav.ancestors(id)]) {
    const k = nav.byId.get(a)?.kind;
    if ((k === 'package' || k === 'deployable') && a !== nav.rootPackageId) return a;
  }
  return nav.systemId;
}

function kindScene(
  ctx: Ctx,
  scene: Scene,
  kinds: string[],
  opts: {
    scope?: string;
    consumers?: string[];
    groupByPackage?: boolean;
    rollUpConsumers?: boolean;
    childKinds?: string[];
    includeTargets?: boolean;
    followCalls?: boolean;
  },
) {
  const { nav, g } = ctx;
  const inScope = (id: string) => !opts.scope || nav.inSubtree(id, opts.scope);
  const primary = g.entities.filter(
    (e) =>
      kinds.includes(e.kind) &&
      (inScope(e.id) || (opts.includeTargets && consumedFromScope(ctx, e.id, opts))),
  );
  const groupNode = (pkgId: string) => {
    const pkg = nav.byId.get(pkgId)!;
    const id = `group:${pkgId}`;
    if (!scene.nodes.has(id))
      scene.add({
        id,
        kind: 'group',
        label: pkgId === nav.systemId ? pkg.displayName : pkg.displayName,
        sublabel: pkg.kind,
        entityId: pkgId,
        entityKind: pkg.kind,
        openCanvasId: ctx.canvasByOwner.get(pkgId),
      });
    return id;
  };
  for (const e of primary.sort((a, b) => a.id.localeCompare(b.id))) {
    const parent = opts.groupByPackage ? groupNode(packageAnchor(ctx, e.id)) : undefined;
    const kids = opts.childKinds
      ? (nav.children.get(e.id) ?? []).filter((k) =>
          opts.childKinds!.includes(nav.byId.get(k)!.kind),
        )
      : [];
    if (kids.length) {
      // an element that owns shown children (a service and its containers) is drawn as a group
      scene.add({ ...entityNode(ctx, e, parent), kind: 'group' }, [e.id]);
      for (const c of kids) scene.add(entityNode(ctx, nav.byId.get(c)!, `n:${e.id}`), [c]);
    } else {
      scene.add(entityNode(ctx, e, parent), [e.id]);
    }
  }
  // stand-alone child kinds (e.g. Dockerfile entrypoints without a compose service)
  for (const k of opts.childKinds ?? []) {
    for (const e of g.entities) {
      if (
        e.kind !== k ||
        scene.owner.has(e.id) ||
        (k === 'entrypoint' && typeof e.attributes.dockerfile !== 'string')
      )
        continue;
      scene.add(entityNode(ctx, e), [e.id]);
    }
  }
  // code started by shown entrypoints (Dockerfile CMD -> module): a port that opens the module's package
  if (opts.childKinds?.includes('entrypoint')) {
    for (const r of g.relations) {
      if (
        r.kind !== 'calls' ||
        !scene.owner.has(r.fromId) ||
        scene.owner.has(r.toId) ||
        nav.byId.get(r.fromId)?.kind !== 'entrypoint'
      )
        continue;
      const target = nav.byId.get(r.toId);
      if (!target) continue;
      const pkg = packageAnchor(ctx, r.toId);
      scene.add(
        {
          id: `port:${r.toId}`,
          kind: 'port',
          label: target.displayName,
          sublabel: `${nav.byId.get(pkg)?.displayName ?? ''} · runs`,
          entityId: r.toId,
          entityKind: target.kind,
          openCanvasId: ctx.canvasByOwner.get(r.toId) ?? ctx.canvasByOwner.get(pkg),
        },
        [r.toId],
      );
    }
  }
  const primaryIds = new Set(primary.map((e) => e.id));
  for (const r of g.relations) {
    if (!opts.consumers?.includes(r.kind)) continue;
    const other = primaryIds.has(r.toId) ? r.fromId : primaryIds.has(r.fromId) ? r.toId : undefined;
    if (!other || scene.owner.has(other) || nav.isExternal(other)) continue;
    if (opts.scope && !nav.inSubtree(other, opts.scope) && !primaryIds.has(r.toId)) continue;
    if (opts.rollUpConsumers) {
      const pkg = packageAnchor(ctx, other);
      scene.add(entityNode(ctx, nav.byId.get(pkg)!), [pkg, ...descendants(nav, pkg)]);
    } else {
      const parent = opts.groupByPackage ? groupNode(packageAnchor(ctx, other)) : undefined;
      scene.add(entityNode(ctx, nav.byId.get(other)!, parent), [other]);
    }
  }
  if (opts.followCalls) {
    // UI lens: endpoints called from modules of the packages that declare screens
    const uiPkgs = new Set(primary.map((e) => packageAnchor(ctx, e.id)));
    for (const r of g.relations) {
      if (r.kind !== 'calls' || nav.byId.get(r.toId)?.kind !== 'endpoint') continue;
      if (!uiPkgs.has(packageAnchor(ctx, r.fromId))) continue;
      if (!scene.owner.has(r.fromId))
        scene.add(
          entityNode(ctx, nav.byId.get(r.fromId)!, groupNode(packageAnchor(ctx, r.fromId))),
          [r.fromId],
        );
      if (!scene.owner.has(r.toId))
        scene.add(entityNode(ctx, nav.byId.get(r.toId)!, groupNode(packageAnchor(ctx, r.toId))), [
          r.toId,
        ]);
    }
  }
}

function consumedFromScope(
  ctx: Ctx,
  id: string,
  opts: { scope?: string; consumers?: string[] },
): boolean {
  if (!opts.scope) return true;
  return (ctx.nav.relationsByEntity.get(id) ?? []).some(
    (r) =>
      opts.consumers?.includes(r.kind) && r.toId === id && ctx.nav.inSubtree(r.fromId, opts.scope!),
  );
}

function coverageScene(ctx: Ctx, scene: Scene) {
  const byKind = new Map<string, { n: number; items: number }>();
  for (const gap of ctx.g.gaps) {
    const cur = byKind.get(gap.kind) ?? { n: 0, items: 0 };
    cur.n += gap.count ?? 1;
    cur.items++;
    byKind.set(gap.kind, cur);
  }
  for (const [kind, v] of [...byKind].sort()) {
    scene.add({
      id: `gap:${kind}`,
      kind: 'gap',
      label: kind.replace(/-/g, ' '),
      sublabel: `${v.n} affected · ${v.items} report(s)`,
      memberCount: v.n,
    });
  }
  const stale = ctx.g.entities.filter((e) => e.lifecycle === 'stale');
  if (stale.length)
    scene.add({
      id: 'gap:stale-entities',
      kind: 'gap',
      label: 'stale facts',
      sublabel: `${stale.length} entities kept from a previous scan`,
      memberCount: stale.length,
    });
}

const CHANGE_ORDER = ['added', 'changed', 'renamed', 'removed', 'stale', 'restored'];

function changesScene(ctx: Ctx, scene: Scene) {
  const ents = ctx.g.changes.filter((c) => c.target === 'entity');
  for (const kind of CHANGE_ORDER) {
    const list = ents.filter((c) => c.change === kind).sort((a, b) => a.id.localeCompare(b.id));
    if (!list.length) continue;
    const group = `group:change:${kind}`;
    scene.add({
      id: group,
      kind: 'group',
      label: kind,
      sublabel: `${list.length} entit${list.length === 1 ? 'y' : 'ies'}`,
      change: kind,
    });
    for (const c of list.slice(0, MAX_VISIBLE)) {
      const live = ctx.nav.byId.get(c.id);
      if (live)
        scene.add({ ...entityNode(ctx, live, group), id: `n:${c.id}:${kind}`, change: kind }, []);
      else
        scene.add({
          id: `removed:${c.id}`,
          kind: 'entity',
          label: String(c.detail.displayName ?? c.detail.canonicalName ?? c.id),
          sublabel: String(c.detail.kind ?? ''),
          entityKind: String(c.detail.kind ?? ''),
          lifecycle: 'removed',
          change: kind,
          parentId: group,
        });
    }
    if (list.length > MAX_VISIBLE)
      scene.add({
        id: `aggregate:change:${kind}`,
        kind: 'aggregate',
        label: `${list.length - MAX_VISIBLE} more`,
        parentId: group,
        change: kind,
      });
  }
}
