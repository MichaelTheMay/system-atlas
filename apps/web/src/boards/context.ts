import { createContext, useContext } from 'react';
import type { BoardDocument, DesignBoard } from '@atlas/schema';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { atlasTag } from './materialize.ts';

/**
 * What the board side panels (properties, scenarios, design doc, export, present) share (D03).
 * BoardView provides it. `patchDocument` edits the registry (components, connections, scenarios,
 * doc, frames) and goes through the board's save path; the scene stays owned by Excalidraw.
 */
export interface BoardSelection {
  componentId?: string;
  connectionId?: string;
  elementIds: string[];
}
export interface BoardContextValue {
  board: DesignBoard;
  api: ExcalidrawImperativeAPI | null;
  patchDocument(fn: (doc: BoardDocument) => BoardDocument): void;
  selection: BoardSelection;
  select(target: { componentId?: string; connectionId?: string } | null): void;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const v = useContext(BoardContext);
  if (!v) throw new Error('useBoard() outside a board');
  return v;
}

type El = {
  id: string;
  customData?: unknown;
  containerId?: string | null;
  groupIds?: readonly string[];
  isDeleted?: boolean;
};

/** The registry entry an element stands for: its own tag, its container's, or its group's. */
export function ownerOf(
  el: El,
  byId: Map<string, El>,
  groupOwner: Map<string, ReturnType<typeof atlasTag>>,
) {
  const own = atlasTag(el);
  if (own) return own;
  const container = el.containerId ? byId.get(el.containerId) : undefined;
  if (container && atlasTag(container)) return atlasTag(container);
  for (const g of el.groupIds ?? []) if (groupOwner.get(g)) return groupOwner.get(g);
  return undefined;
}

/** Index helpers over a scene for owner lookups. */
export function sceneIndex(elements: readonly El[]) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const groupOwner = new Map<string, ReturnType<typeof atlasTag>>();
  for (const e of elements) {
    const t = atlasTag(e);
    if (t && (t.kind === 'component' || t.kind === 'connection'))
      for (const g of e.groupIds ?? []) if (!groupOwner.has(g)) groupOwner.set(g, t);
  }
  return { byId, groupOwner, owner: (e: El) => ownerOf(e, byId, groupOwner) };
}

/** Scene elements that draw one component or connection (shape, bound label, group members). */
export function elementsOf(
  elements: readonly El[],
  target: { kind: 'component' | 'connection'; id: string },
): El[] {
  const idx = sceneIndex(elements);
  return elements.filter((e) => {
    if (e.isDeleted) return false;
    const o = idx.owner(e);
    return o?.kind === target.kind && o.id === target.id;
  });
}

/** Selection derived from Excalidraw's selected element ids through the atlas tags. */
export function selectionFrom(
  elements: readonly El[],
  selectedIds: Record<string, boolean | undefined>,
): BoardSelection {
  const ids = Object.keys(selectedIds).filter((k) => selectedIds[k]);
  if (!ids.length) return { elementIds: [] };
  const idx = sceneIndex(elements);
  const owners = ids.flatMap((id) => {
    const e = idx.byId.get(id);
    const o = e ? idx.owner(e) : undefined;
    return o ? [o] : [];
  });
  const comp = owners.find((o) => o.kind === 'component');
  const conn = owners.find((o) => o.kind === 'connection');
  return {
    ...(comp ? { componentId: comp.id } : {}),
    ...(conn ? { connectionId: conn.id } : {}),
    elementIds: ids,
  };
}

export const selectionKey = (s: BoardSelection) =>
  `${s.componentId ?? ''}|${s.connectionId ?? ''}|${[...s.elementIds].sort().join(',')}`;
