import { z } from 'zod';
import { idSchema, JsonObject, JsonValue, RepoRelativePath, Sha256, Timestamp } from './ids.ts';
import { ClaimOrigin, ClaimStatus, ConfidenceCategory, RedactionState } from './common.ts';

export const SEMANTIC_SCHEMA_VERSION = 1 as const;

export const EntityKind = z.enum([
  'system',
  'external-system',
  'deployable',
  'package',
  'module',
  'symbol',
  'entrypoint',
  'endpoint',
  'database',
  'table',
  'queue',
  'topic',
  'job',
  'workflow',
  'agent',
  'tool',
  'configuration',
  'infrastructure-resource',
  'ui-surface',
  'artifact-type',
]);
export type EntityKind = z.infer<typeof EntityKind>;

export const EntityLifecycle = z.enum(['active', 'stale', 'removed']);

/** plan §6 Entity. `canonicalName` is the semantic label; user labels live in overlays. */
export const Entity = z.object({
  schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
  id: idSchema('entity'),
  projectId: idSchema('project'),
  kind: EntityKind,
  canonicalName: z.string().min(1),
  displayName: z.string().min(1),
  ownerEntityId: idSchema('entity').optional(),
  lifecycle: EntityLifecycle,
  attributes: JsonObject,
  firstSeenSnapshot: idSchema('snapshot'),
  lastSeenSnapshot: idSchema('snapshot'),
});
export type Entity = z.infer<typeof Entity>;

export const RelationKind = z.enum([
  'contains',
  'imports',
  'calls',
  'exposes',
  'reads',
  'writes',
  'publishes',
  'subscribes',
  'invokes-tool',
  'deploys-to',
  'configures',
  'produces',
  'depends-on',
]);
export type RelationKind = z.infer<typeof RelationKind>;

/** plan §6 Relation. Identity = endpoints + kind + qualifiers (route, channel...). */
export const Relation = z
  .object({
    schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
    id: idSchema('relation'),
    fromId: idSchema('entity'),
    toId: idSchema('entity'),
    kind: RelationKind,
    qualifiers: z.record(z.string(), z.string()),
    evidenceIds: z.array(idSchema('evidence')),
    status: ClaimStatus,
    confidenceCategory: ConfidenceCategory,
    snapshotId: idSchema('snapshot'),
  })
  .superRefine((r, ctx) => {
    if (r.status === 'supported' && r.evidenceIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'supported relations require evidence',
        path: ['evidenceIds'],
      });
    }
    if (r.status === 'supported' && r.confidenceCategory === 'proposed') {
      ctx.addIssue({
        code: 'custom',
        message: 'proposed relations cannot be supported',
        path: ['status'],
      });
    }
  });
export type Relation = z.infer<typeof Relation>;

export const EvidenceSourceKind = z.enum([
  'source-file',
  'manifest',
  'config',
  'runtime-event',
  'artifact',
  'human',
  'model',
]);

/** plan §6 Evidence. Line numbers are locators only. */
export const Evidence = z
  .object({
    schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
    id: idSchema('evidence'),
    sourceKind: EvidenceSourceKind,
    repoRelativePath: RepoRelativePath.optional(),
    contentHash: Sha256.optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    snapshotId: idSchema('snapshot').optional(),
    runId: idSchema('run').optional(),
    eventId: idSchema('event').optional(),
    extractorId: z.string().min(1),
    extractorVersion: z.string().min(1),
    capturedAt: Timestamp,
    excerpt: z.string().max(4000).optional(),
    redactionState: RedactionState,
  })
  .superRefine((e, ctx) => {
    if (
      (e.sourceKind === 'source-file' ||
        e.sourceKind === 'manifest' ||
        e.sourceKind === 'config') &&
      !(e.repoRelativePath && e.contentHash && e.snapshotId)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'file evidence requires repoRelativePath, contentHash and snapshotId',
      });
    }
    if (e.sourceKind === 'runtime-event' && !(e.runId && e.eventId)) {
      ctx.addIssue({ code: 'custom', message: 'runtime evidence requires runId and eventId' });
    }
    if (e.startLine !== undefined && e.endLine !== undefined && e.endLine < e.startLine) {
      ctx.addIssue({ code: 'custom', message: 'endLine must be >= startLine', path: ['endLine'] });
    }
  });
export type Evidence = z.infer<typeof Evidence>;

export const ModelMetadata = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  promptTemplateVersion: z.string().min(1),
  inputDigest: Sha256.optional(),
  requestId: z.string().optional(),
});

/** plan §6 Claim. */
export const Claim = z
  .object({
    schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
    id: idSchema('claim'),
    subjectId: z.union([idSchema('entity'), idSchema('relation')]),
    predicate: z.string().min(1),
    value: JsonValue,
    origin: ClaimOrigin,
    evidenceIds: z.array(idSchema('evidence')),
    status: ClaimStatus,
    snapshotId: idSchema('snapshot'),
    modelMetadata: ModelMetadata.optional(),
    inputDigest: Sha256.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.status === 'supported' && c.evidenceIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'supported claims require evidence',
        path: ['evidenceIds'],
      });
    }
    if (c.origin === 'model' && !c.modelMetadata) {
      ctx.addIssue({
        code: 'custom',
        message: 'model claims require modelMetadata',
        path: ['modelMetadata'],
      });
    }
  });
export type Claim = z.infer<typeof Claim>;
