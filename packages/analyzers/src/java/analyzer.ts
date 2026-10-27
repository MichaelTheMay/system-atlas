import type { Analyzer, AnalyzerOutput } from '../types.ts';
import { baseName, manifestDirs } from '../shared/packages.ts';
import { runWorker } from '../shared/worker-host.ts';
import type { JavaInput } from './extract.ts';

export const JAVA_ANALYZER_ID = 'java';
export const JAVA_ANALYZER_VERSION = '0.1.0';
const BUILD_FILES = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts']);

export function createJavaAnalyzer(): Analyzer {
  return {
    id: JAVA_ANALYZER_ID,
    version: JAVA_ANALYZER_VERSION,
    async detect(ctx) {
      return ctx.files.some((f) => f.language === 'java');
    },
    capabilities() {
      return {
        languages: ['java'],
        entityKinds: ['module', 'symbol', 'endpoint', 'entrypoint', 'package'],
        relationKinds: ['imports', 'exposes', 'calls', 'reads', 'writes'],
        limitations: [
          'Syntax-level (tree-sitter) with explicit rules; no compilation, classpath or annotation processing. Kotlin, Scala and Groovy sources are not analyzed.',
          'One module per .java file, named by package and primary type; public methods of public types are symbols.',
          "Imports (single-type, wildcard, static) resolve against the project's own types; JDK packages are skipped; others map to the longest group id in pom.xml/Gradle (exact) or their first two segments (heuristic). Same-package references need no import and are not followed.",
          'HTTP routes: Spring @RequestMapping/@GetMapping/… and JAX-RS @Path with @GET/@POST/… using literal paths, joined with a class-level prefix; constants and properties in paths are not resolved.',
          'Entrypoints: public static main. SQL: literal strings in JDBC/JdbcTemplate calls and @Query annotations (heuristic; JPQL entity names may differ from tables).',
        ],
      };
    },
    affectedBy(changes) {
      return [...changes.added, ...changes.modified, ...changes.deleted].filter(
        (p) => p.endsWith('.java') || BUILD_FILES.has(baseName(p)),
      );
    },
    async extract(files, ctx): Promise<AnalyzerOutput> {
      const input: JavaInput = { files: [], builds: [], manifestDirs: manifestDirs(files) };
      for (const f of files) {
        ctx.signal.throwIfAborted();
        if (f.language === 'java')
          input.files.push({
            path: f.path,
            text: await ctx.readFile(f.path),
            sha256: f.sha256,
            role: f.role,
          });
        else if (BUILD_FILES.has(baseName(f.path)))
          input.builds.push({ path: f.path, text: await ctx.readFile(f.path) });
      }
      return runWorker<JavaInput, AnalyzerOutput>(
        new URL('./worker.ts', import.meta.url),
        input,
        ctx.signal,
      );
    },
  };
}
