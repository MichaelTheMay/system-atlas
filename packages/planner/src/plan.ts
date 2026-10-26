import { CanvasLink, CanvasSpec, type Lens, type ViewQuery } from '@atlas/schema';
import { canvasId } from './ids.ts';
import { buildNav, descendants, pathOf, type Nav } from './nav.ts';
import type { Catalog, PlannerGraph } from './types.ts';

export const SCORING_POLICY_VERSION = 'relevance-v1';
export const GENERATION_VERSION = 'planner-0.1.0';

/** Minimum navigation children for a container to get its own canvas (avoids one-child chains). */
export const MIN_COMPONENT_CHILDREN = 2;
export const MIN_MODULE_DETAIL_CHILDREN = 3;
/** Minimum evidence for per-package API/Data sibling lenses. */
export const MIN_SCOPED_LENS_ITEMS = 2;

const SYSTEM_LENSES: { lens: Lens; title: string; score: number }[] = [
  { lens: 'system-context', title: 'System context', score: 1 },
  { lens: 'component', title: 'Project structure', score: 0.95 },
  { lens: 'coverage', title: 'Coverage & unknowns', score: 0.9 },
  { lens: 'changes', title: 'Changes since previous snapshot', score: 0.6 },
  { lens: 'deployables', title: 'Deployables', score: 0.85 },
  { lens: 'api', title: 'API', score: 0.85 },
  { lens: 'data', title: 'Data', score: 0.8 },
  { lens: 'workflow', title: 'Workflows & queues', score: 0.8 },
  { lens: 'ui-navigation', title: 'UI navigation', score: 0.75 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PlannedCanvas {
  spec: CanvasSpec;
  parentCanvasId?: string;
}

/** Stable id of a canvas for (project, workspace, lens, owner). Owner 'root' for system-level lenses. */
export function viewIdFor(projectId: string, lens: string, ownerEntityId: string | 'root'): string {
  return canvasId(projectId, 'architecture', lens, ownerEntityId);
}

/**
 * Plan the architecture catalog for one snapshot (plan §8). Deterministic: the same graph always
 * yields the same canvases, ids, titles, scores and links. Content is not materialized here.
 */
export function planViews(g: PlannerGraph): Catalog {
  const nav = buildNav(g);
  const kinds = new Map<string, number>();
  for (const e of g.entities) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  const has = (...ks: string[]) => ks.some((k) => (kinds.get(k) ?? 0) > 0);
  const out: PlannedCanvas[] = [];
  const spec = (
    s: Omit<
      CanvasSpec,
      | 'schemaVersion'
      | 'workspace'
      | 'scoringPolicyVersion'
      | 'snapshotId'
      | 'generationVersion'
      | 'state'
    >,
  ): CanvasSpec =>
    CanvasSpec.parse({
      schemaVersion: 1,
      workspace: 'architecture',
      scoringPolicyVersion: SCORING_POLICY_VERSION,
      snapshotId: g.snapshotId,
      generationVersion: GENERATION_VERSION,
      state: 'cataloged',
      ...s,
    });
  const staleIn = (ids: string[]) =>
    ids.filter((id) => nav.byId.get(id)?.lifecycle === 'stale').length;

  // System-level lenses.
  const eligible: Record<string, { ok: boolean; reason: string; query: ViewQuery; count: number }> =
    {
      'system-context': {
        ok: true,
        reason:
          'Always generated: the system, its external dependencies and infrastructure, and unknown boundaries.',
        query: { select: { type: 'children-of', entityId: nav.systemId }, limit: 500 },
        count: nav.children.get(nav.systemId)?.length ?? 0,
      },
      component: {
        ok: true,
        reason:
          'Always generated: top-level packages, services and stores with their dependencies.',
        query: { select: { type: 'children-of', entityId: nav.systemId }, limit: 500 },
        count: nav.children.get(nav.systemId)?.length ?? 0,
      },
      coverage: {
        ok: true,
        reason:
          'Always generated: unsupported files, unresolved references, skipped files and analyzer failures.',
        query: { select: { type: 'kinds', kinds: ['system'] }, limit: 1 },
        count: g.gaps.length,
      },
      changes: {
        ok: g.hasPrevious,
        reason:
          'Generated whenever a previous snapshot exists: what was added, removed, renamed or went stale.',
        query: { select: { type: 'kinds', kinds: ['system'] }, limit: 500 },
        count: g.changes.length,
      },
      deployables: {
        ok:
          has('deployable') ||
          g.entities.some(
            (e) => e.kind === 'entrypoint' && typeof e.attributes.dockerfile === 'string',
          ),
        reason: `Deployment or process boundaries detected (${kinds.get('deployable') ?? 0} deployable(s), ${kinds.get('entrypoint') ?? 0} entrypoint(s)).`,
        query: {
          select: {
            type: 'kinds',
            kinds: ['deployable', 'database', 'infrastructure-resource', 'entrypoint'],
          },
          limit: 500,
        },
        count: (kinds.get('deployable') ?? 0) + (kinds.get('entrypoint') ?? 0),
      },
      api: {
        ok: has('endpoint'),
        reason: `Explicit interfaces detected (${kinds.get('endpoint') ?? 0} endpoint(s)).`,
        query: { select: { type: 'kinds', kinds: ['endpoint'] }, limit: 500 },
        count: kinds.get('endpoint') ?? 0,
      },
      data: {
        ok: has('table', 'database'),
        reason: `Stores or schema detected (${kinds.get('table') ?? 0} table(s), ${kinds.get('database') ?? 0} database(s)).`,
        query: { select: { type: 'kinds', kinds: ['table', 'database'] }, limit: 500 },
        count: (kinds.get('table') ?? 0) + (kinds.get('database') ?? 0),
      },
      workflow: {
        ok: has('queue', 'topic', 'job', 'workflow'),
        reason: `Queues, topics or jobs detected (${(kinds.get('queue') ?? 0) + (kinds.get('topic') ?? 0)} queue/topic(s), ${kinds.get('job') ?? 0} job(s)).`,
        query: {
          select: { type: 'kinds', kinds: ['queue', 'topic', 'job', 'workflow'] },
          limit: 500,
        },
        count: (kinds.get('queue') ?? 0) + (kinds.get('job') ?? 0),
      },
      'ui-navigation': {
        ok: has('ui-surface'),
        reason: `UI routes or screens detected (${kinds.get('ui-surface') ?? 0}).`,
        query: { select: { type: 'kinds', kinds: ['ui-surface'] }, limit: 500 },
        count: kinds.get('ui-surface') ?? 0,
      },
    };
  const rootIds: string[] = [];
  for (const l of SYSTEM_LENSES) {
    const e = eligible[l.lens]!;
    if (!e.ok) continue;
    const id = viewIdFor(g.projectId, l.lens, 'root');
    rootIds.push(id);
    out.push({
      spec: spec({
        id,
        rootEntityId: nav.systemId,
        lens: l.lens,
        title: l.title,
        query: e.query,
        relevanceReason: e.reason,
        relevanceScore: l.score,
        coverageSummary: {
          entityCount: e.count,
          gapCount: l.lens === 'coverage' || l.lens === 'system-context' ? g.gaps.length : 0,
          staleCount: l.lens === 'component' ? staleIn([...nav.byId.keys()]) : 0,
        },
      }),
    });
  }
  const structureId = viewIdFor(g.projectId, 'component', 'root');

  // Container canvases along the navigation tree.
  const componentOf = new Map<string, string>([[nav.systemId, structureId]]);
  const order = bfs(nav);
  for (const id of order) {
    const e = nav.byId.get(id)!;
    if (nav.isExternal(id)) continue;
    const kids = nav.children.get(id) ?? [];
    const parentCanvas = nearestCanvas(nav, id, componentOf);
    const lens: Lens | undefined =
      (e.kind === 'package' || e.kind === 'deployable') && kids.length >= MIN_COMPONENT_CHILDREN
        ? 'component'
        : e.kind === 'module' && kids.length >= MIN_MODULE_DETAIL_CHILDREN
          ? 'module-detail'
          : undefined;
    const desc = descendants(nav, id);
    const scope = new Set([id, ...desc]);
    if (lens) {
      const cid = viewIdFor(g.projectId, lens, id);
      componentOf.set(id, cid);
      const { score, reason } = relevance(nav, e.displayName, e.kind, scope, g);
      out.push({
        parentCanvasId: parentCanvas,
        spec: spec({
          id: cid,
          rootEntityId: id,
          ownerCanvasId: parentCanvas,
          lens,
          title: lens === 'module-detail' ? `${e.displayName} (module)` : e.displayName,
          query: { select: { type: 'children-of', entityId: id }, limit: 500 },
          relevanceReason: reason,
          relevanceScore: score,
          coverageSummary: {
            entityCount: desc.length,
            gapCount: gapsUnder(g, e),
            staleCount: staleIn(desc),
          },
        }),
      });
    }
    if (e.kind === 'package') {
      const endpoints = desc.filter((d) => nav.byId.get(d)?.kind === 'endpoint');
      const dataRels = g.relations.filter(
        (r) => (r.kind === 'reads' || r.kind === 'writes') && scope.has(r.fromId),
      );
      const owner = lens ? componentOf.get(id)! : parentCanvas;
      for (const [l, n, title, what] of [
        ['api', endpoints.length, `${e.displayName} · API`, 'endpoint(s)'],
        ['data', dataRels.length, `${e.displayName} · Data`, 'read/write relation(s)'],
      ] as const) {
        if (n < MIN_SCOPED_LENS_ITEMS) continue;
        out.push({
          parentCanvasId: owner,
          spec: spec({
            id: viewIdFor(g.projectId, l, id),
            rootEntityId: id,
            ownerCanvasId: owner,
            lens: l,
            title,
            query: {
              select: {
                type: 'kinds',
                kinds: l === 'api' ? ['endpoint'] : ['table', 'database'],
                ownerId: id,
              },
              limit: 500,
            },
            relevanceReason: `${e.displayName} has ${n} ${what}.`,
            relevanceScore: round2(Math.min(1, 0.5 + n / 20)),
            coverageSummary: { entityCount: n, gapCount: 0, staleCount: 0 },
          }),
        });
      }
    }
  }

  // Links: child along canonical ownership; siblings among lenses that share an owner entity.
  const links: CanvasLink[] = [];
  for (const c of out) {
    if (c.parentCanvasId)
      links.push(
        CanvasLink.parse({
          schemaVersion: 1,
          fromCanvasId: c.parentCanvasId,
          toCanvasId: c.spec.id,
          relation: 'child',
          viaEntityId: c.spec.rootEntityId,
        }),
      );
  }
  const byOwner = new Map<string, string[]>();
  for (const c of out) {
    const key = c.parentCanvasId ? `${c.spec.rootEntityId}` : 'root';
    (byOwner.get(key) ?? byOwner.set(key, []).get(key)!).push(c.spec.id);
  }
  for (const ids of byOwner.values()) {
    for (const a of ids)
      for (const b of ids)
        if (a !== b)
          links.push(
            CanvasLink.parse({
              schemaVersion: 1,
              fromCanvasId: a,
              toCanvasId: b,
              relation: 'sibling',
            }),
          );
  }
  const canvases = out.map((c) => c.spec).sort((a, b) => (a.id < b.id ? -1 : 1));
  links.sort((a, b) =>
    `${a.fromCanvasId}${a.toCanvasId}${a.relation}`.localeCompare(
      `${b.fromCanvasId}${b.toCanvasId}${b.relation}`,
    ),
  );
  void rootIds;
  return { canvases, links };
}

function bfs(nav: Nav): string[] {
  const out: string[] = [];
  const queue = [...(nav.children.get(nav.systemId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    queue.push(...(nav.children.get(id) ?? []));
  }
  return out;
}

/** Canonical parent canvas: the nearest navigation ancestor that has a container canvas. */
function nearestCanvas(nav: Nav, id: string, componentOf: Map<string, string>): string {
  for (const a of nav.ancestors(id)) {
    const c = componentOf.get(a);
    if (c) return c;
  }
  return componentOf.get(nav.systemId)!;
}

function gapsUnder(g: PlannerGraph, e: { attributes: Record<string, unknown> }): number {
  const dir = pathOf(e as never);
  if (!dir) return 0;
  const prefix =
    dir.includes('.') && !dir.endsWith('/') && dir.split('/').pop()!.includes('.')
      ? dir
      : `${dir}/`;
  return g.gaps.filter((x) => x.path && (x.path === dir || x.path.startsWith(prefix))).length;
}

/**
 * Relevance policy v1 (deterministic, versioned): evidence availability, entrypoints, interfaces,
 * boundary strength and coupling. Weights sum to 1; each factor is in [0, 1].
 */
function relevance(
  nav: Nav,
  name: string,
  kind: string,
  scope: Set<string>,
  g: PlannerGraph,
): { score: number; reason: string } {
  let supported = 0;
  let total = 0;
  let crossing = 0;
  for (const r of g.relations) {
    if (r.kind === 'contains') continue;
    const inFrom = scope.has(r.fromId);
    const inTo = scope.has(r.toId);
    if (!inFrom && !inTo) continue;
    total++;
    if (r.status === 'supported') supported++;
    if (inFrom !== inTo) crossing++;
  }
  let entrypoints = 0;
  let interfaces = 0;
  for (const id of scope) {
    const k = nav.byId.get(id)?.kind;
    if (k === 'entrypoint') entrypoints++;
    if (k === 'endpoint' || k === 'ui-surface') interfaces++;
  }
  const evidence = total ? supported / total : 0;
  const boundary = kind === 'package' || kind === 'deployable' ? 1 : 0.5;
  const score = round2(
    0.2 * evidence +
      0.15 * Math.min(1, entrypoints / 2) +
      0.25 * Math.min(1, interfaces / 5) +
      0.2 * boundary +
      0.2 * Math.min(1, crossing / 10),
  );
  const parts = [`${scope.size - 1} owned element(s)`];
  if (interfaces) parts.push(`${interfaces} interface(s)`);
  if (entrypoints) parts.push(`${entrypoints} entrypoint(s)`);
  parts.push(`${crossing} relation(s) cross its boundary`);
  parts.push(`${Math.round(evidence * 100)}% of its relations are evidence-supported`);
  return { score, reason: `${name} (${kind}): ${parts.join(', ')}.` };
}
