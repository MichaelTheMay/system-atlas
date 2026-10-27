import { planDesign, projectDesign, type Archetype, type Projection } from '@atlas/planner';
import { BoardSpec, idSchema, type ComponentType, type DesignBoard } from '@atlas/schema';
import type { Db } from '@atlas/store';
import { createBoard, documentFromSpec, type BoardResult } from './boards.ts';
import { isCompacted, loadPlannerGraph } from './scan.ts';

/**
 * "From code" import of a design board (D03): the D01 derived design lens (`planDesign` /
 * `projectDesign`) of a snapshot drawn once as a starting point. The board is design-first view
 * data: it copies boxes and flows at import time, marks them `origin.author = 'code'` (drawn faded,
 * "as built") and never reads or writes code facts afterwards. Entity ids are kept only as hints.
 */

const COMPONENT_OF: Record<Archetype, ComponentType> = {
  client: 'web-client',
  'api-service': 'service',
  worker: 'worker',
  queue: 'queue',
  datastore: 'sql-db',
  cache: 'cache',
  'external-api': 'third-party-api',
  library: 'box',
  service: 'service',
};

const entityId = idSchema('entity');
const code = { author: 'code' as const };

/** Whiteboard flow label (HTTP, enqueue, consume, reads/writes, uses, runs on) → connection fields. */
function flowFields(flow: string | undefined): Partial<BoardSpec['connections'][number]> {
  const f = (flow ?? '').toLowerCase();
  if (/\bhttp\b/.test(f)) return { protocol: 'HTTP' };
  if (/grpc/.test(f)) return { protocol: 'gRPC' };
  if (/read|write|sql|query/.test(f)) return { protocol: 'SQL' };
  if (/enqueue|consume|publish|subscribe|event/.test(f))
    return { protocol: 'other', mode: 'async', direction: 'one-way' };
  return {};
}

/** Board ids are short opaque strings (≤ 64 chars, no separators). */
const localKey = (raw: string, used: Set<string>) => {
  const base =
    raw
      .replace(/^box:/, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'c';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
};

/** A design-system projection as a layout-free BoardSpec, everything in one "as built" frame. */
export function boardSpecFromProjection(p: Projection, date = new Date()): BoardSpec {
  const used = new Set<string>();
  const idOf = new Map<string, string>();
  const components: BoardSpec['components'] = [];
  for (const n of p.nodes) {
    if (!n.archetype || n.kind === 'sticky' || n.kind === 'gap' || n.kind === 'port') continue;
    const id = localKey(n.id, used);
    idOf.set(n.id, id);
    const responsibility = [n.sublabel, n.archetypeReason].filter(Boolean).join(' — ');
    components.push({
      id,
      type: COMPONENT_OF[n.archetype] ?? 'box',
      label: (n.label.trim() || id).slice(0, 120),
      props: {},
      ...(responsibility ? { responsibility: responsibility.slice(0, 500) } : {}),
      entityIds: n.entityId && entityId.safeParse(n.entityId).success ? [n.entityId] : [],
      origin: code,
      status: 'active',
    });
  }
  const connections: BoardSpec['connections'] = [];
  const conUsed = new Set<string>();
  for (const e of p.edges) {
    const from = idOf.get(e.source);
    const to = idOf.get(e.target);
    if (!from || !to || from === to) continue;
    const fields = flowFields(e.flow);
    // the flow label is the payload, unless it only repeats the protocol ("HTTP")
    const payload =
      e.flow && e.flow.toLowerCase() !== fields.protocol?.toLowerCase()
        ? e.flow.slice(0, 120)
        : undefined;
    connections.push({
      id: localKey(`k-${from}-${to}`, conUsed),
      from,
      to,
      mode: 'sync',
      direction: 'request-response',
      ...fields,
      ...(payload ? { payload } : {}),
      origin: code,
      status: 'active',
    });
  }
  return BoardSpec.parse({
    title: p.title,
    summary: `Imported from the code's derived design lens (snapshot ${p.snapshotId}). Edit freely: the board does not follow later code changes.`,
    components,
    connections,
    frames: [
      {
        id: 'as-built',
        label: `As built (from code, ${date.toISOString().slice(0, 10)})`,
        componentIds: components.map((c) => c.id),
      },
    ],
  });
}

/** Latest published snapshot of any worktree of the project (what "from code" imports by default). */
export function latestProjectSnapshot(db: Db, projectId: string): string | undefined {
  return db
    .prepare(
      `SELECT id FROM snapshots WHERE project_id = ? AND state IN ('ready','partial')
       ORDER BY published_at DESC LIMIT 1`,
    )
    .get<{ id: string }>(projectId)?.id;
}

export function createBoardFromCode(
  db: Db,
  projectId: string,
  input: { snapshotId?: string; name?: string },
): BoardResult<{ board: DesignBoard }> {
  const snapshotId = input.snapshotId ?? latestProjectSnapshot(db, projectId);
  if (!snapshotId) return { ok: false, status: 409, error: 'no_snapshot' };
  const snap = db
    .prepare(
      "SELECT project_id FROM snapshots WHERE id = ? AND state IN ('ready','partial','superseded')",
    )
    .get<{ project_id: string }>(snapshotId);
  if (!snap || snap.project_id !== projectId)
    return { ok: false, status: 400, error: 'snapshotId is not a snapshot of this project' };
  if (isCompacted(db, snapshotId)) return { ok: false, status: 409, error: 'compacted' };
  const graph = loadPlannerGraph(db, snapshotId);
  const catalog = planDesign(graph);
  const root = catalog.canvases.find((c) => c.lens === 'design-system');
  if (!root) return { ok: false, status: 409, error: 'nothing to import: no design boxes' };
  const spec = boardSpecFromProjection(projectDesign(graph, catalog, root.id));
  if (!spec.components.length)
    return { ok: false, status: 409, error: 'nothing to import: no design boxes' };
  return createBoard(db, projectId, {
    name: input.name?.trim() || 'As built (from code)',
    source: 'code',
    document: documentFromSpec(spec, 'code'),
  });
}
