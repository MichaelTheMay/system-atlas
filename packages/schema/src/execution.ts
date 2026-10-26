import { z } from 'zod';
import { idSchema, JsonObject, Sha256, Timestamp } from './ids.ts';
import { RedactionState } from './common.ts';

export const EXECUTION_SCHEMA_VERSION = 1 as const;

export const RunStatus = z.enum([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** plan §6 Run. Process outcome (status/exitCode) is separate from task outcome (assertions). */
export const Run = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema('run'),
  projectId: idSchema('project'),
  worktreeId: idSchema('worktree').optional(),
  snapshotId: idSchema('snapshot').optional(),
  sourceManifestDigest: Sha256.optional(),
  adapter: z.string().min(1),
  commandSummary: z.string().max(2000).optional(),
  startAt: Timestamp,
  endAt: Timestamp.optional(),
  status: RunStatus,
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  environmentSummary: JsonObject,
  instrumentationCapabilities: z.array(z.string()),
  captureGaps: z.array(z.object({ kind: z.string(), detail: z.string() })),
});
export type Run = z.infer<typeof Run>;

export const EventType = z.enum([
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'step.started',
  'step.completed',
  'step.failed',
  'tool.call.requested',
  'tool.call.completed',
  'command.stdout',
  'command.stderr',
  'command.exit',
  'screenshot.captured',
  'network.summary',
  'console.summary',
  'file.produced',
  'render.produced',
  'assertion.result',
  'human.override',
  'graph.updated',
  'model.enrichment',
  'capture.gap',
]);
export type EventType = z.infer<typeof EventType>;

/** plan §6 Event: immutable, deduped on (producerId, producerEventId). */
export const Event = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema('event'),
  producerId: z.string().min(1).max(200),
  producerEventId: z.string().min(1).max(200),
  runId: idSchema('run'),
  sequence: z.number().int().nonnegative().optional(),
  occurredAt: Timestamp,
  receivedAt: Timestamp,
  type: EventType,
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  spanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  parentSpanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  parentEventId: idSchema('event').optional(),
  causalEventIds: z.array(idSchema('event')),
  entityRefs: z.array(idSchema('entity')),
  payload: JsonObject,
  artifactIds: z.array(idSchema('artifact')),
});
export type Event = z.infer<typeof Event>;

export const ArtifactRole = z.enum([
  'screenshot',
  'log',
  'output-file',
  'render',
  'report',
  'trace',
  'video',
  'preview',
  'thumbnail',
  'other',
]);

/** plan §6 Artifact: content-addressed bytes plus metadata. */
export const Artifact = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema('artifact'),
  sha256: Sha256,
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  localObjectKey: z.string().min(1),
  runId: idSchema('run'),
  eventId: idSchema('event').optional(),
  logicalName: z.string().min(1).max(500),
  role: ArtifactRole,
  capturedAt: Timestamp,
  sourceRevision: z.string().optional(),
  redactionState: RedactionState,
  previewState: z.enum(['none', 'pending', 'ready', 'failed', 'unsupported']),
  retentionClass: z.enum(['ephemeral', 'standard', 'pinned']),
  bytesState: z.enum(['pending', 'available', 'deleted', 'missing']),
  metadata: JsonObject,
});
export type Artifact = z.infer<typeof Artifact>;

export const CorrelationMethod = z.enum([
  'explicit-entity-id',
  'entrypoint-mapping',
  'command-mapping',
  'source-location',
  'route-signature',
  'trace-context',
  'heuristic-proximity',
  'manual',
]);

/** plan §6 Correlation. Heuristic methods can never be 'supported'. */
export const Correlation = z
  .object({
    schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
    id: idSchema('correlation'),
    eventOrArtifactId: z.union([idSchema('event'), idSchema('artifact'), idSchema('run')]),
    entityId: idSchema('entity'),
    method: CorrelationMethod,
    evidenceIds: z.array(idSchema('evidence')),
    status: z.enum(['supported', 'inferred', 'rejected', 'unknown']),
  })
  .superRefine((c, ctx) => {
    if (c.method === 'heuristic-proximity' && c.status === 'supported') {
      ctx.addIssue({
        code: 'custom',
        message: 'heuristic correlations cannot be supported',
        path: ['status'],
      });
    }
  });
export type Correlation = z.infer<typeof Correlation>;

/** plan §6 Assertion: task success, separate from process exit. */
export const Assertion = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  id: idSchema('assertion'),
  runId: idSchema('run'),
  eventId: idSchema('event').optional(),
  subjectArtifactId: idSchema('artifact').optional(),
  source: z.enum(['test', 'human', 'adapter']),
  outcome: z.enum(['pass', 'fail', 'unknown']),
  description: z.string().min(1),
  evidenceIds: z.array(idSchema('evidence')),
});
export type Assertion = z.infer<typeof Assertion>;
