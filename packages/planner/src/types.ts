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

export interface PlannerGraph {
  projectId: string;
  snapshotId: string;
  hasPrevious: boolean;
  entities: GraphEntity[];
  relations: GraphRelation[];
  gaps: GapSummary[];
  changes: GraphChange[];
}

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
}

export interface ProjectionEdge {
  id: string;
  source: string;
  target: string;
  kinds: Record<string, number>;
  relationIds: string[];
  status: 'supported' | 'inferred' | 'stale' | 'mixed';
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
