import type { CanvasLink, CanvasSpec } from '@atlas/schema';

/** The slice of a snapshot the planner and projector need. Built from DB rows or in-memory scan output. */
export interface GraphEntity {
  id: string;
  kind: string;
  canonicalName: string;
  displayName: string;
  ownerEntityId?: string;
  lifecycle: string;
  attributes: Record<string, unknown>;
}

export interface GraphRelation {
  id: string;
  kind: string;
  fromId: string;
  toId: string;
  status: string;
  confidence: string;
  evidenceIds: string[];
}

export interface GraphChange {
  target: 'entity' | 'relation';
  id: string;
  change: string;
  previousId?: string;
  detail: Record<string, unknown>;
}

export interface GapSummary {
  kind: string;
  path?: string;
  detail: string;
  count?: number;
}

/** A human or model claim about an entity (design lens input; never a fact). */
export interface GraphClaim {
  id: string;
  subjectId: string;
  predicate: string;
  value: unknown;
  origin: string;
  status: string;
  /** Model name as reported, for "Proposed by …" labels. */
  model?: string;
}

/** A user decision about a view (plan §8): survives regeneration because it keys on stable canvas ids. */
export interface ViewOverrideRow {
  targetId: string;
  action: 'pin' | 'suppress' | 'promote';
}

export interface PlannerGraph {
  projectId: string;
  snapshotId: string;
  hasPrevious: boolean;
  entities: GraphEntity[];
  relations: GraphRelation[];
  gaps: GapSummary[];
  changes: GraphChange[];
  /** Design lens inputs (D01); absent means none. */
  claims?: GraphClaim[];
  overrides?: ViewOverrideRow[];
}

/** Conceptual whiteboard box kinds of the system-design lens (D01). */
export type Archetype =
  | 'client'
  | 'api-service'
  | 'worker'
  | 'queue'
  | 'datastore'
  | 'cache'
  | 'external-api'
  | 'library'
  | 'service';

/** Where a design canvas or box comes from: analyzers only, a model/agent claim, or a person. */
export type Provenance = 'detected' | 'proposed' | 'accepted';

export interface Catalog {
  canvases: CanvasSpec[];
  links: CanvasLink[];
}

export type NodeKind = 'entity' | 'cluster' | 'port' | 'aggregate' | 'gap' | 'group';

export interface ProjectionNode {
  id: string;
  kind: NodeKind;
  label: string;
  sublabel?: string;
  entityId?: string;
  entityKind?: string;
  lifecycle?: string;
  /** For grouped layouts (React Flow parent/child). */
  parentId?: string;
  /** Canvas to open on double-click (child view or the canvas where a port's target lives). */
  openCanvasId?: string;
  /** Cluster/aggregate drill: same canvas with this focus. */
  focus?: string;
  memberCount?: number;
  counts?: Record<string, number>;
  /** Changes lens only. */
  change?: string;
  /** Relation kinds for ports: inbound/outbound. */
  direction?: 'in' | 'out' | 'both';
  /** Design lens: whiteboard box kind and why it was chosen. */
  archetype?: Archetype;
  archetypeReason?: string;
  provenance?: Provenance;
  /** Design lens: architecture canvas that realizes this box. */
  realizedByCanvasId?: string;
}

export interface ProjectionEdge {
  id: string;
  source: string;
  target: string;
  kinds: Record<string, number>;
  relationIds: string[];
  status: 'supported' | 'inferred' | 'stale' | 'mixed';
  /** Design lens: whiteboard flow label (HTTP, enqueue, consume, reads/writes, uses, runs on). */
  flow?: string;
}

export interface Projection {
  /** Overlay key: the canvas id, or a derived id for a cluster drill-down. */
  viewId: string;
  canvasId: string;
  snapshotId: string;
  lens: string;
  title: string;
  focus?: string;
  relevanceReason: string;
  nodes: ProjectionNode[];
  edges: ProjectionEdge[];
  truncated: boolean;
  breadcrumbs: { canvasId: string; title: string; focus?: string }[];
  siblings: { canvasId: string; lens: string; title: string }[];
  children: { canvasId: string; title: string; viaEntityId?: string }[];
  stats: { entities: number; relations: number; hiddenNodes: number };
}
