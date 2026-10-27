import { z } from 'zod';
import { idSchema, Timestamp } from './ids.ts';
import { EntityKind, RelationKind } from './semantic.ts';

export const VIEW_SCHEMA_VERSION = 1 as const;

export const Workspace = z.enum(['architecture', 'outputs']);
export type Workspace = z.infer<typeof Workspace>;

export const ArchitectureLens = z.enum([
  'system-context',
  'deployables',
  'component',
  'module-detail',
  'api',
  'data',
  'workflow',
  'agent-tool',
  'ui-navigation',
  'deployment',
  'trust-boundaries',
  'changes',
  'coverage',
]);
export const OutputsLens = z.enum([
  'outputs-overview',
  'run-detail',
  'browser-journey',
  'code-execution',
  'artifact-gallery',
  'audit-trail',
  'run-comparison',
]);
export const Lens = z.union([ArchitectureLens, OutputsLens]);
export type Lens = z.infer<typeof Lens>;

/**
 * Structured view query (plan §6): a small AST with limits. Never SQL.
 */
export type Selector =
  | { type: 'children-of'; entityId: string }
  | { type: 'kinds'; kinds: EntityKind[]; ownerId?: string }
  | { type: 'ids'; ids: string[] }
  | { type: 'neighbors'; entityId: string; relationKinds: RelationKind[]; depth: number }
  | { type: 'union'; selectors: Selector[] };

export const Selector: z.ZodType<Selector> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('children-of'), entityId: idSchema('entity') }),
    z.object({
      type: z.literal('kinds'),
      kinds: z.array(EntityKind).min(1),
      ownerId: idSchema('entity').optional(),
    }),
    z.object({ type: z.literal('ids'), ids: z.array(idSchema('entity')).max(500) }),
    z.object({
      type: z.literal('neighbors'),
      entityId: idSchema('entity'),
      relationKinds: z.array(RelationKind),
      depth: z.number().int().min(1).max(3),
    }),
    z.object({ type: z.literal('union'), selectors: z.array(Selector).min(1).max(10) }),
  ]),
);

export const ViewQuery = z.object({
  select: Selector,
  relationKinds: z.array(RelationKind).optional(),
  limit: z.number().int().min(1).max(500),
});
export type ViewQuery = z.infer<typeof ViewQuery>;

export const CanvasState = z.enum(['cataloged', 'materialized', 'stale', 'suppressed']);

/** plan §6 CanvasSpec. ID is stable per (workspace, owner, lens). */
export const CanvasSpec = z.object({
  schemaVersion: z.literal(VIEW_SCHEMA_VERSION),
  id: idSchema('canvas'),
  workspace: Workspace,
  rootEntityId: idSchema('entity').optional(),
  ownerCanvasId: idSchema('canvas').optional(),
  lens: Lens,
  title: z.string().min(1),
  query: ViewQuery,
  relevanceReason: z.string().min(1),
  relevanceScore: z.number().min(0).max(1),
  scoringPolicyVersion: z.string().min(1),
  snapshotId: idSchema('snapshot'),
  generationVersion: z.string().min(1),
  state: CanvasState,
  coverageSummary: z.object({
    entityCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    staleCount: z.number().int().nonnegative(),
  }),
});
export type CanvasSpec = z.infer<typeof CanvasSpec>;

export const CanvasLink = z.object({
  schemaVersion: z.literal(VIEW_SCHEMA_VERSION),
  fromCanvasId: idSchema('canvas'),
  toCanvasId: idSchema('canvas'),
  relation: z.enum(['child', 'sibling', 'related', 'evidence']),
  viaEntityId: idSchema('entity').optional(),
});
export type CanvasLink = z.infer<typeof CanvasLink>;

const Point = z.object({ x: z.number().finite(), y: z.number().finite() });

/** plan §6 ViewOverlay: presentation only, never semantic facts. */
export const ViewOverlay = z
  .object({
    schemaVersion: z.literal(VIEW_SCHEMA_VERSION),
    viewId: idSchema('canvas'),
    profileId: z.string().min(1),
    /** Positions of entity nodes; keyed by entity id so they can follow accepted rename aliases. */
    entityPositions: z.record(idSchema('entity'), Point),
    /** Positions of non-entity nodes (clusters, ports, groups) by projection node id. */
    nodePositions: z.record(z.string().min(1).max(300), Point).default({}),
    /**
     * Where top-level nodes were last laid out automatically (entity id or projection node id).
     * Not pins: they keep a known map stable when nodes are added, and "Re-layout" clears them.
     */
    autoPositions: z.record(z.string().min(1).max(300), Point).default({}),
    pinnedIds: z.array(idSchema('entity')),
    annotations: z.array(
      z.object({
        id: idSchema('annotation'),
        targetId: z.union([idSchema('entity'), idSchema('relation')]).optional(),
        text: z.string().max(10_000),
        position: Point.optional(),
        createdAt: Timestamp,
        /** Notes written by an agent through MCP are labeled as such; absent means a person. */
        author: z.enum(['user', 'agent']).optional(),
        authorName: z.string().max(100).optional(),
      }),
    ),
    displayOverrides: z.record(
      idSchema('entity'),
      z.object({
        label: z.string().optional(),
        collapsed: z.boolean().optional(),
        hidden: z.boolean().optional(),
      }),
    ),
    viewport: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().positive(),
    }),
    revision: z.number().int().nonnegative(),
  })
  .refine(
    (o) =>
      Object.keys(o.entityPositions).length +
        Object.keys(o.nodePositions).length +
        Object.keys(o.autoPositions).length <=
        10_000 && o.annotations.length <= 1_000,
    'overlay too large',
  );
export type ViewOverlay = z.infer<typeof ViewOverlay>;
