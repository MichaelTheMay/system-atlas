import {
  planDesign,
  projectDesign,
  type Archetype,
  type PlannerGraph,
  type Projection,
} from '@atlas/planner';
import { BoardSpec, idSchema, type ComponentType, type DesignBoard } from '@atlas/schema';
import type { Db } from '@atlas/store';
import { createBoard, documentFromSpec, patchBoard, type BoardResult } from './boards.ts';
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

/** BoardSpec limits (schema): a crowded canvas keeps its heaviest flows and says what it dropped. */
const MAX_COMPONENTS = 300;
const MAX_CONNECTIONS = 600;
/** Lowest board level: root 0, internals 1, internals of those 2 (`createBoard` allows no deeper). */
const MAX_BOARD_LEVEL = 2;
/** Subsystems below the lowest board that are drawn in place, one frame each (frames cap at 50). */
const MAX_INLINE_FRAMES = 40;

interface SpecOptions {
  /** Summary of the board (the root says it is an import; a sub-board names what it details). */
  summary?: string;
  /** Subsystems drawn in place: their boxes go into a frame of their own. */
  inline?: { label: string; nodeIds: Set<string> }[];
}

/**
 * A design projection as a layout-free BoardSpec. Boxes go into an "as built" frame (or the frame
 * of the subsystem they are drawn in place for), and context ports become faded "outside" stubs in
 * a frame of their own, so flows that leave the board still show where they go.
 */
