import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManifestAnalyzer, defaultAnalyzers, type Analyzer } from '@atlas/analyzers';
import type { Db } from '@atlas/store';
import { getLatestSnapshot, registerRoot, scanWorktree } from '../src/index.ts';
import { fixture, freshDb, treeFingerprint } from './helpers.ts';

async function scanFixture(name: string, analyzers: Analyzer[] = [createManifestAnalyzer()]) {
  const db = freshDb();
  const { worktree } = await registerRoot(db, fixture(name));
  const result = await scanWorktree(db, worktree, { analyzers });
  return { db, worktree, result };
}

const rows = (db: Db, sql: string, ...p: string[]) =>
  db.prepare(sql).all<Record<string, unknown>>(...p);

describe('scanWorktree on fixtures', () => {
  it('maps the TS fixture packages with evidence-backed relations', async () => {
    const { db, result } = await scanFixture('ts-web-service');
    expect(result.snapshot.state).toBe('ready');
    const ents = rows(
      db,
      'SELECT kind, display_name, canonical_name FROM entities WHERE snapshot_id = ? ORDER BY canonical_name',
      result.snapshot.id,
    );
    expect(ents.map((e) => e.display_name)).toEqual([
      '@reports/api',
      '@reports/shared',
      '@reports/web',
      '@reports/worker',
      'report-service',
      'ts-web-service',
    ]);
    const rels = rows(
      db,
      `SELECT r.kind, a.display_name AS f, b.display_name AS t, r.status, r.evidence_ids FROM relations r
       JOIN entities a ON a.snapshot_id = r.snapshot_id AND a.id = r.from_id
       JOIN entities b ON b.snapshot_id = r.snapshot_id AND b.id = r.to_id
       WHERE r.snapshot_id = ? ORDER BY r.kind, f, t`,
      result.snapshot.id,
    );
    expect(rels.filter((r) => r.kind === 'depends-on').map((r) => `${r.f}->${r.t}`)).toEqual([
      '@reports/api->@reports/shared',
      '@reports/web->@reports/shared',
      '@reports/worker->@reports/shared',
    ]);
    expect(rels.filter((r) => r.kind === 'contains').map((r) => `${r.f}->${r.t}`)).toContain(
      'report-service->@reports/api',
    );
    expect(rels.find((r) => r.kind === 'contains' && r.t === 'report-service')?.f).toBe(
      'ts-web-service',
    );
    // every supported relation cites evidence whose file+hash is in this snapshot's manifest
    for (const r of rels) {
      expect(r.status).toBe('supported');
      for (const evId of JSON.parse(String(r.evidence_ids)) as string[]) {
        const ev = db
          .prepare('SELECT path, content_hash FROM evidence WHERE id = ?')
          .get<{ path: string; content_hash: string }>(evId)!;
        const f = db
          .prepare('SELECT sha256 FROM snapshot_files WHERE snapshot_id = ? AND path = ?')
          .get<{ sha256: string }>(result.snapshot.id, ev.path);
        expect(f?.sha256).toBe(ev.content_hash);
      }
    }
    const cov = result.coverage;
    expect(cov.totals.files).toBe(21);
    expect(cov.analyzers[0]).toMatchObject({
      id: 'generic-manifests',
      status: 'ok',
      filesAnalyzed: 5,
    });
    expect(
      cov.gaps.find((g) => g.kind === 'unsupported-language' && /typescript/.test(g.detail)),
    ).toBeTruthy();
  });

  it('maps the Python fixture and reports the Elixir fixture as an explicit gap', async () => {
    const py = await scanFixture('py-cli-api');
    expect(
      rows(
        py.db,
        "SELECT display_name FROM entities WHERE snapshot_id = ? AND kind = 'package'",
        py.result.snapshot.id,
      ),
    ).toEqual([{ display_name: 'notekeeper' }]);
    const ex = await scanFixture('elixir-unsupported');
    expect(ex.result.coverage.gaps).toContainEqual(
      expect.objectContaining({ kind: 'unsupported-language', count: 2 }),
    );
    expect(ex.result.coverage.byLanguage).toContainEqual({
      language: 'elixir',
      support: 'inventory-only',
      files: 2,
    });
    expect(ex.result.coverage.byLanguage).toContainEqual({
      language: 'elixir',
      support: 'syntax',
      files: 1,
    });
  });

  it('never modifies scanned fixtures', async () => {
    for (const name of ['ts-web-service', 'py-cli-api', 'elixir-unsupported']) {
      const before = treeFingerprint(fixture(name));
      await scanFixture(name);
      expect(treeFingerprint(fixture(name))).toBe(before);
    }
  });

  it('rescans with stable ids and supersedes the previous snapshot', async () => {
    const { db, worktree, result: first } = await scanFixture('ts-web-service');
    const second = await scanWorktree(db, worktree, { analyzers: [createManifestAnalyzer()] });
    const ids = (s: string) =>
      rows(db, 'SELECT id FROM entities WHERE snapshot_id = ? ORDER BY id', s).map((r) => r.id);
    const relIds = (s: string) =>
      rows(db, 'SELECT id FROM relations WHERE snapshot_id = ? ORDER BY id', s).map((r) => r.id);
    expect(ids(second.snapshot.id)).toEqual(ids(first.snapshot.id));
    expect(relIds(second.snapshot.id)).toEqual(relIds(first.snapshot.id));
    expect(second.snapshot.dirtyTreeDigest).toBe(first.snapshot.dirtyTreeDigest);
    expect(
      db
        .prepare('SELECT state FROM snapshots WHERE id = ?')
        .get<{ state: string }>(first.snapshot.id)!.state,
    ).toBe('superseded');
    expect(getLatestSnapshot(db, worktree.id)?.snapshot.id).toBe(second.snapshot.id);
    const firstSeen = rows(
      db,
      'SELECT DISTINCT first_seen_snapshot AS f FROM entities WHERE snapshot_id = ?',
      second.snapshot.id,
    );
    expect(firstSeen).toEqual([{ f: first.snapshot.id }]);
  });
});

