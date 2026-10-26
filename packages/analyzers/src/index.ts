export * from './types.ts';
export * from './parsers.ts';
export * from './git-exec.ts';
export * from './inventory/index.ts';
export * from './redact.ts';
export * from './generic/index.ts';

import type { Analyzer } from './types.ts';
import { createManifestAnalyzer } from './generic/manifests.ts';

/** The analyzers a default scan runs, in order. */
export function defaultAnalyzers(): Analyzer[] {
  return [createManifestAnalyzer()];
}
