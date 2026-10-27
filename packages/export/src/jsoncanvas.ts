/**
 * JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/) exports of Atlas views and runs (plan §13).
 * JSON Canvas carries positioned text/file/link/group nodes and labeled edges only, so Atlas
 * semantics that do not fit are listed as disclosures and kept, by id, in a versioned sidecar.
 * Pure functions: callers supply the projection, its layout and where linked files will live.
 */
export interface JcNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}
export type JcNode =
  | (JcNodeBase & { type: 'text'; text: string })
  | (JcNodeBase & { type: 'file'; file: string; subpath?: string })
  | (JcNodeBase & { type: 'link'; url: string })
  | (JcNodeBase & { type: 'group'; label?: string });
export interface JcEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  color?: string;
  label?: string;
}
export interface JsonCanvas {
  nodes: JcNode[];
  edges: JcEdge[];
}

/** Preset colors (spec: "1" red … "6" purple), used with text labels, never alone. */
export const COLORS = {
  gap: '1',
  removed: '1',
  changed: '2',
  stale: '3',
  inferred: '3',
  added: '4',
} as const;

/** Minimal structural view of an Atlas projection (the daemon's projection route). */
export interface ProjectionLike {
  canvasId: string;
  title: string;
  lens: string;
  snapshotId: string;
  relevanceReason?: string;
  nodes: {
    id: string;
    kind: string;
    label: string;
    sublabel?: string;
    entityId?: string;
    entityKind?: string;
    lifecycle?: string;
    parentId?: string;
    openCanvasId?: string;
    memberCount?: number;
    change?: string;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    kinds: Record<string, number>;
    relationIds: string[];
    status: string;
  }[];
  stats?: { hiddenNodes?: number };
  truncated?: boolean;
}

export interface NoteLike {
  targetId?: string;
  text: string;
  author?: string;
  authorName?: string;
}

export interface SidecarView {
  file: string;
  canvasId: string;
  title: string;
  lens: string;
  nodes: {
    canvasNodeId: string;
    atlasNodeId: string;
    kind: string;
    entityId?: string;
    entityKind?: string;
  }[];
  edges: {
    canvasEdgeId: string;
    relationIds: string[];
    status: string;
    kinds: Record<string, number>;
  }[];
}

