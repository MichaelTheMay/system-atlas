/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are JSON read the way an agent would */
import type { DesignJobRequest } from '@atlas/schema';
import type {
  DesignRuntime,
  DesignRuntimeContext,
  DesignRuntimeResult,
} from '../design-runtime.ts';
import type { DesignToolset } from '../design-tools.ts';

/**
 * Deterministic design runtime for CI and demos (D02c). It does what an agent would, through the
 * same Atlas tools: read the System design view, group its boxes top-down (level 0 by archetype
 * layer, deeper levels by folder) and submit the groups with `atlas_propose_view`, citing the
 * evidence ids the tools returned. Same snapshot and request in, same proposals out. Free.
 */
export const MOCK_DESIGN_MODEL = 'mock-design';

interface Unit {
  entityId: string;
  label: string;
  archetype: string;
  evidenceId: string;
  path: string;
}

const LAYER: Record<string, string> = {
  client: 'Clients',
  'api-service': 'Services',
  service: 'Services',
  worker: 'Workers',
  queue: 'Messaging',
  datastore: 'Data',
  cache: 'Data',
  'external-api': 'External systems',
  library: 'Shared libraries',
};
const LAYER_RESPONSIBILITY: Record<string, string> = {
  Clients: 'User-facing applications that call the services.',
  Services: 'Request-handling services and their APIs.',
  Workers: 'Background processing of queued work.',
  Messaging: 'Queues and topics that connect producers and consumers.',
  Data: 'Databases, caches and the data they hold.',
  'External systems': 'Third-party systems this repository talks to.',
  'Shared libraries': 'Code and packages shared by the other parts.',
  Other: 'Remaining parts of the system.',
};
/** Folders that only hold other folders; grouping skips past them. */
const CONTAINERS = new Set(['packages', 'apps', 'services', 'libs', 'src', 'modules', 'cmd']);
const MAX_MEMBERS_PER_SUBSYSTEM = 6;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const title = (s: string) =>
  s
    .replace(/[^A-Za-z0-9 _.-]/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase()) || 'Other';

