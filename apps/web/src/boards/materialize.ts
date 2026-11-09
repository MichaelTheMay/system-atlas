import {
  componentTypeInfo,
  type BoardDocument,
  type Component,
  type ComponentFamily,
  type Connection,
} from '@atlas/schema';
import type { LayoutInput, LayoutResult } from '@atlas/layout';
import { convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData } from '@excalidraw/excalidraw/types';
import { iconFile } from './icons.ts';
import { routeAround, simplifyRoute } from './route.ts';
import { badgeLines, componentBadges, connectionLabelText } from './registry.ts';
import { atlasTag, tagData, type AtlasTag, type ComponentPartRole } from './tags.ts';

export { atlasTag, type AtlasTag } from './tags.ts';

/**
 * Drawing design boards (D03 wave 1a). The single path from registry to Excalidraw elements, used
 * by templates, palette inserts, agent drafts and code import:
 *
 * - `materialize(doc)` lays out a registry with ELK (layered, left → right, through the layout
 *   worker) and draws everything: components, boundary containers with their children inside,
 *   frames enclosing their members, and connections as bound arrows following ELK's orthogonal
 *   routes (so they go around boxes, not through them).
 * - `renderComponent(c, at)` draws one component: a rounded rectangle in its family colours, a
 *   Lucide icon (SVG data-URL image), the type line, the label (bound text, the part people edit)
 *   and a badge line with its set properties. All parts share a group and carry an atlas tag.
 * - `refreshComponent` / `refreshConnection` re-render one entry in place after a registry edit,
 *   keeping position, size, frame, group and arrow bindings.
 *
 * Nesting rule: a component sits in its container (`parentId`, a boundary type) when it has one;
 * the container — not the child — then belongs to a frame. A component listed by a frame while its
 * container is elsewhere follows its container.
 */

export type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];
export type El = ExcalidrawElement;
export type LayoutFn = (input: LayoutInput) => Promise<LayoutResult>;

export const FAMILY_STYLE: Record<ComponentFamily, { fill: string; stroke: string }> = {
  edge: { fill: '#e0f2fe', stroke: '#0369a1' },
  compute: { fill: '#ede9fe', stroke: '#6d28d9' },
  data: { fill: '#fef3c7', stroke: '#b45309' },
  messaging: { fill: '#ffedd5', stroke: '#c2410c' },
  'cross-cutting': { fill: '#fce7f3', stroke: '#be185d' },
  external: { fill: '#f1f5f9', stroke: '#475569' },
  boundary: { fill: 'transparent', stroke: '#64748b' },
  people: { fill: '#dcfce7', stroke: '#15803d' },
  generic: { fill: '#ffffff', stroke: '#334155' },
};
const INK = '#1e293b';
const MUTED = '#475569';
const FONT_HAND = 5; // Excalifont
const FONT_UI = 6; // Nunito
export const COMPONENT_WIDTH = 220;
const HEADER = 40;
const LABEL_SIZE = 20;
const LABEL_LINE = 25;
const BADGE_SIZE = 13;
const BADGE_LINE = 17;
/** Boundary containers: header band (icon, name, type) above their children. */
export const CONTAINER_HEADER = 64;

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
export const componentElementId = (id: string) => `cmp-${sanitize(id)}`;
export const connectionElementId = (id: string) => `con-${sanitize(id)}`;
const frameElementId = (id: string) => `frm-${sanitize(id)}`;
const rand = () => Math.random().toString(36).slice(2, 10);

const isContainer = (c: Pick<Component, 'type'>) => !!componentTypeInfo(c.type).container;
const styleOf = (c: Pick<Component, 'type'>) => FAMILY_STYLE[componentTypeInfo(c.type).family];

