import type { GraphClaim, GraphEntity, GraphRelation, PlannerGraph } from '@atlas/planner';

/**
 * A hand-built planner graph for design-lens tests: packages, loose files, queues, databases and
 * tables with the attributes the analyzers would set, so one rule can be checked on its own.
 */
let seq = 0;
const hex = () => (++seq).toString(16).padStart(32, '0');
export const SYSTEM = `ent_${hex()}`;

export class Repo {
  entities: GraphEntity[] = [
    {
      id: SYSTEM,
      kind: 'system',
      canonicalName: 'system',
      displayName: 'repo',
      lifecycle: 'active',
      attributes: {},
    },
  ];
  relations: GraphRelation[] = [];
  private add(
    kind: string,
    name: string,
    attributes: Record<string, unknown>,
    owner = SYSTEM,
  ): string {
    const id = `ent_${hex()}`;
    this.entities.push({
      id,
      kind,
      canonicalName: `${kind}:${name}:${id}`,
      displayName: name,
      ownerEntityId: owner,
      lifecycle: 'active',
      attributes,
    });
    return id;
  }
  /** A package with one module in it; returns the module id (for relations). */
  pkg(name: string, directory: string): string {
    const p = this.add('package', name, { directory });
    return this.add('module', 'index.ts', { path: `${directory}/src/index.ts` }, p);
  }
  file(path: string): string {
    return this.add('module', path.split('/').pop()!, { path });
  }
  queue(name: string): string {
    return this.add('queue', name, { name });
  }
  database(name: string, composeFile: string): string {
    return this.add('database', name, { image: 'postgres', composeFile });
  }
  table(name: string, declaredIn: string): string {
    return this.add('table', name, { declaredIn });
  }
  rel(kind: string, fromId: string, toId: string): void {
    this.relations.push({
      id: `rel_${hex()}`,
      kind,
      fromId,
      toId,
      status: 'supported',
      confidence: 'high',
      evidenceIds: [],
    });
  }
  graph(claims: GraphClaim[] = []): PlannerGraph {
    return {
      projectId: `proj_${'0'.repeat(32)}`,
      snapshotId: `snap_${'0'.repeat(32)}`,
      hasPrevious: false,
      entities: this.entities,
      relations: this.relations,
      gaps: [],
      changes: [],
      claims,
    };
  }
}
