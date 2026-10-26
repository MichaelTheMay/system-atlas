export * from './types.ts';
export * from './parsers.ts';
export * from './git-exec.ts';
export * from './inventory/index.ts';
export * from './redact.ts';
export * from './generic/index.ts';

export * from './ts/index.ts';
export * from './python/index.ts';
export * from './shared/sql.ts';
export { routeShape, packageKey as manifestPackageKey } from './shared/packages.ts';

import type { Analyzer } from './types.ts';
import { createManifestAnalyzer } from './generic/manifests.ts';
import { createSqlAnalyzer } from './generic/sql.ts';
import { createDockerAnalyzer } from './generic/docker.ts';
import { createTsAnalyzer } from './ts/analyzer.ts';
import { createPythonAnalyzer } from './python/analyzer.ts';

/** The analyzers a default scan runs, in order. Order matters only for duplicate-key precedence. */
export function defaultAnalyzers(): Analyzer[] {
  return [
    createManifestAnalyzer(),
    createSqlAnalyzer(),
    createDockerAnalyzer(),
    createTsAnalyzer(),
    createPythonAnalyzer(),
  ];
}
