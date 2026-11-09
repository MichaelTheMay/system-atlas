import { useSyncExternalStore } from 'react';

/**
 * Following a flow across boards (D04). Opening another board remounts the whole board view, so
 * what the player is doing has to live outside it: where to come back to (a stack of frames), and
 * what the board being opened should show (`pending`). A frame is only good while the user is on
 * the board it led to; any other navigation drops the stack.
 */
export interface FlowFrame {
  /** The board and scenario the user came from, and the step that drilled down. */
  boardId: string;
  scenarioId: string;
  index: number;
  /** The board that step opened. */
  childBoardId: string;
}
export interface FlowPending {
  boardId: string;
  scenarioId: string;
  /** Step to show; `after` means "the step after this one" (coming back up). */
  index: number;
  after?: boolean;
  playing: boolean;
}
interface State {
  stack: FlowFrame[];
  pending?: FlowPending;
}

let state: State = { stack: [] };
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  for (const l of listeners) l();
};

export const flowSession = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Leave step `from.index` for the flow one level down. The caller then opens that board. */
  descend(
    from: { boardId: string; scenarioId: string; index: number },
    to: { boardId: string; scenarioId: string },
    playing: boolean,
  ) {
    set({
      stack: [...state.stack, { ...from, childBoardId: to.boardId }],
      pending: { boardId: to.boardId, scenarioId: to.scenarioId, index: 0, playing },
    });
  },
  /** The frame to return to from `boardId`, if the user got here by drilling down. */
  frameFor(boardId: string): FlowFrame | undefined {
    const top = state.stack.at(-1);
    return top?.childBoardId === boardId ? top : undefined;
  },
  /** Go back up from `boardId`. Returns the board to open, or undefined when there is none. */
  ascend(boardId: string, playing: boolean): string | undefined {
    const top = flowSession.frameFor(boardId);
    if (!top) return undefined;
    set({
      stack: state.stack.slice(0, -1),
      pending: {
        boardId: top.boardId,
        scenarioId: top.scenarioId,
        index: top.index,
        after: true,
        playing,
      },
    });
    return top.boardId;
  },
  /** What `boardId` should show now that it is open (not consumed). */
  pendingFor(boardId: string): FlowPending | undefined {
    return state.pending?.boardId === boardId ? state.pending : undefined;
  },
  /** The board has shown its pending flow. */
  consume(boardId: string) {
    if (state.pending?.boardId === boardId) set({ ...state, pending: undefined });
  },
  /**
   * A board was opened. Frames stay only while the user is on the board they led to (or on the
   * way back up); anything else is ordinary navigation and ends the session.
   */
  arrived(boardId: string) {
    const onPath =
      state.pending?.boardId === boardId || state.stack.at(-1)?.childBoardId === boardId;
    if (!onPath && (state.stack.length || state.pending)) set({ stack: [] });
  },
  reset() {
    if (state.stack.length || state.pending) set({ stack: [] });
  },
};

export const useFlowSession = () =>
  useSyncExternalStore(flowSession.subscribe, flowSession.get, flowSession.get);