async function call(tools: DesignToolset, name: string, args: Record<string, unknown>) {
  const r = await tools.call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.text.slice(0, 300)}`);
  return r.data as any;
}

/** Folder that distinguishes a unit below `depth` meaningful path segments. */
function folderKey(path: string, depth: number): string | undefined {
  const segs = path
    .split('/')
    .slice(0, -1)
    .filter((s) => !CONTAINERS.has(s));
  return segs[depth];
}

async function readUnits(tools: DesignToolset, signal: AbortSignal): Promise<Unit[]> {
  const views = await call(tools, 'atlas_list_views', { workspace: 'design', limit: 200 });
  const root = (views.views as any[]).find((v) => v.lens === 'design-system');
  if (!root) throw new Error('no System design view yet: scan the project first');
  // boxes a person grouped (or promoted) stay where they are: never collect them
  const seen = new Set<string>(
    (views.views as any[]).filter((v) => v.provenance === 'accepted').map((v) => v.viewId),
  );
  const queue: string[] = [root.viewId];
  const found = new Map<string, { label: string; archetype: string }>();
  while (queue.length && seen.size < 200) {
    signal.throwIfAborted();
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const v = await call(tools, 'atlas_get_view', { viewId: id });
    for (const n of v.nodes as any[]) {
      // boxes are units; anything else that opens a view (a subsystem) holds more units
      if (n.entityId && (n.kind === 'entity' || n.kind === 'aggregate')) {
        if (!found.has(n.entityId))
          found.set(n.entityId, { label: String(n.label), archetype: String(n.archetype ?? '') });
      } else if (typeof n.opensView === 'string') queue.push(n.opensView);
    }
  }
  const units: Unit[] = [];
  for (const [entityId, u] of [...found].sort((a, b) => cmp(a[0], b[0]))) {
    signal.throwIfAborted();
    const ev = await call(tools, 'atlas_get_evidence', { entityId });
    const first = (ev.entity?.evidence as any[] | undefined)?.find((e) => e.id && e.path);
    if (!first) continue; // nothing to cite: never propose without evidence
    units.push({ entityId, ...u, evidenceId: first.id, path: String(first.path) });
  }
  return units;
}

/** Split into at most `max` named groups; the smallest overflow groups merge into "Other". */
function capGroups(groups: Map<string, Unit[]>, max: number): [string, Unit[]][] {
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]));
  if (sorted.length <= max) return sorted.sort((a, b) => cmp(a[0], b[0]));
  const kept = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1).flatMap(([, us]) => us);
  return [...kept, ['Other', rest] as [string, Unit[]]].sort((a, b) => cmp(a[0], b[0]));
}

interface Leaf {
  path: string[];
  members: Unit[];
}

function decompose(path: string[], members: Unit[], req: DesignJobRequest, out: Leaf[]): void {
  if (path.length < req.depth && members.length > MAX_MEMBERS_PER_SUBSYSTEM) {
    const by = new Map<string, Unit[]>();
    for (const u of members) {
      const k = title(folderKey(u.path, path.length - 1) ?? 'Other');
      (by.get(k) ?? by.set(k, []).get(k)!).push(u);
    }
    if (by.size > 1) {
      for (const [name, us] of capGroups(by, req.maxSubsystemsPerLevel))
        decompose([...path, name], us, req, out);
      return;
    }
  }
  out.push({ path, members });
}

async function generate(req: DesignJobRequest, ctx: DesignRuntimeContext) {
  const { tools, signal, emit, jobId } = ctx;
  const units = await readUnits(tools, signal);
  emit({
    type: 'progress',
    jobId,
    level: 0,
    message: `read ${units.length} box(es) with evidence`,
  });
  if (!units.length) return;
  const layers = new Map<string, Unit[]>();
  for (const u of units) {
    const k = LAYER[u.archetype] ?? 'Other';
    (layers.get(k) ?? layers.set(k, []).get(k)!).push(u);
  }
  const leaves: Leaf[] = [];
  for (const [name, us] of capGroups(layers, req.maxSubsystemsPerLevel))
    decompose([name], us, req, leaves);
  const levels = Math.max(...leaves.map((l) => l.path.length));
  for (let level = 0; level < levels; level++) {
    signal.throwIfAborted();
    const here = leaves.filter((l) => l.path.length === level + 1);
    if (!here.length) continue;
    emit({
      type: 'progress',
      jobId,
      level,
      message: `level ${level}: proposing ${here.length} subsystem(s)`,
    });
    const entries = here.flatMap((l) => {
      const out = [];
      for (let i = 0; i < l.members.length; i += 25)
        out.push({
          name: l.path.join('/'),
          responsibility: LAYER_RESPONSIBILITY[l.path[0]!] ?? LAYER_RESPONSIBILITY.Other,
          members: l.members.slice(i, i + 25).map((u) => ({
            entityId: u.entityId,
            citations: [{ evidenceId: u.evidenceId }],
          })),
        });
      return out;
    });
    for (let i = 0; i < entries.length; i += 10)
      await call(tools, 'atlas_propose_view', {
        snapshotId: req.snapshotId,
        subsystems: entries.slice(i, i + 10),
        model: MOCK_DESIGN_MODEL,
      });
  }
}

async function targetsOf(req: DesignJobRequest, ctx: DesignRuntimeContext): Promise<Unit[]> {
  const out: Unit[] = [];
  for (const id of req.targetIds.filter((t) => /^ent_[0-9a-f]{16,64}$/.test(t)).sort()) {
    ctx.signal.throwIfAborted();
    const d = await call(ctx.tools, 'atlas_get_entity', { entityId: id });
    const first = (d.evidence as any[] | undefined)?.find((e) => e.id && e.path);
    if (!first) continue;
    out.push({
      entityId: id,
      label: String(d.entity?.displayName ?? id),
      archetype: '',
      evidenceId: first.id,
      path: String(first.path),
    });
  }
  return out;
}

function commonName(units: Unit[]): string {
  const keys = units.map((u) => folderKey(u.path, 0) ?? u.label);
  const first = keys[0];
  return first && keys.every((k) => k === first)
    ? title(first)
    : `${title(units[0]?.label ?? 'Selection')} group`;
}

async function copilot(
  req: DesignJobRequest,
  ctx: DesignRuntimeContext,
): Promise<DesignRuntimeResult['output']> {
  const units = await targetsOf(req, ctx);
  if (!units.length) throw new Error('select at least one entity with evidence');
  const evidenceIds = units.map((u) => u.evidenceId);
  switch (req.kind) {
    case 'propose-grouping': {
      const name = commonName(units);
      const r = await call(ctx.tools, 'atlas_propose_view', {
        snapshotId: req.snapshotId,
        model: MOCK_DESIGN_MODEL,
        subsystems: [
          {
            name,
            members: units.slice(0, 25).map((u) => ({
              entityId: u.entityId,
              citations: [{ evidenceId: u.evidenceId }],
            })),
          },
        ],
      });
      return { data: { name, members: units.map((u) => u.entityId), result: r } };
    }
    case 'name-subsystem': {
      const name = commonName(units);
      return {
        data: {
          name,
          responsibility: `Groups ${units.map((u) => u.label).join(', ')}.`,
          evidenceIds,
        },
      };
    }
    case 'explain-flow': {
      const [a, b] = units;
      const d = await call(ctx.tools, 'atlas_get_entity', { entityId: a!.entityId });
      const kinds = [
        ...new Set(
          ((d.relations as any[]) ?? [])
            .filter((r) => b && (r.other?.id === b.entityId || r.otherId === b.entityId))
            .map((r) => String(r.kind)),
        ),
      ].sort();
      const explanation = b
        ? kinds.length
          ? `${a!.label} ${kinds.join(', ')} ${b.label} (see ${a!.path}).`
          : `No detected relation connects ${a!.label} and ${b.label}.`
        : `${a!.label} is defined in ${a!.path}.`;
      return { data: { explanation, evidenceIds }, text: explanation };
    }
    case 'suggest-responsibilities': {
      const r = await call(ctx.tools, 'atlas_propose_claims', {
        snapshotId: req.snapshotId,
        model: MOCK_DESIGN_MODEL,
        claims: units.slice(0, 25).map((u) => ({
          subjectId: u.entityId,
          predicate: 'responsibility',
          value: `${u.label}: defined in ${u.path}.`,
          citations: [{ evidenceId: u.evidenceId }],
        })),
      });
      return { data: { result: r } };
    }
    default:
      return undefined;
  }
}

export function createMockDesignRuntime(): DesignRuntime {
  return {
    id: 'mock',
    async check() {
      return { available: true, detail: 'deterministic mock (no model, free)', external: false };
    },
    async run(request, ctx) {
      ctx.signal.throwIfAborted();
      const output =
        request.kind === 'generate'
          ? (await generate(request, ctx), undefined)
          : await copilot(request, ctx);
      return {
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        model: MOCK_DESIGN_MODEL,
        output,
      };
    },
  };
}
