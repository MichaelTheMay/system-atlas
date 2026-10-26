import { parentPort, workerData } from 'node:worker_threads';
import { extractTs, type TsInput } from './extract.ts';

try {
  parentPort!.postMessage({ ok: true, value: extractTs(workerData as TsInput) });
} catch (e) {
  parentPort!.postMessage({
    ok: false,
    error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
  });
}