const md = (s: string) => s.replace(/([\\`*_[\]<>#|])/g, '\\$1');
const edgeLabel = (kinds: Record<string, number>) =>
  Object.entries(kinds)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(', ');
/** JSON Canvas ids must be unique strings; Atlas node ids can contain characters some tools dislike. */
const cid = (prefix: string, i: number) => `${prefix}${i.toString(36).padStart(3, '0')}`;

export function projectionToCanvas(
  p: ProjectionLike,
  positions: Record<string, { x: number; y: number; width: number; height: number }>,
  opts: { fileFor(canvasId: string): string | undefined; notes?: NoteLike[]; file: string },
): { canvas: JsonCanvas; sidecar: SidecarView; disclosures: string[] } {
  const disclosures: string[] = [];
  const idMap = new Map<string, string>();
  p.nodes.forEach((n, i) => idMap.set(n.id, cid('n', i)));
  const notesFor = (entityId?: string) =>
    entityId ? (opts.notes ?? []).filter((x) => x.targetId === entityId) : [];
  let unlinked = 0;

  // groups first: renderers draw later nodes on top
  const ordered = [...p.nodes].sort(
    (a, b) => Number(b.kind === 'group') - Number(a.kind === 'group'),
  );
  const nodes: JcNode[] = ordered.map((n) => {
    const pos = positions[n.id] ?? { x: 0, y: 0, width: 240, height: 80 };
    const base = {
      id: idMap.get(n.id)!,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      width: Math.max(1, Math.round(pos.width)),
      height: Math.max(1, Math.round(pos.height)),
    };
    if (n.kind === 'group') return { ...base, type: 'group' as const, label: n.label };
    const lines = [`**${md(n.label)}**`];
    const kind = n.entityKind ?? n.kind;
    const sub = [kind, n.sublabel && n.sublabel !== kind ? n.sublabel : '']
      .filter(Boolean)
      .join(' · ');
    if (sub) lines.push(md(sub));
    const status = [
      n.lifecycle && n.lifecycle !== 'active' ? n.lifecycle : '',
      n.change ?? '',
      n.kind === 'gap' ? 'coverage gap' : '',
      n.memberCount ? `${n.memberCount} members` : '',
    ].filter(Boolean);
    if (status.length) lines.push(`_${status.join(' · ')}_`);
    for (const note of notesFor(n.entityId))
      lines.push(
        `> note${note.author === 'agent' ? ` (agent${note.authorName ? `: ${md(note.authorName)}` : ''})` : ''}: ${md(note.text.slice(0, 300))}`,
      );
    if (n.openCanvasId) {
      const f = opts.fileFor(n.openCanvasId);
      if (f) lines.push(`[open view →](${encodeURI(f)})`);
      else unlinked++;
    }
    const color =
      n.kind === 'gap'
        ? COLORS.gap
        : n.change === 'removed'
          ? COLORS.removed
          : n.lifecycle === 'stale'
            ? COLORS.stale
            : n.change === 'added'
              ? COLORS.added
              : n.change
                ? COLORS.changed
                : undefined;
    return {
      ...base,
      type: 'text' as const,
      text: lines.join('\n\n'),
      ...(color ? { color } : {}),
    };
  });

  const edges: JcEdge[] = [];
  const sidecarEdges: SidecarView['edges'] = [];
  p.edges.forEach((e, i) => {
    const from = idMap.get(e.source);
    const to = idMap.get(e.target);
    if (!from || !to) return;
    const id = cid('e', i);
    const status = e.status === 'supported' ? '' : ` (${e.status})`;
    edges.push({
      id,
      fromNode: from,
      toNode: to,
      fromSide: 'right',
      toSide: 'left',
      toEnd: 'arrow',
      label: `${edgeLabel(e.kinds)}${status}`,
      ...(e.status === 'supported' ? {} : { color: COLORS.inferred }),
    });
    sidecarEdges.push({
      canvasEdgeId: id,
      relationIds: e.relationIds,
      status: e.status,
      kinds: e.kinds,
    });
  });

  if (p.stats?.hiddenNodes)
    disclosures.push(
      `${p.title}: ${p.stats.hiddenNodes} element(s) are folded into cluster nodes, as in Atlas; their members are not exported individually.`,
    );
  if (p.truncated)
    disclosures.push(`${p.title}: Atlas truncated this view; the export shows the same subset.`);
  if (unlinked)
    disclosures.push(
      `${p.title}: ${unlinked} node(s) open views that were not part of this export; they have no link.`,
    );
  return {
    canvas: { nodes, edges },
    sidecar: {
      file: opts.file,
      canvasId: p.canvasId,
      title: p.title,
      lens: p.lens,
      nodes: p.nodes.map((n) => ({
        canvasNodeId: idMap.get(n.id)!,
        atlasNodeId: n.id,
        kind: n.kind,
        entityId: n.entityId,
        entityKind: n.entityKind,
      })),
      edges: sidecarEdges,
    },
    disclosures,
  };
}

/** Always true of these exports; listed in the sidecar and printed by the CLI. */
export const STANDARD_DISCLOSURES = [
  'Evidence, claims, coverage details and source excerpts are not inside .canvas files. The sidecar (atlas-export.json) maps every canvas node and edge to Atlas entity and relation ids.',
  'Status is written as text in each node and edge label. JSON Canvas preset colors repeat it (red: coverage gap or removed, yellow: stale or inferred, green: added, orange: changed); the spec gives colors no meaning.',
  "Drill-down is a relative markdown link to the child view's .canvas file. Renderers that do not follow links in text nodes cannot navigate between views.",
  'Interactive features are not exported: inspectors, search, live updates, focus/expand of clusters and the outputs timeline.',
];

export interface RunLike {
  run: {
    id: string;
    commandSummary?: string;
    adapter: string;
    status: string;
    startAt: string;
    endAt?: string;
    snapshotId?: string;
    captureGaps: { kind: string; detail: string }[];
  };
  outcome: { process: string; task: string };
  events: {
    id: string;
    type: string;
    parentEventId?: string;
    sequence?: number;
    payload: Record<string, unknown>;
  }[];
  artifacts: {
    id: string;
    logicalName: string;
    mediaType: string;
    role: string;
    bytesState: string;
    eventId?: string;
    metadata?: Record<string, unknown>;
  }[];
}

const isImage = (m: string) => /^image\/(png|jpeg|gif|webp)$/.test(m);

/**
 * A run as a canvas: an outcome header, its steps top to bottom, and its artifacts beside the
 * steps that produced them. `assetFor` returns the path an artifact was written to, relative to
 * the export root (JSON Canvas file paths are root-relative, like a vault), or undefined when it
 * was not exported (missing bytes, logs without consent, unsafe types).
 */
export function runToCanvas(
  d: RunLike,
  assetFor: (artifactId: string) => string | undefined,
): { canvas: JsonCanvas; disclosures: string[] } {
  const nodes: JcNode[] = [];
  const edges: JcEdge[] = [];
  const disclosures: string[] = [];
  const title = d.run.commandSummary ?? d.run.adapter;
  const gaps = d.run.captureGaps.map((g) => `- ${md(g.kind)}: ${md(g.detail.slice(0, 200))}`);
  nodes.push({
    id: 'header',
    type: 'text',
    x: 0,
    y: 0,
    width: 520,
    height: 140 + Math.min(gaps.length, 6) * 22,
    text: [
      `## ${md(title)}`,
      `process **${d.outcome.process}** · task **${d.outcome.task}** · ${d.run.adapter}`,
      d.run.snapshotId
        ? `source snapshot \`${d.run.snapshotId}\``
        : '_not linked to a source snapshot_',
      ...(gaps.length ? ['capture gaps:', ...gaps.slice(0, 6)] : []),
    ].join('\n\n'),
    ...(d.outcome.task === 'failed' || d.outcome.process === 'failed' ? { color: '1' } : {}),
  });

  const children = new Map<string, typeof d.events>();
  for (const e of d.events)
    if (e.parentEventId)
      children.set(e.parentEventId, [...(children.get(e.parentEventId) ?? []), e]);
  const isStep = (e: (typeof d.events)[number]) =>
    e.type === 'step.started' || e.type === 'tool.call.requested';
  const stepIds = new Set(d.events.filter(isStep).map((e) => e.id));
  const top = d.events.filter(
    (e) => isStep(e) && (!e.parentEventId || !stepIds.has(e.parentEventId)),
  );
  const stateOf = (s: (typeof d.events)[number]) => {
    const kids = children.get(s.id) ?? [];
    if (
      kids.some(
        (k) =>
          k.type === 'step.failed' || (k.type === 'tool.call.completed' && k.payload.ok === false),
      )
    )
      return 'failed';
    if (kids.some((k) => k.type === 'step.completed' || k.type === 'tool.call.completed'))
      return 'done';
    // SDK tool calls pair by tool name and order rather than by parent (as in the Atlas UI)
    if (s.type === 'tool.call.requested') {
      const at = d.events.indexOf(s);
      const end = d.events.find(
        (e, i) =>
          i > at &&
          e.type === 'tool.call.completed' &&
          !e.parentEventId &&
          e.payload.tool === s.payload.tool,
      );
      if (end) return end.payload.ok === false ? 'failed' : 'done';
    }
    return 'no completion recorded';
  };
  const nameOf = (s: (typeof d.events)[number]) =>
    s.type === 'tool.call.requested'
      ? `tool: ${String(s.payload.tool)}`
      : String(s.payload.name ?? s.type);
  const outline = (s: (typeof d.events)[number], depth: number): string[] => [
    `${'  '.repeat(depth)}- ${md(nameOf(s))} — ${stateOf(s)}`,
    ...(depth < 3
      ? (children.get(s.id) ?? []).filter(isStep).flatMap((c) => outline(c, depth + 1))
      : []),
  ];
  const owner = new Map<string, string>(); // event id -> top-level step node id
  const mark = (e: (typeof d.events)[number], nodeId: string) => {
    owner.set(e.id, nodeId);
    for (const c of children.get(e.id) ?? []) mark(c, nodeId);
  };
  let y = nodes[0]!.height + 60;
  top.forEach((s, i) => {
    const lines = outline(s, 0);
    const h = 60 + Math.min(lines.length, 12) * 22;
    const id = cid('s', i);
    mark(s, id);
    const state = stateOf(s);
    nodes.push({
      id,
      type: 'text',
      x: 0,
      y,
      width: 520,
      height: h,
      text:
        lines.slice(0, 12).join('\n') +
        (lines.length > 12 ? `\n- … ${lines.length - 12} more` : ''),
      ...(state === 'failed' ? { color: '1' } : {}),
    });
    edges.push({
      id: `e-${id}`,
      fromNode: i === 0 ? 'header' : cid('s', i - 1),
      toNode: id,
      fromSide: 'bottom',
      toSide: 'top',
      toEnd: 'arrow',
    });
    y += h + 40;
  });
  const asserts = d.events.filter((e) => e.type === 'assertion.result');
  if (asserts.length) {
    nodes.push({
      id: 'assertions',
      type: 'text',
      x: 0,
      y,
      width: 520,
      height: 60 + Math.min(asserts.length, 10) * 22,
      text: [
        '**Assertions**',
        ...asserts
          .slice(0, 10)
          .map((a) => `- ${String(a.payload.outcome)}: ${md(String(a.payload.description ?? ''))}`),
      ].join('\n'),
      ...(asserts.some((a) => a.payload.outcome === 'fail') ? { color: '1' } : {}),
    });
  }

  let ay = 0;
  let skipped = 0;
  d.artifacts.forEach((a, i) => {
    const id = cid('a', i);
    const path = a.bytesState === 'available' ? assetFor(a.id) : undefined;
    if (path && isImage(a.mediaType)) {
      nodes.push({ id, type: 'file', file: path, x: 620, y: ay, width: 360, height: 240 });
      ay += 280;
    } else {
      if (a.bytesState === 'available' && !path) skipped++;
      const why =
        a.bytesState !== 'available'
          ? `_${a.bytesState}${a.metadata?.missingReason ? `: ${md(String(a.metadata.missingReason))}` : ''}_`
          : path
            ? `[${md(a.logicalName)}](${encodeURI(path)})`
            : '_not exported_';
      nodes.push({
        id,
        type: 'text',
        x: 620,
        y: ay,
        width: 360,
        height: 120,
        text: `**${md(a.logicalName)}**\n\n${a.mediaType} · ${a.role}\n\n${why}`,
        ...(a.bytesState === 'missing' ? { color: '1' } : {}),
      });
      ay += 150;
    }
    const from = a.eventId ? owner.get(a.eventId) : undefined;
    if (from)
      edges.push({
        id: `e-${id}`,
        fromNode: from,
        toNode: id,
        fromSide: 'right',
        toSide: 'left',
        toEnd: 'arrow',
        label: 'produced',
      });
  });
  if (skipped)
    disclosures.push(
      `${title}: ${skipped} artifact(s) were left out (logs need --include-logs; HTML and SVG are never copied into exports).`,
    );
  disclosures.push(
    `${title}: event payloads other than step and tool names, outcomes and assertions are not exported; the audit trail stays in Atlas.`,
  );
  return { canvas: { nodes, edges }, disclosures };
}

