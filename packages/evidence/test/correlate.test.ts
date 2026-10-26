import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '@atlas/store';
import {
  appendEvents,
  correlateRun,
  createRun,
  ObjectStore,
  reserveArtifact,
  runsForEntity,
} from '../src/index.ts';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const pid = `proj_${'1'.repeat(32)}`;
  const wt = `wt_${'2'.repeat(32)}`;
  const snap = `snap_${'3'.repeat(32)}`;
  db.prepare("INSERT INTO projects (id, display_name, created_at) VALUES (?, 'p', 'now')").run(pid);
  db.prepare(
    "INSERT INTO worktrees (id, project_id, root_path, created_at) VALUES (?, ?, '/x', 'now')",
  ).run(wt, pid);
  db.prepare(
    "INSERT INTO snapshots (id, project_id, worktree_id, dirty_tree_digest, dirty, created_at, analyzer_versions, config_digest, state) VALUES (?, ?, ?, ?, 1, 'now', '{}', ?, 'ready')",
  ).run(snap, pid, wt, 'a'.repeat(64), 'b'.repeat(64));
  const ent = (id: string, kind: string, attrs: object) =>
    db
      .prepare(
        "INSERT INTO entities (snapshot_id, id, project_id, kind, canonical_name, display_name, lifecycle, attributes, first_seen_snapshot, last_seen_snapshot) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
      )
      .run(snap, id, pid, kind, id, id, JSON.stringify(attrs), snap, snap);
  ent(`ent_${'4'.repeat(32)}`, 'module', { path: 'worker/generate-report.mjs' });
  ent(`ent_${'5'.repeat(32)}`, 'ui-surface', { path: '/reports/:id' });
  return { db, pid, wt, snap, objects: new ObjectStore(mkdtempSync(join(tmpdir(), 'atlas-cor-'))) };
}

describe('correlateRun', () => {
  it('links a command run (and its outputs) to the module its argv names, and screenshots to matching routes', () => {
    const { db, pid, wt, snap, objects } = setup();
    const { run } = createRun(db, {
      projectId: pid,
      worktreeId: wt,
      snapshotId: snap,
      adapter: 'process',
      environmentSummary: { cwd: '.' },
    });
    appendEvents(db, run.id, [
      {
        producerId: 'p',
        producerEventId: '1',
        type: 'run.started',
        occurredAt: '2026-10-26T12:00:00Z',
        payload: { argv: ['/usr/bin/node', 'worker/generate-report.mjs', '--out', 'out'] },
      },
      {
        producerId: 'p',
        producerEventId: '2',
        type: 'screenshot.captured',
        occurredAt: '2026-10-26T12:00:01Z',
        payload: { url: 'http://127.0.0.1:5/reports/42?x=1' },
      },
    ]);
    reserveArtifact(db, objects, run.id, { logicalName: 'out/report.json', role: 'output-file' });
    expect(correlateRun(db, run.id)).toBe(3);
    expect(correlateRun(db, run.id)).toBe(0); // idempotent
    const methods = db
      .prepare("SELECT json_extract(body, '$.method') AS m, status FROM correlations ORDER BY m")
      .all();
    expect(methods).toEqual([
      { m: 'command-mapping', status: 'supported' },
      { m: 'command-mapping', status: 'supported' },
      { m: 'route-signature', status: 'inferred' },
    ]);
    expect(runsForEntity(db, `ent_${'4'.repeat(32)}`).map((r) => r.id)).toEqual([run.id]);
  });

  it('guesses nothing for unbound runs or unmatched commands', () => {
    const { db, pid, wt } = setup();
    const unbound = createRun(db, { projectId: pid, worktreeId: wt, adapter: 'process' });
    appendEvents(db, unbound.run.id, [
      {
        producerId: 'p',
        producerEventId: 'u',
        type: 'run.started',
        occurredAt: '2026-10-26T12:00:00Z',
        payload: { argv: ['node', 'worker/generate-report.mjs'] },
      },
    ]);
    expect(correlateRun(db, unbound.run.id)).toBe(0);
  });
});
