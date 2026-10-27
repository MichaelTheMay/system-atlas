import { createContext, useContext } from 'react';
import type { BoardDocument, DesignBoard } from '@atlas/schema';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { BoardController } from './controller.ts';
import type { BoardSelection } from './registry.ts';

export type { BoardSelection } from './registry.ts';

/**
 * The open board, shared by everything mounted around the canvas (D03): palette, inspector and
 * the panels waves 1b/1c add (scenarios, design doc, export, present, agent proposals).
 * `BoardView` provides it; the inspector is portalled into the App's right column and still sees it.
 *
 * Contract:
 * - `board` is the latest local state (registry edits included before they are saved).
 * - `patchDocument(fn)` edits the **registry** part of the document (components, connections,
 *   scenarios, doc, frames) and schedules a debounced save with optimistic revision. While the
 *   board is mounted `doc.scene` is NOT authoritative: the scene lives in Excalidraw, scene edits go
 *   through `api.updateScene`, and every save reads the scene from `api`. Changes to `doc.scene`
 *   made through `patchDocument` are ignored.
 * - Registry entries that are drawn keep their element ids (`Component.elementIds`, container rect
 *   first; `Connection.elementId`; `BoardFrame.elementId`) and their elements carry
 *   `customData.atlas = { kind, id, role? }` (see `tags.ts`). Use `controller` (add / update /
 *   refresh / delete / connect) rather than hand-editing elements for components and connections:
 *   it keeps both sides consistent. To draw a whole registry (agent draft, code import) use
 *   `materialize` from `materialize.ts`.
 * - `selection` follows Excalidraw's `appState.selectedElementIds` mapped through the tags;
 *   `select(target)` selects a component / connection on the canvas (`null` clears).
 */
export interface BoardContextValue {
  board: DesignBoard;
  api: ExcalidrawImperativeAPI | null;
  patchDocument(fn: (doc: BoardDocument) => BoardDocument): void;
  selection: BoardSelection;
  select(target: { componentId?: string; connectionId?: string } | null): void;
  /** Registry ↔ scene operations (palette, inspector, agent proposals). */
  controller: BoardController;
  token: string;
  /** Opens another board of the project (internals sub-board, parent). */
  openBoard(boardId: string): void;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const v = useContext(BoardContext);
  if (!v) throw new Error('useBoard() outside a <BoardView>');
  return v;
}
