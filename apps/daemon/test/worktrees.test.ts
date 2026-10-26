import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import { registerRoot, scanWorktree, stableId } from '@atlas/graph';
import { newId } from '@atlas/schema';
import { migrate, openDb } from '@atlas/store';
import { getOverlay, putOverlay } from '../src/routes/overlays.ts';

const g = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, stdio: 'pipe' },
  );

describe('worktree isolation of identity continuations', () => {
  it("a rename on a feature worktree does not move main's pins or claims", async () => {
    const base = mkdtempSync(join(tmpdir(), 'atlas-wt-'));
    const main = join(base, 'main');
    mkdirSync(join(main, 'src'), { recursive: true });
    writeFileSync(join(main, 'package.json'), '{"name":"app"}');
    writeFileSync(join(main, 'src/gen.ts'), 'export function generate() { return 1; }\n');
    writeFileSync(
      join(main, 'src/use.ts'),
      "import { generate } from './gen';\nexport const v = generate();\n",
    );
    g(main, 'init', '-q');
    g(main, 'add', '.');
    g(main, 'commit', '-q', '-m', 'init');
    const feature = join(base, 'feature');
    g(main, 'worktree', 'add', '-q', '-b', 'feature', feature);

    const db = openDb(':memory:');
    migrate(db);
    const m = await registerRoot(db, main);
    const f = await registerRoot(db, feature);
    expect(f.project.id).toBe(m.project.id);
    const pid = m.project.id;
    const scan = (wt: typeof m.worktree) => scanWorktree(db, wt, { analyzers: defaultAnalyzers() });

    const m1 = await scan(m.worktree);
    await scan(f.worktree);
    const oldId = stableId('entity', pid, 'ts:module:src/gen.ts');
    const newIdOnFeature = stableId('entity', pid, 'ts:module:src/jobs/gen.ts');

    // main: a pin and a human claim on src/gen.ts
    const viewId = `cvs_${'a'.repeat(32)}`;
    const put = putOverlay(db, viewId, {
      schemaVersion: 1,
      viewId,
      profileId: 'local',
      entityPositions: { [oldId]: { x: 11, y: 22 } },
      nodePositions: {},
      pinnedIds: [oldId],
      annotations: [],
      displayOverrides: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      revision: 0,
    });
    expect(put.ok).toBe(true);
    const ev = db
      .prepare("SELECT id FROM evidence WHERE path = 'src/gen.ts' LIMIT 1")
      .get<{ id: string }>()!.id;
    const claimId = newId('claim');
    db.prepare(
      "INSERT INTO claims (snapshot_id, id, subject_id, predicate, origin, status, body) VALUES (?, ?, ?, 'responsibility', 'human', 'supported', ?)",
    ).run(
      m1.snapshot.id,
      claimId,
      oldId,
      JSON.stringify({
        schemaVersion: 1,
        id: claimId,
        subjectId: oldId,
        predicate: 'responsibility',
        value: 'generator',
        origin: 'human',
        evidenceIds: [ev],
        status: 'supported',
        snapshotId: m1.snapshot.id,
      }),
    );

    // feature: move the file with identical content -> project-wide alias old -> new
    mkdirSync(join(feature, 'src/jobs'));
    renameSync(join(feature, 'src/gen.ts'), join(feature, 'src/jobs/gen.ts'));
    const f2 = await scan(f.worktree);
    expect(
      db
        .prepare('SELECT new_id FROM entity_aliases WHERE project_id = ? AND old_id = ?')
        .get<{ new_id: string }>(pid, oldId)?.new_id,
    ).toBe(newIdOnFeature);

    // main rescans: its file did not move, so the claim keeps its subject and status
    const m2 = await scan(m.worktree);
    const claim = db
      .prepare('SELECT subject_id, status FROM claims WHERE snapshot_id = ? AND id = ?')
      .get<{ subject_id: string; status: string }>(m2.snapshot.id, claimId);
    expect(claim).toEqual({ subject_id: oldId, status: 'supported' });

    // main's view keeps its pin on the old id; the feature view sees it follow the move
    const onMain = getOverlay(db, viewId, { projectId: pid, snapshotId: m2.snapshot.id });
    expect(onMain.entityPositions).toEqual({ [oldId]: { x: 11, y: 22 } });
    expect(onMain.pinnedIds).toEqual([oldId]);
    const onFeature = getOverlay(db, viewId, { projectId: pid, snapshotId: f2.snapshot.id });
    expect(onFeature.entityPositions).toEqual({ [newIdOnFeature]: { x: 11, y: 22 } });
  });
});
