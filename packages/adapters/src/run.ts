import { IngestClient, type IngestTarget } from './client.ts';

/** Create a run through the daemon API and return an ingest client bound to it (run token only). */
export async function startRun(o: {
  daemon: { baseUrl: string; token: string };
  rootPath: string;
  adapter: string;
  commandSummary?: string;
  environmentSummary?: Record<string, unknown>;
  instrumentationCapabilities?: string[];
  producerId?: string;
}): Promise<{ client: IngestClient; target: IngestTarget; snapshotBound: boolean; runId: string }> {
  const res = await fetch(`${o.daemon.baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      rootPath: o.rootPath,
      adapter: o.adapter,
      commandSummary: o.commandSummary,
      environmentSummary: o.environmentSummary ?? {},
      instrumentationCapabilities: o.instrumentationCapabilities ?? [],
      waitForSnapshot: true,
    }),
  });
  if (!res.ok) throw new Error(`could not create run: ${res.status} ${await res.text()}`);
  const { run, ingestToken, snapshotBound } = (await res.json()) as {
    run: { id: string };
    ingestToken: string;
    snapshotBound: boolean;
  };
  const target = { baseUrl: o.daemon.baseUrl, runId: run.id, runToken: ingestToken };
  return {
    client: new IngestClient(target, o.producerId ?? o.adapter),
    target,
    snapshotBound,
    runId: run.id,
  };
}
