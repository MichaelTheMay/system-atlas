import { emptyBoardDocument, type BoardSpec, type DesignBoard } from '@atlas/schema';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { BinaryFileData } from '@excalidraw/excalidraw/types';
import { api } from '../api.ts';
import { layoutInWorker } from '../layout.ts';
import type { BoardContextValue } from './context.ts';
import { materialize, type El } from './materialize.ts';

/**
 * "From code" (D03 wave 1b): the daemon reads the derived design lens of the project's latest
 * snapshot as a BoardSpec ("as built": components with `origin.author = 'code'`, one frame). It is
 * either a new board (`source: 'code'`, drawn on first open) or added to the open board next to
 * what is already drawn. Either way it is a copy: drawn faded, never a fact, never re-synced.
 */
export const fromCodeStatus = (token: string, projectId: string) =>
  api<{ available: boolean; snapshotId?: string }>(
    `/projects/${projectId}/boards/from-code`,
    token,
  );

export const createBoardFromCode = (
  token: string,
  projectId: string,
  input: { name?: string; snapshotId?: string } = {},
) =>
  api<DesignBoard>(`/projects/${projectId}/boards/from-code`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

export const codeSpec = (token: string, projectId: string) =>
  api<{ snapshotId: string; spec: BoardSpec }>(
    `/projects/${projectId}/boards/from-code/spec`,
    token,
  );

/**
 * Adds the "as built" spec to an already-drawn board: ids that clash with the board's get a
 * suffix, 1a's materializer lays the import out on its own (ELK, frame, faded parts), and the
 * result is placed to the right of the current drawing; the registry goes in through
 * `patchDocument`. Returns the number of components added.
 */
export async function importAsBuilt(
  ctx: Pick<BoardContextValue, 'board' | 'api' | 'patchDocument' | 'token'>,
): Promise<number> {
  const a = ctx.api;
  if (!a) return 0;
  const { spec } = await codeSpec(ctx.token, ctx.board.projectId);
  const cur = ctx.board.document;
  const taken = new Set([
    ...Object.keys(cur.components),
    ...Object.keys(cur.connections),
    ...cur.frames.map((f) => f.id),
  ]);
  const ren = new Map<string, string>();
  const fresh = (id: string) => {
    let n = id;
    for (let i = 2; taken.has(n); i++) n = `${id}-${i}`.slice(-64);
    taken.add(n);
    ren.set(id, n);
    return n;
  };
  const temp = emptyBoardDocument();
  for (const c of spec.components) {
    const id = fresh(c.id);
    temp.components[id] = { ...c, id, elementIds: [] };
  }
  for (const k of spec.connections) {
    const id = fresh(k.id);
    temp.connections[id] = { ...k, id, from: ren.get(k.from)!, to: ren.get(k.to)! };
  }
  temp.frames = spec.frames.map((f) => ({
    ...f,
    id: fresh(f.id),
    componentIds: f.componentIds.flatMap((id) => (ren.has(id) ? [ren.get(id)!] : [])),
  }));
  const drawn = await materialize(temp, layoutInWorker);
  const els = drawn.scene.elements as unknown as El[];
  // to the right of what is on the board, top-aligned
  const existing = a.getSceneElements();
  const right = existing.length ? Math.max(...existing.map((e) => e.x + e.width)) + 200 : 0;
  const top = existing.length ? Math.min(...existing.map((e) => e.y)) : 0;
  const dx = right - Math.min(...els.map((e) => e.x));
  const dy = top - Math.min(...els.map((e) => e.y));
  const placed = els.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy })) as El[];
  ctx.patchDocument((d) => ({
    ...d,
    components: { ...d.components, ...drawn.components },
    connections: { ...d.connections, ...drawn.connections },
    frames: [...d.frames, ...drawn.frames],
  }));
  a.addFiles(Object.values(drawn.scene.files) as unknown as BinaryFileData[]);
  a.updateScene({
    elements: [...a.getSceneElementsIncludingDeleted(), ...placed] as never,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  a.scrollToContent(placed as never, {
    fitToViewport: true,
    viewportZoomFactor: 0.85,
    animate: true,
  });
  return Object.keys(drawn.components).length;
}
