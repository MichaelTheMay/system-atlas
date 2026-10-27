import type { Catalog, PlannerGraph, Projection } from './types.ts';

/**
 * System-design lens (D01): whiteboard canvases derived from the semantic graph, subsystem claims
 * and view overrides. Views only: nothing here becomes a claim or a relation.
 *
 * Wave 0 stub: the signatures are the contract the daemon builds against; the planner wave fills
 * them in.
 */
export function planDesign(_g: PlannerGraph): Catalog {
  return { canvases: [], links: [] };
}

export function projectDesign(_g: PlannerGraph, catalog: Catalog, canvasIdArg: string): Projection {
  const spec = catalog.canvases.find((c) => c.id === canvasIdArg);
  if (!spec) throw new Error(`unknown canvas ${canvasIdArg}`);
  return {
    viewId: spec.id,
    canvasId: spec.id,
    snapshotId: spec.snapshotId,
    lens: spec.lens,
    title: spec.title,
    relevanceReason: spec.relevanceReason,
    nodes: [],
    edges: [],
    truncated: false,
    breadcrumbs: [{ canvasId: spec.id, title: spec.title }],
    siblings: [],
    children: [],
    stats: { entities: 0, relations: 0, hiddenNodes: 0 },
  };
}
