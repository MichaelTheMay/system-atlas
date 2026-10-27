import { parentPort, workerData } from 'node:worker_threads';
import { extractJava, type JavaInput } from './extract.ts';

extractJava(workerData as JavaInput).then(
  (value) => parentPort!.postMessage({ ok: true, value }),
  (e: unknown) =>
    parentPort!.postMessage({
      ok: false,
      error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
    }),
);