function specOf(
  p: Projection,
  date: Date,
  opts: SpecOptions = {},
): { spec: BoardSpec; idOf: Map<string, string> } {
  const used = new Set<string>();
  const idOf = new Map<string, string>();
  const components: BoardSpec['components'] = [];
  const stubs: string[] = [];
  const nodes = p.nodes.filter((n) => n.archetype && n.kind !== 'sticky' && n.kind !== 'gap');
  // boxes of the board first: when the canvas is over the limit, the stubs are what is left out
  for (const n of [
    ...nodes.filter((x) => x.kind !== 'port'),
    ...nodes.filter((x) => x.kind === 'port'),
  ]) {
    if (components.length >= MAX_COMPONENTS) break;
    const port = n.kind === 'port';
    const id = localKey(port ? `out-${n.id.replace(/^(box|port):/, '')}` : n.id, used);
    idOf.set(n.id, id);
    if (port) stubs.push(id);
    const label = (n.label.trim() || id).slice(0, port ? 111 : 120);
    const responsibility = port
      ? `Outside this board${n.openCanvasId ? ' (a subsystem)' : ''}; drawn for the flows that cross its edge.`
      : [n.sublabel, n.archetypeReason].filter(Boolean).join(' — ');
    components.push({
      id,
      // a subsystem or an outside stub is a plain box: its members decide what it is
      type: port || n.openCanvasId ? 'box' : (COMPONENT_OF[n.archetype!] ?? 'box'),
      label: port ? `outside: ${label}` : label,
      props: {},
      ...(responsibility ? { responsibility: responsibility.slice(0, 500) } : {}),
      entityIds: !port && n.entityId && entityId.safeParse(n.entityId).success ? [n.entityId] : [],
      origin: code,
      status: 'active',
    });
  }
  const weight = (e: Projection['edges'][number]) =>
    Object.values(e.kinds).reduce((a, b) => a + b, 0);
  const edges = p.edges
    .filter((e) => idOf.has(e.source) && idOf.has(e.target) && e.source !== e.target)
    .map((e, i) => ({ e, i }));
  const kept = new Set(
    [...edges]
      .sort((a, b) => weight(b.e) - weight(a.e) || a.i - b.i)
      .slice(0, MAX_CONNECTIONS)
      .map((x) => x.i),
  );
  const connections: BoardSpec['connections'] = [];
  const conUsed = new Set<string>();
  /** `source>target` node ids -> connection id, for binding flow steps to their hop. */
  const connOf = new Map<string, string>();
  for (const { e, i } of edges) {
    if (!kept.has(i)) continue;
    const from = idOf.get(e.source)!;
    const to = idOf.get(e.target)!;
    const fields = flowFields(e.flow);
    // the flow label is the payload, unless it only repeats the protocol ("HTTP")
    const payload =
      e.flow && e.flow.toLowerCase() !== fields.protocol?.toLowerCase()
        ? e.flow.slice(0, 120)
        : undefined;
    const id = localKey(`k-${from}-${to}`, conUsed);
    if (!connOf.has(`${e.source}>${e.target}`)) connOf.set(`${e.source}>${e.target}`, id);
    connections.push({
      id,
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
  const frames: BoardSpec['frames'] = [];
  const framed = new Set<string>(stubs);
  const inline = (opts.inline ?? []).map((f) => ({
    label: f.label,
    componentIds: [...f.nodeIds].flatMap((id) => (idOf.has(id) ? [idOf.get(id)!] : [])),
  }));
  for (const f of inline) for (const id of f.componentIds) framed.add(id);
  const own = components.map((c) => c.id).filter((id) => !framed.has(id));
  if (own.length)
    frames.push({
      id: localKey('as-built', used),
      label: `As built (from code, ${date.toISOString().slice(0, 10)})`,
      componentIds: own,
    });
  for (const f of inline)
    if (f.componentIds.length)
      frames.push({
        id: localKey(`frame-${f.label}`, used),
        label: f.label.slice(0, 120),
        componentIds: f.componentIds,
      });
  if (stubs.length)
    frames.push({
      id: localKey('outside', used),
      label: 'Outside this board',
      componentIds: stubs,
    });
  // request flows derived from code (D04): scenarios over this board's boxes and hops
  const scenarios: BoardSpec['scenarios'] = [];
  for (const f of p.flows ?? []) {
    const steps: BoardSpec['scenarios'][number]['steps'] = [];
    for (const st of f.steps) {
      const text = st.text.slice(0, 500);
      const id = `st-${steps.length + 1}`;
      if (st.target) {
        const connectionId = connOf.get(`${st.source}>${st.target}`);
        if (connectionId) steps.push({ id, connectionId, text });
      } else if (idOf.has(st.source)) steps.push({ id, componentId: idOf.get(st.source)!, text });
    }
    if (steps.length >= 2)
      scenarios.push({
        id: f.id,
        name: f.name.slice(0, 120),
        description: f.description.slice(0, 1000),
        steps,
        origin: code,
        status: 'active',
      });
  }
  const dropped = edges.length - connections.length;
  const summary =
    (opts.summary ??
      `Imported from the code's derived design lens (snapshot ${p.snapshotId}). Edit freely: the board does not follow later code changes.`) +
    (dropped
      ? ` ${dropped} lighter flow(s) of ${edges.length} were left out to keep the board within its limits.`
      : '');
  return {
    spec: BoardSpec.parse({ title: p.title, summary, components, connections, scenarios, frames }),
    idOf,
  };
}

/** A design projection as a layout-free BoardSpec (one board, no sub-boards). */
export function boardSpecFromProjection(p: Projection, date = new Date()): BoardSpec {
  // flows come with the projection when it was made with `{ flows: true }`
  return specOf(p, date).spec;
}

const FLOWS = { flows: true } as const;

/** A board and the sub-boards that detail its subsystem boxes. */
export interface BoardTree {
  spec: BoardSpec;
  /** `componentId` is the subsystem box on this board that `tree` shows the internals of. */
  children: { componentId: string; tree: BoardTree }[];
}

/**
 * The whole derived design as a tree of boards (D04): one board per design canvas, each subsystem
 * box linked to the board of its canvas. Boards nest two levels below the root; subsystems below
 * that are drawn in place on the lowest board, each in a frame of its own, so nothing is lost.
 * Pure: reads the graph, writes nothing.
 */
export function boardTreeFromDesign(graph: PlannerGraph, date = new Date()): BoardTree | undefined {
  const catalog = planDesign(graph);
  const root = catalog.canvases.find((c) => c.lens === 'design-system');
  if (!root) return undefined;
  const isSubsystem = new Set(
    catalog.canvases.filter((c) => c.lens === 'design-subsystem').map((c) => c.id),
  );
  /** Subsystem boxes of a canvas, by name (node ids are hashes: their order means nothing). */
  const opened = (p: Projection) =>
    p.nodes
      .filter((n) => n.kind !== 'port' && n.openCanvasId && isSubsystem.has(n.openCanvasId))
      .sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1));
  const build = (canvasId: string, level: number, seen: Set<string>): BoardTree => {
    let p = projectDesign(graph, catalog, canvasId, FLOWS);
    const summary =
      level === 0
        ? undefined
        : `Internals of "${p.title}", imported from the code's derived design lens (snapshot ${p.snapshotId}). Edit freely: the board does not follow later code changes.`;
    const subs = opened(p).filter((n) => !seen.has(n.openCanvasId!));
    if (level < MAX_BOARD_LEVEL) {
      const { spec, idOf } = specOf(p, date, { summary });
      return {
        spec,
        children: subs.map((n) => ({
          componentId: idOf.get(n.id)!,
          tree: build(n.openCanvasId!, level + 1, new Set([...seen, canvasId])),
        })),
      };
    }
    // lowest board: draw the subsystems below it in place (their member boxes, one frame each)
    const flat = subs.slice(0, MAX_INLINE_FRAMES);
    const inline = flat.map((n) => ({
      label: n.label,
      nodeIds: new Set(
        projectDesign(graph, catalog, n.openCanvasId!)
          .nodes.filter((x) => x.kind !== 'port')
          .map((x) => x.id),
      ),
    }));
    if (flat.length)
      p = projectDesign(
        {
          ...graph,
          overrides: [
            ...(graph.overrides ?? []),
            ...flat.map((n) => ({ targetId: n.openCanvasId!, action: 'suppress' as const })),
          ],
        },
        catalog,
        canvasId,
        FLOWS,
      );
    return { spec: specOf(p, date, { summary, inline }).spec, children: [] };
  };
  return build(root.id, 0, new Set());
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

type Refusal = Extract<BoardResult<object>, { ok: false }>;
class Abort extends Error {
  readonly result: Refusal;
  constructor(result: Refusal) {
    super(result.error);
    this.result = result;
  }
}

const boardName = (s: string) => s.trim().slice(0, 120) || 'Untitled board';

/**
 * Stores a board tree: the root, then each sub-board under its parent, with the parent's subsystem
 * box linked to it. All or nothing: any refusal (nesting too deep, an invalid document) rolls the
 * whole tree back.
 */
export function persistBoardTree(
  db: Db,
  projectId: string,
  tree: BoardTree,
  name: string,
): BoardResult<{ board: DesignBoard; boards: number }> {
  try {
    return db.transaction(() => {
      let boards = 0;
      const make = (t: BoardTree, title: string, parentBoardId?: string): DesignBoard => {
        const made = createBoard(db, projectId, {
          name: boardName(title),
          source: 'code',
          document: documentFromSpec(t.spec, 'code'),
          ...(parentBoardId ? { parentBoardId } : {}),
        });
        if (!made.ok) throw new Abort(made);
        boards++;
        if (!t.children.length) return made.board;
        const document = structuredClone(made.board.document);
        /** component id -> the board of its internals and the flows told on it */
        const below = new Map<string, { boardId: string; flows: Set<string> }>();
        for (const c of t.children) {
          const component = document.components[c.componentId];
          if (!component)
            throw new Abort({ ok: false, status: 400, error: `no component ${c.componentId}` });
          const child = make(
            c.tree,
            `${c.tree.spec.title ?? component.label} — internals`,
            made.board.id,
          );
          component.internalsBoardId = child.id;
          below.set(c.componentId, {
            boardId: child.id,
            flows: new Set(c.tree.spec.scenarios.map((s) => s.id)),
          });
        }
        // a flow step through a subsystem box opens the same flow one level down: the box it
        // happens in, else the box its hop enters, else the one it leaves; once per box and flow
        for (const sc of document.scenarios) {
          const opened = new Set<string>();
          for (const st of sc.steps) {
            const k = st.connectionId ? document.connections[st.connectionId] : undefined;
            const via = (k ? [k.to, k.from] : [st.componentId]).find(
              (id) => id && !opened.has(id) && below.get(id)?.flows.has(sc.id),
            );
            if (!via) continue;
            opened.add(via);
            st.drillInto = { boardId: below.get(via)!.boardId, scenarioId: sc.id };
          }
        }
        const linked = patchBoard(db, made.board.id, { document, revision: made.board.revision });
        if (!linked.ok) throw new Abort(linked);
        return linked.board;
      };
      const board = make(tree, name);
      return { ok: true as const, board, boards };
    });
  } catch (e) {
    if (e instanceof Abort) return e.result;
    throw e;
  }
}

/**
 * New boards (`source: 'code'`) holding the "as built" design: the root board and, linked from
 * its subsystem boxes, one sub-board per design subsystem (D04). Returns the root.
 */
export function createBoardFromCode(
  db: Db,
  projectId: string,
  input: { snapshotId?: string; name?: string },
): BoardResult<{ board: DesignBoard; boards: number }> {
  const r = designOf(db, projectId, input.snapshotId);
  if (!r.ok) return r;
  const tree = boardTreeFromDesign(r.graph);
  if (!tree?.spec.components.length)
    return { ok: false, status: 409, error: 'nothing to import: no design boxes' };
  return persistBoardTree(db, projectId, tree, input.name?.trim() || 'As built (from code)');
}

/**
 * The "as built" spec of the top level of a project's snapshot (latest by default), without
 * creating a board. Subsystem boxes stay plain boxes: importing into an open drawing never adds
 * sub-boards.
 */
export function codeSpecOf(
  db: Db,
  projectId: string,
  snapshotIdArg?: string,
): BoardResult<{ spec: BoardSpec; snapshotId: string }> {
  const r = designOf(db, projectId, snapshotIdArg);
  if (!r.ok) return r;
  const catalog = planDesign(r.graph);
  const root = catalog.canvases.find((c) => c.lens === 'design-system');
  if (!root) return { ok: false, status: 409, error: 'nothing to import: no design boxes' };
  const spec = boardSpecFromProjection(projectDesign(r.graph, catalog, root.id, FLOWS));
  if (!spec.components.length)
    return { ok: false, status: 409, error: 'nothing to import: no design boxes' };
  return { ok: true, spec, snapshotId: r.snapshotId };
}

/** Planner graph of a project's snapshot (latest by default), or why it cannot be imported. */
function designOf(
  db: Db,
  projectId: string,
  snapshotIdArg?: string,
): BoardResult<{ graph: PlannerGraph; snapshotId: string }> {
  const snapshotId = snapshotIdArg ?? latestProjectSnapshot(db, projectId);
  if (!snapshotId) return { ok: false, status: 409, error: 'no_snapshot' };
  const snap = db
    .prepare(
      "SELECT project_id FROM snapshots WHERE id = ? AND state IN ('ready','partial','superseded')",
    )
    .get<{ project_id: string }>(snapshotId);
  if (!snap || snap.project_id !== projectId)
    return { ok: false, status: 400, error: 'snapshotId is not a snapshot of this project' };
  if (isCompacted(db, snapshotId)) return { ok: false, status: 409, error: 'compacted' };
  return { ok: true, graph: loadPlannerGraph(db, snapshotId), snapshotId };
}
