import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers, tsAnalyzerStats } from '@atlas/analyzers';
import type { Db } from '@atlas/store';
import { registerRoot, scanWorktree } from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

/** The published graph in project-independent terms (canonical names instead of opaque IDs). */
function graphOf(db: Db, snapshotId: string) {
  const names = new Map(
    db
      .prepare('SELECT id, kind, canonical_name AS c FROM entities WHERE snapshot_id = ?')
      .all<{ id: string; kind: string; c: string }>(snapshotId)
      .map((e) => [e.id, `${e.kind}:${e.c}`]),
  );
  const entities = db
    .prepare(
      'SELECT kind, canonical_name, display_name, owner_entity_id AS o, lifecycle, attributes FROM entities WHERE snapshot_id = ?',
    )
    .all<{ o: string | null; attributes: string }>(snapshotId)
    .map((e) => {
      // evidence IDs embed the project ID; compare everything else
      const { evidenceIds: _ignored, ...attributes } = JSON.parse(e.attributes) as Record<
        string,
        unknown
      >;
      return JSON.stringify({ ...e, attributes, o: e.o ? names.get(e.o) : null });
    })
    .sort();
  const relations = db
    .prepare(
      'SELECT from_id AS f, to_id AS t, kind, qualifiers, status, confidence FROM relations WHERE snapshot_id = ?',
    )
    .all<{ f: string; t: string }>(snapshotId)
    .map((r) => JSON.stringify({ ...r, f: names.get(r.f) ?? r.f, t: names.get(r.t) ?? r.t }))
    .sort();
  return { entities, relations };
}

describe('incremental TS/JS analysis', () => {
  it('re-parses only changed files and publishes the same graph as a cold scan', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'atlas-incr-')), 'ts-web-service');
    cpSync(fixture('ts-web-service'), root, { recursive: true });
    const db = freshDb();
    const { worktree } = await registerRoot(db, root);
    await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
    const cold = tsAnalyzerStats.get(root)!;
    expect(cold.parsed).toBeGreaterThan(5);

    // edit one module: add an import and an endpoint
    const f = join(root, 'packages/api/src/db.ts');
    writeFileSync(
      f,
      readFileSync(f, 'utf8') + "\nimport { z } from 'zod';\nexport const extra = z;\n",
    );
    const warm = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
    expect(tsAnalyzerStats.get(root)).toEqual({ parsed: 1, cached: cold.parsed + cold.cached - 1 });

    // a cold scan of the same tree in a fresh store
    const db2 = freshDb();
    const { worktree: wt2 } = await registerRoot(db2, root);
    const coldAgain = await scanWorktree(db2, wt2, { analyzers: defaultAnalyzers() });
    expect(graphOf(db, warm.snapshot.id)).toEqual(graphOf(db2, coldAgain.snapshot.id));
  });
});
