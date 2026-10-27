import { CanvasLink, CanvasSpec } from '@atlas/schema';
import { canvasId } from './ids.ts';
import { buildNav, descendants, pathOf, type Nav } from './nav.ts';
import { GENERATION_VERSION, SCORING_POLICY_VERSION } from './plan.ts';
import { buildEdges, catalogNav, Scene, type Ctx } from './scene.ts';
import type {
  Archetype,
  Catalog,
  GraphEntity,
  GraphRelation,
  NodeKind,
  PlannerGraph,
  Projection,
  ProjectionEdge,
  ProjectionNode,
  Provenance,
} from './types.ts';

/**
 * System-design lens (D01): whiteboard canvases derived from the semantic graph, subsystem claims
 * and view overrides. Views only: nothing here becomes a claim or a relation, and the inputs are
 * never mutated. Deterministic: the same graph, claims and overrides give the same catalog and
 * projections.
 *
 * Model:
 * - A *unit* is one whiteboard box: a deployable fused with the package it runs, a package, a
 *   directory group of a single-package repo, a queue/topic, a database (with its tables), an
 *   infrastructure resource, an external system, or all third-party libraries. Every non-test
 *   entity belongs to at most one unit, so relations aggregate into flows between boxes.
 * - A unit sits on at most one subsystem path (up to three levels), from `subsystem` claims, or, when
 *   there are none, from deployables that run several packages. Each path prefix is a canvas.
 */

/** Maximum subsystem nesting (design-system > A > A/B > A/B/C). */
export const MAX_SUBSYSTEM_DEPTH = 3;
/** Directory groups of a single-package repo drawn individually; the rest fold into "more". */
export const MAX_CODE_GROUPS = 10;

const DESIGN_SCORING = 'design-v1';

interface Unit {
  /** Stable key: the anchor entity id, or a synthetic key for aggregates. */
  key: string;
  anchorId?: string;
  label: string;
  sublabel?: string;
  nodeKind: NodeKind;
  members: string[];
  archetype: Archetype;
  reason: string;
  /** Entities whose architecture canvas realizes this box, best first. */
  realizedBy: string[];
  /** Deployable that runs this unit when it runs several packages (baseline subsystems). */
  deployableId?: string;
  /** True for code units (archetype computed from signals). */
  code: boolean;
}

interface Subsystem {
  canvasId: string;
  /** Normalized path segments. */
  path: string[];
  title: string;
  parentCanvasId: string;
  provenance: Provenance;
  state: 'cataloged' | 'suppressed' | 'stale';
  reason: string;
  /** Unit keys placed exactly here or below. */
  unitKeys: string[];
  anchorIds: string[];
  entityCount: number;
}

interface DesignModel {
  nav: Nav;
  units: Unit[];
  unitOf: Map<string, Unit>;
  /** unit key -> normalized subsystem path ([] = top level) */
  pathOf: Map<string, string[]>;
  rootCanvasId: string;
  subsystems: Map<string, Subsystem>;
  /** normalized path joined by '/' -> canvas id */
  canvasByPath: Map<string, string>;
}

export function planDesign(g: PlannerGraph): Catalog {
  const m = designModel(g);
  if (!m.units.length) return { canvases: [], links: [] };
  const spec = (
    s: Omit<
      CanvasSpec,
      'schemaVersion' | 'workspace' | 'scoringPolicyVersion' | 'snapshotId' | 'generationVersion'
    >,
  ): CanvasSpec =>
    CanvasSpec.parse({
      schemaVersion: 1,
      workspace: 'design',
      scoringPolicyVersion: `${SCORING_POLICY_VERSION}+${DESIGN_SCORING}`,
      snapshotId: g.snapshotId,
      generationVersion: GENERATION_VERSION,
      ...s,
    });
  const subs = [...m.subsystems.values()];
  const proposed = subs.filter((s) => s.provenance !== 'detected').length;
  const canvases: CanvasSpec[] = [
    spec({
      id: m.rootCanvasId,
      rootEntityId: m.nav.systemId,
      lens: 'design-system',
      title: 'System design',
      query: { select: { type: 'children-of', entityId: m.nav.systemId }, limit: 500 },
      relevanceReason:
        `Always generated: a whiteboard of ${m.units.length} box(es) inferred from detected deployables, packages, stores, queues and libraries` +
        (subs.length
          ? `, with ${subs.length} subsystem(s)${proposed ? ` (${proposed} proposed or accepted)` : ''}.`
          : '.'),
      relevanceScore: 1,
      state: 'cataloged',
      provenance: 'detected',
      coverageSummary: {
        entityCount: m.units.length,
        gapCount: g.gaps.length,
        staleCount: g.entities.filter((e) => e.lifecycle === 'stale').length,
      },
    }),
  ];
  const links: CanvasLink[] = [];
  for (const s of subs) {
    canvases.push(
      spec({
        id: s.canvasId,
        ownerCanvasId: s.parentCanvasId,
        lens: 'design-subsystem',
        title: s.title,
        query: { select: { type: 'ids', ids: s.anchorIds.slice(0, 500) }, limit: 500 },
        relevanceReason: s.reason,
        relevanceScore:
          s.provenance === 'accepted' ? 0.85 : s.provenance === 'detected' ? 0.75 : 0.6,
        state: s.state,
        provenance: s.provenance,
        coverageSummary: {
          entityCount: s.entityCount,
          gapCount: 0,
          staleCount: 0,
        },
      }),
    );
    links.push(
      CanvasLink.parse({
        schemaVersion: 1,
        fromCanvasId: s.parentCanvasId,
        toCanvasId: s.canvasId,
        relation: 'child',
      }),
    );
  }
  canvases.sort((a, b) => (a.id < b.id ? -1 : 1));
  links.sort((a, b) =>
    `${a.fromCanvasId}${a.toCanvasId}${a.relation}`.localeCompare(
      `${b.fromCanvasId}${b.toCanvasId}${b.relation}`,
    ),
  );
  return { canvases, links };
}