function tempProject(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-scan-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

const pkgFiles = {
  'package.json': '{"name":"root","workspaces":["a"]}',
  'a/package.json': '{"name":"a"}',
};

describe('TS declaration files and non-source roles', () => {
  it('treats .d.ts and infra-role TypeScript as covered, not unsupported', async () => {
    const root = tempProject({
      'package.json': '{"name":"x"}',
      'src/a.ts': 'export const a = 1;',
      'src/types.d.ts': 'declare const x: number;',
      'infra/stack.ts': 'export const s = 1;',
    });
    const db = freshDb();
    const { worktree } = await registerRoot(db, root);
    const r = await scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
    expect(r.coverage.gaps.filter((g) => g.kind === 'unsupported-language')).toEqual([]);
    expect(r.coverage.byLanguage).toContainEqual({
      language: 'typescript',
      support: 'syntax',
      files: 1,
    });
    expect(r.coverage.byLanguage).toContainEqual({
      language: 'typescript',
      support: 'deep',
      files: 2,
    });
  });
});

describe('scan failure handling', () => {
  it('carries a failing analyzer’s previous facts forward as stale instead of erasing them', async () => {
    const db = freshDb();
    const { worktree } = await registerRoot(db, tempProject(pkgFiles));
    const good = createManifestAnalyzer();
    const first = await scanWorktree(db, worktree, { analyzers: [good] });
    const broken: Analyzer = { ...good, extract: async () => Promise.reject(new Error('boom')) };
    const second = await scanWorktree(db, worktree, { analyzers: [broken] });
    expect(second.snapshot.state).toBe('partial');
    expect(second.counts.carriedForward).toBeGreaterThan(0);
    const lifecycles = rows(
      db,
      "SELECT lifecycle FROM entities WHERE snapshot_id = ? AND kind = 'package'",
      second.snapshot.id,
    );
    expect(lifecycles).toEqual([{ lifecycle: 'stale' }, { lifecycle: 'stale' }]);
    const relStatus = rows(
      db,
      'SELECT DISTINCT status FROM relations WHERE snapshot_id = ?',
      second.snapshot.id,
    );
    expect(relStatus).toEqual([{ status: 'stale' }]);
    expect(second.coverage.gaps).toContainEqual(
      expect.objectContaining({ kind: 'analyzer-failed', analyzerId: 'generic-manifests' }),
    );
    expect(
      rows(db, 'SELECT count(*) AS n FROM entities WHERE snapshot_id = ?', first.snapshot.id),
    ).toEqual([{ n: 3 }]);
  });

  it('marks the snapshot partial when a file changes between hashing and parsing', async () => {
    const root = tempProject(pkgFiles);
    const db = freshDb();
    const { worktree } = await registerRoot(db, root);
    const base = createManifestAnalyzer();
    const racing: Analyzer = {
      ...base,
      async extract(files, ctx) {
        writeFileSync(join(root, 'a/package.json'), '{"name":"a-renamed"}');
        return base.extract(files, ctx);
      },
    };
    const r = await scanWorktree(db, worktree, { analyzers: [racing] });
    expect(r.snapshot.state).toBe('partial');
    expect(r.coverage.gaps).toContainEqual(
      expect.objectContaining({ kind: 'changed-during-scan', path: 'a/package.json' }),
    );
    // nothing cites the bytes that were never parsed
    expect(
      rows(
        db,
        "SELECT count(*) AS n FROM entities WHERE snapshot_id = ? AND display_name = 'a-renamed'",
        r.snapshot.id,
      ),
    ).toEqual([{ n: 0 }]);
  });

  it('times out hung analyzers and keeps the scan', async () => {
    const db = freshDb();
    const { worktree } = await registerRoot(db, tempProject(pkgFiles));
    const hung: Analyzer = {
      ...createManifestAnalyzer(),
      id: 'hung',
      extract: () => new Promise(() => {}),
    };
    const r = await scanWorktree(db, worktree, {
      analyzers: [hung, createManifestAnalyzer()],
      analyzerTimeoutMs: 50,
    });
    expect(r.snapshot.state).toBe('partial');
    expect(r.coverage.gaps).toContainEqual(
      expect.objectContaining({ kind: 'analyzer-timeout', analyzerId: 'hung' }),
    );
    expect(r.counts.entities).toBe(3);
  });

  it('leaves the previous snapshot current when a scan is cancelled', async () => {
    const db = freshDb();
    const { worktree } = await registerRoot(db, tempProject(pkgFiles));
    const first = await scanWorktree(db, worktree, { analyzers: [createManifestAnalyzer()] });
    const ctrl = new AbortController();
    const slow: Analyzer = {
      ...createManifestAnalyzer(),
      extract: () =>
        new Promise((res) =>
          setTimeout(() => res({ entities: [], relations: [], diagnostics: [], handled: [] }), 200),
        ),
    };
    const p = scanWorktree(db, worktree, { analyzers: [slow], signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new Error('superseded')), 20);
    await expect(p).rejects.toThrow('superseded');
    expect(getLatestSnapshot(db, worktree.id)?.snapshot.id).toBe(first.snapshot.id);
    expect(rows(db, "SELECT count(*) AS n FROM snapshots WHERE state = 'failed'")).toEqual([
      { n: 1 },
    ]);
  });

  it('records git HEAD and dirtiness on the snapshot', async () => {
    const root = tempProject(pkgFiles);
    const g = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], {
        cwd: root,
        stdio: 'pipe',
      });
    g('init', '-q');
    g('add', '.');
    g('commit', '-q', '-m', 'i');
    const db = freshDb();
    const { worktree } = await registerRoot(db, root);
    const clean = await scanWorktree(db, worktree, { analyzers: [createManifestAnalyzer()] });
    expect(clean.snapshot).toMatchObject({ dirty: false });
    expect(clean.snapshot.headCommit).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(root, 'a/package.json'), '{"name":"a2"}');
    const dirty = await scanWorktree(db, worktree, { analyzers: [createManifestAnalyzer()] });
    expect(dirty.snapshot).toMatchObject({ dirty: true, headCommit: clean.snapshot.headCommit });
    expect(dirty.snapshot.dirtyTreeDigest).not.toBe(clean.snapshot.dirtyTreeDigest);
  });
});
