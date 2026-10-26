import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AtlasPaths } from '@atlas/schema/node';
import { isProcessAlive, readDiscovery, type DiscoveryRecord } from '@atlas/daemon/discovery';

export interface DaemonHandle {
  rec: DiscoveryRecord;
  baseUrl: string;
  api<T = unknown>(path: string, init?: RequestInit): Promise<T>;
}

function handle(rec: DiscoveryRecord): DaemonHandle {
  const baseUrl = `http://127.0.0.1:${rec.port}`;
  return {
    rec,
    baseUrl,
    async api(path, init) {
      const res = await fetch(`${baseUrl}/api/v1${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: `Bearer ${rec.token}`,
          'content-type': 'application/json',
        },
      });
      if (!res.ok) throw new Error(`daemon ${path} -> ${res.status} ${await res.text()}`);
      return (await res.json()) as never;
    },
  };
}

/** Running, healthy daemon from the discovery record, or undefined. */
export async function findDaemon(paths: AtlasPaths): Promise<DaemonHandle | undefined> {
  const rec = await readDiscovery(paths.discoveryFile);
  if (!rec || !isProcessAlive(rec.pid)) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
  } catch {
    return undefined;
  }
  return handle(rec);
}

/** Start the daemon detached (user-initiated by `atlas open` / `atlas daemon start`) and wait for it. */
export async function ensureDaemon(
  paths: AtlasPaths,
): Promise<{ daemon: DaemonHandle; started: boolean }> {
  const running = await findDaemon(paths);
  if (running) return { daemon: running, started: false };

  const logDir = join(paths.dataDir, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(logDir, 'daemon.log'), 'a', 0o600);
  const entry = new URL(import.meta.resolve('@atlas/daemon/main')).pathname;
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const d = await findDaemon(paths);
    if (d && d.rec.pid === child.pid) return { daemon: d, started: true };
    if (child.exitCode !== null) break;
  }
  throw new Error(`daemon did not start; see ${join(logDir, 'daemon.log')}`);
}