/** Box size a component needs for its label and badges (containers get theirs from layout). */
export function componentSize(c: Component): { width: number; height: number } {
  if (isContainer(c)) return { width: 300, height: 180 };
  const labelLines = Math.max(1, Math.ceil(c.label.length / 18));
  const badges = badgeLines(componentBadges(c)).length;
  return {
    width: COMPONENT_WIDTH,
    height: Math.max(100, HEADER + labelLines * LABEL_LINE + 14 + badges * BADGE_LINE + 12),
  };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Elements for one component at `box`. `ids` reuses existing element ids per part (refresh);
 * `groupId` and `frameId` place the parts in a group / frame.
 */
export function renderComponent(
  c: Component,
  box: Box,
  opts: {
    ids?: Partial<Record<ComponentPartRole, string>>;
    groupId?: string;
    frameId?: string | null;
  } = {},
): { elements: El[]; files: BinaryFileData[] } {
  const info = componentTypeInfo(c.type);
  const style = styleOf(c);
  const tag = (role: ComponentPartRole): Record<string, unknown> =>
    tagData({ kind: 'component', id: c.id, role } satisfies AtlasTag);
  const ids = {
    box: opts.ids?.box ?? componentElementId(c.id),
    icon: opts.ids?.icon ?? `${componentElementId(c.id)}-icon`,
    type: opts.ids?.type ?? `${componentElementId(c.id)}-type`,
    badges: opts.ids?.badges ?? `${componentElementId(c.id)}-badges`,
    label: opts.ids?.label ?? `${componentElementId(c.id)}-label`,
  };
  const groupIds = [opts.groupId ?? `grp-${sanitize(c.id)}`];
  const common = { groupIds, frameId: opts.frameId ?? null };
  const proposed = c.status === 'proposed';
  const file = iconFile(info.icon, style.stroke);
  const badges = componentBadges(c);
  const skeletons: Skeleton[] = [];
  if (isContainer(c)) {
    skeletons.push(
      {
        type: 'rectangle',
        id: ids.box,
        ...box,
        roundness: { type: 3 },
        strokeColor: style.stroke,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeStyle: 'dashed',
        strokeWidth: 2,
        roughness: 1,
        customData: tag('box'),
        ...common,
      },
      {
        type: 'text',
        id: ids.label,
        x: box.x + 44,
        y: box.y + 12,
        text: c.label,
        fontSize: LABEL_SIZE,
        fontFamily: FONT_HAND,
        strokeColor: INK,
        customData: tag('label'),
        ...common,
      },
      {
        type: 'text',
        id: ids.type,
        x: box.x + 44,
        y: box.y + 38,
        text: [info.label.toLowerCase(), ...badges].join(' · '),
        fontSize: 12,
        fontFamily: FONT_UI,
        strokeColor: style.stroke,
        customData: tag('type'),
        ...common,
      },
    );
  } else {
    skeletons.push(
      {
        type: 'rectangle',
        id: ids.box,
        ...box,
        roundness: { type: 3 },
        strokeColor: style.stroke,
        backgroundColor: style.fill,
        fillStyle: 'solid',
        strokeStyle: proposed ? 'dashed' : 'solid',
        strokeWidth: 2,
        roughness: 1,
        label: {
          text: c.label,
          fontSize: LABEL_SIZE,
          fontFamily: FONT_HAND,
          textAlign: 'center',
          verticalAlign: 'middle',
          strokeColor: INK,
        },
        customData: tag('box'),
        ...common,
      },
      {
        type: 'text',
        id: ids.type,
        x: box.x + 40,
        y: box.y + 13,
        text: info.label,
        fontSize: 13,
        fontFamily: FONT_UI,
        strokeColor: style.stroke,
        customData: tag('type'),
        ...common,
      },
    );
    if (badges.length)
      skeletons.push({
        type: 'text',
        id: ids.badges,
        x: box.x + 10,
        y: box.y + box.height - 30,
        text: badgeLines(badges).join('\n'),
        fontSize: BADGE_SIZE,
        fontFamily: FONT_UI,
        textAlign: 'center',
        strokeColor: MUTED,
        customData: tag('badges'),
        ...common,
      });
  }
  skeletons.push({
    type: 'image',
    id: ids.icon,
    x: box.x + (isContainer(c) ? 14 : 11),
    y: box.y + (isContainer(c) ? 14 : 10),
    width: isContainer(c) ? 24 : 22,
    height: isContainer(c) ? 24 : 22,
    fileId: file.id as never,
    status: 'saved',
    customData: tag('icon'),
    ...common,
  });
  const elements = convertToExcalidrawElements(skeletons, { regenerateIds: false }) as El[];
  for (const el of elements as Mutable<El>[]) {
    if (el.type === 'text' && (el as { containerId?: string }).containerId === ids.box) {
      // the bound label: give it its stable id, group and tag
      Object.assign(el, { customData: tag('label'), groupIds, frameId: common.frameId });
      if (el.id !== ids.label) {
        const box = elements.find((e) => e.id === ids.box) as Mutable<El>;
        box.boundElements = (box.boundElements ?? []).map((b) =>
          b.id === el.id ? { ...b, id: ids.label } : b,
        );
        el.id = ids.label;
      }
    }
    // fixed widths with room to spare: text measured before the web fonts load comes out a
    // little narrow, and Excalidraw clips a text element to its width
    if (el.id === ids.badges) {
      // centred along the bottom edge
      Object.assign(el, { x: box.x + 10, width: box.width - 20, autoResize: false });
      el.y = box.y + box.height - 12 - el.height;
    }
    if (el.id === ids.type || (isContainer(c) && el.id === ids.label))
      Object.assign(el, { width: box.width - (isContainer(c) ? 60 : 50), autoResize: false });
    // imported "as built" from code (D03 1b): drawn faded so it reads as a reference, not a design
    if (c.origin.author === 'code') el.opacity = 60;
  }
  return { elements, files: [file] };
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Arrow (and its bound label) for a connection along absolute `points`, bound to two boxes. */
export function renderConnection(
  k: Connection,
  points: { x: number; y: number }[],
  ends: { from: El; to: El },
  opts: { id?: string; labelId?: string } = {},
): El[] {
  const id = opts.id ?? connectionElementId(k.id);
  const text = connectionLabelText(k);
  if (text) {
    const lines = text.split('\n');
    points = withLabelAnchor(points, {
      width: Math.max(...lines.map((l) => l.length)) * 13 * 0.52,
      height: lines.length * 17,
    });
  }
  const p0 = points[0]!;
  const [arrow, ...rest] = convertToExcalidrawElements(
    [
      {
        type: 'arrow',
        id,
        x: p0.x,
        y: p0.y,
        points: points.map((p) => [p.x - p0.x, p.y - p0.y]) as never,
        strokeColor: k.status === 'proposed' ? '#64748b' : '#334155',
        strokeWidth: 2,
        roughness: 1,
        roundness: null,
        strokeStyle: k.mode === 'async' ? 'dashed' : 'solid',
        startArrowhead: k.direction === 'bidirectional' ? 'arrow' : null,
        endArrowhead: 'arrow',
        customData: tagData({ kind: 'connection', id: k.id }),
        ...(text
          ? {
              label: {
                text,
                fontSize: 13,
                fontFamily: FONT_UI,
                strokeColor: MUTED,
              },
            }
          : {}),
      },
    ],
    { regenerateIds: false },
  ) as Mutable<El>[];
  const a = arrow as Mutable<El> & {
    startBinding: unknown;
    endBinding: unknown;
  };
  a.startBinding = { elementId: ends.from.id, focus: 0, gap: 1 };
  a.endBinding = { elementId: ends.to.id, focus: 0, gap: 1 };
  const label = rest.find((e) => e.type === 'text');
  if (label && opts.labelId && label.id !== opts.labelId) {
    a.boundElements = (a.boundElements ?? []).map((b) =>
      b.id === label.id ? { ...b, id: opts.labelId! } : b,
    );
    label.id = opts.labelId;
  }
  // "as built" from code (D03 1b): faded like its components
  if (k.origin.author === 'code') for (const e of [a, ...rest]) e.opacity = 60;
  return [a, ...rest];
}

/**
 * Excalidraw puts an arrow's label on its middle point (odd point count). Fan-outs share their
 * first segments, so the label goes on the segment entering the target (the longest one when that
 * is too short): its midpoint is inserted and collinear points are added so it is the middle one.
 */
export function withLabelAnchor(
  points: { x: number; y: number }[],
  label: { width: number; height: number } = { width: 80, height: 18 },
): { x: number; y: number }[] {
  points = simplifyRoute(points);
  if (points.length < 2) return points;
  const len = (i: number) =>
    Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y);
  let seg = points.length - 2;
  if (len(seg) < 60) for (let i = 0; i < points.length - 1; i++) if (len(i) > len(seg)) seg = i;
  const a = points[seg]!;
  const b = points[seg + 1]!;
  // on the segment entering the target, sit close to the target (long runs pass beside boxes)
  // clear of the target box: half the label along the segment plus a gap for the arrowhead
  const along = a.x === b.x ? label.height / 2 + 16 : label.width / 2 + 16;
  const t = seg === points.length - 2 ? Math.max(0.5, 1 - along / Math.max(1, len(seg))) : 0.5;
  const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const before = points.slice(0, seg + 1);
  const after = points.slice(seg + 1);
  // pad the shorter side with collinear points (halfway along its first / last segment)
  const pad = (side: { x: number; y: number }[], atStart: boolean) => {
    const out = [...side];
    while (out.length < Math.max(before.length, after.length)) {
      const [u, v] = atStart ? [out[0]!, out[1] ?? mid] : [out.at(-2) ?? mid, out.at(-1)!];
      const m = { x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 };
      if (atStart) out.splice(1, 0, m);
      else out.splice(out.length - 1, 0, m);
    }
    return out;
  };
  return [...pad(before, true), mid, ...pad(after, false)];
}

/** An orthogonal route between two boxes: out of the side facing the target, into the facing side. */
export function routeBetween(a: Box, b: Box): { x: number; y: number }[] {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  if (Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y)) {
    const right = bc.x >= ac.x;
    const sx = right ? a.x + a.width : a.x;
    const ex = right ? b.x : b.x + b.width;
    const mx = (sx + ex) / 2;
    return ac.y === bc.y
      ? [
          { x: sx, y: ac.y },
          { x: ex, y: bc.y },
        ]
      : [
          { x: sx, y: ac.y },
          { x: mx, y: ac.y },
          { x: mx, y: bc.y },
          { x: ex, y: bc.y },
        ];
  }
  const down = bc.y >= ac.y;
  const sy = down ? a.y + a.height : a.y;
  const ey = down ? b.y : b.y + b.height;
  const my = (sy + ey) / 2;
  return ac.x === bc.x
    ? [
        { x: ac.x, y: sy },
        { x: bc.x, y: ey },
      ]
    : [
        { x: ac.x, y: sy },
        { x: ac.x, y: my },
        { x: bc.x, y: my },
        { x: bc.x, y: ey },
      ];
}

