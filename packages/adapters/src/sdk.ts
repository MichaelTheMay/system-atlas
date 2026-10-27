import { IngestClient, targetFromEnv, type ArtifactDraft } from './client.ts';

/**
 * SDK for programs started by `atlas run` (or any process given ATLAS_INGEST_URL / ATLAS_RUN_ID /
 * ATLAS_RUN_TOKEN). Without those variables every call is a no-op, so instrumented code also runs
 * normally outside Atlas.
 */
export interface AtlasRecorder {
  readonly enabled: boolean;
  step<T>(name: string, fn: () => Promise<T> | T, opts?: { entityRefs?: string[] }): Promise<T>;
  assert(
    description: string,
    ok: boolean | 'unknown',
    opts?: { subjectArtifactId?: string },
  ): Promise<void>;
  recordArtifact(path: string, draft?: Partial<ArtifactDraft>): Promise<string | undefined>;
  event(type: string, payload?: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
}

export function recorderFromEnv(producer = `sdk:${process.pid}`): AtlasRecorder {
  const t = targetFromEnv();
  if (!t) {
    return {
      enabled: false,
      step: async (_n, fn) => fn(),
      assert: async () => {},
      recordArtifact: async () => undefined,
      event: async () => {},
      flush: async () => {},
    };
  }
  return recorderFor(new IngestClient(t, producer));
}

/**
 * The same recorder API for a run the program started itself (generic event SDK):
 *
 *   const { client } = await startRun({ daemon: localDaemon(), rootPath, adapter: 'my-agent' });
 *   const atlas = recorderFor(client);
 *   await atlas.step('plan', () => plan());
 *   await atlas.assert('tests pass', ok);
 *   await client.finish('succeeded');
 */
export function recorderFor(c: IngestClient): AtlasRecorder {
  return {
    enabled: true,
    async step(name, fn, opts) {
      const started = await c.event({
        type: 'step.started',
        payload: { name },
        entityRefs: opts?.entityRefs,
      });
      const t0 = performance.now();
      try {
        const out = await fn();
        c.emit({
          type: 'step.completed',
          payload: { name, durationMs: Math.round(performance.now() - t0) },
          parentEventId: started,
        });
        return out;
      } catch (e) {
        c.emit({
          type: 'step.failed',
          payload: { name, error: String((e as Error).message ?? e).slice(0, 2000) },
          parentEventId: started,
        });
        throw e;
      } finally {
        await c.flush();
      }
    },
    async assert(description, ok, opts) {
      await c.event({
        type: 'assertion.result',
        payload: {
          description,
          outcome: ok === 'unknown' ? 'unknown' : ok ? 'pass' : 'fail',
          source: 'test',
          subjectArtifactId: opts?.subjectArtifactId,
        },
      });
    },
    async recordArtifact(path, draft) {
      const produced = await c.event({
        type: 'file.produced',
        payload: { path: draft?.logicalName ?? path },
      });
      const a = await c.uploadFile(path, { ...draft, eventId: produced });
      return a.id;
    },
    async event(type, payload) {
      await c.event({ type, payload });
    },
    flush: () => c.flush(),
  };
}
