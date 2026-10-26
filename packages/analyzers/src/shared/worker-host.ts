import { Worker } from 'node:worker_threads';

/**
 * Runs CPU-heavy parsing off the daemon's event loop (plan §7). The worker is terminated on
 * abort, so a cancelled or timed-out analysis cannot keep burning CPU.
 */
export function runWorker<I, O>(url: URL, input: I, signal: AbortSignal): Promise<O> {
  return new Promise<O>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(url, {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 2048 },
    });
    const onAbort = () => {
      void worker.terminate();
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg: { ok: true; value: O } | { ok: false; error: string }) => {
      signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      if (msg.ok) resolve(msg.value);
      else reject(new Error(msg.error));
    });
    worker.once('error', (e) => {
      signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`analysis worker exited with code ${code}`));
    });
  });
}
