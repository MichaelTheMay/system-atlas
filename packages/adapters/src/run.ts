import { readFileSync } from 'node:fs';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { IngestClient, type IngestTarget } from './client.ts';

/**
 * The local daemon from its discovery record (written 0600 by `atlas open` / `atlas daemon start`),
 * for programs that record runs without being started by `atlas run`.
 */
export function localDaemon(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  token: string;
} {
  const file = resolveAtlasPaths(env).discoveryFile;
  let rec: { port?: number; token?: string };
  try {
    rec = JSON.parse(readFileSync(file, 'utf8')) as { port?: number; token?: string };
  } catch {
    throw new Error(`no running Atlas daemon (${file}); start one with: atlas open <project>`);
  }
  if (!rec.port || !rec.token) throw new Error(`invalid daemon discovery record: ${file}`);
  return { baseUrl: `http://127.0.0.1:${rec.port}`, token: rec.token };
}

/** Create a run through the daemon API and return an ingest client bound to it (run token only). */
export async function startRun(o: {
  daemon: { baseUrl: string; token: string };
  rootPath: string;
  adapter: string;
  commandSummary?: string;
  environmentSummary?: Record<string, unknown>;
  instrumentationCapabilities?: string[];
  producerId?: string;
  /** `none` for imported evidence (never bound to the current tree). */
  binding?: 'current-tree' | 'none';
  externalRef?: string;
  startAt?: string;
  captureGaps?: { kind: string; detail: string }[];
}): Promise<{
  client: IngestClient;
  target: IngestTarget;
  snapshotBound: boolean;
  runId: string;
  existing: boolean;
}> {
  const res = await fetch(`${o.daemon.baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      rootPath: o.rootPath,
      adapter: o.adapter,
      commandSummary: o.commandSummary,
      environmentSummary: o.environmentSummary ?? {},
      instrumentationCapabilities: o.instrumentationCapabilities ?? [],
      waitForSnapshot: o.binding !== 'none',
      binding: o.binding ?? 'current-tree',
      externalRef: o.externalRef,
      startAt: o.startAt,
      captureGaps: o.captureGaps,
    }),
  });
  if (!res.ok) throw new Error(`could not create run: ${res.status} ${await res.text()}`);
  const { run, ingestToken, snapshotBound, existing } = (await res.json()) as {
    run: { id: string };
    ingestToken: string;
    snapshotBound: boolean;
    existing?: boolean;
  };
  const target = { baseUrl: o.daemon.baseUrl, runId: run.id, runToken: ingestToken };
  return {
    client: new IngestClient(target, o.producerId ?? o.adapter),
    target,
    snapshotBound,
    runId: run.id,
    existing: !!existing,
  };
}
