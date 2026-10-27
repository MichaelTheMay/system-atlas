import { appendFileSync, cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnalyzers } from '@atlas/analyzers';
import {
  listProposals,
  proposeClaims,
  registerRoot,
  rejectClaim,
  scanWorktree,
  searchEntities,
} from '../src/index.ts';
import { fixture, freshDb } from './helpers.ts';

const meta = {
  provider: 'mcp-client',
  model: 'test-agent',
  promptTemplateVersion: 'agent-authored',
};

async function setup(db = freshDb(), name = 'ts-web-service') {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-prop-')), name);
  cpSync(fixture(name), root, { recursive: true });
  const { worktree, project } = await registerRoot(db, root);
  const scan = () => scanWorktree(db, worktree, { analyzers: defaultAnalyzers() });
  const first = await scan();
  const anyModule = db
    .prepare(
      "SELECT id FROM entities WHERE snapshot_id = ? AND kind = 'module' ORDER BY id LIMIT 1",
    )
    .get<{ id: string }>(first.snapshot.id)!;
  const dbModule =
    searchEntities(db, first.snapshot.id, 'db', { kind: 'module' }).find(
      (h) => h.path === 'packages/api/src/db.ts',
    ) ?? anyModule;
  const server =
    searchEntities(db, first.snapshot.id, 'server', { kind: 'module' }).find(
      (h) => h.path === 'packages/api/src/server.ts',
    ) ?? anyModule;
  const evidenceIds = (
    JSON.parse(
      db
        .prepare('SELECT attributes FROM entities WHERE snapshot_id = ? AND id = ?')
        .get<{ attributes: string }>(first.snapshot.id, dbModule.id)!.attributes,
    ) as { evidenceIds: string[] }
  ).evidenceIds;
  const line1 =
    name === 'ts-web-service'
      ? readFileSync(join(root, 'packages/api/src/db.ts'), 'utf8').split('\n')[0]!
      : '';
  return {
    db,
    root,
    project,
    scan,
    snapshotId: first.snapshot.id,
    dbId: dbModule.id,
    serverId: server.id,
    evidenceIds,
    line1,
  };
}

const count = (db: ReturnType<typeof freshDb>, sql: string, ...a: string[]) =>
  db.prepare(sql).get<{ n: number }>(...a)!.n;