/** A sticky note: a yellow rectangle with bound text, tagged `sticky`. */
export function renderSticky(at: { x: number; y: number }, text = 'Note'): El[] {
  const id = `sticky-${rand()}`;
  return convertToExcalidrawElements(
    [
      {
        type: 'rectangle',
        id,
        x: at.x,
        y: at.y,
        width: 180,
        height: 120,
        backgroundColor: '#fef08a',
        strokeColor: '#ca8a04',
        fillStyle: 'solid',
        roughness: 1,
        label: {
          text,
          fontSize: 18,
          fontFamily: FONT_HAND,
          textAlign: 'left',
          verticalAlign: 'top',
        },
        customData: tagData({ kind: 'sticky', id }),
      },
    ],
    { regenerateIds: false },
  ).map((el) =>
    el.type === 'text' ? { ...el, customData: tagData({ kind: 'sticky', id }) } : el,
  ) as El[];
}

/** An empty frame for a `BoardFrame`. */
export function renderFrame(frameId: string, label: string, box: Box): El[] {
  return convertToExcalidrawElements(
    [
      {
        type: 'frame',
        id: frameElementId(frameId),
        children: [],
        name: label,
        ...box,
        customData: tagData({ kind: 'frame', id: frameId }),
      },
    ],
    { regenerateIds: false },
  ) as El[];
}

