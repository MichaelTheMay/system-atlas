import ElkApi from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { createElkLayoutEngine, type LayoutInput, type LayoutResult } from '@atlas/layout';

// elk-api runs the ELK engine in its own Web Worker (elk-worker.min.js), keeping the UI thread
// free on large canvases; Atlas's engine wrapper adds deterministic ordering and pinned positions.
let engine: ReturnType<typeof createElkLayoutEngine> | undefined;

export function layoutInWorker(input: LayoutInput): Promise<LayoutResult> {
  engine ??= createElkLayoutEngine(new ElkApi({ workerUrl: elkWorkerUrl }));
  return engine.layout(input);
}
