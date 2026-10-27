import type { Analyzer, AnalyzerOutput } from '../types.ts';
import { baseName, manifestDirs } from '../shared/packages.ts';
import { runWorker } from '../shared/worker-host.ts';
import type { GoInput } from './extract.ts';

export const GO_ANALYZER_ID = 'go';
export const GO_ANALYZER_VERSION = '0.1.0';

export function createGoAnalyzer(): Analyzer {
  return {
    id: GO_ANALYZER_ID,
    version: GO_ANALYZER_VERSION,
    async detect(ctx) {
      return ctx.files.some((f) => f.language === 'go');
    },
    capabilities() {
      return {
        languages: ['go'],
        entityKinds: ['module', 'symbol', 'endpoint', 'entrypoint', 'package'],
        relationKinds: ['imports', 'exposes', 'calls', 'reads', 'writes'],
        limitations: [
          'Syntax-level (tree-sitter) with explicit rules; no type checking, build tags or cgo.',
          'A Go package (directory) is one module; exported functions, methods of exported types, types, consts and vars are symbols. _test.go files are evidence only.',
          'Imports resolve by the module path in the nearest go.mod; third-party imports map to its longest matching require (exact) or to the first three path segments (heuristic). Replace directives and workspaces (go.work) are not followed.',
          'HTTP routes: <x>.HandleFunc/Handle/Get/Post/… and GET/POST/… calls with a literal path (net/http incl. "METHOD /path" patterns, chi, gin, echo, gorilla/mux); resolved when the file imports one of these, else heuristic. Handle("/", h) is treated as mounting a router. Route groups and prefixes are not followed.',
          'Entrypoints: package main with func main. SQL: table names in literal strings passed to database/sql or sqlx calls (heuristic).',
        ],
      };
    },
    affectedBy(changes) {
      return [...changes.added, ...changes.modified, ...changes.deleted].filter(
        (p) => p.endsWith('.go') || baseName(p) === 'go.mod',
      );
    },
    async extract(files, ctx): Promise<AnalyzerOutput> {
      const input: GoInput = { files: [], gomods: [], manifestDirs: manifestDirs(files) };
      for (const f of files) {
        ctx.signal.throwIfAborted();
        if (f.language === 'go')
          input.files.push({
            path: f.path,
            text: await ctx.readFile(f.path),
            sha256: f.sha256,
            role: f.role,
          });
        else if (baseName(f.path) === 'go.mod')
          input.gomods.push({ path: f.path, text: await ctx.readFile(f.path) });
      }
      return runWorker<GoInput, AnalyzerOutput>(
        new URL('./worker.ts', import.meta.url),
        input,
        ctx.signal,
      );
    },
  };
}