const partsOf = (elements: readonly El[], componentId: string) =>
  elements.filter((e) => {
    const t = atlasTag(e);
    return !e.isDeleted && t?.kind === 'component' && t.id === componentId;
  });

/**
 * Re-renders a component in place after a registry edit (label, type, props, status): the box
 * keeps its position, size (grown if the content needs it), group, frame and arrow bindings; the
 * other parts are regenerated. Returns the whole next scene, or null when the component is not drawn.
 */
export function refreshComponent(
  elements: readonly El[],
  c: Component,
): { elements: El[]; files: BinaryFileData[] } | null {
  const parts = partsOf(elements, c.id);
  const box = parts.find((e) => atlasTag(e)?.role === 'box');
  if (!box) return null;
  const roleIds: Partial<Record<ComponentPartRole, string>> = {};
  for (const p of parts) {
    const role = atlasTag(p)?.role;
    if (role) roleIds[role] = p.id;
  }
  const need = componentSize(c);
  const geometry = {
    x: box.x,
    y: box.y,
    width: box.width,
    height: isContainer(c) ? box.height : Math.max(box.height, need.height),
  };
  const fresh = renderComponent(c, geometry, {
    ids: roleIds,
    groupId: box.groupIds[0],
    frameId: box.frameId,
  });
  const freshById = new Map(fresh.elements.map((e) => [e.id, e]));
  const freshBox = freshById.get(box.id)!;
  const next: El[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const f = freshById.get(el.id);
    seen.add(el.id);
    if (el.id === box.id) {
      // keep the box itself (bindings, user styling of stroke width/roughness); refresh look
      next.push(
        newElementWith(el, {
          height: geometry.height,
          backgroundColor: freshBox.backgroundColor,
          strokeColor: freshBox.strokeColor,
          strokeStyle: freshBox.strokeStyle,
          customData: freshBox.customData,
        }),
      );
    } else if (f) {
      next.push({
        ...f,
        groupIds: el.groupIds,
        frameId: el.frameId,
        ...(el.type === 'text' && (el as { containerId?: string }).containerId
          ? { containerId: box.id }
          : {}),
        version: el.version + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      } as El);
    } else if (parts.includes(el) && !freshById.has(el.id)) {
      next.push(newElementWith(el, { isDeleted: true })); // e.g. badges now empty
    } else next.push(el);
  }
  for (const f of fresh.elements) if (!seen.has(f.id)) next.push(f);
  return { elements: next, files: fresh.files };
}

