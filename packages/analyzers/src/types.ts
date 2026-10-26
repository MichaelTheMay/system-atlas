import type {
  ConfidenceCategory,
  Diagnostic,
  EntityKind,
  RelationKind,
  SupportLevel,
} from '@atlas/schema';
import type { InventoryFile } from './inventory/inventory.ts';

export type { InventoryFile };

export interface AnalyzerContext {
  rootPath: string;
  /** Project display name, for analyzers that label the system. */
  projectName: string;
  files: readonly InventoryFile[];
  /**
   * Returns the file's text only if its bytes still match the inventory hash; otherwise throws
   * ContentChangedError, so evidence never cites a hash for bytes it did not parse.
   */
  readFile(path: string): Promise<string>;
  signal: AbortSignal;
}

export class ContentChangedError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`file changed during scan: ${path}`);
    this.path = path;
    this.name = 'ContentChangedError';
  }
}

/** Evidence locator emitted by analyzers; persisted as Evidence by the reconciler. */
export interface EvidenceRef {
  path: string;
  contentHash: string;
  startLine?: number;
  endLine?: number;
  excerpt?: string;
}

/**
 * Identity key is the language-qualified semantic name (e.g. `ts:module:packages/api/src/server.ts`,
 * `py:symbol:app.routes.get_user`), never a line number (plan §9).
 */
export interface EntityObservation {
  key: string;
  kind: EntityKind;
  canonicalName: string;
  displayName: string;
  ownerKey?: string;
  attributes?: Record<string, string | number | boolean | null>;
  evidence: EvidenceRef[];
}

export interface RelationObservation {
  fromKey: string;
  /** Unresolved targets use an `unresolved:` key and become gaps, never verified externals. */
  toKey: string;
  kind: RelationKind;
  qualifiers?: Record<string, string>;
  confidence: ConfidenceCategory;
  resolved: boolean;
  evidence: EvidenceRef[];
}

export interface AnalyzerOutput {
  entities: EntityObservation[];
  relations: RelationObservation[];
  diagnostics: Diagnostic[];
  /** Files this analyzer handled, with the depth it achieved. */
  handled: { path: string; support: SupportLevel }[];
}

export interface AnalyzerCapabilities {
  languages: string[];
  entityKinds: EntityKind[];
  relationKinds: RelationKind[];
  /** Plain-language boundary statement surfaced in docs/capabilities.md and the coverage view. */
  limitations: string[];
}

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** plan §7 analyzer interface. */
export interface Analyzer {
  readonly id: string;
  readonly version: string;
  detect(ctx: AnalyzerContext): Promise<boolean>;
  capabilities(): AnalyzerCapabilities;
  extract(files: readonly InventoryFile[], ctx: AnalyzerContext): Promise<AnalyzerOutput>;
  affectedBy(changes: ChangeSet, ctx: AnalyzerContext): string[];
  resolve?(output: AnalyzerOutput, ctx: AnalyzerContext): Promise<AnalyzerOutput>;
}
