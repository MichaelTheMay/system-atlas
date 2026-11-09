import {
  componentTypeInfo,
  type BoardDocument,
  type Component,
  type ComponentType,
  type Connection,
} from '@atlas/schema';
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import {
  CONTAINER_HEADER,
  componentSize,
  deleteFromScene,
  refreshComponent,
  refreshConnection,
  renderComponent,
  renderConnection,
  renderFrame,
  renderSticky,
  type El,
} from './materialize.ts';
import {
  newTombstones,
  reconcile,
  removeFromRegistry,
  selectionFor,
  type BoardSelection,
} from './registry.ts';
import { routeAround } from './route.ts';
import { atlasTag, tagData, type AtlasTag } from './tags.ts';

export type ComponentPatch = Partial<
  Pick<Component, 'label' | 'type' | 'props' | 'responsibility' | 'internalsBoardId' | 'status'>
>;
export type ConnectionPatch = Partial<
  Pick<Connection, 'protocol' | 'mode' | 'direction' | 'payload' | 'volume' | 'label' | 'status'>
>;

export interface BoardControllerHost {
  /** The current board document (registry); synchronous, includes edits not yet saved. */
  getDocument(): BoardDocument;
  /** Replaces the registry part of the document and schedules a save. */
  patchDocument(fn: (doc: BoardDocument) => BoardDocument): void;
  getApi(): ExcalidrawImperativeAPI | null;
  onSelection(selection: BoardSelection): void;
}

