import { parentPort, workerData } from 'node:worker_threads';
import { extractPython, type PyInput } from './extract.ts';

extractPython(workerData as PyInput).then(
  (value) => parentPort!.postMessage({ ok: true, value }),
  (e: unknown) =>
    parentPort!.postMessage({
      ok: false,
      error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
    }),
);
