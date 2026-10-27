import { componentTypeInfo, type BoardDocument, type Component } from '@atlas/schema';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';

type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];
type El = Record<string, unknown> & { id: string };
type Tag = { kind?: string; id?: string; proposed?: boolean };

/**
 * Agent proposals on the canvas (D03c). Runs after the materializer when a board loads:
 * - registry items an agent added to a board that already has a drawing get drawn (below the
 *   drawing, by family column; arrows to existing boxes are left unbound),
 * - every proposed component/connection is drawn dashed and faded with an "agent: <model>" tag,
 *   so it reads as a suggestion until a person accepts it (the daemon restyles on review).
 * Returns the same document object when there is nothing to do.
 */
const PROPOSED_OPACITY = 55;
const W = 200;
const H = 72;
const GAP_X = 120;
const GAP_Y = 48;
const COLUMN: Record<string, number> = {
  people: 0,
  edge: 1,
  'cross-cutting': 2,
  compute: 3,
  messaging: 4,
  data: 5,
  external: 6,
  boundary: 7,
  generic: 7,
};

const tagOf = (el: Record<string, unknown>): Tag | undefined =>
  (el.customData as { atlas?: Tag } | undefined)?.atlas;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const elId = (prefix: string, id: string) => `${prefix}-${id}`.replace(/[^A-Za-z0-9_-]/g, '_');

export function decorateProposals(doc: BoardDocument): BoardDocument {
  const drawn = drawUndrawn(doc);
  return markProposed(drawn);
}

/** Components/connections (not rejected) with no element on a non-empty scene. */
function drawUndrawn(doc: BoardDocument): BoardDocument {
  const els = doc.scene.elements as El[];
  if (!els.length) return doc; // an empty scene is the materializer's job
  const ids = new Set(els.map((e) => e.id));
  const owned = new Set(
    els.map((e) => tagOf(e)).flatMap((t) => (t?.id && t.kind !== 'proposal-tag' ? [t.id] : [])),
  );
  const hasEl = (c: Component) => owned.has(c.id) || c.elementIds.some((e) => ids.has(e));
  const comps = Object.values(doc.components).filter((c) => c.status !== 'rejected' && !hasEl(c));
  const cons = Object.values(doc.connections).filter(
    (k) => k.status !== 'rejected' && !owned.has(k.id) && !(k.elementId && ids.has(k.elementId)),
  );
  if (!comps.length && !cons.length) return doc;

  // centres of what is already drawn, to aim arrows at existing boxes
  const centre = new Map<string, { x: number; y: number }>();
  let maxY = -Infinity;
  let minX = Infinity;
  for (const e of els) {
    maxY = Math.max(maxY, num(e.y) + num(e.height));
    minX = Math.min(minX, num(e.x));
    const t = tagOf(e);
    if (t?.kind === 'component' && t.id)
      centre.set(t.id, { x: num(e.x) + num(e.width) / 2, y: num(e.y) + num(e.height) / 2 });
  }
  const top = (Number.isFinite(maxY) ? maxY : 0) + 140;
  const left = Number.isFinite(minX) ? minX : 0;
  const rows = new Map<number, number>();
  const skeletons: Skeleton[] = [];
  const newIds = new Set<string>();
  for (const c of comps) {
    const col = COLUMN[componentTypeInfo(c.type).family] ?? 7;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const x = left + col * (W + GAP_X);
    const y = top + row * (H + GAP_Y);
    const id = elId('cmp', c.id);
    newIds.add(c.id);
    centre.set(c.id, { x: x + W / 2, y: y + H / 2 });
    skeletons.push({
      id,
      type: 'rectangle',
      x,
      y,
      width: W,
      height: H,
      roundness: { type: 3 },
      strokeColor: '#1e293b',
      backgroundColor: '#ffffff',
      fillStyle: 'solid',
      strokeStyle: c.status === 'proposed' ? 'dashed' : 'solid',
      label: {
        text:
          c.type === 'box'
            ? c.label
            : `${c.label}\n${componentTypeInfo(c.type).label.toLowerCase()}`,
        fontSize: 14,
        textAlign: 'center',
        verticalAlign: 'middle',
      },
      customData: { atlas: { kind: 'component', id: c.id } },
    });
  }
  for (const k of cons) {
    const a = centre.get(k.from);
    const b = centre.get(k.to);
    if (!a || !b) continue;
    const bothNew = newIds.has(k.from) && newIds.has(k.to);
    const label = [k.label ?? k.payload, k.protocol, k.volume].filter(Boolean).join(' · ');
    skeletons.push({
      id: elId('con', k.id),
      type: 'arrow',
      x: a.x,
      y: a.y,
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
      points: [
        [0, 0],
        [b.x - a.x, b.y - a.y],
      ],
      // binding works inside one batch; arrows to boxes drawn earlier stay unbound
      ...(bothNew ? { start: { id: elId('cmp', k.from) }, end: { id: elId('cmp', k.to) } } : {}),
      strokeStyle: k.status === 'proposed' || k.mode === 'async' ? 'dashed' : 'solid',
      startArrowhead: k.direction === 'bidirectional' ? 'arrow' : null,
      endArrowhead: 'arrow',
      ...(label ? { label: { text: label, fontSize: 12 } } : {}),
      customData: { atlas: { kind: 'connection', id: k.id } },
    });
  }
  if (!skeletons.length) return doc;
  const added = convertToExcalidrawElements(skeletons, { regenerateIds: false }) as unknown as El[];
  const components = { ...doc.components };
  const connections = { ...doc.connections };
  for (const el of added) {
    const own =
      tagOf(el) ??
      tagOf(added.find((p) => p.id === (el as { containerId?: string }).containerId) ?? {});
    if (!own?.id) continue;
    if (own.kind === 'component' && components[own.id]) {
      const c = components[own.id]!;
      const fresh = c.elementIds.filter((e) => ids.has(e));
      components[own.id] = { ...c, elementIds: tagOf(el) ? [el.id, ...fresh] : [...fresh, el.id] };
    } else if (own.kind === 'connection' && connections[own.id] && tagOf(el))
      connections[own.id] = { ...connections[own.id]!, elementId: el.id };
  }
  return {
    ...doc,
    components,
    connections,
    scene: {
      ...doc.scene,
      elements: [...doc.scene.elements, ...(added as Record<string, unknown>[])],
    },
  };
}

