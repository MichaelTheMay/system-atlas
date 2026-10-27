import { componentTypeInfo, type BoardDocument, type Component } from '@atlas/schema';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';

type ExcalidrawElementSkeleton = NonNullable<
  Parameters<typeof convertToExcalidrawElements>[0]
>[number];

/**
 * Draws a board's registry onto an empty scene (D03 wave 0): a board created from a template, a
 * prompt or code has components and connections but no elements yet. Each component becomes a
 * labeled rounded rectangle, each connection a bound arrow; both are tagged through
 * `customData.atlas` so the controller can map elements back to the registry.
 *
 * Layout here is a plain grid by family column (edge → compute → messaging → data → external);
 * wave 1a replaces it with ELK and adds icons, badges and frames.
 */
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
const W = 200;
const H = 72;
const GAP_X = 120;
const GAP_Y = 48;

export interface AtlasTag {
  kind: 'component' | 'connection' | 'scenario-step' | 'frame';
  id: string;
}
export const atlasTag = (el: { customData?: unknown }): AtlasTag | undefined =>
  (el.customData as { atlas?: AtlasTag } | undefined)?.atlas;

export function needsMaterialize(doc: BoardDocument): boolean {
  return doc.scene.elements.length === 0 && Object.keys(doc.components).length > 0;
}

export function materialize(doc: BoardDocument): BoardDocument {
  const comps = Object.values(doc.components).filter((c) => c.status !== 'rejected');
  const rows = new Map<number, number>();
  const elementIdOf = new Map<string, string>();
  const centerOf = new Map<string, { x: number; y: number }>();
  const skeletons: ExcalidrawElementSkeleton[] = [];
  const elId = (prefix: string, id: string) => `${prefix}-${id}`.replace(/[^A-Za-z0-9_-]/g, '_');
  for (const c of comps) {
    const col = COLUMN[componentTypeInfo(c.type).family] ?? 7;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const id = elId('cmp', c.id);
    elementIdOf.set(c.id, id);
    const x = col * (W + GAP_X);
    const y = row * (H + GAP_Y);
    centerOf.set(c.id, { x: x + W / 2, y: y + H / 2 });
    skeletons.push({
      id,
      type: 'rectangle',
      x,
      y,
      width: W,
      height: H,
      roundness: { type: 3 },
      strokeColor: '#1e293b',
      backgroundColor: fillFor(c),
      fillStyle: 'solid',
      strokeStyle: c.status === 'proposed' ? 'dashed' : 'solid',
      label: { text: labelFor(c), fontSize: 14, textAlign: 'center', verticalAlign: 'middle' },
      customData: { atlas: { kind: 'component', id: c.id } satisfies AtlasTag },
    });
  }
  for (const k of Object.values(doc.connections)) {
    if (k.status === 'rejected') continue;
    const from = elementIdOf.get(k.from);
    const to = elementIdOf.get(k.to);
    if (!from || !to) continue;
    const id = elId('con', k.id);
    // the arrow runs centre to centre; binding then pulls its ends back to the box edges
    const a = centerOf.get(k.from)!;
    const b = centerOf.get(k.to)!;
    skeletons.push({
      id,
      type: 'arrow',
      x: a.x,
      y: a.y,
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
      points: [
        [0, 0],
        [b.x - a.x, b.y - a.y],
      ],
      start: { id: from },
      end: { id: to },
      strokeStyle: k.mode === 'async' ? 'dashed' : 'solid',
      startArrowhead: k.direction === 'bidirectional' ? 'arrow' : null,
      endArrowhead: 'arrow',
      ...(connectionLabel(k) ? { label: { text: connectionLabel(k), fontSize: 12 } } : {}),
      customData: { atlas: { kind: 'connection', id: k.id } satisfies AtlasTag },
    });
  }
  const elements = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  // record which elements stand for which registry entries (label texts are bound to their container)
  const components = { ...doc.components };
  const connections = { ...doc.connections };
  for (const el of elements) {
    const tag = atlasTag(el);
    const owner =
      tag ??
      atlasTag(elements.find((p) => p.id === (el as { containerId?: string }).containerId) ?? {});
    if (!owner) continue;
    if (owner.kind === 'component' && components[owner.id]) {
      const c = components[owner.id]!;
      components[owner.id] = {
        ...c,
        elementIds: tag ? [el.id, ...c.elementIds] : [...c.elementIds, el.id],
      };
    } else if (owner.kind === 'connection' && connections[owner.id] && tag)
      connections[owner.id] = { ...connections[owner.id]!, elementId: el.id };
  }
  return {
    ...doc,
    components,
    connections,
    scene: { ...doc.scene, elements: elements as unknown as Record<string, unknown>[] },
  };
}

function labelFor(c: Component): string {
  const info = componentTypeInfo(c.type);
  return c.type === 'box' ? c.label : `${c.label}\n${info.label.toLowerCase()}`;
}

function connectionLabel(k: BoardDocument['connections'][string]): string {
  return [k.label ?? k.payload, k.protocol, k.volume].filter(Boolean).join(' · ');
}

function fillFor(c: Component): string {
  switch (componentTypeInfo(c.type).family) {
    case 'edge':
      return '#e0f2fe';
    case 'compute':
      return '#ede9fe';
    case 'data':
      return '#fef3c7';
    case 'messaging':
      return '#ffedd5';
    case 'external':
      return '#f1f5f9';
    case 'people':
      return '#dcfce7';
    case 'cross-cutting':
      return '#fce7f3';
    default:
      return '#ffffff';
  }
}