const shortId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Keeps a board's registry and its Excalidraw scene in sync (D03 wave 1a).
 *
 * Scene → registry (`onSceneChange`, every Excalidraw onChange): deleting a component's box
 * removes the component, its other parts and the connections touching it; editing its label text
 * renames it; an arrow drawn between two components becomes a connection; deleting an arrow
 * removes its connection; copy/paste clones; undo of a delete restores from in-memory tombstones.
 *
 * Registry → scene (the methods below, used by the palette and inspector): add, edit, re-render
 * and delete entries in place. Scene writes from registry edits use `CaptureUpdateAction.NEVER`
 * (the registry is the authority; Excalidraw's undo stays about drawing), except deletes, which
 * are undoable (`IMMEDIATELY`) and come back through the tombstones.
 */
export class BoardController {
  private readonly host: BoardControllerHost;
  private readonly tombstones = newTombstones();
  private lastSelection = '';

  constructor(host: BoardControllerHost) {
    this.host = host;
  }

  private get api() {
    return this.host.getApi();
  }

  private scene(): El[] {
    return [...(this.api?.getSceneElementsIncludingDeleted() ?? [])] as El[];
  }

  private write(elements: El[], capture: 'never' | 'immediately' = 'never') {
    this.api?.updateScene({
      elements: elements as never,
      captureUpdate:
        capture === 'never' ? CaptureUpdateAction.NEVER : CaptureUpdateAction.IMMEDIATELY,
    });
  }

  /** Scene → registry; call from Excalidraw's onChange with the elements including deleted ones. */
  onSceneChange(elements: readonly El[], appState: AppState): void {
    const busy = new Set<string>(
      [appState.newElement?.id, appState.multiElement?.id, appState.editingTextElement?.id].filter(
        (x): x is string => !!x,
      ),
    );
    if (appState.editingLinearElement) busy.add(appState.editingLinearElement.elementId);
    const r = reconcile(this.host.getDocument(), elements as never, {
      tombstones: this.tombstones,
      busyElementIds: busy,
      newId: (kind) =>
        shortId(kind === 'component' ? 'cmp' : kind === 'connection' ? 'con' : 'frm'),
    });
    if (r.changed) this.host.patchDocument(() => r.doc);
    if (r.deleteElementIds.length || r.retag.length) {
      let next = r.deleteElementIds.length
        ? deleteFromScene(elements, new Set(r.deleteElementIds))
        : [...elements];
      const tags = new Map(r.retag.map((t) => [t.elementId, t.tag]));
      next = next.map((el) =>
        tags.has(el.id)
          ? newElementWith(el, { customData: tagData(tags.get(el.id)!, el.customData) })
          : el,
      );
      this.write(next);
    }
    for (const id of r.refreshComponentIds) this.refreshComponent(id);
    const sel = selectionFor(elements as never, appState.selectedElementIds);
    const key = JSON.stringify(sel);
    if (key !== this.lastSelection) {
      this.lastSelection = key;
      this.host.onSelection(sel);
    }
  }

  /** A free spot near the centre of the current view for a box of the given size. */
  freeSpot(width: number, height: number): { x: number; y: number } {
    const api = this.api;
    if (!api) return { x: 0, y: 0 };
    const s = api.getAppState();
    const z = s.zoom.value;
    const cx = -s.scrollX + s.width / 2 / z - width / 2;
    const cy = -s.scrollY + s.height / 2 / z - height / 2;
    const boxes = api
      .getSceneElements()
      .filter((e) => e.type !== 'text' && e.type !== 'arrow' && e.type !== 'frame');
    const free = (x: number, y: number) =>
      boxes.every(
        (b) =>
          x >= b.x + b.width + 24 ||
          b.x >= x + width + 24 ||
          y >= b.y + b.height + 24 ||
          b.y >= y + height + 24,
      );
    for (let r = 0; r < 40; r++)
      for (let i = 0; i <= Math.max(0, r * 8 - 1); i++) {
        const a = r === 0 ? 0 : (i / (r * 8)) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(a) * r * 60);
        const y = Math.round(cy + Math.sin(a) * r * 60);
        if (free(x, y)) return { x, y };
      }
    return { x: cx, y: cy };
  }

  /** Adds a component of `type` (at a scene point, else a free spot in view) and selects it. */
  addComponent(type: ComponentType, at?: { x: number; y: number }): string {
    const info = componentTypeInfo(type);
    const id = shortId(type);
    const c: Component = {
      id,
      type,
      label: info.label,
      props: {},
      entityIds: [],
      origin: { author: 'user' },
      status: 'active',
      elementIds: [],
    };
    const size = componentSize(c);
    const pos = at
      ? { x: at.x - size.width / 2, y: at.y - size.height / 2 }
      : this.freeSpot(size.width, size.height);
    const r = renderComponent(c, { ...pos, ...size });
    const box = r.elements[0]!;
    this.host.patchDocument((doc) => ({
      ...doc,
      components: {
        ...doc.components,
        [id]: { ...c, elementIds: [box.id, ...r.elements.slice(1).map((e) => e.id)] },
      },
    }));
    this.api?.addFiles(r.files);
    this.write([...this.scene(), ...r.elements], 'immediately');
    this.select({ componentId: id });
    return id;
  }

  updateComponent(id: string, patch: ComponentPatch): void {
    const cur = this.host.getDocument().components[id];
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.host.patchDocument((doc) => ({
      ...doc,
      components: { ...doc.components, [id]: { ...doc.components[id]!, ...patch } },
    }));
    if ('label' in patch || 'type' in patch || 'props' in patch || 'status' in patch)
      this.refreshComponent(id, next);
  }

  /** Re-renders a component's parts from the registry (keeps its place). */
  refreshComponent(id: string, c = this.host.getDocument().components[id]): void {
    if (!c || !this.api) return;
    const r = refreshComponent(this.scene(), c);
    if (!r) return;
    this.api.addFiles(r.files);
    this.write(r.elements);
  }

  deleteComponent(id: string): void {
    const doc = this.host.getDocument();
    const c = doc.components[id];
    if (!c) return;
    const scene = this.scene();
    const ids = new Set(
      scene
        .filter((e) => {
          const t = atlasTag(e);
          return t?.kind === 'component' && t.id === id;
        })
        .map((e) => e.id),
    );
    const r = removeFromRegistry(doc, new Set([id]));
    this.tombstones.components.set(id, c);
    for (const k of r.removedConnections) {
      this.tombstones.connections.set(k.id, k);
      if (k.elementId) ids.add(k.elementId);
    }
    this.host.patchDocument(() => r.doc);
    this.write(deleteFromScene(scene, ids), 'immediately');
  }

  /** Draws a new connection between two components (inspector "Connect to…"). */
  connect(from: string, to: string, init: ConnectionPatch = {}): string | undefined {
    const doc = this.host.getDocument();
    const a = doc.components[from];
    const b = doc.components[to];
    if (!a || !b || from === to) return undefined;
    const scene = this.scene();
    const boxA = scene.find((e) => e.id === a.elementIds[0] && !e.isDeleted);
    const boxB = scene.find((e) => e.id === b.elementIds[0] && !e.isDeleted);
    if (!boxA || !boxB) return undefined;
    const id = shortId('con');
    const k: Connection = {
      id,
      from,
      to,
      mode: 'sync',
      direction: 'request-response',
      origin: { author: 'user' },
      status: 'active',
      ...init,
    };
    // around every other component box (containers may be crossed: arrows enter zones)
    const obstacles = scene.flatMap((e) => {
      const t = atlasTag(e);
      if (e.isDeleted || t?.kind !== 'component' || t.role !== 'box' || e === boxA || e === boxB)
        return [];
      const c = doc.components[t.id];
      if (!c) return [];
      return [componentTypeInfo(c.type).container ? { ...e, height: CONTAINER_HEADER } : e];
    });
    const avoid = scene
      .filter((e) => e.type === 'arrow' && !e.isDeleted)
      .map((e) => {
        const a = e as El & { points: readonly (readonly [number, number])[] };
        return a.points.map(([x, y]) => ({ x: a.x + x, y: a.y + y }));
      });
    const route = routeAround(boxA, boxB, obstacles, { avoid });
    const els = renderConnection(k, route, { from: boxA, to: boxB });
    const arrowId = els[0]!.id;
    this.host.patchDocument((d) => ({
      ...d,
      connections: { ...d.connections, [id]: { ...k, elementId: arrowId } },
    }));
    const next = scene.map((e) =>
      e === boxA || e === boxB
        ? newElementWith(e, {
            boundElements: [...(e.boundElements ?? []), { id: arrowId, type: 'arrow' as const }],
          })
        : e,
    );
    this.write([...next, ...els], 'immediately');
    return id;
  }

  updateConnection(id: string, patch: ConnectionPatch): void {
    const cur = this.host.getDocument().connections[id];
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.host.patchDocument((doc) => ({
      ...doc,
      connections: { ...doc.connections, [id]: { ...doc.connections[id]!, ...patch } },
    }));
    const els = refreshConnection(this.scene(), next);
    if (els) this.write(els);
  }

  /** Swaps a connection's ends: registry from/to, arrow points and bindings. */
  reverseConnection(id: string): void {
    const k = this.host.getDocument().connections[id];
    if (!k) return;
    const next = { ...k, from: k.to, to: k.from };
    this.host.patchDocument((doc) => ({ ...doc, connections: { ...doc.connections, [id]: next } }));
    const scene = this.scene();
    const arrow = scene.find((e) => e.id === k.elementId && !e.isDeleted) as
      | (El & {
          points: readonly (readonly [number, number])[];
          startBinding: unknown;
          endBinding: unknown;
        })
      | undefined;
    if (!arrow) return;
    const abs = arrow.points.map(([x, y]) => ({ x: arrow.x + x, y: arrow.y + y })).reverse();
    const p0 = abs[0]!;
    const swapped = newElementWith(
      arrow as never,
      {
        x: p0.x,
        y: p0.y,
        points: abs.map((p) => [p.x - p0.x, p.y - p0.y]),
        startBinding: arrow.endBinding,
        endBinding: arrow.startBinding,
      } as never,
    ) as El;
    const els = refreshConnection(
      scene.map((e) => (e === arrow ? swapped : e)),
      next,
    );
    if (els) this.write(els);
  }

  deleteConnection(id: string): void {
    const doc = this.host.getDocument();
    const k = doc.connections[id];
    if (!k) return;
    this.tombstones.connections.set(id, k);
    this.host.patchDocument((d) => removeFromRegistry(d, new Set(), new Set([id])).doc);
    if (k.elementId)
      this.write(deleteFromScene(this.scene(), new Set([k.elementId])), 'immediately');
  }

  /** Adds an empty frame in view (frames drawn with Excalidraw's own tool are adopted too). */
  addFrame(label = 'Frame'): string {
    const id = shortId('frm');
    const pos = this.freeSpot(520, 360);
    const els = renderFrame(id, label, { ...pos, width: 520, height: 360 });
    this.host.patchDocument((doc) => ({
      ...doc,
      frames: [...doc.frames, { id, label, componentIds: [], elementId: els[0]!.id }],
    }));
    this.write([...this.scene(), ...els], 'immediately');
    return id;
  }

  addSticky(text?: string): void {
    const pos = this.freeSpot(180, 120);
    this.write([...this.scene(), ...renderSticky(pos, text)], 'immediately');
  }

  /** Selects a registry entry's elements on the canvas (or clears the selection). */
  select(target: { componentId?: string; connectionId?: string } | null): void {
    const api = this.api;
    if (!api) return;
    const doc = this.host.getDocument();
    let ids: string[] = [];
    const groups: Record<string, boolean> = {};
    if (target?.componentId) {
      const c = doc.components[target.componentId];
      const scene = api.getSceneElements();
      const parts = scene.filter((e) => {
        const t = atlasTag(e) as AtlasTag | undefined;
        return t?.kind === 'component' && t.id === target.componentId;
      });
      ids = parts.map((e) => e.id);
      const box = parts.find((e) => e.id === c?.elementIds[0]);
      if (box?.groupIds[0]) groups[box.groupIds[0]] = true;
    } else if (target?.connectionId) {
      const k = doc.connections[target.connectionId];
      if (k?.elementId) ids = [k.elementId];
    }
    api.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
        selectedGroupIds: groups,
      } as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  /** Scrolls the canvas to a component. */
  reveal(componentId: string): void {
    const api = this.api;
    const c = this.host.getDocument().components[componentId];
    if (!api || !c) return;
    const els = api.getSceneElements().filter((e) => c.elementIds.includes(e.id));
    if (els.length) api.scrollToContent(els as never, { animate: true });
  }
}
