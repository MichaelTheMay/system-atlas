import { parentPort, workerData } from 'node:worker_threads';
import { extractGo, type GoInput } from './extract.ts';

extractGo(workerData as GoInput).then(
  (value) => parentPort!.postMessage({ ok: true, value }),
  (e: unknown) =>
    parentPort!.postMessage({
      ok: false,
      error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
    }),
);
