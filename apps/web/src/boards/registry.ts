import {
  componentTypeInfo,
  type BoardDocument,
  type Component,
  type Connection,
} from '@atlas/schema';
import { atlasTag, type AtlasTag, type SceneElementLike } from './tags.ts';

/**
 * Registry ↔ scene reconciliation for design boards (D03 wave 1a), kept pure (no Excalidraw
 * import) so it runs under vitest. The board document's registry (components, connections,
 * frames) is the source of truth for *what* is on the board; the Excalidraw scene is the source of
 * truth for *where* it is and whether it still exists. `reconcile` reads the scene after every
 * change and returns the registry edits plus the scene edits the controller must apply.
 */

export interface BoardSelection {
  componentId?: string;
  connectionId?: string;
  elementIds: string[];
}

/** Registry entries removed from the board, kept so an Excalidraw undo can bring them back. */
export interface Tombstones {
  components: Map<string, Component>;
  connections: Map<string, Connection>;
}
export const newTombstones = (): Tombstones => ({ components: new Map(), connections: new Map() });

export interface ReconcileContext {
  tombstones: Tombstones;
  /** Elements the user is still drawing or typing in: not adopted until finished. */
  busyElementIds: ReadonlySet<string>;
  newId: (kind: 'component' | 'connection' | 'frame') => string;
}

export interface ReconcileResult {
  doc: BoardDocument;
  changed: boolean;
  /** Leftover parts of removed components (and their arrows) to delete from the scene. */
  deleteElementIds: string[];
  /** Elements whose `customData.atlas` must be (re)written. */
  retag: { elementId: string; tag: AtlasTag }[];
  /** Components that came back (undo) or were copied: their parts should be re-rendered. */
  refreshComponentIds: string[];
}

const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0]!.trim().slice(0, 120);
const textOf = (el: SceneElementLike | undefined) => el?.originalText ?? el?.text;

/** Drops components (and the connections touching them) plus every reference to them. */
export function removeFromRegistry(
  doc: BoardDocument,
  componentIds: ReadonlySet<string>,
  connectionIds: ReadonlySet<string> = new Set(),
): { doc: BoardDocument; removedConnections: Connection[] } {
  const components = { ...doc.components };
  const connections = { ...doc.connections };
  const goneConns = new Set(connectionIds);
  for (const k of Object.values(connections))
    if (componentIds.has(k.from) || componentIds.has(k.to)) goneConns.add(k.id);
  const removedConnections: Connection[] = [];
  for (const id of componentIds) delete components[id];
  for (const id of goneConns) {
    if (connections[id]) removedConnections.push(connections[id]!);
    delete connections[id];
  }
  for (const [id, c] of Object.entries(components))
    if (c.parentId && componentIds.has(c.parentId)) {
      const { parentId: _gone, ...rest } = c;
      components[id] = rest as Component;
    }
  const gone = (id: string | undefined) => !!id && (componentIds.has(id) || goneConns.has(id));
  return {
    removedConnections,
    doc: {
      ...doc,
      components,
      connections,
      frames: doc.frames.map((f) => ({
        ...f,
        componentIds: f.componentIds.filter((id) => !componentIds.has(id)),
      })),
      scenarios: doc.scenarios.map((s) => ({
        ...s,
        steps: s.steps.filter((st) => !gone(st.componentId) && !gone(st.connectionId)),
      })),
      doc: {
        ...doc.doc,
        items: doc.doc.items.map((i) => ({ ...i, pins: i.pins.filter((p) => !gone(p)) })),
      },
    },
  };
}

