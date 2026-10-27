import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getBoard } from './api.ts';
import { useBoard } from './context.ts';
import { applyServerBoard, drawUndrawn } from './drawProposals.ts';
import { proposedRows } from './ProposalsPanel.tsx';
import { call, errorText } from '../components/design/useDesignJobs.ts';
import {
  useBoardJobs,
  type BoardJobDto,
  type BoardJobKind,
  type BoardJobs,
} from './useBoardJobs.ts';

/**
 * Agent state of an open board (D03c), shared by the "Agent ▾" menu in the board header and the
 * Proposals / Plan tabs of the board inspector: the running job, its last result, the inspector
 * tab, and `review` (accept / reject proposals). Lives inside `BoardContext`.
 */
export type InspectorTab = 'properties' | 'proposals' | 'plan';

export interface BoardAgentValue {
  jobs: BoardJobs;
  /** The last job started from this board (progress while it runs, then its result). */
  last?: { title: string; job?: BoardJobDto };
  clearLast(): void;
  tab: InspectorTab;
  setTab(t: InspectorTab): void;
  /** Explicit user action: start a board job on this board. */
  start(kind: BoardJobKind, title: string, body?: Record<string, unknown>): Promise<boolean>;
  review(body: { accept?: string[]; reject?: string[] }): Promise<string | undefined>;
  /** Consent was asked for before this job could start (non-mock runtime). */
  pendingConsent?: { kind: BoardJobKind; title: string; body: Record<string, unknown> };
  agreeAndStart(): Promise<void>;
  cancelConsent(): void;
  /** Settings are loaded only once an agent surface is used (they check runtime availability). */
  enable(): void;
}

const Ctx = createContext<BoardAgentValue | null>(null);

export function useBoardAgent(): BoardAgentValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBoardAgent() outside a <BoardAgentProvider>');
  return v;
}

export function BoardAgentProvider({ children }: { children: ReactNode }) {
  const board = useBoard();
  const { api, controller, patchDocument, token } = board;
  const [used, setUsed] = useState(false);
  // a board opened with proposals waiting (a fresh draft) starts on them
  const [tab, setTab] = useState<InspectorTab>(() =>
    proposedRows(board.board).length ? 'proposals' : 'properties',
  );
  // selecting something on the canvas shows its properties
  const picked = board.selection.componentId ?? board.selection.connectionId;
  useEffect(() => {
    if (picked) setTab('properties');
  }, [picked]);
  const [last, setLast] = useState<BoardAgentValue['last']>();
  const [pendingConsent, setPendingConsent] = useState<BoardAgentValue['pendingConsent']>();
  const live = useRef(board);
  live.current = board;
  /**
   * The editor's latest document, synchronously (the context's `board` lags one render behind a
   * series of patches): `patchDocument` hands its callback the current document; returning it
   * unchanged is a no-op.
   */
  const getDocument = useCallback(() => {
    let doc = live.current.board.document;
    patchDocument((d) => {
      doc = d;
      return d;
    });
    return doc;
  }, [patchDocument]);

  /** Re-reads the board from the daemon and applies agent changes to the open editor. */
  const sync = useCallback(async () => {
    const server = await getBoard(token, live.current.board.id);
    applyServerBoard({ api: live.current.api, controller, patchDocument, getDocument }, server);
  }, [token, controller, patchDocument, getDocument]);

  const jobs = useBoardJobs(
    token,
    board.board.projectId,
    (job) => {
      setLast((l) => (l ? { ...l, job } : l));
      if (job.state !== 'succeeded') return;
      if (job.boardId === live.current.board.id || job.kind === 'implementation-plan')
        void sync().then(() => {
          if (job.kind === 'implementation-plan') setTab('plan');
          else if (job.proposedBoardItems) setTab('proposals');
        });
    },
    used,
  );

  // proposals added while the board was closed (CLI, MCP) get drawn once the canvas is up
  const drawnOnce = useRef(false);
  useEffect(() => {
    if (!api || drawnOnce.current) return;
    drawnOnce.current = true;
    const t = setTimeout(() => drawUndrawn({ api, controller, patchDocument, getDocument }), 200);
    return () => clearTimeout(t);
  }, [api, controller, patchDocument, getDocument]);

  const run = useCallback(
    async (kind: BoardJobKind, title: string, body: Record<string, unknown>) => {
      setLast({ title });
      setTab('proposals');
      return jobs.run(kind, { boardId: live.current.board.id, ...body });
    },
    [jobs],
  );

  const start = useCallback(
    async (kind: BoardJobKind, title: string, body: Record<string, unknown> = {}) => {
      setUsed(true);
      const rt = jobs.settings?.runtime ?? 'mock';
      if (rt !== 'mock' && jobs.settings && !jobs.settings.consented[rt]) {
        setPendingConsent({ kind, title, body });
        return false;
      }
      return run(kind, title, body);
    },
    [jobs.settings, run],
  );

  const review = useCallback(
    async (body: { accept?: string[]; reject?: string[] }) => {
      const r = await call<unknown>(token, 'POST', `/boards/${live.current.board.id}/review`, body);
      if (!r.ok) return errorText(r);
      await sync();
      return undefined;
    },
    [token, sync],
  );

  const value = useMemo<BoardAgentValue>(
    () => ({
      jobs,
      last,
      clearLast: () => {
        setLast(undefined);
        if (!jobs.running) jobs.clear();
      },
      tab,
      setTab,
      start,
      review,
      pendingConsent,
      agreeAndStart: async () => {
        const p = pendingConsent;
        const rt = jobs.settings?.runtime;
        setPendingConsent(undefined);
        if (p && rt && (await jobs.consent(rt))) await run(p.kind, p.title, p.body);
      },
      cancelConsent: () => setPendingConsent(undefined),
      enable: () => setUsed(true),
    }),
    [jobs, last, tab, start, review, pendingConsent, run],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