/** Re-renders a connection's arrow style and label in place (route and bindings kept). */
export function refreshConnection(elements: readonly El[], k: Connection): El[] | null {
  const arrow = k.elementId
    ? elements.find((e) => e.id === k.elementId && !e.isDeleted)
    : undefined;
  if (!arrow || arrow.type !== 'arrow') return null;
  const a = arrow as El & {
    points: readonly (readonly [number, number])[];
    startBinding: { elementId: string } | null;
    endBinding: { elementId: string } | null;
  };
  const oldLabel = elements.find(
    (e) => !e.isDeleted && (e as { containerId?: string }).containerId === a.id,
  );
  const points = a.points.map(([x, y]) => ({ x: a.x + x, y: a.y + y }));
  const from = elements.find((e) => e.id === a.startBinding?.elementId);
  const to = elements.find((e) => e.id === a.endBinding?.elementId);
  const fresh = renderConnection(
    k,
    points,
    { from: from ?? a, to: to ?? a },
    { id: a.id, ...(oldLabel ? { labelId: oldLabel.id } : {}) },
  ) as Mutable<El>[];
  const freshArrow = fresh[0] as Mutable<El> & { startBinding: unknown; endBinding: unknown };
  freshArrow.startBinding = a.startBinding;
  freshArrow.endBinding = a.endBinding;
  const byId = new Map(fresh.map((e) => [e.id, e]));
  const next: El[] = [];
  for (const el of elements) {
    const f = byId.get(el.id);
    if (f) {
      next.push({
        ...f,
        groupIds: el.groupIds,
        frameId: el.frameId,
        version: el.version + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
      } as El);
      byId.delete(el.id);
    } else if (el === oldLabel) next.push(newElementWith(el, { isDeleted: true }));
    else next.push(el);
  }
  next.push(...byId.values());
  return next;
}

/** Elements to delete (plus binding cleanup) for removing registry entries from the scene. */
export function deleteFromScene(elements: readonly El[], ids: ReadonlySet<string>): El[] {
  const gone = new Set(ids);
  // bound texts go with their container
  for (const el of elements)
    if (
      (el as { containerId?: string }).containerId &&
      gone.has((el as { containerId: string }).containerId)
    )
      gone.add(el.id);
  return elements.map((el) => {
    if (gone.has(el.id) && !el.isDeleted) return newElementWith(el, { isDeleted: true });
    if (el.boundElements?.some((b) => gone.has(b.id)))
      return newElementWith(el, {
        boundElements: el.boundElements.filter((b) => !gone.has(b.id)),
      });
    return el;
  });
}

