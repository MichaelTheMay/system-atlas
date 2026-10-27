import { parentPort, workerData } from 'node:worker_threads';
import { factsOf, resolveTs, type TsFacts, type TsInput } from './extract.ts';

/** Parses only the files without cached facts, then resolves over all facts in inventory order. */
export interface TsWorkerInput {
  parse: TsInput['files'];
  cached: TsFacts[];
  order: string[];
  packageJsons: TsInput['packageJsons'];
  tsconfigs: TsInput['tsconfigs'];
  manifestDirs: string[];
}

try {
  const input = workerData as TsWorkerInput;
  const parsed = input.parse.map(factsOf);
  const byPath = new Map([...input.cached, ...parsed].map((f) => [f.path, f]));
  const output = resolveTs({
    facts: input.order.map((p) => byPath.get(p)!),
    packageJsons: input.packageJsons,
    tsconfigs: input.tsconfigs,
    manifestDirs: input.manifestDirs,
  });
  parentPort!.postMessage({ ok: true, value: { output, parsed } });
} catch (e) {
  parentPort!.postMessage({
    ok: false,
    error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
  });
}
