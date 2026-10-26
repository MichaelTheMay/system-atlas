import { uuidv7Hex, type Worktree } from '@atlas/schema';
import type { Analyzer } from '@atlas/analyzers';
import { compactSnapshots, scanWorktree } from '@atlas/graph';
import type { Db } from '@atlas/store';
import type { EventBus } from './events.ts';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: 'scan';
  worktreeId: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  phase?: string;
  snapshotId?: string;
  snapshotState?: string;
  counts?: Record<string, number>;
  /** The tree was unchanged: the existing snapshot was returned and nothing was published. */
  noop?: boolean;
  compacted?: number;
  error?: string;
}

/**
 * Serial job runner: the daemon is the single writer (plan §9). A new scan request for a worktree
 * replaces a queued one and cancels a running one, so obsolete work never publishes.
 */
export class JobRunner {
  private jobs = new Map<string, Job>();
  private queue: { job: Job; worktree: Worktree }[] = [];
  private running?: { job: Job; ctrl: AbortController };
  private db: Db;
  private bus: EventBus;
  private analyzers: () => Analyzer[];

  constructor(db: Db, bus: EventBus, analyzers: () => Analyzer[]) {
    this.db = db;
    this.bus = bus;
    this.analyzers = analyzers;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  enqueueScan(worktree: Worktree): Job {
    const queued = this.queue.find((q) => q.job.worktreeId === worktree.id);
    if (queued) return queued.job;
    if (this.running?.job.worktreeId === worktree.id)
      this.running.ctrl.abort(new Error('superseded by a newer scan'));
    const job: Job = {
      id: `job_${uuidv7Hex()}`,
      kind: 'scan',
      worktreeId: worktree.id,
      state: 'queued',
      createdAt: new Date().toISOString(),
    };
    this.remember(job);
    this.queue.push({ job, worktree });
    queueMicrotask(() => void this.pump());
    return job;
  }

  /** Resolves when the job reaches a final state (or the timeout passes). */
  async wait(jobId: string, timeoutMs = 120_000): Promise<Job | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const j = this.jobs.get(jobId);
      if (!j || (j.state !== 'queued' && j.state !== 'running') || Date.now() > deadline) return j;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Waits for the queue to drain (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 10));
  }

  private remember(job: Job) {
    this.jobs.set(job.id, job);
    if (this.jobs.size > 200) this.jobs.delete(this.jobs.keys().next().value!);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const { job, worktree } = next;
    const ctrl = new AbortController();
    this.running = { job, ctrl };
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    this.bus.publish({ type: 'scan.started', data: { jobId: job.id, worktreeId: job.worktreeId } });
    try {
      const r = await scanWorktree(this.db, worktree, {
        analyzers: this.analyzers(),
        signal: ctrl.signal,
        onProgress: (p) => {
          job.phase = p.detail ? `${p.phase}:${p.detail}` : p.phase;
        },
      });
      job.state = 'succeeded';
      job.snapshotId = r.snapshot.id;
      job.snapshotState = r.snapshot.state;
      job.counts = r.counts;
      job.noop = r.noop ?? false;
      // retention: superseded snapshots no run references lose their graph rows
      if (!r.noop) job.compacted = compactSnapshots(this.db, worktree.id).length;
      this.bus.publish({
        type: 'snapshot.published',
        data: {
          jobId: job.id,
          worktreeId: job.worktreeId,
          snapshotId: r.snapshot.id,
          state: r.snapshot.state,
        },
      });
    } catch (e) {
      job.state = ctrl.signal.aborted ? 'cancelled' : 'failed';
      job.error = String((e as Error).message ?? e).slice(0, 500);
      this.bus.publish({
        type: `scan.${job.state}`,
        data: { jobId: job.id, worktreeId: job.worktreeId, error: job.error },
      });
    } finally {
      job.finishedAt = new Date().toISOString();
      this.running = undefined;
      void this.pump();
    }
  }
}
