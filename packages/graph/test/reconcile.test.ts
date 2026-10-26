import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers, type Analyzer } from '@atlas/analyzers';
import { newId } from '@atlas/schema';
import type { Db } from '@atlas/store';
import {
  checkSnapshotIntegrity,
  registerRoot,
  resolveAlias,
  scanWorktree,
  stableId,
} from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

function copyFixture(name: string): string {
  const dest = join(mkdtempSync(join(tmpdir(), 'atlas-rec-')), name);
  cpSync(fixture(name), dest, { recursive: true });
  return dest;
}

async function setup(name = 'ts-web-service') {
  const root = copyFixture(name);
  const db = freshDb();
  const { project, worktree } = await registerRoot(db, root);
  const scan = () => scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
  const first = await scan();
  return { root, db, project, worktree, scan, first };
}

const changes = (db: Db, snapshotId: string) =>
  db
    .prepare(
      'SELECT target, change, detail FROM snapshot_changes WHERE snapshot_id = ? ORDER BY target, change',
    )
    .all<{ target: string; change: string; detail: string }>(snapshotId)
    .map((c) => ({ ...c, detail: JSON.parse(c.detail) as Record<string, unknown> }));

describe('reconciliation', () => {
  it('a no-op rescan produces no semantic churn and passes integrity checks', async () => {
    for (const name of ['ts-web-service', 'py-cli-api']) {
      const { db, scan, first } = await setup(name);
      expect(checkSnapshotIntegrity(db, first.snapshot.id)).toEqual([]);
      const second = await scan();
      expect(changes(db, second.snapshot.id)).toEqual([]);
      expect(second.changes.entities).toEqual({
        added: 0,
        removed: 0,
        changed: 0,
        renamed: 0,
        stale: 0,
        restored: 0,
      });
      expect(second.changes.relations).toEqual({
        added: 0,
        removed: 0,
        changed: 0,
        renamed: 0,
        stale: 0,
        restored: 0,
      });
      expect(checkSnapshotIntegrity(db, second.snapshot.id)).toEqual([]);
    }
  });

  it('a single-file edit changes only the affected entities and relations', async () => {
    const { root, db, scan } = await setup();
    const file = join(root, 'packages/api/src/routes/reports.ts');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        "app.get('/reports/:id'",
        "app.delete('/reports/:id', async () => null);\n\n  app.get('/reports/:id'",
      ),
    );
    const r = await scan();
    const c = changes(db, r.snapshot.id);
    expect(
      c
        .filter((x) => x.change === 'added')
        .map((x) => `${x.target} ${x.detail.kind}`)
        .sort(),
    ).toEqual(['entity endpoint', 'relation exposes']);
    expect(c.filter((x) => x.change === 'removed')).toEqual([]);
    // every changed entity is changed because it cites the edited file; nothing else moved
    const changedIds = db
      .prepare(
        "SELECT id FROM snapshot_changes WHERE snapshot_id = ? AND target = 'entity' AND change = 'changed'",
      )
      .all<{ id: string }>(r.snapshot.id)
      .map((x) => x.id);
    expect(changedIds.length).toBeGreaterThan(0);
    for (const id of changedIds) {
      const attrs = JSON.parse(
        db
          .prepare('SELECT attributes FROM entities WHERE snapshot_id = ? AND id = ?')
          .get<{ attributes: string }>(r.snapshot.id, id)!.attributes,
      ) as { evidenceIds: string[] };
      const paths = attrs.evidenceIds.map(
        (e) => db.prepare('SELECT path FROM evidence WHERE id = ?').get<{ path: string }>(e)!.path,
      );
      expect(paths).toContain('packages/api/src/routes/reports.ts');
    }
    const total = db
      .prepare('SELECT count(*) AS n FROM entities WHERE snapshot_id = ?')
      .get<{ n: number }>(r.snapshot.id)!.n;
    expect(changedIds.length).toBeLessThan(total / 5);
    expect(checkSnapshotIntegrity(db, r.snapshot.id)).toEqual([]);
  });

  it('deleted files leave tombstones in the change record, not in the live graph', async () => {
    const { root, db, scan } = await setup();
    rmSync(join(root, 'packages/worker/src/generate.ts'));
    const r = await scan();
    const removed = changes(db, r.snapshot.id).filter(
      (x) => x.target === 'entity' && x.change === 'removed',
    );
    expect(removed.map((x) => x.detail.canonicalName).sort()).toEqual([
      'ts:packages/worker/src/generate.ts',
      'ts:packages/worker/src/generate.ts#generateReport',
    ]);
    expect(removed[0]!.detail).toHaveProperty('kind');
    const live = db
      .prepare(
        "SELECT count(*) AS n FROM entities WHERE snapshot_id = ? AND canonical_name LIKE '%generate.ts%'",
      )
      .get<{ n: number }>(r.snapshot.id)!.n;
    expect(live).toBe(0);
    expect(
      r.coverage.gaps.some((g) => g.kind === 'unresolved-reference' && /generate/.test(g.detail)),
    ).toBe(true);
  });

  it('accepts an exact-content move as a rename and carries symbols with it', async () => {
    const { root, db, project, scan, first } = await setup();
    mkdirSync(join(root, 'packages/worker/src/jobs'));
    renameSync(
      join(root, 'packages/worker/src/generate.ts'),
      join(root, 'packages/worker/src/jobs/generate.ts'),
    );
    const r = await scan();
    const renamed = changes(db, r.snapshot.id).filter((x) => x.change === 'renamed');
    expect(renamed.map((x) => x.detail.method).sort()).toEqual(['content-hash', 'parent-rename']);
    const oldId = stableId(
      'entity',
      project.id,
      'ts:symbol:packages/worker/src/generate.ts#generateReport',
    );
    expect(resolveAlias(db, project.id, oldId)).toBe(
      stableId(
        'entity',
        project.id,
        'ts:symbol:packages/worker/src/jobs/generate.ts#generateReport',
      ),
    );
    expect(
      changes(db, r.snapshot.id).filter((x) => x.target === 'entity' && x.change === 'removed'),
    ).toEqual([]);
    expect(first.snapshot.id).not.toBe(r.snapshot.id);
  });

  it('surfaces ambiguous and similarity-only renames as open issues without merging', async () => {
    const { root, db, scan } = await setup('py-cli-api');
    const pkg = join(root, 'src/notekeeper');
    writeFileSync(join(pkg, 'a.py'), 'X = 1\n');
    writeFileSync(join(pkg, 'b.py'), 'X = 1\n');
    await scan();
    mkdirSync(join(pkg, 'sub'));
    renameSync(join(pkg, 'a.py'), join(pkg, 'sub/a2.py'));
    renameSync(join(pkg, 'b.py'), join(pkg, 'sub/b2.py'));
    mkdirSync(join(pkg, 'io'));
    writeFileSync(
      join(pkg, 'io/export.py'),
      readFileSync(join(pkg, 'export.py'), 'utf8') + '\n# moved and edited\n',
    );
    rmSync(join(pkg, 'export.py'));
    const r = await scan();
    const issues = db
      .prepare(
        "SELECT kind, body FROM issues WHERE snapshot_id = ? AND status = 'open' ORDER BY kind",
      )
      .all<{ kind: string; body: string }>(r.snapshot.id);
    expect(issues.map((i) => i.kind)).toEqual(['ambiguous-rename', 'possible-rename']);
    expect(JSON.parse(issues[1]!.body)).toMatchObject({ name: 'export.py' });
    expect(changes(db, r.snapshot.id).filter((x) => x.change === 'renamed')).toEqual([]);
    expect(r.changes.issues).toBe(2);
  });

  it('carries human claims forward and marks them stale when their evidence changes', async () => {
    const { root, db, project, scan, first } = await setup();
    const moduleId = stableId('entity', project.id, 'ts:module:packages/api/src/db.ts');
    const ev = db
      .prepare("SELECT id FROM evidence WHERE path = 'packages/api/src/db.ts' LIMIT 1")
      .get<{ id: string }>()!.id;
    const claimId = newId('claim');
    const body = {
      schemaVersion: 1,
      id: claimId,
      subjectId: moduleId,
      predicate: 'responsibility',
      value: 'Report persistence',
      origin: 'human',
      evidenceIds: [ev],
      status: 'supported',
      snapshotId: first.snapshot.id,
    };
    db.prepare(
      "INSERT INTO claims (snapshot_id, id, subject_id, predicate, origin, status, body) VALUES (?, ?, ?, 'responsibility', 'human', 'supported', ?)",
    ).run(first.snapshot.id, claimId, moduleId, JSON.stringify(body));
    const same = await scan();
    expect(
      db
        .prepare('SELECT status FROM claims WHERE snapshot_id = ? AND id = ?')
        .get<{ status: string }>(same.snapshot.id, claimId)?.status,
    ).toBe('supported');
    writeFileSync(
      join(root, 'packages/api/src/db.ts'),
      readFileSync(join(root, 'packages/api/src/db.ts'), 'utf8') + '\n// edited\n',
    );
    const edited = await scan();
    expect(
      db
        .prepare('SELECT status FROM claims WHERE snapshot_id = ? AND id = ?')
        .get<{ status: string }>(edited.snapshot.id, claimId)?.status,
    ).toBe('stale');
  });

  it('reports stale changes when an analyzer fails, and restores them when it recovers', async () => {
    const { db, worktree } = await setup();
    const broken = defaultAnalyzers().map((a): Analyzer =>
      a.id === 'generic-docker' ? { ...a, extract: () => Promise.reject(new Error('boom')) } : a,
    );
    const failed = await scanWorktree(db, worktree, { analyzers: broken });
    expect(failed.changes.entities.stale).toBeGreaterThan(0);
    expect(failed.changes.entities.removed).toBe(0);
    const recovered = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
    expect(recovered.changes.entities.restored).toBe(failed.changes.entities.stale);
    expect(recovered.snapshot.state).toBe('ready');
  });

  it('detects integrity violations', async () => {
    const { db, first } = await setup();
    const rel = db
      .prepare(
        "SELECT id, evidence_ids FROM relations WHERE snapshot_id = ? AND status = 'supported' LIMIT 1",
      )
      .get<{ id: string; evidence_ids: string }>(first.snapshot.id)!;
    db.prepare('UPDATE relations SET evidence_ids = ? WHERE snapshot_id = ? AND id = ?').run(
      '["evd_0000000000000000"]',
      first.snapshot.id,
      rel.id,
    );
    expect(checkSnapshotIntegrity(db, first.snapshot.id)).toEqual([
      `relation ${rel.id} cites missing evidence evd_0000000000000000`,
    ]);
  });
});