/** Lays a board's registry out with ELK and draws it (a board whose scene is still empty). */
export async function materialize(doc: BoardDocument, layout: LayoutFn): Promise<BoardDocument> {
  const comps = Object.values(doc.components).filter((c) => c.status !== 'rejected');
  const byId = new Map(comps.map((c) => [c.id, c]));
  // the containment tree: container (boundary) first, else frame, else the root
  const containerOf = (c: Component): string | undefined => {
    const p = c.parentId ? byId.get(c.parentId) : undefined;
    if (!p || p.id === c.id || !isContainer(p)) return undefined;
    // a container may not sit (transitively) inside its own child
    for (let q: Component | undefined = p, depth = 0; q; depth++) {
      if (q.id === c.id || depth > 8) return undefined;
      q = q.parentId ? byId.get(q.parentId) : undefined;
    }
    return p.id;
  };
  const frameOf = new Map<string, string>();
  for (const f of doc.frames)
    for (const id of f.componentIds) if (byId.has(id) && !frameOf.has(id)) frameOf.set(id, f.id);
  const topFrame = (c: Component): string | undefined => {
    let cur = c;
    for (let p = containerOf(cur); p; p = containerOf(cur)) cur = byId.get(p)!;
    return frameOf.get(cur.id);
  };
  const hasChildren = new Set(comps.map(containerOf).filter(Boolean) as string[]);
  const framesUsed = doc.frames.filter((f) => comps.some((c) => topFrame(c) === f.id));

  const conns = Object.values(doc.connections).filter(
    (k) => k.status !== 'rejected' && byId.has(k.from) && byId.has(k.to) && k.from !== k.to,
  );
  const node = (c: Component): LayoutInput['nodes'][number] => {
    const parent = containerOf(c);
    return {
      id: `c:${c.id}`,
      ...componentSize(c),
      ...(parent ? { parentId: `c:${parent}` } : {}),
      ...(hasChildren.has(c.id)
        ? { padding: { top: CONTAINER_HEADER + 8, left: 28, bottom: 28, right: 28 } }
        : {}),
    };
  };
  const laid = await placeBoard(layout, {
    comps,
    conns,
    frames: framesUsed.map((f) => f.id),
    frameOf: (c) => topFrame(c),
    node,
  });
  // arrows between blocks go around boxes and the header bands of containers (their children's
  // arrows still enter them)
  const obstacles = comps
    .filter((c) => laid.positions[`c:${c.id}`])
    .map((c) => {
      const box = laid.positions[`c:${c.id}`]!;
      return { id: c.id, box: isContainer(c) ? { ...box, height: CONTAINER_HEADER } : box };
    });

  const elements: El[] = [];
  const files = new Map<string, BinaryFileData>();
  const components = { ...doc.components };
  const boxOf = new Map<string, El>();
  // containers before their children so children draw on top
  const depth = (c: Component) => {
    let d = 0;
    for (let p = containerOf(c); p; p = containerOf(byId.get(p)!)) d++;
    return d;
  };
  const ordered = [...comps].sort(
    (a, b) => Number(isContainer(b)) - Number(isContainer(a)) || depth(a) - depth(b),
  );
  for (const c of ordered) {
    const pos = laid.positions[`c:${c.id}`];
    if (!pos) continue;
    const r = renderComponent(c, pos);
    for (const f of r.files) files.set(f.id, f);
    elements.push(...r.elements);
    boxOf.set(
      c.id,
      r.elements.find((e) => e.id === componentElementId(c.id))!,
    );
    components[c.id] = {
      ...c,
      elementIds: [
        componentElementId(c.id),
        ...r.elements.filter((e) => e.id !== componentElementId(c.id)).map((e) => e.id),
      ],
    };
  }
  const connections = { ...doc.connections };
  const drawn: { x: number; y: number }[][] = Object.values(laid.routes);
  // ELK-routed arrows first, so the ones routed here can keep off them
  const sortedConns = [...conns].sort(
    (a, b) => Number(!laid.routes[`k:${a.id}`]) - Number(!laid.routes[`k:${b.id}`]),
  );
  for (const k of sortedConns) {
    const from = boxOf.get(k.from);
    const to = boxOf.get(k.to);
    if (!from || !to) continue;
    const route = laid.routes[`k:${k.id}`];
    const els = renderConnection(
      k,
      route && route.length >= 2
        ? route
        : routeAround(
            from,
            to,
            obstacles.filter((o) => o.id !== k.from && o.id !== k.to).map((o) => o.box),
            { avoid: drawn },
          ),
      { from, to },
    );
    if (!route) {
      const a = els[0] as El & { points: readonly (readonly [number, number])[] };
      drawn.push(a.points.map(([x, y]) => ({ x: a.x + x, y: a.y + y })));
    }
    for (const end of [from, to] as Mutable<El>[])
      end.boundElements = [...(end.boundElements ?? []), { id: els[0]!.id, type: 'arrow' }];
    elements.push(...els);
    connections[k.id] = { ...k, elementId: els[0]!.id };
  }
  const frames = doc.frames.map((f) => {
    const pos = laid.positions[`f:${f.id}`];
    if (!pos) return f;
    const members = comps.filter((c) => topFrame(c) === f.id);
    const frame = renderFrame(f.id, f.label, pos)[0] as Mutable<El>;
    // every part of every member (including container children) belongs to the frame
    const memberIds = new Set(members.map((c) => c.id));
    for (const el of elements as Mutable<El>[]) {
      const t = atlasTag(el);
      if (t?.kind === 'component' && memberIds.has(t.id)) el.frameId = frame.id;
    }
    elements.push(frame);
    return { ...f, componentIds: members.map((c) => c.id), elementId: frame.id };
  });
  return {
    ...doc,
    components,
    connections,
    frames,
    scene: {
      ...doc.scene,
      elements: elements as unknown as Record<string, unknown>[],
      files: { ...doc.scene.files, ...Object.fromEntries(files) } as Record<string, unknown>,
    },
  };
}

