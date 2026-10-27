import { z } from 'zod';
import { idSchema, Timestamp } from './ids.ts';

/**
 * User-authored design layer (D02, plan §4): boxes, flows, sticky notes and subsystems that people
 * draw on the System design canvases. View data, never semantic facts: a box may be bound to code
 * entities or left unbound ("planned, not in code yet"). Keyed by project so it survives rescans.
 */
export const DesignArchetype = z.enum([
  'client',
  'api-service',
  'worker',
  'queue',
  'datastore',
  'cache',
  'external-api',
  'library',
  'service',
]);
export type DesignArchetype = z.infer<typeof DesignArchetype>;

export const DesignElementKind = z.enum(['box', 'flow', 'sticky', 'subsystem']);
export type DesignElementKind = z.infer<typeof DesignElementKind>;

/** `proposed` = agent ghost awaiting review; `rejected` stays for the audit trail. */
export const DesignElementStatus = z.enum(['active', 'proposed', 'rejected']);

const Label = z.string().trim().min(1).max(120);

/** Endpoint of a drawn flow: another design element or a detected box (by entity id). */
const FlowEnd = z.union([
  z.object({ elementId: idSchema('designElement') }),
  z.object({ entityId: idSchema('entity') }),
]);

export const DesignElementBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('box'),
    label: Label,
    archetype: DesignArchetype,
    responsibility: z.string().max(500).optional(),
    /** Subsystem element this box sits in; absent = top level of the system canvas. */
    parentId: idSchema('designElement').optional(),
  }),
  z.object({
    kind: z.literal('flow'),
    from: FlowEnd,
    to: FlowEnd,
    label: z.string().trim().max(60).optional(),
  }),
  z.object({
    kind: z.literal('sticky'),
    text: z.string().max(2_000),
    /** Canvas the note sits on (design canvases only). */
    canvasId: idSchema('canvas'),
  }),
  z.object({
    kind: z.literal('subsystem'),
    label: Label,
    responsibility: z.string().max(500).optional(),
    parentId: idSchema('designElement').optional(),
  }),
]);
export type DesignElementBody = z.infer<typeof DesignElementBody>;

export const DesignElement = z.object({
  id: idSchema('designElement'),
  projectId: idSchema('project'),
  body: DesignElementBody,
  /** Code entities this element stands for; empty = unbound (drawn dashed). */
  boundEntityIds: z.array(idSchema('entity')).max(500),
  author: z.enum(['user', 'agent']),
  /** Model as reported by the agent runtime, for "agent: <model>" labels. */
  authorName: z.string().max(100).optional(),
  /** Evidence an agent cited for a proposed element (validated like claim citations). */
  citations: z.array(idSchema('evidence')).max(50).default([]),
  status: DesignElementStatus,
  /** Generation job that proposed it, if any. */
  jobId: idSchema('designJob').optional(),
  revision: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type DesignElement = z.infer<typeof DesignElement>;

/** Create/patch payloads (server assigns id, author for the UI path, revision and timestamps). */
export const DesignElementInput = z.object({
  body: DesignElementBody,
  boundEntityIds: z.array(idSchema('entity')).max(500).default([]),
});
export const DesignElementPatch = z.object({
  body: DesignElementBody.optional(),
  boundEntityIds: z.array(idSchema('entity')).max(500).optional(),
  status: DesignElementStatus.optional(),
  /** Optimistic concurrency, as for overlays. */
  revision: z.number().int().nonnegative(),
});

/** Drift between the board and the code, always visible on the canvas (D02a). */
export const DesignDrift = z.discriminatedUnion('kind', [
  /** A drawn flow with no matching code relation. */
  z.object({ kind: z.literal('flow-not-in-code'), elementId: idSchema('designElement') }),
  /** A code flow between boxes that is not on the board (ghost edge the user can adopt). */
  z.object({
    kind: z.literal('code-flow-not-drawn'),
    fromEntityId: idSchema('entity'),
    toEntityId: idSchema('entity'),
    relationIds: z.array(idSchema('relation')),
  }),
  /** A bound box whose entity is gone from the current snapshot. */
  z.object({
    kind: z.literal('bound-entity-missing'),
    elementId: idSchema('designElement'),
    entityIds: z.array(idSchema('entity')),
  }),
]);
export type DesignDrift = z.infer<typeof DesignDrift>;

/** Agent runtimes for copilot actions and design generation (D02c). Mock is for CI and demos. */
export const DesignRuntimeId = z.enum(['claude-code', 'anthropic-api', 'mock']);
export type DesignRuntimeId = z.infer<typeof DesignRuntimeId>;

export const DesignJobKind = z.enum([
  'generate',
  'propose-grouping',
  'name-subsystem',
  'explain-flow',
  'suggest-responsibilities',
]);

/** A manual request; nothing schedules these (watcher and scans never trigger a model). */
export const DesignJobRequest = z.object({
  kind: DesignJobKind,
  runtime: DesignRuntimeId,
  model: z.string().max(100).optional(),
  snapshotId: idSchema('snapshot'),
  /** generate: recursion depth (levels below the system canvas). */
  depth: z.number().int().min(1).max(3).default(3),
  maxSubsystemsPerLevel: z.number().int().min(2).max(12).default(8),
  /** Selection the copilot action applies to (entity ids or design element ids). */
  targetIds: z.array(z.string().min(1).max(100)).max(200).default([]),
  /** generate: drop earlier *proposed* elements first. Accepted and human work is never replaced. */
  replaceProposals: z.boolean().default(false),
});
export type DesignJobRequest = z.infer<typeof DesignJobRequest>;

export const DesignJobState = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']);

/** Streamed over SSE as `design.job` bus events; the job is also recorded as a run (`design-agent`). */
export const DesignJobEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), jobId: idSchema('designJob'), state: DesignJobState }),
  z.object({
    type: z.literal('progress'),
    jobId: idSchema('designJob'),
    level: z.number().int().min(0).max(3),
    message: z.string().max(500),
  }),
  z.object({
    type: z.literal('tool-call'),
    jobId: idSchema('designJob'),
    tool: z.string().max(100),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('usage'),
    jobId: idSchema('designJob'),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('done'),
    jobId: idSchema('designJob'),
    runId: idSchema('run').optional(),
    proposedElements: z.number().int().nonnegative(),
    proposedClaims: z.number().int().nonnegative(),
    error: z.string().max(2_000).optional(),
  }),
]);
export type DesignJobEvent = z.infer<typeof DesignJobEvent>;