/** JSON Canvas 1.0 structural checks: what a conforming renderer relies on. */
export function validateJsonCanvas(c: unknown): string[] {
  const problems: string[] = [];
  const doc = c as JsonCanvas;
  if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges))
    return ['top level must have nodes and edges arrays'];
  const ids = new Set<string>();
  const sides = new Set(['top', 'right', 'bottom', 'left']);
  const ends = new Set(['none', 'arrow']);
  const color = (v: unknown) =>
    v === undefined ||
    (typeof v === 'string' && (/^[1-6]$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(v)));
  for (const n of doc.nodes) {
    if (typeof n.id !== 'string' || !n.id) problems.push('node without id');
    else if (ids.has(n.id)) problems.push(`duplicate id ${n.id}`);
    ids.add(n.id);
    for (const k of ['x', 'y', 'width', 'height'] as const)
      if (!Number.isInteger(n[k])) problems.push(`node ${n.id}: ${k} must be an integer`);
    if (n.width <= 0 || n.height <= 0) problems.push(`node ${n.id}: size must be positive`);
    if (!color(n.color)) problems.push(`node ${n.id}: invalid color`);
    if (n.type === 'text' && typeof n.text !== 'string')
      problems.push(`node ${n.id}: text node needs text`);
    else if (
      n.type === 'file' &&
      (typeof n.file !== 'string' || n.file.startsWith('/') || n.file.split('/').includes('..'))
    )
      problems.push(`node ${n.id}: file must be a relative path inside the export`);
    else if (n.type === 'link' && typeof n.url !== 'string')
      problems.push(`node ${n.id}: link node needs url`);
    else if (!['text', 'file', 'link', 'group'].includes(n.type))
      problems.push(`node ${n.id}: unknown type ${(n as { type: string }).type}`);
  }
  for (const e of doc.edges) {
    if (typeof e.id !== 'string' || ids.has(e.id))
      problems.push(`edge ${e.id}: missing or duplicate id`);
    ids.add(e.id);
    if (!doc.nodes.some((n) => n.id === e.fromNode) || !doc.nodes.some((n) => n.id === e.toNode))
      problems.push(`edge ${e.id}: endpoints must be nodes`);
    if ((e.fromSide && !sides.has(e.fromSide)) || (e.toSide && !sides.has(e.toSide)))
      problems.push(`edge ${e.id}: invalid side`);
    if ((e.fromEnd && !ends.has(e.fromEnd)) || (e.toEnd && !ends.has(e.toEnd)))
      problems.push(`edge ${e.id}: invalid end`);
    if (!color(e.color)) problems.push(`edge ${e.id}: invalid color`);
  }
  return problems;
}
