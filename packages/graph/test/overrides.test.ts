import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import {
  inSubsystem,
  listOverrides,
  loadPlannerGraph,
  promoteSubsystem,
  proposeClaims,
  registerRoot,
  rejectClaim,
  scanWorktree,
  searchEntities,
  setOverride,
  subsystemSegments,
} from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

const meta = {
  provider: 'mcp-client',
  model: 'test-agent',
  promptTemplateVersion: 'agent-authored',
};
const canvas = 'cvs_' + 'a'.repeat(32);

async function setup() {
  const db = freshDb();
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-ovr-')), 'svc');
  cpSync(fixture('ts-web-service'), root, { recursive: true });
  const { worktree, project } = await registerRoot(db, root);
  const scan = () => scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
  const first = await scan();
  const mod = (q: string, path: string) =>
    searchEntities(db, first.snapshot.id, q, { kind: 'module' }).find((h) => h.path === path)!.id;
  const dbId = mod('db', 'packages/api/src/db.ts');
  const serverId = mod('server', 'packages/api/src/server.ts');
  const propose = (snapshotId: string, items: [string, string, string][]) =>
    proposeClaims(db, {
      snapshotId,
      origin: 'model',
      modelMetadata: meta,
      claims: items.map(([subjectId, value, path]) => ({
        subjectId,
        predicate: 'subsystem',
        value,
        citations: [{ path, startLine: 1, endLine: 1 }],
      })),
    });
  return { db, root, project, scan, snapshotId: first.snapshot.id, dbId, serverId, propose };
}

describe('view overrides and design inputs', () => {
  it('normalizes subsystem paths segment-wise', () => {
    expect(subsystemSegments('  Backend /  Data   Store ')).toEqual(['backend', 'data store']);
    expect(inSubsystem('backend/data store', ['backend'])).toBe(true);
    expect(inSubsystem('Backend', ['backend'])).toBe(true);
    expect(inSubsystem('backends', ['backend'])).toBe(false);
    expect(inSubsystem('backend', ['backend', 'auth'])).toBe(false);
    expect(inSubsystem(42, ['backend'])).toBe(false);
  });

  it('loads claims and project overrides into the planner graph', async () => {
    const t = await setup();
    expect(loadPlannerGraph(t.db, t.snapshotId)).toMatchObject({ claims: [], overrides: [] });
    const r = await t.propose(t.snapshotId, [[t.dbId, 'Storage', 'packages/api/src/db.ts']]);
    expect(r.ok).toBe(true);
    setOverride(t.db, t.project.id, canvas, 'pin', true);
    setOverride(t.db, t.project.id, canvas, 'pin', true); // idempotent
    setOverride(t.db, t.project.id, canvas, 'suppress', true);
    const g = loadPlannerGraph(t.db, t.snapshotId);
    expect(g.claims).toEqual([
      {
        id: expect.stringMatching(/^clm_/),
        subjectId: t.dbId,
        predicate: 'subsystem',
        value: 'Storage',
        origin: 'model',
        status: 'inferred',
        model: 'test-agent',
      },
    ]);
    expect(g.overrides).toEqual([
      { targetId: canvas, action: 'pin' },
      { targetId: canvas, action: 'suppress' },
    ]);
    setOverride(t.db, t.project.id, canvas, 'pin', false);
    expect(listOverrides(t.db, t.project.id)).toEqual([
      { targetId: canvas, action: 'suppress', createdAt: expect.any(String) },
    ]);
    // rejected claims stay visible to the planner with their status (it decides what to show)
    const claimId = g.claims![0]!.id;
    expect(rejectClaim(t.db, claimId, 'wrong').ok).toBe(true);
    expect(loadPlannerGraph(t.db, t.snapshotId).claims![0]!.status).toBe('rejected');
  });

  it('promotes model subsystem claims to supported human claims through the validator', async () => {
    const t = await setup();
    const r = await t.propose(t.snapshotId, [
      [t.dbId, 'Backend / Storage', 'packages/api/src/db.ts'],
      [t.serverId, 'backend', 'packages/api/src/server.ts'],
      [t.serverId, 'Frontend', 'packages/api/src/server.ts'],
    ]);
    expect(r.ok && r.accepted).toHaveLength(3);
    const relations = () =>
      t.db.prepare('SELECT count(*) AS n FROM relations').get<{ n: number }>()!.n;
    const before = relations();

    const p = await promoteSubsystem(t.db, {
      snapshotId: t.snapshotId,
      canvasId: canvas,
      subsystemPath: 'BACKEND',
    });
    expect(p).toMatchObject({ ok: true, rejected: [], overrideRecorded: true, alreadyAccepted: 0 });
    expect(p.ok && p.accepted.map((a) => [a.subjectId, a.status]).sort()).toEqual(
      [
        [t.dbId, 'supported'],
        [t.serverId, 'supported'],
      ].sort(),
    );
    const human = loadPlannerGraph(t.db, t.snapshotId).claims!.filter((c) => c.origin === 'human');
    expect(human.map((c) => c.value).sort()).toEqual(['Backend / Storage', 'backend']);
    // model claims are untouched and never become supported; no relation rows are written
    expect(
      loadPlannerGraph(t.db, t.snapshotId)
        .claims!.filter((c) => c.origin === 'model')
        .map((c) => c.status),
    ).toEqual(['inferred', 'inferred', 'inferred']);
    expect(relations()).toBe(before);
    expect(listOverrides(t.db, t.project.id)).toEqual([
      expect.objectContaining({ targetId: canvas, action: 'promote' }),
    ]);

    // promoting again re-proposes nothing
    const again = await promoteSubsystem(t.db, {
      snapshotId: t.snapshotId,
      canvasId: canvas,
      subsystemPath: 'backend',
    });
    expect(again).toMatchObject({ ok: true, accepted: [], alreadyAccepted: 2 });

    expect(
      await promoteSubsystem(t.db, {
        snapshotId: t.snapshotId,
        canvasId: canvas,
        subsystemPath: 'nothing here',
      }),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses to promote claims whose cited file changed, with the validator reasons', async () => {
    const t = await setup();
    await t.propose(t.snapshotId, [[t.dbId, 'Storage', 'packages/api/src/db.ts']]);
    appendFileSync(join(t.root, 'packages/api/src/db.ts'), '\n// edited\n');
    const next = await t.scan();
    expect(next.snapshot.id).not.toBe(t.snapshotId);
    const carried = loadPlannerGraph(t.db, next.snapshot.id).claims!;
    expect(carried.map((c) => c.status)).toEqual(['stale']);

    const p = await promoteSubsystem(t.db, {
      snapshotId: next.snapshot.id,
      canvasId: canvas,
      subsystemPath: 'storage',
    });
    expect(p).toMatchObject({ ok: true, accepted: [], overrideRecorded: false });
    expect(p.ok && p.rejected).toEqual([
      {
        sourceClaimId: carried[0]!.id,
        subjectId: t.dbId,
        reasons: [
          expect.stringMatching(/describes a different version of packages\/api\/src\/db\.ts/),
        ],
      },
    ]);
    expect(
      loadPlannerGraph(t.db, next.snapshot.id).claims!.filter((c) => c.origin === 'human'),
    ).toEqual([]);
    expect(listOverrides(t.db, t.project.id)).toEqual([]);

    // the superseded snapshot is no longer a valid precondition
    expect(
      await promoteSubsystem(t.db, {
        snapshotId: t.snapshotId,
        canvasId: canvas,
        subsystemPath: 'storage',
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });
});