export function projectDesign(g: PlannerGraph, catalog: Catalog, canvasIdArg: string): Projection {
  const spec = catalog.canvases.find((c) => c.id === canvasIdArg);
  if (!spec) throw new Error(`unknown canvas ${canvasIdArg}`);
  const m = designModel(g);
  const nav = m.nav;
  const canvasByOwner = new Map<string, string>();
  for (const c of catalog.canvases)
    if (
      c.workspace === 'architecture' &&
      (c.lens === 'component' || c.lens === 'module-detail') &&
      c.rootEntityId
    )
      canvasByOwner.set(c.rootEntityId, c.id);
  const ctx: Ctx = { g, nav, catalog, canvasByOwner, spec };
  const scene = new Scene();
  const here: string[] | undefined =
    spec.id === m.rootCanvasId ? [] : m.subsystems.get(spec.id)?.path;

  const realizedBy = (u: Unit): string | undefined => {
    for (const id of u.realizedBy) {
      const c = canvasByOwner.get(id);
      if (c) return c;
    }
    if (u.anchorId)
      for (const a of nav.ancestors(u.anchorId)) {
        const c = canvasByOwner.get(a);
        if (c) return c;
      }
    return canvasByOwner.get(nav.systemId);
  };
  const unitNode = (u: Unit, kind?: NodeKind): ProjectionNode => ({
    id: `box:${u.key}`,
    kind: kind ?? u.nodeKind,
    label: u.label,
    sublabel: u.sublabel,
    entityId: u.anchorId,
    entityKind: u.anchorId ? nav.byId.get(u.anchorId)?.kind : undefined,
    lifecycle: u.anchorId ? nav.byId.get(u.anchorId)?.lifecycle : undefined,
    memberCount: u.members.length,
    archetype: u.archetype,
    archetypeReason: u.reason,
    provenance: 'detected',
    realizedByCanvasId: realizedBy(u),
  });

  if (here) {
    const ports: Unit[] = [];
    const grouped = new Map<string, Unit[]>();
    for (const u of m.units) {
      const p = m.pathOf.get(u.key) ?? [];
      if (!startsWith(p, here)) {
        ports.push(u);
        continue;
      }
      if (p.length > here.length) {
        const next = p.slice(0, here.length + 1).join('/');
        const sid = m.canvasByPath.get(next)!;
        if (m.subsystems.get(sid)!.state !== 'suppressed') {
          (grouped.get(sid) ?? grouped.set(sid, []).get(sid)!).push(u);
          continue;
        }
      }
      scene.add(unitNode(u), u.members);
    }
    for (const [sid, us] of [...grouped].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const s = m.subsystems.get(sid)!;
      const { archetype, reason } = dominant(us);
      scene.add(
        {
          id: `subsystem:${sid}`,
          kind: 'cluster',
          label: s.title,
          sublabel: `subsystem · ${us.length} box(es)`,
          entityId: us.find((u) => u.anchorId)?.anchorId,
          openCanvasId: sid,
          memberCount: us.length,
          archetype,
          archetypeReason: reason,
          provenance: s.provenance,
        },
        us.flatMap((u) => u.members),
      );
    }
    // On a subsystem canvas, boxes outside it that exchange flows with it are context ports.
    if (here.length) for (const u of ports) scene.add(unitNode(u, 'port'), u.members);
  }

  let edges = flows(g, ctx, scene);
  if (here?.length) {
    const isPort = (id: string) => scene.nodes.get(id)?.kind === 'port';
    edges = edges.filter((e) => !(isPort(e.source) && isPort(e.target)));
    const used = new Set(edges.flatMap((e) => [e.source, e.target]));
    for (const [id, n] of [...scene.nodes])
      if (n.kind === 'port' && !used.has(id)) scene.nodes.delete(id);
  }
  let nodes = [...scene.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  let truncated = false;
  if (nodes.length > HARD_DESIGN_CAP) {
    truncated = true;
    nodes = nodes.slice(0, HARD_DESIGN_CAP);
  }
  const keep = new Set(nodes.map((n) => n.id));
  const keptEdges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  return {
    viewId: spec.id,
    canvasId: spec.id,
    snapshotId: g.snapshotId,
    lens: spec.lens,
    title: spec.title,
    relevanceReason: spec.relevanceReason,
    nodes,
    edges: keptEdges,
    truncated,
    ...catalogNav(catalog, spec),
    stats: {
      entities: nodes.filter((n) => n.entityId).length,
      relations: keptEdges.reduce(
        (n, e) => n + Object.values(e.kinds).reduce((a, b) => a + b, 0),
        0,
      ),
      hiddenNodes: scene.hidden,
    },
  };
}

/** Same hard cap as other projections (plan §16). */
const HARD_DESIGN_CAP = 200;

// ---------------------------------------------------------------------------------------------
// Flows

const FLOW_ORDER = [
  'HTTP',
  'runs',
  'calls',
  'enqueue',
  'consume',
  'reads/writes',
  'reads',
  'writes',
  'invokes',
  'configures',
  'produces',
  'exposes',
  'runs on',
  'uses',
];

function flows(g: PlannerGraph, ctx: Ctx, scene: Scene): ProjectionEdge[] {
  const relById = new Map(g.relations.map((r) => [r.id, r]));
  return buildEdges(ctx, scene, ctx.nav.systemId, false).map((e) => {
    const labels = new Set<string>();
    const k = e.kinds;
    if (k.calls) {
      for (const id of e.relationIds) {
        const r = relById.get(id);
        if (r?.kind !== 'calls') continue;
        const from = ctx.nav.byId.get(r.fromId)?.kind;
        const to = ctx.nav.byId.get(r.toId)?.kind;
        labels.add(to === 'endpoint' ? 'HTTP' : from === 'entrypoint' ? 'runs' : 'calls');
      }
      if (![...labels].some((l) => l === 'HTTP' || l === 'runs' || l === 'calls'))
        labels.add('calls');
    }
    if (k.publishes) labels.add('enqueue');
    if (k.subscribes) labels.add('consume');
    if (k.reads && k.writes) labels.add('reads/writes');
    else if (k.reads) labels.add('reads');
    else if (k.writes) labels.add('writes');
    if (k['invokes-tool']) labels.add('invokes');
    if (k.configures) labels.add('configures');
    if (k.produces) labels.add('produces');
    if (k.exposes) labels.add('exposes');
    if (k['deploys-to']) labels.add('runs on');
    // "uses" (imports, depends-on) only when nothing more specific describes the flow
    if ((k.imports || k['depends-on']) && !labels.size) labels.add('uses');
    const flow = [...labels]
      .sort((a, b) => FLOW_ORDER.indexOf(a) - FLOW_ORDER.indexOf(b))
      .join(', ');
    return flow ? { ...e, flow } : e;
  });
}

// ---------------------------------------------------------------------------------------------
// Model: units, archetypes and subsystem paths

const startsWith = (p: string[], prefix: string[]) => prefix.every((s, i) => p[i] === s);

/** Identity of a subsystem name: trimmed, whitespace collapsed, lowercase. */
export function normalizeSubsystemName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function designModel(g: PlannerGraph): DesignModel {
  const nav = buildNav(g);
  const units = buildUnits(g, nav);
  const unitOf = new Map<string, Unit>();
  for (const u of units) for (const id of u.members) if (!unitOf.has(id)) unitOf.set(id, u);
  const rootCanvasId = canvasId(g.projectId, 'design', 'design-system', 'root');
  const subId = (path: string[]) =>
    canvasId(g.projectId, 'design', 'design-subsystem', path.join('/'));
  const overrides = g.overrides ?? [];
  const has = (target: string, action: string) =>
    overrides.some((o) => o.targetId === target && o.action === action);

  // ---- claims -> per-unit candidate paths
  interface Usable {
    claimId: string;
    path: string[];
    titles: string[];
    origin: string;
    model?: string;
    stale: boolean;
    unitKey: string;
  }
  const byUnit = new Map<string, Usable[]>();
  const usableClaims: Usable[] = [];
  const claims = [...(g.claims ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of claims) {
    if (c.predicate !== 'subsystem' || typeof c.value !== 'string') continue;
    if (c.status === 'rejected') continue;
    const raw = c.value
      .split('/')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, MAX_SUBSYSTEM_DEPTH);
    if (!raw.length) continue;
    const path = raw.map((s) => s.toLowerCase());
    if (c.status === 'stale' && !has(subId(path), 'pin')) continue;
    const u = unitOf.get(c.subjectId);
    if (!u) continue;
    const usable: Usable = {
      claimId: c.id,
      path,
      titles: raw,
      origin: c.origin,
      model: c.model,
      stale: c.status === 'stale',
      unitKey: u.key,
    };
    usableClaims.push(usable);
    (byUnit.get(u.key) ?? byUnit.set(u.key, []).get(u.key)!).push(usable);
  }

  const pathOfUnit = new Map<string, string[]>();
  const titleOf = new Map<string, string>();
  const detectedReason = new Map<string, string>();
  if (usableClaims.length) {
    for (const u of units) {
      const cands = byUnit.get(u.key);
      if (!cands) continue;
      // acyclic navigation: a unit sits on exactly one path; the lexicographically first wins
      const best = [...cands].sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')))[0]!;
      pathOfUnit.set(u.key, best.path);
    }
    // display casing: the first human claim, else the first claim (by id)
    for (const c of [...usableClaims.filter((x) => x.origin === 'human'), ...usableClaims])
      c.path.forEach((_, i) => {
        const key = c.path.slice(0, i + 1).join('/');
        if (!titleOf.has(key)) titleOf.set(key, c.titles[i]!);
      });
  } else {
    // Baseline: a deployable that runs several packages is a detected subsystem.
    const byDeployable = new Map<string, Unit[]>();
    for (const u of units)
      if (u.deployableId)
        (
          byDeployable.get(u.deployableId) ??
          byDeployable.set(u.deployableId, []).get(u.deployableId)!
        ).push(u);
    for (const [d, us] of [...byDeployable].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (us.length < 2) continue;
      const name = nav.byId.get(d)!.displayName;
      const path = [`${normalizeSubsystemName(name)}#${d}`];
      titleOf.set(path[0]!, name);
      detectedReason.set(
        path[0]!,
        `Detected: deployable ${name} runs ${us.length} packages (${us.map((u) => u.label).join(', ')}).`,
      );
      for (const u of us) pathOfUnit.set(u.key, path);
    }
  }

  // ---- canvases for every path prefix that has members
  const subsystems = new Map<string, Subsystem>();
  const canvasByPath = new Map<string, string>();
  const prefixes = new Map<string, string[]>();
  for (const p of pathOfUnit.values())
    for (let i = 1; i <= p.length; i++) prefixes.set(p.slice(0, i).join('/'), p.slice(0, i));
  for (const [key, path] of [...prefixes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const id = subId(path);
    canvasByPath.set(key, id);
    const parentCanvasId = path.length > 1 ? subId(path.slice(0, -1)) : rootCanvasId;
    const members = units.filter((u) => {
      const p = pathOfUnit.get(u.key);
      return !!p && startsWith(p, path);
    });
    const contributing = usableClaims.filter(
      (c) => startsWith(c.path, path) && pathOfUnit.get(c.unitKey)?.join('/') === c.path.join('/'),
    );
    const human = contributing.some((c) => c.origin === 'human');
    const provenance: Provenance = detectedReason.has(key)
      ? 'detected'
      : human || has(id, 'promote')
        ? 'accepted'
        : 'proposed';
    const names = members.map((u) => u.label).join(', ');
    let reason =
      detectedReason.get(key) ??
      (provenance === 'accepted'
        ? `Accepted: ${human ? 'a person grouped' : 'promoted proposal grouping'} ${members.length} box(es) (${names}).`
        : `Proposed by ${contributing.find((c) => c.model)?.model ?? 'an agent'}: groups ${members.length} box(es) (${names}).`);
    if (contributing.some((c) => c.stale)) reason += ' Pinned: kept while its evidence changed.';
    subsystems.set(id, {
      canvasId: id,
      path,
      title: titleOf.get(key) ?? path[path.length - 1]!,
      parentCanvasId,
      provenance,
      state: has(id, 'suppress')
        ? 'suppressed'
        : contributing.length && contributing.every((c) => c.stale)
          ? 'stale'
          : 'cataloged',
      reason,
      unitKeys: members.map((u) => u.key),
      anchorIds: members.flatMap((u) => (u.anchorId ? [u.anchorId] : [])).sort(),
      entityCount: members.reduce((n, u) => n + u.members.length, 0),
    });
  }
  return { nav, units, unitOf, pathOf: pathOfUnit, rootCanvasId, subsystems, canvasByPath };
}

const ARCHETYPE_ORDER: Archetype[] = [
  'client',
  'api-service',
  'worker',
  'queue',
  'datastore',
  'cache',
  'external-api',
  'library',
  'service',
];

/** Archetype of a subsystem box: the most common member archetype (ties by a fixed order). */
function dominant(us: Unit[]): { archetype: Archetype; reason: string } {
  const counts = new Map<Archetype, number>();
  for (const u of us) counts.set(u.archetype, (counts.get(u.archetype) ?? 0) + 1);
  const ranked = [...counts].sort(
    (a, b) => b[1] - a[1] || ARCHETYPE_ORDER.indexOf(a[0]) - ARCHETYPE_ORDER.indexOf(b[0]),
  );
  return {
    archetype: ranked[0]![0],
    reason: `Subsystem of ${us.length} box(es): ${ranked.map(([a, n]) => `${n} ${a}`).join(', ')}.`,
  };
}

const HTTP_SERVER_LIB =
  /^(express|fastify|koa|hono|@hono\/|@nestjs\/|@hapi\/|restify|next$|github\.com\/(go-chi\/chi|gin-gonic\/gin|labstack\/echo|gofiber\/fiber|gorilla\/mux|julienschmidt\/httprouter)|net\/http|flask|fastapi|django|starlette|aiohttp|tornado|sanic|org\.springframework\.boot|org\.springframework\.web|io\.javalin|io\.micronaut|io\.quarkus|io\.ktor|com\.sparkjava|io\.vertx|actix-web|axum|rocket|warp|sinatra|rails)/i;
const CACHE_RE = /redis|memcached|valkey|dragonfly/i;
const BROKER_NAME_RE =
  /(^|[^a-z])(queue|queues|broker|mq|bus)([^a-z]|$)|kafka|rabbit|nats|sqs|pubsub/i;
const BROKER_IMAGE_RE = /kafka|rabbitmq|nats|activemq|redpanda|pulsar/i;
const STORE_IMAGE_RE =
  /postgres|mysql|mariadb|mongo|cockroach|clickhouse|cassandra|elastic|opensearch|minio|sqlite/i;
const TRANSPARENT_DIRS = new Set(['cmd', 'internal', 'pkg', 'src', 'lib']);
const CODE_KINDS = new Set([
  'module',
  'entrypoint',
  'endpoint',
  'ui-surface',
  'job',
  'workflow',
  'agent',
  'tool',
  'configuration',
  'symbol',
  'artifact-type',
]);

const byName = (a: GraphEntity, b: GraphEntity) =>
  a.displayName.localeCompare(b.displayName) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function buildUnits(g: PlannerGraph, nav: Nav): Unit[] {
  const units: Unit[] = [];
  const taken = new Set<string>();
  const claim = (ids: string[]) => ids.filter((id) => !taken.has(id) && (taken.add(id), true));
  const all = [...g.entities].sort(byName);
  const ofKind = (...ks: string[]) =>
    all.filter((e) => ks.includes(e.kind) && e.id !== nav.systemId);
  const subtree = (id: string) => [id, ...descendants(nav, id)];
  const image = (e: GraphEntity) =>
    typeof e.attributes.image === 'string' ? e.attributes.image : '';
  const simple = (
    e: GraphEntity,
    archetype: Archetype,
    reason: string,
    members: string[] = subtree(e.id),
  ) => {
    const mine = claim(members);
    if (!mine.length) return;
    units.push({
      key: e.id,
      anchorId: e.id,
      label: e.displayName,
      sublabel: e.kind,
      nodeKind: 'entity',
      members: mine.sort(),
      archetype,
      reason,
      realizedBy: [e.id],
      code: false,
    });
  };

  // Third-party libraries: one box.
  const ext = all.filter((e) => nav.isExternal(e.id) && e.kind !== 'external-system');
  const extMembers = claim(ext.flatMap((e) => subtree(e.id)));
  if (extMembers.length)
    units.push({
      key: 'libraries',
      label: 'Third-party libraries',
      sublabel: `${ext.length} package(s)`,
      nodeKind: 'aggregate',
      members: extMembers.sort(),
      archetype: 'library',
      reason: `${ext.length} third-party package(s) imported or declared as dependencies.`,
      realizedBy: [],
      code: false,
    });
  for (const e of ofKind('external-system'))
    simple(
      e,
      'external-api',
      `External system ${e.displayName}: called across the system boundary.`,
    );
  for (const e of ofKind('queue', 'topic'))
    simple(e, 'queue', `Detected ${e.kind} ${e.displayName}${channelUse(g, e.id)}.`);

  // Stores: databases take the tables (the first primary store when there are several).
  const dbs = ofKind('database');
  const tables = ofKind('table');
  const isCache = (e: GraphEntity) => CACHE_RE.test(e.displayName) || CACHE_RE.test(image(e));
  const primary = dbs.find((d) => !isCache(d));
  for (const d of dbs) {
    if (isCache(d)) {
      simple(
        d,
        'cache',
        `Heuristic: database ${d.displayName}${image(d) ? ` (image ${image(d)})` : ''} looks like a cache (redis/memcached/valkey).`,
      );
      continue;
    }
    const withTables = d === primary ? tables.map((t) => t.id) : [];
    simple(
      d,
      'datastore',
      `Database ${d.displayName}${image(d) ? ` (image ${image(d)})` : ''}` +
        (withTables.length
          ? ` holding ${withTables.length} table(s)${dbs.length > 1 ? ' (assigned to the first primary database)' : ''}.`
          : '.'),
      [...subtree(d.id), ...withTables.flatMap(subtree)],
    );
  }
  for (const e of ofKind('infrastructure-resource')) {
    const img = image(e);
    const desc = `${e.displayName}${img ? ` (image ${img})` : ''}`;
    if (BROKER_NAME_RE.test(e.displayName) || BROKER_IMAGE_RE.test(img))
      simple(
        e,
        'queue',
        `Heuristic: infrastructure ${desc} is named or built like a message broker.`,
      );
    else if (CACHE_RE.test(e.displayName) || CACHE_RE.test(img))
      simple(
        e,
        'cache',
        `Heuristic: infrastructure ${desc} looks like a cache (redis/memcached/valkey).`,
      );
    else if (STORE_IMAGE_RE.test(img))
      simple(e, 'datastore', `Heuristic: infrastructure ${desc} runs a database image.`);
    else simple(e, 'service', `Infrastructure resource ${desc}.`);
  }
  if (!primary) {
    const free = tables.filter((t) => !taken.has(t.id));
    const ms = claim(free.flatMap((t) => subtree(t.id)));
    if (ms.length)
      units.push({
        key: 'tables',
        anchorId: free[0]!.id,
        label: 'Database tables',
        sublabel: `${free.length} table(s)`,
        nodeKind: 'aggregate',
        members: ms.sort(),
        archetype: 'datastore',
        reason: `${free.length} table(s) declared in schema or migrations; no database service was detected, so they are drawn as one store.`,
        realizedBy: [free[0]!.id],
        code: false,
      });
  }

  // Code: deployables fused with the package they run; remaining packages; then loose modules.
  const codeUnits: Unit[] = [];
  const packages = ofKind('package').filter(
    (p) => !nav.isExternal(p.id) && p.id !== nav.rootPackageId,
  );
  const pkgOf = (id: string) => packageOf(nav, id);
  const pairedTo = new Map<string, string>(); // package -> deployable
  const runs = new Map<string, string[]>(); // deployable -> packages
  for (const d of ofKind('deployable')) {
    if (nav.isExternal(d.id)) continue;
    const found = new Set<string>();
    for (const ep of subtree(d.id)) {
      const e = nav.byId.get(ep)!;
      for (const r of nav.relationsByEntity.get(ep) ?? [])
        if (r.kind === 'calls' && r.fromId === ep) {
          const p = pkgOf(r.toId);
          if (p) found.add(p);
        }
      const df = typeof e.attributes.dockerfile === 'string' ? e.attributes.dockerfile : '';
      const dir = df.includes('/') ? df.slice(0, df.lastIndexOf('/')) : '';
      if (dir) {
        const match = packages
          .filter((p) => {
            const pd = String(p.attributes.directory ?? '');
            return pd && (dir === pd || dir.startsWith(`${pd}/`));
          })
          .sort(
            (a, b) => String(b.attributes.directory).length - String(a.attributes.directory).length,
          )[0];
        if (match) found.add(match.id);
      }
    }
    const ps = [...found].filter((p) => !pairedTo.has(p)).sort();
    for (const p of ps) pairedTo.set(p, d.id);
    runs.set(d.id, ps);
  }
  for (const d of ofKind('deployable')) {
    if (nav.isExternal(d.id)) continue;
    const ps = runs.get(d.id) ?? [];
    if (ps.length === 1) {
      const p = nav.byId.get(ps[0]!)!;
      const ms = claim([...subtree(d.id), ...subtree(p.id)]);
      if (ms.length)
        codeUnits.push({
          key: p.id,
          anchorId: p.id,
          label: d.displayName,
          sublabel: p.displayName,
          nodeKind: 'entity',
          members: ms.sort(),
          archetype: 'service',
          reason: '',
          realizedBy: [p.id, d.id],
          code: true,
        });
    } else if (ps.length > 1) {
      ps.forEach((pid, i) => {
        const p = nav.byId.get(pid)!;
        const ms = claim(i === 0 ? [...subtree(d.id), ...subtree(pid)] : subtree(pid));
        if (ms.length)
          codeUnits.push({
            key: pid,
            anchorId: pid,
            label: p.displayName,
            sublabel: `package · runs in ${d.displayName}`,
            nodeKind: 'entity',
            members: ms.sort(),
            archetype: 'service',
            reason: '',
            realizedBy: [pid, d.id],
            deployableId: d.id,
            code: true,
          });
      });
    } else {
      const ms = claim(subtree(d.id));
      if (ms.length)
        codeUnits.push({
          key: d.id,
          anchorId: d.id,
          label: d.displayName,
          sublabel: 'deployable',
          nodeKind: 'entity',
          members: ms.sort(),
          archetype: 'service',
          reason: '',
          realizedBy: [d.id],
          code: true,
        });
    }
  }
  const depth = (id: string) => nav.ancestors(id).length;
  for (const p of [...packages].sort((a, b) => depth(a.id) - depth(b.id) || byName(a, b))) {
    if (taken.has(p.id)) continue;
    const ms = claim(subtree(p.id));
    codeUnits.push({
      key: p.id,
      anchorId: p.id,
      label: p.displayName,
      sublabel: 'package',
      nodeKind: 'entity',
      members: ms.sort(),
      archetype: 'service',
      reason: '',
      realizedBy: [p.id],
      code: true,
    });
  }

  // Loose code owned by the system or the root package: group by directory.
  const loose = all.filter(
    (e) =>
      !taken.has(e.id) &&
      CODE_KINDS.has(e.kind) &&
      !nav.isExternal(e.id) &&
      nav.parent.get(e.id) === nav.systemId,
  );
  const isTest = (e: GraphEntity) => e.attributes.test === true;
  const pathed = loose.filter((e) => e.kind !== 'entrypoint' && pathOf(e) && !isTest(e));
  const groups = new Map<string, GraphEntity[]>();
  const dirOf = (e: GraphEntity) => {
    const p = pathOf(e)!;
    // modules that are files sit in their directory; directory modules (Go) are their own dir
    return e.kind === 'module' && !/\.[^/]+$/.test(p)
      ? p
      : p.includes('/')
        ? p.slice(0, p.lastIndexOf('/'))
        : '';
  };
  let prefix: string[] = [];
  if (pathed.length > 1) {
    const dirs = pathed.map((e) => dirOf(e).split('/').filter(Boolean));
    prefix = dirs[0]!.slice();
    for (const d of dirs) {
      let i = 0;
      while (i < prefix.length && i < d.length && prefix[i] === d[i]) i++;
      prefix.length = i;
    }
    // a module whose own directory is the prefix (Go) must keep its last segment
    if (
      pathed.some(
        (e) =>
          e.kind === 'module' &&
          dirOf(e) === pathOf(e) &&
          dirOf(e).split('/').length <= prefix.length,
      )
    )
      prefix.length = Math.max(0, prefix.length - 1);
  }
  for (const e of pathed) {
    let segs = pathOf(e)!.split('/').filter(Boolean).slice(prefix.length);
    while (segs.length > 1 && TRANSPARENT_DIRS.has(segs[0]!)) segs = segs.slice(1);
    const key = segs[0] ?? e.displayName;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  let entries = [...groups].sort((a, b) => a[0].localeCompare(b[0]));
  let more: GraphEntity[] = [];
  if (entries.length > MAX_CODE_GROUPS) {
    const ranked = [...entries].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    const keepKeys = new Set(ranked.slice(0, MAX_CODE_GROUPS - 1).map(([k]) => k));
    more = entries.filter(([k]) => !keepKeys.has(k)).flatMap(([, es]) => es);
    entries = entries.filter(([k]) => keepKeys.has(k));
  }
  const looseUnits: Unit[] = [];
  for (const [key, es] of entries) {
    const anchor = [...es].sort((a, b) => (pathOf(a)! < pathOf(b)! ? -1 : 1))[0]!;
    const ms = claim(es.flatMap((e) => subtree(e.id)));
    if (!ms.length) continue;
    const single = es.length === 1;
    looseUnits.push({
      key: anchor.id,
      anchorId: anchor.id,
      label: single && /\.[^/]+$/.test(key) ? anchor.displayName.replace(/\.[a-z0-9]+$/i, '') : key,
      sublabel: single ? pathOf(anchor) : `${es.length} modules`,
      nodeKind: single ? 'entity' : 'cluster',
      members: ms,
      archetype: 'service',
      reason: '',
      realizedBy: [anchor.id],
      code: true,
    });
  }
  if (more.length) {
    const anchor = [...more].sort((a, b) => (pathOf(a)! < pathOf(b)! ? -1 : 1))[0]!;
    const ms = claim(more.flatMap((e) => subtree(e.id)));
    looseUnits.push({
      key: `more:${anchor.id}`,
      anchorId: anchor.id,
      label: `${more.length} more modules`,
      sublabel: 'smaller directories folded together',
      nodeKind: 'cluster',
      members: ms,
      archetype: 'service',
      reason: '',
      realizedBy: [anchor.id],
      code: true,
    });
  }
  // Entrypoints and other unpathed loose items join the unit of the code they start.
  const unitOfId = new Map<string, Unit>();
  for (const u of [...codeUnits, ...looseUnits]) for (const m of u.members) unitOfId.set(m, u);
  for (const e of loose) {
    if (taken.has(e.id) || isTest(e)) continue;
    const target = (nav.relationsByEntity.get(e.id) ?? [])
      .filter((r) => r.fromId === e.id && r.kind === 'calls')
      .map((r) => unitOfId.get(r.toId))
      .find(Boolean);
    if (!target) continue;
    for (const id of claim(subtree(e.id))) {
      target.members.push(id);
      unitOfId.set(id, target);
    }
  }
  for (const u of looseUnits) u.members.sort();
  for (const u of codeUnits) u.members.sort();
  codeUnits.push(...looseUnits);

  // A repo with a root package and nothing else detected (unsupported language): one box.
  if (!codeUnits.length && nav.rootPackageId) {
    const p = nav.byId.get(nav.rootPackageId)!;
    const rest = loose.filter((e) => !taken.has(e.id) && !isTest(e)).map((e) => e.id);
    codeUnits.push({
      key: p.id,
      anchorId: p.id,
      label: p.displayName,
      sublabel: 'package',
      nodeKind: 'entity',
      members: [p.id, ...claim(rest)].sort(),
      archetype: 'service',
      reason: '',
      realizedBy: [p.id],
      code: true,
    });
    taken.add(p.id);
  }
  units.push(...codeUnits);

  // Archetypes of code units from their members' signals.
  const owner = new Map<string, Unit>();
  for (const u of units) for (const m of u.members) owner.set(m, u);
  for (const u of codeUnits) Object.assign(u, codeArchetype(g, nav, u, owner));
  return units.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Nearest internal, non-root package of an entity (undefined: owned by the root package or system). */
function packageOf(nav: Nav, id: string): string | undefined {
  for (const a of [id, ...nav.ancestors(id)]) {
    const e = nav.byId.get(a);
    if (e?.kind === 'package' && a !== nav.rootPackageId && !nav.isExternal(a)) return a;
  }
  return undefined;
}

function channelUse(g: PlannerGraph, id: string): string {
  const pub = g.relations.filter((r) => r.toId === id && r.kind === 'publishes').length;
  const sub = g.relations.filter((r) => r.toId === id && r.kind === 'subscribes').length;
  return pub || sub ? ` (${pub} publisher(s), ${sub} subscriber(s))` : '';
}

const list = (xs: string[], n = 3) =>
  xs.slice(0, n).join(', ') + (xs.length > n ? `, +${xs.length - n} more` : '');

function codeArchetype(
  g: PlannerGraph,
  nav: Nav,
  u: Unit,
  owner: Map<string, Unit>,
): { archetype: Archetype; reason: string } {
  const mine = new Set(u.members);
  const ents = u.members.map((id) => nav.byId.get(id)!).filter(Boolean);
  const named = (k: string) => ents.filter((e) => e.kind === k).sort(byName);
  const ui = named('ui-surface');
  if (ui.length)
    return {
      archetype: 'client',
      reason: `Owns ${ui.length} UI route(s)/screen(s): ${list(ui.map((e) => e.displayName))}.`,
    };
  const endpoints = named('endpoint');
  if (endpoints.length)
    return {
      archetype: 'api-service',
      reason: `Exposes ${endpoints.length} endpoint(s): ${list(endpoints.map((e) => e.displayName))}.`,
    };
  const rels = (pred: (r: GraphRelation) => boolean) => g.relations.filter(pred);
  const consumed = rels((r) => r.kind === 'subscribes' && mine.has(r.fromId) && !mine.has(r.toId));
  if (consumed.length) {
    const names = [
      ...new Set(consumed.map((r) => nav.byId.get(r.toId)?.displayName ?? r.toId)),
    ].sort();
    return { archetype: 'worker', reason: `Consumes ${list(names)} (subscribes).` };
  }
  const jobs = named('job');
  if (jobs.length)
    return {
      archetype: 'worker',
      reason: `Owns ${jobs.length} job(s): ${list(jobs.map((e) => e.displayName))}.`,
    };
  const entrypoints = named('entrypoint');
  if (entrypoints.length) {
    const ep = entrypoints[0]!;
    // HTTP server evidence: the code the entrypoints start reaches endpoints or an HTTP framework
    const start = rels(
      (r) =>
        r.kind === 'calls' && mine.has(r.fromId) && nav.byId.get(r.fromId)?.kind === 'entrypoint',
    ).map((r) => r.toId);
    const seen = new Set(start);
    const queue = [...start];
    let reachedEndpoints = 0;
    const libs = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      for (const r of nav.relationsByEntity.get(id) ?? []) {
        if (r.fromId !== id) continue;
        const to = nav.byId.get(r.toId);
        if (!to) continue;
        if (r.kind === 'exposes' && to.kind === 'endpoint') reachedEndpoints++;
        if (r.kind === 'imports' && nav.isExternal(to.id) && HTTP_SERVER_LIB.test(to.displayName))
          libs.add(to.displayName);
        if (r.kind === 'imports' && !nav.isExternal(to.id) && !seen.has(to.id)) {
          seen.add(to.id);
          queue.push(to.id);
        }
      }
    }
    const types = [...new Set(entrypoints.map((e) => String(e.attributes.type ?? 'entrypoint')))];
    const mains = entrypoints.some((e) => /main$/.test(String(e.attributes.type ?? '')));
    // a Go/Java/… main in a package that serves endpoints is the server process of that package
    const homes = new Set(entrypoints.map((e) => packageOf(nav, e.id) ?? 'root'));
    const pkgEndpoints = mains
      ? g.entities.filter((e) => e.kind === 'endpoint' && homes.has(packageOf(nav, e.id) ?? 'root'))
          .length
      : 0;
    if (reachedEndpoints || libs.size || pkgEndpoints) {
      const why = reachedEndpoints
        ? `its code reaches ${reachedEndpoints} endpoint(s) through imports`
        : libs.size
          ? `it imports HTTP server framework ${list([...libs])}`
          : `it is a ${types.join('/')} in a package that exposes ${pkgEndpoints} endpoint(s)`;
      return {
        archetype: 'api-service',
        reason: `Entrypoint ${ep.displayName} starts an HTTP server: ${why}.`,
      };
    }
    const cliLike =
      entrypoints.some(
        (e) =>
          /(^|[^a-z])(cli|cmd|command)([^a-z]|$)/i.test(String(e.attributes.target ?? '')) ||
          /(^|[^a-z])cli([^a-z]|$)/i.test(e.displayName),
      ) || /(^|[^a-z])cli([^a-z]|$)/i.test(u.label);
    if (cliLike)
      return {
        archetype: 'client',
        reason: `Command-line entrypoint ${ep.displayName} (${types.join('/')}) with no endpoints: a CLI client.`,
      };
    return {
      archetype: 'worker',
      reason: `Entrypoint ${ep.displayName} (${types.join('/')}) with no endpoints and no HTTP server evidence: a background process.`,
    };
  }
  const webName = /(^|[^a-z])(web|ui|frontend|front-end|client|browser|spa)([^a-z]|$)/i;
  const callsApi = rels(
    (r) =>
      r.kind === 'calls' &&
      mine.has(r.fromId) &&
      !mine.has(r.toId) &&
      nav.byId.get(r.toId)?.kind === 'endpoint',
  );
  if (callsApi.length && webName.test(`${u.label} ${u.sublabel ?? ''}`))
    return {
      archetype: 'client',
      reason: `Web/UI code that calls ${callsApi.length} endpoint(s).`,
    };
  if (webName.test(u.label))
    return {
      archetype: 'client',
      reason: `Heuristic: named like a front end (${u.label}); no UI routes were detected.`,
    };
  const users = new Set<string>();
  for (const r of g.relations) {
    if (
      (r.kind !== 'imports' && r.kind !== 'depends-on' && r.kind !== 'calls') ||
      !mine.has(r.toId) ||
      mine.has(r.fromId)
    )
      continue;
    const o = owner.get(r.fromId);
    if (o && o.key !== u.key) users.add(o.label);
  }
  if (users.size)
    return {
      archetype: 'library',
      reason: `Internal code used by ${users.size} other box(es) (${list([...users].sort())}); no entrypoint, endpoint or UI.`,
    };
  if (callsApi.length)
    return { archetype: 'client', reason: `Calls ${callsApi.length} endpoint(s) of other boxes.` };
  return {
    archetype: 'service',
    reason: 'No entrypoint, endpoint, UI, queue or dependents detected: a generic component.',
  };
}
