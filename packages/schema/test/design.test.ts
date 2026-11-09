import { describe, expect, it } from 'vitest';
import { DesignElement, DesignJobRequest, newId } from '../src/index.ts';

const now = '2026-10-26T00:00:00.000Z';

describe('design layer contract (D02)', () => {
  it('accepts an unbound drawn box and a flow to a detected entity', () => {
    const box = DesignElement.parse({
      id: newId('designElement'),
      projectId: newId('project'),
      body: { kind: 'box', label: 'Billing', archetype: 'api-service' },
      boundEntityIds: [],
      author: 'user',
      status: 'active',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    expect(box.citations).toEqual([]);
    const flow = DesignElement.safeParse({
      ...box,
      id: newId('designElement'),
      body: {
        kind: 'flow',
        from: { elementId: box.id },
        to: { entityId: `ent_${'a'.repeat(32)}` },
        label: 'HTTP',
      },
    });
    expect(flow.success).toBe(true);
  });

  it('rejects unknown archetypes and empty labels', () => {
    const bad = (body: unknown) =>
      DesignElement.safeParse({
        id: newId('designElement'),
        projectId: newId('project'),
        body,
        boundEntityIds: [],
        author: 'agent',
        status: 'proposed',
        revision: 0,
        createdAt: now,
        updatedAt: now,
      }).success;
    expect(bad({ kind: 'box', label: 'x', archetype: 'mainframe' })).toBe(false);
    expect(bad({ kind: 'subsystem', label: '   ' })).toBe(false);
  });

  it('bounds generation depth to 3 and defaults to never replacing proposals', () => {
    const snapshotId = newId('snapshot');
    const r = DesignJobRequest.parse({ kind: 'generate', runtime: 'mock', snapshotId });
    expect(r).toMatchObject({ depth: 3, replaceProposals: false });
    expect(
      DesignJobRequest.safeParse({ kind: 'generate', runtime: 'mock', snapshotId, depth: 4 })
        .success,
    ).toBe(false);
  });
});