type Placed = Record<string, { x: number; y: number; width: number; height: number }>;

/** Width / height of the bounding box of `ids` in `positions`. */
function bounds(positions: Placed, ids: readonly string[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const p = positions[id];
    if (!p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.width);
    y1 = Math.max(y1, p.y + p.height);
  }
  return x1 > x0
    ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    : { x: 0, y: 0, width: 1, height: 1 };
}

const SPACING = {
  RIGHT: { betweenLayers: 150, nodeNode: 44, edgeNode: 24 },
  DOWN: { betweenLayers: 110, nodeNode: 64, edgeNode: 24 },
} as const;
const FRAME_PAD = { top: 48, left: 28, bottom: 28, right: 28 };

/**
 * Where everything goes. Without frames: one layered ELK layout, left → right (top → bottom when
 * left → right makes a strip too wide to read). With frames: each frame's members are laid out on
 * their own, then frames (and unframed components) are laid out as blocks; the direction pair
 * (inside, between frames) whose result is closest to a screen's shape wins, preferring all
 * left → right. Returns positions (`c:<component>`, `f:<frame>`) and the routes ELK computed
 * (`k:<connection>`); connections between blocks are routed afterwards around the boxes.
 */
async function placeBoard(
  layout: LayoutFn,
  g: {
    comps: Component[];
    conns: Connection[];
    frames: string[];
    frameOf: (c: Component) => string | undefined;
    node: (c: Component) => LayoutInput['nodes'][number];
  },
): Promise<{ positions: Placed; routes: Record<string, { x: number; y: number }[]> }> {
  const edgesAmong = (ids: Set<string>): LayoutInput['edges'] =>
    g.conns
      .filter((k) => ids.has(k.from) && ids.has(k.to))
      .map((k) => ({ id: `k:${k.id}`, source: `c:${k.from}`, target: `c:${k.to}` }));
  const fit = (b: { width: number; height: number }) =>
    Math.abs(Math.log(b.width / b.height / 1.4));
  const top = (nodes: LayoutInput['nodes']) => nodes.filter((n) => !n.parentId).map((n) => n.id);

  if (g.frames.length === 0) {
    const nodes = g.comps.map(g.node);
    const edges = edgesAmong(new Set(g.comps.map((c) => c.id)));
    const run = (direction: 'RIGHT' | 'DOWN') =>
      layout({ nodes, edges, direction, spacing: SPACING[direction], routes: true });
    const right = await run('RIGHT');
    const rb = bounds(right.positions, top(nodes));
    if (rb.width / rb.height <= 2.2)
      return { positions: right.positions, routes: right.edges ?? {} };
    const down = await run('DOWN');
    const pick = fit(bounds(down.positions, top(nodes))) < fit(rb) ? down : right;
    return { positions: pick.positions, routes: pick.edges ?? {} };
  }

  const members = new Map(g.frames.map((f) => [f, g.comps.filter((c) => g.frameOf(c) === f)]));
  const unframed = g.comps.filter((c) => !g.frameOf(c));
  const inner = new Map<
    string,
    Awaited<ReturnType<LayoutFn>> & { box: ReturnType<typeof bounds> }
  >();
  const innerLayout = async (frame: string, direction: 'RIGHT' | 'DOWN') => {
    const k = `${frame}:${direction}`;
    if (!inner.has(k)) {
      const cs = members.get(frame)!;
      const nodes = cs.map(g.node);
      const r = await layout({
        nodes,
        edges: edgesAmong(new Set(cs.map((c) => c.id))),
        direction,
        spacing: SPACING[direction],
        routes: true,
      });
      inner.set(k, { ...r, box: bounds(r.positions, top(nodes)) });
    }
    return inner.get(k)!;
  };
  const candidate = async (dirIn: 'RIGHT' | 'DOWN', dirTop: 'RIGHT' | 'DOWN') => {
    const blocks: LayoutInput['nodes'] = [];
    for (const f of g.frames) {
      const r = await innerLayout(f, dirIn);
      blocks.push({
        id: `f:${f}`,
        width: r.box.width + FRAME_PAD.left + FRAME_PAD.right,
        height: r.box.height + FRAME_PAD.top + FRAME_PAD.bottom,
      });
    }
    const unframedNodes = unframed.map(g.node);
    const unitOf = (id: string) => {
      const c = g.comps.find((x) => x.id === id)!;
      const f = g.frameOf(c);
      return f ? `f:${f}` : `c:${id}`;
    };
    const seen = new Set<string>();
    const edges: LayoutInput['edges'] = [];
    for (const k of g.conns) {
      const a = unitOf(k.from);
      const b = unitOf(k.to);
      if (a === b && a.startsWith('f:')) continue;
      if (a.startsWith('c:') && b.startsWith('c:')) {
        edges.push({ id: `k:${k.id}`, source: a, target: b });
        continue;
      }
      if (seen.has(`${a}>${b}`)) continue;
      seen.add(`${a}>${b}`);
      edges.push({ id: `u:${a}>${b}`, source: a, target: b });
    }
    const nodes = [...blocks, ...unframedNodes];
    const t = await layout({
      nodes,
      edges,
      direction: dirTop,
      spacing: { ...SPACING[dirTop], betweenLayers: 130, nodeNode: 90 },
      routes: true,
    });
    const positions: Placed = { ...t.positions };
    const routes: Record<string, { x: number; y: number }[]> = {};
    for (const [id, pts] of Object.entries(t.edges ?? {}))
      if (id.startsWith('k:')) routes[id] = pts;
    for (const f of g.frames) {
      const r = await innerLayout(f, dirIn);
      const fp = t.positions[`f:${f}`]!;
      const dx = fp.x + FRAME_PAD.left - r.box.x;
      const dy = fp.y + FRAME_PAD.top - r.box.y;
      for (const [id, p] of Object.entries(r.positions))
        positions[id] = { ...p, x: p.x + dx, y: p.y + dy };
      for (const [id, pts] of Object.entries(r.edges ?? {}))
        routes[id] = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    return { positions, routes, box: bounds(t.positions, top(nodes)) };
  };
  const rr = await candidate('RIGHT', 'RIGHT');
  if (rr.box.width / rr.box.height <= 2.2) return rr;
  const options = [rr, await candidate('DOWN', 'RIGHT'), await candidate('RIGHT', 'DOWN')];
  return options.reduce((best, o) => (fit(o.box) < fit(best.box) ? o : best));
}

export function needsMaterialize(doc: BoardDocument): boolean {
  return doc.scene.elements.length === 0 && Object.keys(doc.components).length > 0;
}
