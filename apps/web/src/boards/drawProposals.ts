import type { BoardDocument, Component, Connection, DesignBoard } from '@atlas/schema';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { BoardContextValue } from './context.ts';
import { componentSize, deleteFromScene, renderComponent, type El } from './materialize.ts';
import { atlasTag, tagData } from './tags.ts';

/**
 * Agent proposals on an open board (D03c). Agent jobs and reviews change the board on the daemon;
 * while a board is open the scene belongs to Excalidraw and the editor's save wins, so the web
 * applies those changes to the live board instead of reloading it:
 *
 * - registry entries the daemon has and this editor does not (new proposals) are added, and
 *   drawn through the 1a renderers: `renderComponent` at a free spot in view, connections with
 *   `controller.connect` (routed around boxes, bound to both ends — existing boxes included);
 * - status changes (accept → active, reject → rejected) are taken over: accepted items re-render
 *   solid via the controller, rejected ones leave the canvas but stay in the registry (audit);
 * - doc items, scenarios and the implementation plan are merged the same way.
 *
 * The editor then saves as usual, so the stored scene matches what was drawn here.
 */
type Ctx = Pick<BoardContextValue, 'api' | 'controller' | 'patchDocument'> & {
  /** Latest local document (the controller's view of it). */
  getDocument(): BoardDocument;
};

const write = (ctx: Ctx, elements: El[]) =>
  ctx.api?.updateScene({ elements: elements as never, captureUpdate: CaptureUpdateAction.NEVER });
const scene = (ctx: Ctx) => [...(ctx.api?.getSceneElementsIncludingDeleted() ?? [])] as El[];

const isDrawn = (els: readonly El[], ids: readonly string[]) =>
  ids.some((id) => els.some((e) => e.id === id && !e.isDeleted));

function drawComponent(ctx: Ctx, c: Component) {
  const size = componentSize(c);
  const at = ctx.controller.freeSpot(size.width, size.height);
  const r = renderComponent({ ...c, elementIds: [] }, { ...at, ...size });
  ctx.patchDocument((doc) => ({
    ...doc,
    components: {
      ...doc.components,
      [c.id]: { ...c, elementIds: r.elements.map((e) => e.id) },
    },
  }));
  ctx.api?.addFiles(r.files);
  write(ctx, [...scene(ctx), ...r.elements]);
}

/** Draws a connection with the controller, then gives it back its registry id and fields. */
function drawConnection(ctx: Ctx, k: Connection) {
  const tmp = ctx.controller.connect(k.from, k.to, { status: k.status, mode: k.mode });
  if (!tmp) {
    // an end is not drawn: keep the entry, undrawn
    ctx.patchDocument((doc) => ({ ...doc, connections: { ...doc.connections, [k.id]: k } }));
    return;
  }
  const arrowId = ctx.getDocument().connections[tmp]?.elementId;
  ctx.patchDocument((doc) => {
    const { [tmp]: _drawn, ...rest } = doc.connections;
    return { ...doc, connections: { ...rest, [k.id]: { ...k, elementId: arrowId } } };
  });
  write(
    ctx,
    scene(ctx).map((e) =>
      e.id === arrowId
        ? ({
            ...e,
            customData: tagData({ kind: 'connection', id: k.id }, e.customData),
            version: e.version + 1,
          } as El)
        : e,
    ),
  );
  // label, protocol and style from the full entry
  ctx.controller.updateConnection(k.id, {
    protocol: k.protocol,
    payload: k.payload,
    volume: k.volume,
    label: k.label,
    direction: k.direction,
  });
}

function removeFromCanvas(ctx: Ctx, itemId: string) {
  const els = scene(ctx);
  const ids = new Set(
    els
      .filter((e) => {
        const t = atlasTag(e);
        return (t?.kind === 'component' || t?.kind === 'connection') && t.id === itemId;
      })
      .map((e) => e.id),
  );
  if (ids.size) write(ctx, deleteFromScene(els, ids));
}

/** Draws registry components/connections (not rejected) that have no element on the scene. */
export function drawUndrawn(ctx: Ctx): number {
  if (!ctx.api) return 0;
  let n = 0;
  const doc = ctx.getDocument();
  for (const c of Object.values(doc.components))
    if (c.status !== 'rejected' && !isDrawn(scene(ctx), c.elementIds)) {
      drawComponent(ctx, c);
      n++;
    }
  for (const k of Object.values(ctx.getDocument().connections))
    if (k.status !== 'rejected' && !(k.elementId && isDrawn(scene(ctx), [k.elementId]))) {
      const d = ctx.getDocument();
      if (!d.components[k.from] || !d.components[k.to]) continue;
      drawConnection(ctx, k);
      n++;
    }
  return n;
}

/** Applies the daemon's view of the board (after an agent job or a review) to the open editor. */
export function applyServerBoard(ctx: Ctx, server: DesignBoard): void {
  const s = server.document;
  const local = ctx.getDocument();
  // components first, so connections can bind to them
  for (const c of Object.values(s.components)) {
    const mine = local.components[c.id];
    if (!mine) {
      if (c.status !== 'rejected') drawComponent(ctx, c);
      else ctx.patchDocument((d) => ({ ...d, components: { ...d.components, [c.id]: c } }));
    } else if (mine.status !== c.status) {
      if (c.status === 'rejected') {
        removeFromCanvas(ctx, c.id);
        ctx.patchDocument((d) => ({
          ...d,
          components: { ...d.components, [c.id]: { ...d.components[c.id]!, status: 'rejected' } },
        }));
      } else ctx.controller.updateComponent(c.id, { status: c.status });
    }
  }
  for (const k of Object.values(s.connections)) {
    const mine = ctx.getDocument().connections[k.id];
    if (!mine) {
      if (k.status !== 'rejected') drawConnection(ctx, k);
      else ctx.patchDocument((d) => ({ ...d, connections: { ...d.connections, [k.id]: k } }));
    } else if (mine.status !== k.status) {
      if (k.status === 'rejected') {
        removeFromCanvas(ctx, k.id);
        ctx.patchDocument((d) => ({
          ...d,
          connections: {
            ...d.connections,
            [k.id]: { ...d.connections[k.id]!, status: 'rejected' },
          },
        }));
      } else ctx.controller.updateConnection(k.id, { status: k.status });
    }
  }
  ctx.patchDocument((d) => {
    const items = new Map(d.doc.items.map((i) => [i.id, i]));
    for (const i of s.doc.items) {
      const mine = items.get(i.id);
      items.set(i.id, mine ? { ...mine, status: i.status } : i);
    }
    const scenarios = new Map(d.scenarios.map((x) => [x.id, x]));
    for (const x of s.scenarios) {
      const mine = scenarios.get(x.id);
      scenarios.set(x.id, mine ? { ...mine, status: x.status } : x);
    }
    return {
      ...d,
      scenarios: [...scenarios.values()],
      doc: {
        ...d.doc,
        items: [...items.values()],
        ...(s.doc.plan !== undefined ? { plan: s.doc.plan } : {}),
        ...(!d.doc.summary && s.doc.summary ? { summary: s.doc.summary } : {}),
      },
    };
  });
}