/** Fade proposed items and add one "agent: <model>" tag per proposed component. */
function markProposed(doc: BoardDocument): BoardDocument {
  const els = doc.scene.elements as El[];
  const proposedIds = new Set(
    [...Object.values(doc.components), ...Object.values(doc.connections)]
      .filter((x) => x.status === 'proposed')
      .map((x) => x.id),
  );
  if (!proposedIds.size) return doc;
  const owner = new Map<string, string>(); // element id → proposed item id
  for (const e of els) {
    const t = tagOf(e);
    if (t?.id && t.kind !== 'proposal-tag' && proposedIds.has(t.id)) owner.set(e.id, t.id);
  }
  for (const e of els)
    if (typeof e.containerId === 'string' && owner.has(e.containerId))
      owner.set(e.id, owner.get(e.containerId)!);
  const tagged = new Set(
    els.flatMap((e) => (tagOf(e)?.kind === 'proposal-tag' ? [tagOf(e)!.id ?? ''] : [])),
  );
  let changed = false;
  const next = els.map((e) => {
    if (!owner.has(e.id) || e.opacity === PROPOSED_OPACITY) return e;
    changed = true;
    const t = tagOf(e);
    return {
      ...e,
      opacity: PROPOSED_OPACITY,
      ...(e.type !== 'text' ? { strokeStyle: 'dashed' } : {}),
      ...(t
        ? { customData: { ...(e.customData as object), atlas: { ...t, proposed: true } } }
        : {}),
      version: num(e.version) + 1,
    };
  });
  const tags: Skeleton[] = [];
  for (const c of Object.values(doc.components)) {
    if (c.status !== 'proposed' || tagged.has(c.id)) continue;
    const box = els.find((e) => tagOf(e)?.kind === 'component' && tagOf(e)?.id === c.id);
    if (!box) continue;
    tags.push({
      id: elId('tag', c.id),
      type: 'text',
      x: num(box.x) + 4,
      y: num(box.y) - 20,
      text: `agent: ${c.origin.name ?? c.origin.author}`,
      fontSize: 12,
      strokeColor: '#7c3aed',
      opacity: 85,
      customData: { atlas: { kind: 'proposal-tag', id: c.id } },
    });
  }
  if (!changed && !tags.length) return doc;
  const added = tags.length
    ? (convertToExcalidrawElements(tags, { regenerateIds: false }) as unknown as El[])
    : [];
  return {
    ...doc,
    scene: { ...doc.scene, elements: [...next, ...added] as Record<string, unknown>[] },
  };
}
