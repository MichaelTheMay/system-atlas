import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  projectionToCanvas,
  projectionToMermaid,
  runToCanvas,
  SIDECAR_FORMAT,
  STANDARD_DISCLOSURES,
  validateJsonCanvas,
  type NoteLike,
  type ProjectionLike,
  type RunLike,
  type SidecarView,
} from '@atlas/export';
import { createElkLayoutEngine } from '@atlas/layout';

/**
 * `atlas export`: views of a snapshot as linked JSON Canvas files (or Mermaid), and runs as
 * canvases with their artifacts beside them. Positions follow what the user saw (pins and
 * remembered layout). Artifact bytes come only from the isolated preview origin and are verified
 * against their recorded hash; HTML/SVG (active content) are never copied, logs only on request.
 */
export interface ExportOptions {
  daemon: { baseUrl: string; token: string };
  rootPath: string;
  output: string;
  snapshotId?: string;
  views?: string[];
  runs?: string[];
  format?: 'canvas' | 'mermaid';
  includeLogs?: boolean;
}

export interface ExportResult {
  output: string;
  files: string[];
  disclosures: string[];
  problems: string[];
}

const W = 260;
const H = 150;
const SX = W / 190;
const SY = H / 56;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'view';
/** Markdown-escape text placed in a canvas text node (same rule as @atlas/export). */
const md = (s: string) => s.replace(/([\\`*_[\]<>#|])/g, '\\$1');
const SAFE_MEDIA =
  /^(image\/(png|jpeg|gif|webp)|application\/(json|pdf)|text\/(plain|csv|markdown))$/;

export async function exportToDir(o: ExportOptions): Promise<ExportResult> {
  if (existsSync(o.output) && readdirSync(o.output).length)
    throw new Error(`${o.output} is not empty; choose a new or empty directory`);
  mkdirSync(o.output, { recursive: true });
  const api = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${o.daemon.baseUrl}/api/v1${path}`, {
      headers: { authorization: `Bearer ${o.daemon.token}` },
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  };
  const reg = await fetch(`${o.daemon.baseUrl}/api/v1/projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ rootPath: o.rootPath }),
  }).then(
    (r) =>
      r.json() as Promise<{
        project: { id: string; displayName: string };
        worktree: { id: string };
      }>,
  );
  const out: ExportResult = {
    output: o.output,
    files: [],
    disclosures: [...STANDARD_DISCLOSURES],
    problems: [],
  };
  const write = (rel: string, data: string | Uint8Array) => {
    mkdirSync(join(o.output, rel, '..'), { recursive: true });
    writeFileSync(join(o.output, rel), data);
    out.files.push(rel);
  };
  const sidecar: Record<string, unknown> = {
    ...SIDECAR_FORMAT,
    exportedAt: new Date().toISOString(),
    project: { id: reg.project.id, name: reg.project.displayName },
  };

  const wantViews = o.views?.length || !o.runs?.length;
  if (wantViews) {
    const snapshotId =
      o.snapshotId ??
      (await api<{ snapshot: { id: string } }>(`/worktrees/${reg.worktree.id}/snapshot`)).snapshot
        .id;
    const catalog = await api<{
      canvases: { id: string; title: string; lens: string; workspace?: string }[];
    }>(`/snapshots/${snapshotId}/canvases`);
    const chosen = o.views?.length
      ? catalog.canvases.filter((c) => o.views!.includes(c.id) || o.views!.includes(c.title))
      : catalog.canvases;
    if (o.views?.length && chosen.length < o.views.length)
      out.problems.push(
        `not found in snapshot ${snapshotId}: ${o.views.filter((v) => !chosen.some((c) => c.id === v || c.title === v)).join(', ')}`,
      );
    const names = new Map<string, string>();
    for (const c of chosen) {
      let n = `${slug(c.title)}.${o.format === 'mermaid' ? 'mmd' : 'canvas'}`;
      if ([...names.values()].includes(n))
        n = n.replace(/\.(canvas|mmd)$/, `-${c.id.slice(4, 10)}.$1`);
      names.set(c.id, n);
    }
    const titles = new Map(chosen.map((c) => [c.id, c.title]));
    const engine = createElkLayoutEngine();
    const views: SidecarView[] = [];
    for (const c of chosen) {
      const p = {
        ...(await api<DesignProjection & { viewId: string }>(
          `/snapshots/${snapshotId}/canvases/${c.id}/projection`,
        )),
        workspace: c.workspace,
      };
      const file = `views/${names.get(c.id)!}`;
      if (o.format === 'mermaid') {
        const m = projectionToMermaid(p);
        write(file, m.text);
        if (!out.disclosures.includes(m.disclosures[0]!)) out.disclosures.push(...m.disclosures);
        continue;
      }
      const overlay = await api<{
        entityPositions: Record<string, { x: number; y: number }>;
        nodePositions: Record<string, { x: number; y: number }>;
        autoPositions?: Record<string, { x: number; y: number }>;
        annotations: NoteLike[];
      }>(`/views/${p.viewId}/overlay?project=${reg.project.id}&snapshot=${snapshotId}`);
      const key = (n: ProjectionLike['nodes'][number]) =>
        n.kind === 'entity' && n.entityId ? n.entityId : n.id;
      const groups = new Set(p.nodes.filter((n) => n.kind === 'group').map((n) => n.id));
      // design boxes carry two more lines (archetype, "Realized by"); give them room
      const boxH = p.workspace === 'design' ? 82 : 56;
      // the user's map: pins, then remembered positions; laid out in UI units, then scaled for text
      const layout = await engine.layout({
        nodes: p.nodes.map((n) => {
          const fixed = n.parentId
            ? undefined
            : ((n.kind === 'entity' && n.entityId
                ? overlay.entityPositions[n.entityId]
                : overlay.nodePositions[n.id]) ?? overlay.autoPositions?.[key(n)]);
          return {
            id: n.id,
            width: n.kind === 'group' ? 260 : 190,
            height: n.kind === 'group' ? 80 : boxH,
            parentId: n.parentId && groups.has(n.parentId) ? n.parentId : undefined,
            fixed,
          };
        }),
        edges: p.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        direction: p.lens === 'changes' || p.lens === 'coverage' ? 'DOWN' : 'RIGHT',
      });
      const positions = Object.fromEntries(
        Object.entries(layout.positions).map(([id, r]) => {
          const isGroup = groups.has(id);
          return [
            id,
            {
              x: r.x * SX,
              y: r.y * SY,
              width: isGroup ? r.width * SX : W - 10,
              height: isGroup ? r.height * SY : boxH * SY - 10,
            },
          ];
        }),
      );
      const r = projectionToCanvas(p, positions, {
        file,
        notes: overlay.annotations,
        // root-relative, like JSON Canvas file paths
        fileFor: (id) => (names.has(id) ? `views/${names.get(id)}` : undefined),
      });
      if (p.workspace === 'design') designDetails(p, r, names, titles, out.disclosures);
      const problems = validateJsonCanvas(r.canvas);
      if (problems.length) out.problems.push(...problems.map((x) => `${file}: ${x}`));
      write(file, JSON.stringify(r.canvas, null, 2));
      views.push(r.sidecar);
      out.disclosures.push(...r.disclosures);
    }
    sidecar.snapshotId = snapshotId;
    sidecar.views = views;
  }

  const runs: unknown[] = [];
  for (const runId of o.runs ?? []) {
    const d = await api<
      RunLike & { artifacts: (RunLike['artifacts'][number] & { sha256?: string })[] }
    >(`/runs/${runId}`);
    const dir = `runs/${slug(d.run.commandSummary ?? d.run.adapter)}-${runId.slice(4, 12)}`;
    const assets = new Map<string, string>();
    const used = new Set<string>();
    for (const a of d.artifacts) {
      if (a.bytesState !== 'available') continue;
      if (a.role === 'log' && !o.includeLogs) continue;
      if (!SAFE_MEDIA.test(a.mediaType)) continue; // HTML, SVG and unknown types are never copied
      const pre = await api<{ url: string }>(`/artifacts/${a.id}/preview-url?raw=1`);
      const bytes = new Uint8Array(await (await fetch(pre.url)).arrayBuffer());
      if (a.sha256 && createHash('sha256').update(bytes).digest('hex') !== a.sha256) {
        out.problems.push(`${a.logicalName}: bytes did not match the recorded hash; not exported`);
        continue;
      }
      let name =
        a.logicalName
          .split('/')
          .pop()!
          .replace(/[^A-Za-z0-9._-]/g, '_') || a.id;
      while (used.has(name)) name = `${a.id.slice(4, 10)}-${name}`;
      used.add(name);
      write(`${dir}/artifacts/${name}`, bytes);
      // JSON Canvas paths are relative to the export root (the "vault"), not to the canvas file
      assets.set(a.id, `${dir}/artifacts/${name}`);
    }
    const r = runToCanvas(d, (id) => assets.get(id));
    const problems = validateJsonCanvas(r.canvas);
    if (problems.length) out.problems.push(...problems.map((x) => `${dir}/run.canvas: ${x}`));
    write(`${dir}/run.canvas`, JSON.stringify(r.canvas, null, 2));
    out.disclosures.push(...r.disclosures);
    runs.push({
      runId,
      file: `${dir}/run.canvas`,
      snapshotId: d.run.snapshotId ?? null,
      artifacts: [...assets.entries()].map(([artifactId, file]) => ({ artifactId, file })),
    });
  }
  if (runs.length) sidecar.runs = runs;
  sidecar.disclosures = out.disclosures;
  write('atlas-export.json', JSON.stringify(sidecar, null, 2));
  return out;
}

/** Design-lens fields of a projection (D01) that the generic converter does not know about. */
type DesignProjection = Omit<ProjectionLike, 'nodes' | 'edges'> & {
  workspace?: string;
  nodes: (ProjectionLike['nodes'][number] & {
    archetype?: string;
    provenance?: string;
    realizedByCanvasId?: string;
  })[];
  edges: (ProjectionLike['edges'][number] & { flow?: string })[];
};

/**
 * System-design canvases (D01): each box states its archetype and provenance and links to the
 * architecture canvas that realizes it ("Realized by"); flows are labeled as on the whiteboard.
 * Links use the same root-relative file names as drill-down links; targets outside the export are
 * counted in a disclosure instead.
 */
function designDetails(
  p: DesignProjection,
  r: ReturnType<typeof projectionToCanvas>,
  names: Map<string, string>,
  titles: Map<string, string>,
  disclosures: string[],
): void {
  const nodeOf = new Map(r.sidecar.nodes.map((n) => [n.atlasNodeId, n.canvasNodeId]));
  const textNodes = new Map(
    r.canvas.nodes.flatMap((n) => (n.type === 'text' ? [[n.id, n] as const] : [])),
  );
  let unlinked = 0;
  for (const n of p.nodes) {
    const t = textNodes.get(nodeOf.get(n.id) ?? '');
    if (!t) continue;
    const label = [n.archetype, n.provenance && n.provenance !== 'detected' ? n.provenance : '']
      .filter(Boolean)
      .join(' · ');
    const lines = label ? [`_${label}_`] : [];
    if (n.realizedByCanvasId) {
      const f = names.get(n.realizedByCanvasId);
      if (f)
        lines.push(
          `[Realized by: ${md(titles.get(n.realizedByCanvasId) ?? f)} →](${encodeURI(`views/${f}`)})`,
        );
      else unlinked++;
    }
    if (lines.length) t.text = [t.text, ...lines].join('\n\n');
  }
  // projectionToCanvas keeps, in order, the edges whose two ends are nodes; pair them the same way
  const kept = p.edges.filter((e) => nodeOf.has(e.source) && nodeOf.has(e.target));
  const edges = new Map(r.canvas.edges.map((e) => [e.id, e]));
  kept.forEach((e, i) => {
    const ce = edges.get(r.sidecar.edges[i]?.canvasEdgeId ?? '');
    if (ce && e.flow) ce.label = `${e.flow}${e.status === 'supported' ? '' : ` (${e.status})`}`;
  });
  if (unlinked)
    disclosures.push(
      `${p.title}: ${unlinked} box(es) are realized by architecture views that were not part of this export; they have no "Realized by" link.`,
    );
}
