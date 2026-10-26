import type { Analyzer, AnalyzerOutput } from '../types.ts';
import { baseName, manifestDirs } from '../shared/packages.ts';
import { runWorker } from '../shared/worker-host.ts';
import type { PyInput } from './extract.ts';

export const PY_ANALYZER_ID = 'python';
export const PY_ANALYZER_VERSION = '0.1.0';

export function createPythonAnalyzer(): Analyzer {
  return {
    id: PY_ANALYZER_ID,
    version: PY_ANALYZER_VERSION,
    async detect(ctx) {
      return ctx.files.some((f) => f.language === 'python');
    },
    capabilities() {
      return {
        languages: ['python'],
        entityKinds: ['module', 'symbol', 'endpoint', 'entrypoint', 'job', 'package'],
        relationKinds: ['imports', 'exposes', 'calls', 'reads', 'writes'],
        limitations: [
          'Syntax-level (tree-sitter) with explicit rules; no type inference or interpreter environment.',
          'Module names come from `src/` layout or the project directory; sys.path manipulation and namespace packages spanning roots are not resolved.',
          'Third-party imports are recorded by top-level import name, which may differ from the distribution name.',
          'HTTP routes: FastAPI/Flask decorators on objects created with FastAPI()/APIRouter()/Flask()/Blueprint() in the same module (resolved), or on objects named app/router/api/bp (heuristic). include_router prefixes are not followed.',
          'Entrypoints: [project.scripts] and [tool.poetry.scripts]. Celery @task/@shared_task functions become jobs.',
          'SQL: table names in literal strings passed to execute/query-like calls (heuristic).',
        ],
      };
    },
    affectedBy(changes) {
      return [...changes.added, ...changes.modified, ...changes.deleted].filter(
        (p) => /\.pyi?$/.test(p) || baseName(p) === 'pyproject.toml',
      );
    },
    async extract(files, ctx): Promise<AnalyzerOutput> {
      const input: PyInput = { files: [], pyprojects: [], manifestDirs: manifestDirs(files) };
      for (const f of files) {
        ctx.signal.throwIfAborted();
        if (f.language === 'python')
          input.files.push({
            path: f.path,
            text: await ctx.readFile(f.path),
            sha256: f.sha256,
            role: f.role,
          });
        else if (baseName(f.path) === 'pyproject.toml')
          input.pyprojects.push({
            path: f.path,
            text: await ctx.readFile(f.path),
            sha256: f.sha256,
          });
      }
      return runWorker<PyInput, AnalyzerOutput>(
        new URL('./worker.ts', import.meta.url),
        input,
        ctx.signal,
      );
    },
  };
}
