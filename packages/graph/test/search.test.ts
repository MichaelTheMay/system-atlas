import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import { registerRoot, scanWorktree, searchEntities } from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

describe('searchEntities', () => {
  it('finds entities by name prefix, filters by kind, and neutralizes FTS syntax', async () => {
    const db = freshDb();
    const { worktree } = await registerRoot(db, fixture('ts-web-service'));
    const { snapshot } = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
    const hits = searchEntities(db, snapshot.id, 'repor');
    expect(hits.map((h) => h.displayName)).toEqual(expect.arrayContaining(['reports.ts']));
    const modules = searchEntities(db, snapshot.id, 'db', { kind: 'module' });
    expect(modules.every((h) => h.kind === 'module')).toBe(true);
    expect(modules.find((h) => h.displayName === 'db.ts')?.path).toBe('packages/api/src/db.ts');
    for (const evil of ['NEAR(a b)', 'kind:module', '"unbalanced', 'a OR b AND NOT c', '*', ''])
      expect(() => searchEntities(db, snapshot.id, evil)).not.toThrow();
    expect(searchEntities(db, snapshot.id, '   ')).toEqual([]);
    expect(searchEntities(db, snapshot.id, 'report', { limit: 1 })).toHaveLength(1);
  });
});
