import { statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { createExcludeMatcher } from '@atlas/analyzers';
import type { Worktree } from '@atlas/schema';
import type { Db } from '@atlas/store';
import { getLatestSnapshot } from '@atlas/graph';
import type { EventBus } from './events.ts';
import type { JobRunner } from './jobs.ts';

export interface WatchOptions {
  /** Quiet period after the last change before a scan starts (plan §9: ~750 ms). */
  debounceMs?: number;
  /** Upper bound on how long continuous changes can postpone a scan. */
  maxWaitMs?: number;
}

export interface WatchStatus {
  worktreeId: string;
  rootPath: string;
  directories: number;
  debounceMs: number;
  /** Changes seen since the last flush (not yet scanned). */
  pendingChanges: number;
  flushes: number;
  lastFlushAt?: string;
}

/**
 * Watches one worktree. It watches only directories that hold inventoried files, plus new
 * directories that Atlas's excludes allow, so dependency and build folders never consume
 * inotify watches. Events are coalesced: a scan starts after `debounceMs` of quiet, or at the
 * latest `maxWaitMs` after the first unscanned change.
 */
export class WorktreeWatcher {
  private readonly dirs = new Map<string, FSWatcher>();
  private readonly pending = new Set<string>();
  private readonly excluded: (rel: string, isDir: boolean) => boolean;
  private timer?: NodeJS.Timeout;
  private firstChangeAt?: number;
  private closed = false;
  flushes = 0;
  lastFlushAt?: string;
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly worktree: Worktree;
  private readonly onFlush: (paths: string[]) => void;

  constructor(worktree: Worktree, onFlush: (paths: string[]) => void, opts: WatchOptions = {}) {
    this.worktree = worktree;
    this.onFlush = onFlush;
    this.debounceMs = opts.debounceMs ?? 750;
    this.maxWaitMs = opts.maxWaitMs ?? Math.max(5_000, this.debounceMs * 4);
    this.excluded = createExcludeMatcher(worktree.rootPath);
  }

  /** Watch exactly the directories that contain the given files (and their ancestors). */
  sync(filePaths: Iterable<string>) {
    const want = new Set<string>(['']);
    for (const p of filePaths) {
      let i = p.lastIndexOf('/');
      while (i > 0) {
        const d = p.slice(0, i);
        if (want.has(d)) break;
        want.add(d);
        i = d.lastIndexOf('/');
      }
    }
    for (const [d, w] of this.dirs)
      if (!want.has(d) && !this.isLiveDir(d)) {
        w.close();
        this.dirs.delete(d);
      }
    for (const d of want) if (!this.dirs.has(d)) this.add(d);
  }

  get directories() {
    return this.dirs.size;
  }

  get pendingChanges() {
    return this.pending.size;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const w of this.dirs.values()) w.close();
    this.dirs.clear();
  }

  private isLiveDir(rel: string) {
    try {
      return statSync(join(this.worktree.rootPath, rel)).isDirectory();
    } catch {
      return false;
    }
  }

  private add(rel: string) {
    if (this.closed || this.dirs.has(rel)) return;
    try {
      const w = watch(join(this.worktree.rootPath, rel), { persistent: false }, (_ev, name) =>
        this.onEvent(rel, name ? String(name) : undefined),
      );
      w.on('error', () => {
        w.close();
        this.dirs.delete(rel);
        this.change(rel);
      });
      this.dirs.set(rel, w);
    } catch {
      // vanished between listing and watching: the parent's event triggers a rescan
    }
  }

  private onEvent(dir: string, name: string | undefined) {
    if (!name) return this.change(dir);
    const rel = dir ? `${dir}/${name}` : name;
    if (this.excluded(rel, false) || this.excluded(rel, true)) return;
    if (!this.dirs.has(rel) && this.isLiveDir(rel)) {
      // a new directory: watch it now so files written into it before the next scan are seen
      this.add(rel);
    } else if (this.dirs.has(rel) && !this.isLiveDir(rel)) {
      this.dirs.get(rel)!.close();
      this.dirs.delete(rel);
    }
    this.change(rel);
  }

  private change(rel: string) {
    if (this.closed) return;
    this.pending.add(rel);
    const now = Date.now();
    this.firstChangeAt ??= now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstChangeAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush() {
    const paths = [...this.pending].sort();
    this.pending.clear();
    this.firstChangeAt = undefined;
    this.flushes++;
    this.lastFlushAt = new Date().toISOString();
    this.onFlush(paths);
  }
}

/** All watchers of the daemon; scans they trigger queue behind a running scan instead of cancelling it. */
export class WatchManager {
  private readonly watchers = new Map<string, WorktreeWatcher>();
  private readonly db: Db;
  private readonly jobs: JobRunner;
  private readonly bus: EventBus;
  private readonly opts: WatchOptions;

  constructor(db: Db, jobs: JobRunner, bus: EventBus, opts: WatchOptions = {}) {
    this.db = db;
    this.jobs = jobs;
    this.bus = bus;
    this.opts = opts;
  }

  enable(worktree: Worktree): WatchStatus {
    let w = this.watchers.get(worktree.id);
    if (!w) {
      w = new WorktreeWatcher(
        worktree,
        (paths) => {
          const job = this.jobs.enqueueScan(worktree, { supersede: false });
          this.bus.publish({
            type: 'watch.changed',
            data: {
              worktreeId: worktree.id,
              changes: paths.length,
              sample: paths.slice(0, 20),
              jobId: job.id,
            },
          });
        },
        this.opts,
      );
      this.watchers.set(worktree.id, w);
      this.refresh(worktree.id);
      // pick up anything that changed while nobody was watching
      this.jobs.enqueueScan(worktree, { supersede: false });
    }
    return this.status(worktree.id)!;
  }

  disable(worktreeId: string): boolean {
    const w = this.watchers.get(worktreeId);
    w?.close();
    return this.watchers.delete(worktreeId);
  }

  /** Re-derive watched directories from the worktree's latest snapshot (after every publish). */
  refresh(worktreeId: string) {
    const w = this.watchers.get(worktreeId);
    if (!w) return;
    const latest = getLatestSnapshot(this.db, worktreeId);
    const files = latest
      ? this.db
          .prepare('SELECT path FROM snapshot_files WHERE snapshot_id = ?')
          .all<{ path: string }>(latest.snapshot.id)
          .map((r) => r.path)
      : [];
    w.sync(files);
  }

  status(worktreeId: string): WatchStatus | undefined {
    const w = this.watchers.get(worktreeId);
    return w
      ? {
          worktreeId,
          rootPath: w.worktree.rootPath,
          directories: w.directories,
          debounceMs: w.debounceMs,
          pendingChanges: w.pendingChanges,
          flushes: w.flushes,
          lastFlushAt: w.lastFlushAt,
        }
      : undefined;
  }

  list(): WatchStatus[] {
    return [...this.watchers.keys()].map((id) => this.status(id)!);
  }

  closeAll() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