export function reconcile(
  doc: BoardDocument,
  elements: readonly SceneElementLike[],
  ctx: ReconcileContext,
): ReconcileResult {
  const live = new Map<string, SceneElementLike>();
  for (const el of elements) if (!el.isDeleted) live.set(el.id, el);
  const retag: ReconcileResult['retag'] = [];
  const deleteElementIds = new Set<string>();
  const refresh: string[] = [];
  let changed = false;
  let components = { ...doc.components };
  let connections = { ...doc.connections };

  // what each live element stands for (after copies get their own ids below)
  const tagOf = new Map<string, AtlasTag>();
  for (const el of live.values()) {
    const t = atlasTag(el);
    if (t) tagOf.set(el.id, t);
  }
  const partsOf = (componentId: string) =>
    [...live.values()].filter((el) => {
      const t = tagOf.get(el.id);
      return t?.kind === 'component' && t.id === componentId;
    });

  // 1. copies (copy/paste, alt-drag) and cut/paste: several boxes tagged with one component
  const boxesByComponent = new Map<string, SceneElementLike[]>();
  for (const el of live.values()) {
    const t = tagOf.get(el.id);
    if (t?.kind === 'component' && t.role === 'box')
      boxesByComponent.set(t.id, [...(boxesByComponent.get(t.id) ?? []), el]);
  }
  for (const [cid, boxes] of boxesByComponent) {
    const registered =
      components[cid]?.elementIds[0] ?? ctx.tombstones.components.get(cid)?.elementIds[0];
    const original = boxes.find((b) => b.id === registered) ?? boxes[0]!;
    for (const box of boxes) {
      if (box === original) continue;
      const source = components[cid] ?? ctx.tombstones.components.get(cid);
      if (!source) continue;
      const id = ctx.newId('component');
      const group = box.groupIds?.[0];
      const members = partsOf(cid).filter(
        (el) =>
          el.id === box.id ||
          el.containerId === box.id ||
          (!!group && el.groupIds?.includes(group) && el.id !== original.id),
      );
      for (const m of members) {
        const t = { ...tagOf.get(m.id)!, id };
        tagOf.set(m.id, t);
        retag.push({ elementId: m.id, tag: t });
      }
      const { internalsBoardId: _i, ...rest } = source;
      components[id] = {
        ...rest,
        id,
        entityIds: [],
        origin: { author: 'user' },
        status: 'active',
        elementIds: [box.id, ...members.filter((m) => m.id !== box.id).map((m) => m.id)],
      };
      refresh.push(id);
      changed = true;
    }
  }

  // 2. components: gone, renamed, or redrawn
  const removed = new Set<string>();
  for (const c of Object.values(components)) {
    const parts = partsOf(c.id);
    if (c.elementIds.length === 0 && parts.length === 0) continue; // not drawn yet
    const box = parts.find((el) => tagOf.get(el.id)?.role === 'box');
    if (!box) {
      removed.add(c.id);
      for (const p of parts) deleteElementIds.add(p.id);
      continue;
    }
    let next = c;
    const label = parts.find((el) => tagOf.get(el.id)?.role === 'label');
    if (label && !ctx.busyElementIds.has(label.id)) {
      const text = firstLine(textOf(label));
      if (text && text !== c.label) next = { ...next, label: text };
    }
    const elementIds = [box.id, ...parts.filter((p) => p !== box).map((p) => p.id)];
    if (elementIds.join() !== c.elementIds.join()) next = { ...next, elementIds };
    if (next !== c) {
      components[c.id] = next;
      changed = true;
    }
  }
  // undo of a delete: tagged boxes whose component is gone come back from the tombstones
  for (const [cid, boxes] of boxesByComponent) {
    if (components[cid] || boxes.length === 0) continue;
    const parts = partsOf(cid);
    const stone = ctx.tombstones.components.get(cid);
    const label = firstLine(textOf(parts.find((el) => tagOf.get(el.id)?.role === 'label')));
    components[cid] = {
      ...(stone ?? {
        id: cid,
        type: 'box' as const,
        label: label || 'Box',
        props: {},
        entityIds: [],
        origin: { author: 'user' as const },
        status: 'active' as const,
      }),
      elementIds: [boxes[0]!.id, ...parts.filter((p) => p !== boxes[0]).map((p) => p.id)],
    };
    ctx.tombstones.components.delete(cid);
    refresh.push(cid);
    changed = true;
  }
  if (removed.size) {
    for (const id of removed) ctx.tombstones.components.set(id, components[id]!);
    const r = removeFromRegistry({ ...doc, components, connections }, removed);
    components = r.doc.components;
    connections = r.doc.connections;
    doc = r.doc;
    for (const k of r.removedConnections) {
      ctx.tombstones.connections.set(k.id, k);
      if (k.elementId && live.has(k.elementId)) deleteElementIds.add(k.elementId);
    }
    changed = true;
  }

  const componentOfElement = (elementId: string | undefined) => {
    if (!elementId || deleteElementIds.has(elementId)) return undefined;
    const t = tagOf.get(elementId);
    return t?.kind === 'component' && components[t.id] ? t.id : undefined;
  };

  // 3. connections: deleted arrows, re-pointed arrow ends
  const goneConnections = new Set<string>();
  for (const k of Object.values(connections)) {
    if (!k.elementId) continue;
    const arrow = live.get(k.elementId);
    if (!arrow || deleteElementIds.has(arrow.id)) {
      goneConnections.add(k.id);
      continue;
    }
    if (ctx.busyElementIds.has(arrow.id)) continue;
    const from = componentOfElement(arrow.startBinding?.elementId);
    const to = componentOfElement(arrow.endBinding?.elementId);
    if (from && to && from !== to && (from !== k.from || to !== k.to)) {
      connections[k.id] = { ...k, from, to };
      changed = true;
    }
  }
  if (goneConnections.size) {
    for (const id of goneConnections) ctx.tombstones.connections.set(id, connections[id]!);
    const r = removeFromRegistry({ ...doc, components, connections }, new Set(), goneConnections);
    doc = r.doc;
    connections = r.doc.connections;
    changed = true;
  }

  // 4. arrows the user drew between two components become connections (or come back on undo)
  for (const el of live.values()) {
    if (el.type !== 'arrow' || ctx.busyElementIds.has(el.id) || deleteElementIds.has(el.id))
      continue;
    const t = tagOf.get(el.id);
    if (t?.kind === 'connection' && connections[t.id]?.elementId === el.id) continue;
    const from = componentOfElement(el.startBinding?.elementId);
    const to = componentOfElement(el.endBinding?.elementId);
    const stone = t?.kind === 'connection' ? ctx.tombstones.connections.get(t.id) : undefined;
    if (stone && !connections[stone.id] && components[stone.from] && components[stone.to]) {
      connections[stone.id] = { ...stone, elementId: el.id };
      ctx.tombstones.connections.delete(stone.id);
      changed = true;
      continue;
    }
    if (!from || !to || from === to) continue;
    const id = ctx.newId('connection');
    const text = [...live.values()].find((x) => x.containerId === el.id && x.type === 'text');
    const label = textOf(text)?.trim().slice(0, 120);
    connections[id] = {
      id,
      from,
      to,
      mode: 'sync',
      direction: 'request-response',
      ...(label ? { label } : {}),
      origin: { author: 'user' },
      status: 'active',
      elementId: el.id,
    };
    retag.push({ elementId: el.id, tag: { kind: 'connection', id } });
    changed = true;
  }

  // 5. frames: deleted, renamed, drawn with Excalidraw's frame tool, membership from the scene
  let frames = doc.frames;
  const frameEls = [...live.values()].filter((el) => el.type === 'frame');
  const nextFrames: BoardDocument['frames'] = [];
  for (const f of frames) {
    const el = f.elementId ? live.get(f.elementId) : undefined;
    if (f.elementId && !el) continue;
    if (!el) {
      nextFrames.push(f);
      continue;
    }
    const label = (el.name ?? '').trim().slice(0, 120) || f.label;
    const componentIds = Object.values(components)
      .filter((c) => c.elementIds[0] && live.get(c.elementIds[0])?.frameId === el.id)
      .map((c) => c.id);
    nextFrames.push({ ...f, label, componentIds });
  }
  for (const el of frameEls) {
    if (nextFrames.some((f) => f.elementId === el.id)) continue;
    const t = tagOf.get(el.id);
    const id =
      t?.kind === 'frame' && !nextFrames.some((f) => f.id === t.id) ? t.id : ctx.newId('frame');
    nextFrames.push({
      id,
      label: (el.name ?? '').trim().slice(0, 120) || 'Frame',
      componentIds: Object.values(components)
        .filter((c) => c.elementIds[0] && live.get(c.elementIds[0])?.frameId === el.id)
        .map((c) => c.id),
      elementId: el.id,
    });
    if (t?.kind !== 'frame' || t.id !== id)
      retag.push({ elementId: el.id, tag: { kind: 'frame', id } });
  }
  if (JSON.stringify(nextFrames) !== JSON.stringify(frames)) {
    frames = nextFrames;
    changed = true;
  }

  return {
    doc: changed ? { ...doc, components, connections, frames } : doc,
    changed,
    deleteElementIds: [...deleteElementIds],
    retag,
    refreshComponentIds: refresh,
  };
}

