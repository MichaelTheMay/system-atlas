import { z } from 'zod';
import { idSchema, Sha256, Timestamp } from './ids.ts';
import { Diagnostic } from './common.ts';

export const PROJECT_SCHEMA_VERSION = 1 as const;

/** A registered root. Identity is a generated ID, not the path (plan §5). */
export const Project = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: idSchema('project'),
  displayName: z.string().min(1),
  /** Remote URL with any embedded credentials removed; absent when unknown. */
  remoteUrl: z.string().optional(),
  createdAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

/**
 * An analysis context: one registered root on disk. Two checkouts or git worktrees
 * of the same project are separate worktrees. The registered root is the analysis
 * boundary; git metadata is recorded but never widens it.
 */
export const Worktree = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: idSchema('worktree'),
  projectId: idSchema('project'),
  rootPath: z.string().min(1),
  git: z
    .object({
      topLevel: z.string(),
      commonDir: z.string(),
      /** Path of rootPath relative to the git top level ('' when equal). */
      subPath: z.string(),
      branch: z.string().optional(),
    })
    .optional(),
  createdAt: Timestamp,
});
export type Worktree = z.infer<typeof Worktree>;

export const SnapshotState = z.enum(['building', 'partial', 'ready', 'failed', 'superseded']);
export type SnapshotState = z.infer<typeof SnapshotState>;

/** plan §6 Analysis snapshot. */
export const Snapshot = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: idSchema('snapshot'),
  projectId: idSchema('project'),
  worktreeId: idSchema('worktree'),
  /** HEAD commit at scan time, if the root is inside a git repo. Never implies the tree equals HEAD. */
  headCommit: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
  /** Digest of the manifest of included file content hashes: identifies the analyzed tree. */
  dirtyTreeDigest: Sha256,
  /** True when the analyzed tree differs from HEAD (or no git). */
  dirty: z.boolean(),
  createdAt: Timestamp,
  publishedAt: Timestamp.optional(),
  analyzerVersions: z.record(z.string(), z.string()),
  configDigest: Sha256,
  state: SnapshotState,
  previousSnapshotId: idSchema('snapshot').optional(),
  coverageReportId: idSchema('coverage').optional(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const SupportLevel = z.enum(['deep', 'syntax', 'inventory-only', 'skipped']);
export type SupportLevel = z.infer<typeof SupportLevel>;

export const CoverageGapKind = z.enum([
  'unsupported-language',
  'unresolved-reference',
  'analyzer-failed',
  'analyzer-timeout',
  'skipped-binary',
  'skipped-size',
  'skipped-secret',
  'skipped-symlink-escape',
  'nested-repository',
  'unreadable',
  'changed-during-scan',
  'dynamic-dispatch',
  'generated-code',
  'missing-telemetry',
  'stale-claim',
]);
export type CoverageGapKind = z.infer<typeof CoverageGapKind>;

export const CoverageGap = z.object({
  kind: CoverageGapKind,
  path: z.string().optional(),
  analyzerId: z.string().optional(),
  detail: z.string(),
  count: z.number().int().positive().optional(),
});
export type CoverageGap = z.infer<typeof CoverageGap>;

/** Coverage is scoped to the exact input manifest (plan §6). */
export const CoverageReport = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: idSchema('coverage'),
  snapshotId: idSchema('snapshot'),
  manifestDigest: Sha256,
  totals: z.object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  byLanguage: z.array(
    z.object({
      language: z.string(),
      files: z.number().int().nonnegative(),
      support: SupportLevel,
    }),
  ),
  analyzers: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
      status: z.enum(['ok', 'partial', 'failed', 'skipped']),
      filesAnalyzed: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      diagnostics: z.array(Diagnostic),
    }),
  ),
  gaps: z.array(CoverageGap),
});
export type CoverageReport = z.infer<typeof CoverageReport>;
