import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import { compactSnapshots, isCompacted, registerRoot, scanWorktree } from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

describe('snapshot compaction', () => {
  it('drops graph rows of superseded snapshots but keeps the latest, its predecessor and run-bound ones', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'atlas-compact-')), 'p');
    cpSync(fixture('ts-web-service'), root, { recursive: true });
    const db = freshDb();
    const { worktree } = await registerRoot(db, root);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, 'NOTES.md'), `rev ${i}`);
      ids.push((await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() })).snapshot.id);
    }
    // a run executed on the second snapshot pins it
    db.prepare(
      "INSERT INTO runs (id, project_id, worktree_id, snapshot_id, status, start_at, body) VALUES ('run_x', ?, ?, ?, 'succeeded', 'now', '{}')",
    ).run(worktree.projectId, worktree.id, ids[1]!);

    expect(compactSnapshots(db, worktree.id)).toEqual([ids[0]]);
    expect(compactSnapshots(db, worktree.id)).toEqual([]); // idempotent
    const count = (table: string, id: string) =>
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE snapshot_id = ?`).get<{ n: number }>(id)!
        .n;
    for (const t of ['entities', 'relations', 'snapshot_files', 'canvases', 'entity_search'])
      expect(count(t, ids[0]!), t).toBe(0);
    for (const kept of ids.slice(1)) expect(count('entities', kept)).toBeGreaterThan(0);
    expect(isCompacted(db, ids[0]!)).toBe(true);
    expect(isCompacted(db, ids[3]!)).toBe(false);
    // metadata and coverage of the compacted snapshot survive
    expect(
      db
        .prepare('SELECT coverage_report_id AS c FROM snapshots WHERE id = ?')
        .get<{ c: string }>(ids[0]!)!.c,
    ).toBeTruthy();
  });
});