/** What the current Excalidraw selection stands for in the registry. */
export function selectionFor(
  elements: readonly SceneElementLike[],
  selectedElementIds: Readonly<Record<string, boolean>>,
): BoardSelection {
  const ids = Object.keys(selectedElementIds).filter((id) => selectedElementIds[id]);
  const byId = new Map(elements.map((e) => [e.id, e]));
  const comps = new Set<string>();
  const conns = new Set<string>();
  for (const id of ids) {
    const el = byId.get(id);
    if (!el || el.isDeleted) continue;
    const t = atlasTag(el) ?? atlasTag(el.containerId ? byId.get(el.containerId) : undefined);
    if (t?.kind === 'component') comps.add(t.id);
    else if (t?.kind === 'connection') conns.add(t.id);
  }
  return {
    elementIds: ids,
    ...(comps.size === 1 && conns.size === 0 ? { componentId: [...comps][0] } : {}),
    ...(conns.size === 1 && comps.size === 0 ? { connectionId: [...conns][0] } : {}),
  };
}

/** Badge texts for a component's set properties ("postgres", "4 instances", "stateful"). */
export function componentBadges(c: Pick<Component, 'type' | 'props'>): string[] {
  const info = componentTypeInfo(c.type);
  const out: string[] = [];
  const known = new Set(info.properties.map((p) => p.key));
  for (const p of info.properties) {
    const v = c.props[p.key];
    if (v === undefined || v === '' || v === false) continue;
    if (v === true) out.push(p.label.toLowerCase());
    else if (typeof v === 'number')
      out.push(p.hint ? `${v} ${p.hint}` : `${p.label.toLowerCase()} ${v}`);
    else out.push(String(v));
  }
  for (const [k, v] of Object.entries(c.props))
    if (!known.has(k) && v !== '' && v !== false) out.push(v === true ? k : `${k}: ${v}`);
  return out;
}

/** "payload · protocol · volume", broken in two lines when long. */
export function connectionLabelText(
  k: Pick<Connection, 'label' | 'payload' | 'protocol' | 'volume'>,
): string {
  const head = k.label ?? k.payload;
  const tail = [k.protocol, k.volume].filter(Boolean).join(' · ');
  const one = [head, tail].filter(Boolean).join(' · ');
  return head && tail && one.length > 30 ? `${head}\n${tail}` : one;
}

/** Breaks badge texts into lines of at most `max` characters. */
export function badgeLines(badges: readonly string[], max = 30): string[] {
  const lines: string[] = [];
  for (const b of badges) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 3 + b.length <= max)
      lines[lines.length - 1] = `${last} · ${b}`;
    else lines.push(b.length > max ? `${b.slice(0, max - 1)}…` : b);
  }
  return lines;
}