describe('claim proposals', () => {
  it('stores cited model claims as inferred, never as supported facts or relations', async () => {
    const t = await setup();
    const relationsBefore = count(
      t.db,
      'SELECT count(*) AS n FROM relations WHERE snapshot_id = ?',
      t.snapshotId,
    );
    const r = await proposeClaims(t.db, {
      snapshotId: t.snapshotId,
      origin: 'model',
      modelMetadata: meta,
      claims: [
        {
          subjectId: t.dbId,
          predicate: 'summary',
          value: 'Persists reports in Postgres.',
          citations: [{ path: 'packages/api/src/db.ts', startLine: 1, endLine: 2, quote: t.line1 }],
        },
        {
          subjectId: t.dbId,
          predicate: 'role',
          value: 'storage',
          citations: [{ evidenceId: t.evidenceIds[0] }],
        },
        {
          subjectId: t.serverId,
          predicate: 'depends-on',
          value: { entityId: t.dbId, reason: 'stores what it serves' },
          citations: [{ path: 'packages/api/src/server.ts', startLine: 1, endLine: 1 }],
        },
      ],
    });
    expect(r).toMatchObject({ ok: true, rejected: [] });
    expect(r.ok && r.accepted.map((a) => a.status)).toEqual(['inferred', 'inferred', 'inferred']);
    expect(
      count(
        t.db,
        "SELECT count(*) AS n FROM claims WHERE snapshot_id = ? AND origin = 'model' AND status = 'inferred'",
        t.snapshotId,
      ),
    ).toBe(3);
    expect(
      count(t.db, 'SELECT count(*) AS n FROM relations WHERE snapshot_id = ?', t.snapshotId),
    ).toBe(relationsBefore);
    const ev = t.db
      .prepare("SELECT path, content_hash FROM evidence WHERE body LIKE '%model-citation%'")
      .all<{ path: string; content_hash: string }>();
    expect(ev).toEqual([
      expect.objectContaining({ path: 'packages/api/src/db.ts' }),
      expect.objectContaining({ path: 'packages/api/src/server.ts' }),
    ]);
    // people citing evidence make supported claims
    const human = await proposeClaims(t.db, {
      snapshotId: t.snapshotId,
      origin: 'human',
      claims: [
        {
          subjectId: t.dbId,
          predicate: 'concern',
          value: 'no retries on insert',
          citations: [{ path: 'packages/api/src/db.ts', startLine: 1, endLine: 1 }],
        },
      ],
    });
    expect(human.ok && human.accepted[0]!.status).toBe('supported');
  });

  it('rejects invented or mismatched evidence with a reason and writes nothing for it', async () => {
    const t = await setup();
    const other = await setup(t.db, 'py-cli-api');
    appendFileSync(join(t.root, 'packages/api/src/server.ts'), '\n// edited after the snapshot\n');
    const cases: [string, object, RegExp][] = [
      [
        'unknown evidence id',
        { evidenceId: `evd_${'0'.repeat(32)}` },
        /does not exist in this project/,
      ],
      [
        "another project's evidence",
        { evidenceId: other.evidenceIds[0] },
        /does not exist in this project/,
      ],
      [
        'path not in the snapshot',
        { path: 'packages/api/src/invented.ts', startLine: 1, endLine: 2 },
        /not part of this snapshot/,
      ],
      [
        'lines past the end',
        { path: 'packages/api/src/db.ts', startLine: 1, endLine: 150 },
        /has \d+ lines/,
      ],
      [
        'quote not at those lines',
        { path: 'packages/api/src/db.ts', startLine: 1, endLine: 2, quote: 'DROP TABLE users' },
        /quote does not appear/,
      ],
      [
        'file edited after the snapshot',
        { path: 'packages/api/src/server.ts', startLine: 1, endLine: 1 },
        /changed since the snapshot/,
      ],
    ];
    const claimsBefore = count(t.db, 'SELECT count(*) AS n FROM claims');
    const r = await proposeClaims(t.db, {
      snapshotId: t.snapshotId,
      origin: 'model',
      modelMetadata: meta,
      claims: [
        ...cases.map(([, citation]) => ({
          subjectId: t.dbId,
          predicate: 'summary',
          value: 'x',
          citations: [citation],
        })),
        {
          subjectId: `ent_${'f'.repeat(32)}`,
          predicate: 'summary',
          value: 'x',
          citations: [{ evidenceId: t.evidenceIds[0] }],
        },
        { subjectId: t.dbId, predicate: 'summary', value: 'uncited' },
        {
          subjectId: t.dbId,
          predicate: 'depends-on',
          value: { entityId: `ent_${'e'.repeat(32)}`, reason: 'x' },
          citations: [{ evidenceId: t.evidenceIds[0] }],
        },
        {
          subjectId: t.dbId,
          predicate: 'role',
          value: 'database-wizard',
          citations: [{ evidenceId: t.evidenceIds[0] }],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accepted).toEqual([]);
    cases.forEach(([name, , reason], i) =>
      expect(r.rejected[i]!.reasons.join(' '), name).toMatch(reason),
    );
    expect(r.rejected[6]!.reasons.join(' ')).toMatch(/subject .* does not exist/);
    expect(r.rejected[7]!.reasons.join(' ')).toMatch(/must cite evidence/);
    expect(r.rejected[8]!.reasons.join(' ')).toMatch(/target .* does not exist/);
    expect(r.rejected[9]!.reasons.join(' ')).toMatch(/value for "role"/);
    expect(count(t.db, 'SELECT count(*) AS n FROM claims')).toBe(claimsBefore);
    // rejected items stay inspectable with their reasons
    const audit = listProposals(t.db, t.project.id);
    expect(audit[0]).toMatchObject({ kind: 'claims', accepted: 0, rejected: 10 });
    // shape errors and missing metadata are refused outright
    expect(
      await proposeClaims(t.db, {
        snapshotId: t.snapshotId,
        origin: 'model',
        modelMetadata: meta,
        claims: [{ subjectId: t.dbId, predicate: 'kind', value: 'database', citations: [] }],
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await proposeClaims(t.db, {
        snapshotId: t.snapshotId,
        origin: 'model',
        claims: [
          {
            subjectId: t.dbId,
            predicate: 'summary',
            value: 'x',
            citations: [{ evidenceId: t.evidenceIds[0] }],
          },
        ],
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a stale snapshot precondition', async () => {
    const t = await setup();
    appendFileSync(join(t.root, 'NOTES.md'), 'changed');
    const next = await t.scan();
    expect(next.noop).toBeUndefined();
    const r = await proposeClaims(t.db, {
      snapshotId: t.snapshotId,
      origin: 'model',
      modelMetadata: meta,
      claims: [
        {
          subjectId: t.dbId,
          predicate: 'summary',
          value: 'x',
          citations: [{ evidenceId: t.evidenceIds[0] }],
        },
      ],
    });
    expect(r).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringMatching(/stale_precondition/),
    });
  });

  it('invalidates inference when its cited file changes; a human rejection survives later snapshots', async () => {
    const t = await setup();
    const r = await proposeClaims(t.db, {
      snapshotId: t.snapshotId,
      origin: 'model',
      modelMetadata: meta,
      claims: [
        {
          subjectId: t.dbId,
          predicate: 'summary',
          value: 'Persists reports.',
          citations: [{ path: 'packages/api/src/db.ts', startLine: 1, endLine: 1 }],
        },
        {
          subjectId: t.serverId,
          predicate: 'role',
          value: 'api',
          citations: [{ path: 'packages/api/src/server.ts', startLine: 1, endLine: 1 }],
        },
      ],
    });
    if (!r.ok) throw new Error(r.error);
    const [cited, other] = r.accepted;
    expect(rejectClaim(t.db, other!.claimId, 'wrong role')).toEqual({ ok: true });
    appendFileSync(join(t.root, 'packages/api/src/db.ts'), '\nexport const extra = 1;\n');
    const next = await t.scan();
    expect(next.noop).toBeUndefined();
    const status = (id: string) =>
      t.db
        .prepare('SELECT status FROM claims WHERE snapshot_id = ? AND id = ?')
        .get<{ status: string }>(next.snapshot.id, id)?.status;
    expect(status(cited!.claimId)).toBe('stale');
    expect(status(other!.claimId)).toBe('rejected');
    expect(listProposals(t.db, t.project.id)[0]).toMatchObject({ kind: 'review', origin: 'human' });
  });
});
