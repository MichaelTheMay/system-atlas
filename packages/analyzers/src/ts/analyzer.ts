import type { Analyzer, AnalyzerOutput } from '../types.ts';
import { baseName, manifestDirs } from '../shared/packages.ts';
import { runWorker } from '../shared/worker-host.ts';
import type { TsInput } from './extract.ts';

export const TS_ANALYZER_ID = 'ts-js';
export const TS_ANALYZER_VERSION = '0.1.0';

const isTsJs = (lang: string) => lang === 'typescript' || lang === 'javascript';

export function createTsAnalyzer(): Analyzer {
  return {
    id: TS_ANALYZER_ID,
    version: TS_ANALYZER_VERSION,
    async detect(ctx) {
      return ctx.files.some((f) => isTsJs(f.language));
    },
    capabilities() {
      return {
        languages: ['typescript', 'javascript'],
        entityKinds: [
          'module',
          'symbol',
          'endpoint',
          'ui-surface',
          'queue',
          'entrypoint',
          'package',
        ],
        relationKinds: [
          'imports',
          'exposes',
          'calls',
          'publishes',
          'subscribes',
          'reads',
          'writes',
        ],
        limitations: [
          'Module resolution covers relative paths, tsconfig paths and workspace package names inside the registered root; node_modules is never read, so third-party imports are recorded by package name only.',
          'Exported top-level declarations become symbols; call graphs between functions are not computed.',
          'HTTP routes: explicit <app|router>.<method>("/path") and fastify route({method,url}) calls; dynamic paths and middleware mounts are not followed.',
          'HTTP consumers: fetch/axios calls with literal paths are matched to declared endpoints by method and path shape (heuristic, no base URL resolution).',
          'Queues: BullMQ/Bull Queue and Worker constructors with literal or constant names.',
          'SQL: table names in literal query strings (heuristic); ORMs and query builders are not analyzed.',
          'UI routes: react-router route objects and <Route path> elements.',
        ],
      };
    },
    affectedBy(changes) {
      return [...changes.added, ...changes.modified, ...changes.deleted].filter(
        (p) => /\.(m|c)?[jt]sx?$/.test(p) || /(^|\/)(package|tsconfig[\w.-]*)\.json$/.test(p),
      );
    },
    async extract(files, ctx): Promise<AnalyzerOutput> {
      const input: TsInput = {
        files: [],
        packageJsons: [],
        tsconfigs: [],
        manifestDirs: manifestDirs(files),
      };
      // Declaration files describe types only; they are recognized (not a coverage gap) but not modeled.
      const declarations: string[] = [];
      for (const f of files) {
        ctx.signal.throwIfAborted();
        if (isTsJs(f.language) && f.path.endsWith('.d.ts')) {
          declarations.push(f.path);
        } else if (isTsJs(f.language)) {
          input.files.push({
            path: f.path,
            text: await ctx.readFile(f.path),
            sha256: f.sha256,
            role: f.role,
          });
        } else if (baseName(f.path) === 'package.json') {
          input.packageJsons.push({ path: f.path, text: await ctx.readFile(f.path) });
        } else if (
          /^tsconfig[\w.-]*\.json$/.test(baseName(f.path)) ||
          /^jsconfig\.json$/.test(baseName(f.path))
        ) {
          input.tsconfigs.push({ path: f.path, text: await ctx.readFile(f.path) });
        }
      }
      const output = await runWorker<TsInput, AnalyzerOutput>(
        new URL('./worker.ts', import.meta.url),
        input,
        ctx.signal,
      );
      for (const p of declarations) output.handled.push({ path: p, support: 'syntax' });
      // bin evidence points at package.json; attach the verified hash here
      const hashes = new Map(files.map((f) => [f.path, f.sha256]));
      for (const e of output.entities)
        for (const r of e.evidence) if (!r.contentHash) r.contentHash = hashes.get(r.path) ?? '';
      for (const rel of output.relations)
        for (const r of rel.evidence) if (!r.contentHash) r.contentHash = hashes.get(r.path) ?? '';
      return output;
    },
  };
}
