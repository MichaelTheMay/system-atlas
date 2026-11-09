import { useCallback, useEffect, useRef, useState } from 'react';
import {
  call,
  errorText,
  isTerminal,
  useDesignJobs,
  useDesignSettings,
  type DesignAgentSettingsDto,
  type DesignJobDto,
  type RuntimeId,
} from '../components/design/useDesignJobs.ts';

/**
 * Design-board agent jobs in the web (D03c), on top of the D02 job client: the configured runtime
 * (mock by default), the same consent gate, progress from `design.job` SSE events. When a job
 * ends, `onFinished` gets the final job (with `boardId`, `proposedBoardItems` and `result`).
 */
export type BoardJobKind =
  | 'draft-board'
  | 'critique-board'
  | 'fill-doc'
  | 'explain-scenario'
  | 'variant-board'
  | 'implementation-plan';

export type BoardJobDto = Omit<DesignJobDto, 'kind'> & {
  kind: BoardJobKind;
  boardId?: string;
  proposedBoardItems?: number;
  result?: string;
};

export const BOARD_JOB_LABEL: Record<BoardJobKind, string> = {
  'draft-board': 'Draft from prompt',
  'critique-board': 'Critique',
  'fill-doc': 'Fill the design doc',
  'explain-scenario': 'Explain scenario',
  'variant-board': 'Propose a variant',
  'implementation-plan': 'Implementation plan',
};

export function useBoardJobs(
  token: string,
  projectId: string,
  onFinished: (job: BoardJobDto) => void,
  enabled = true,
) {
  const { settings, setSettings } = useDesignSettings(token, enabled);
  const jobs = useDesignJobs(token, projectId);
  const [error, setError] = useState<string>();
  const reported = useRef<string | undefined>(undefined);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const job = jobs.active?.job as unknown as BoardJobDto | undefined;
  useEffect(() => {
    if (!job || !isTerminal(job.state) || reported.current === job.id) return;
    // the terminal SSE state arrives before the job is re-read: wait for the finished record
    if (!job.finishedAt) return;
    reported.current = job.id;
    finished.current(job);
  }, [job]);

  // SSE can deliver a fast (mock) job's events before the POST returns: re-read while it runs
  const runningId = job && !isTerminal(job.state) ? job.id : undefined;
  const { refresh } = jobs;
  useEffect(() => {
    if (!runningId) return;
    const t = setInterval(() => void refresh(runningId), 1_000);
    return () => clearInterval(t);
  }, [runningId, refresh]);

  const consent = useCallback(
    async (runtime: RuntimeId): Promise<boolean> => {
      const r = await call<DesignAgentSettingsDto>(token, 'PUT', '/settings/design-agent', {
        runtime,
        consent: true,
      });
      if (r.ok) setSettings(r.body);
      else setError(errorText(r));
      return r.ok;
    },
    [token, setSettings],
  );

  /** Explicit user action only. Returns false (with `error` set) when the job did not start. */
  const run = useCallback(
    async (kind: BoardJobKind, body: Record<string, unknown>, runtime?: RuntimeId) => {
      setError(undefined);
      const rt = runtime ?? settings?.runtime ?? 'mock';
      const err = await jobs.start({ kind, runtime: rt, ...body });
      if (err) setError(err);
      return !err;
    },
    [jobs, settings?.runtime],
  );

  return {
    settings,
    job,
    progress: jobs.active?.progress ?? [],
    running: !!job && !isTerminal(job.state),
    error,
    setError,
    run,
    consent,
    cancel: jobs.cancel,
    clear: jobs.clear,
  };
}

export type BoardJobs = ReturnType<typeof useBoardJobs>;

/** POST /boards/:id/review; returns the error text, or undefined on success. */
export async function reviewBoard(
  token: string,
  boardId: string,
  body: { accept?: string[]; reject?: string[] },
): Promise<string | undefined> {
  const r = await call<unknown>(token, 'POST', `/boards/${boardId}/review`, body);
  return r.ok ? undefined : errorText(r);
}
