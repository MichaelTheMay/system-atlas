import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '@atlas/store';
import {
  appendEvents,
  bindRunsToSnapshot,
  createRun,
  finishRun,
  getArtifact,
  getRunDetail,
  markArtifactMissing,
  ObjectStore,
  recoverInterruptedRuns,
  reserveArtifact,
  runTokenMatches,
  summarizeRun,
  uploadArtifactBytes,
} from '../src/index.ts';

let db: Db;
let objects: ObjectStore;
const projectId = `proj_${'1'.repeat(32)}`;
const at = (s: number) => new Date(Date.UTC(2026, 9, 26, 12, 0, s)).toISOString();
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO projects (id, display_name, created_at) VALUES (?, 'p', 'now')").run(
    projectId,
  );
  objects = new ObjectStore(mkdtempSync(join(tmpdir(), 'atlas-obj-')));
});

describe('runs and events', () => {
  it('scopes ingestion with a per-run token stored only as a hash', () => {
    const { run, ingestToken } = createRun(db, { projectId, adapter: 'test' });
    expect(runTokenMatches(db, run.id, ingestToken)).toBe(true);
    expect(runTokenMatches(db, run.id, 'nope')).toBe(false);
    const other = createRun(db, { projectId, adapter: 'test' });
    expect(runTokenMatches(db, other.run.id, ingestToken)).toBe(false);
    const stored = db
      .prepare('SELECT ingest_token_hash FROM runs WHERE id = ?')
      .get<{ ingest_token_hash: string }>(run.id)!.ingest_token_hash;
    expect(stored).not.toContain(ingestToken);
  });

  it('dedupes per producer, rejects invalid events individually and orders by sequence', () => {
    const { run } = createRun(db, { projectId, adapter: 'test' });
    const ev = (id: string, seq: number, extra: object = {}) => ({
      producerId: 'p1',
      producerEventId: id,
      type: 'step.started',
      occurredAt: at(seq),
      sequence: seq,
      ...extra,
    });
    const first = appendEvents(db, run.id, [ev('b', 2), ev('a', 1), { type: 'nonsense' }]);
    expect(first.accepted).toHaveLength(2);
    expect(first.rejected).toEqual([{ index: 2, error: expect.any(String) }]);
    const again = appendEvents(db, run.id, [
      ev('a', 1),
      ev('c', 3, { parentEventId: `evt_${'9'.repeat(32)}` }),
    ]);
    expect(again.duplicates).toEqual([{ index: 0, id: first.accepted[1]!.id }]);
    const detail = getRunDetail(db, run.id)!;
    expect(detail.events.map((e) => e.producerEventId)).toEqual(['a', 'b', 'c']);
    expect(detail.missingParents).toEqual([`evt_${'9'.repeat(32)}`]);
    expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/);
  });

  it('redacts secrets in payloads and records explicit entity correlations', () => {
    const { run } = createRun(db, {
      projectId,
      adapter: 'test',
      environmentSummary: { API_TOKEN: 'abc123456789', cwd: '/x' },
    });
    expect(run.environmentSummary).toEqual({ API_TOKEN: '[REDACTED]', cwd: '/x' });
    const entity = `ent_${'2'.repeat(32)}`;
    appendEvents(db, run.id, [
      {
        producerId: 'p',
        producerEventId: '1',
        type: 'tool.call.requested',
        occurredAt: at(1),
        payload: { url: 'https://u:supersecret@x.example/a', password: 'hunter22' },
        entityRefs: [entity],
      },
    ]);
    const d = getRunDetail(db, run.id)!;
    const payload = d.events[0]!.payload as Record<string, string>;
    expect(JSON.stringify(payload)).not.toContain('supersecret');
    expect(payload.password).toBe('[REDACTED]');
    expect(payload._redaction).toBe('redacted');
    expect(d.correlations).toEqual([
      expect.objectContaining({
        entityId: entity,
        method: 'explicit-entity-id',
        status: 'supported',
      }),
    ]);
  });

  it('keeps task outcome (assertions) separate from process outcome (exit code)', () => {
    const { run } = createRun(db, { projectId, adapter: 'test' });
    appendEvents(db, run.id, [
      {
        producerId: 'p',
        producerEventId: '1',
        type: 'assertion.result',
        occurredAt: at(1),
        payload: { outcome: 'pass', description: 'page loads' },
      },
      {
        producerId: 'p',
        producerEventId: '2',
        type: 'assertion.result',
        occurredAt: at(2),
        payload: { outcome: 'fail', description: 'report has 3 sources' },
      },
    ]);
    const done = finishRun(db, run.id, { status: 'succeeded', exitCode: 0 });
    expect(done.ok).toBe(true);
    const s = summarizeRun(db, done.ok ? done.run : run);
    expect(s.outcome).toEqual({
      process: 'succeeded',
      task: 'failed',
      assertions: { pass: 1, fail: 1, unknown: 0 },
    });
    expect(finishRun(db, run.id, { status: 'succeeded', exitCode: 0 }).ok).toBe(true);
    expect(finishRun(db, run.id, { status: 'failed' })).toEqual({
      ok: false,
      error: 'run already succeeded',
    });
  });

  it('marks unfinished runs interrupted after recovery and records a late finish', () => {
    const { run } = createRun(db, { projectId, adapter: 'test' });
    expect(recoverInterruptedRuns(db)).toBe(1);
    expect(getRunDetail(db, run.id)!.run.status).toBe('interrupted');
    const late = finishRun(db, run.id, { status: 'failed', exitCode: 1 });
    expect(late.ok && late.run.captureGaps.map((g) => g.kind)).toEqual([
      'interrupted',
      'late-finish',
    ]);
  });

  it('binds runs only to a snapshot of the exact tree they ran against', () => {
    const wt = `wt_${'3'.repeat(32)}`;
    const digest = 'a'.repeat(64);
    const { run } = createRun(db, {
      projectId,
      worktreeId: wt,
      adapter: 'process',
      sourceManifestDigest: digest,
    });
    expect(
      bindRunsToSnapshot(db, {
        id: `snap_${'4'.repeat(32)}`,
        worktreeId: wt,
        dirtyTreeDigest: 'b'.repeat(64),
      }),
    ).toBe(0);
    expect(
      bindRunsToSnapshot(db, {
        id: `snap_${'5'.repeat(32)}`,
        worktreeId: wt,
        dirtyTreeDigest: digest,
      }),
    ).toBe(1);
    expect(getRunDetail(db, run.id)!.run.snapshotId).toBe(`snap_${'5'.repeat(32)}`);
  });
});

describe('artifacts', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  it('stores verified bytes content-addressed and dedupes identical content', async () => {
    const { run } = createRun(db, { projectId, adapter: 'test' });
    const { artifact, uploadRequired } = reserveArtifact(db, objects, run.id, {
      logicalName: 'shot.png',
      mediaType: 'image/png',
      role: 'screenshot',
      sha256: sha(png),
      byteLength: png.length,
    });
    expect(uploadRequired).toBe(true);
    expect(artifact.bytesState).toBe('pending');
    const done = await uploadArtifactBytes(db, objects, artifact.id, Readable.from([png]));
    expect(done).toMatchObject({
      bytesState: 'available',
      sha256: sha(png),
      byteLength: png.length,
      mediaType: 'image/png',
    });
    expect(objects.size(sha(png))).toBe(png.length);
    const again = reserveArtifact(db, objects, run.id, {
      logicalName: 'copy.png',
      sha256: sha(png),
      byteLength: png.length,
    });
    expect(again.uploadRequired).toBe(false);
    expect(again.artifact).toMatchObject({ bytesState: 'available', mediaType: 'image/png' });
  });

  it('keeps the record and reports bytes missing on hash mismatch or oversize', async () => {
    const { run } = createRun(db, { projectId, adapter: 'test' });
    const bad = reserveArtifact(db, objects, run.id, {
      logicalName: 'x.bin',
      sha256: 'f'.repeat(64),
    });
    await expect(
      uploadArtifactBytes(
        db,
        objects,
        bad.artifact.id,
        Readable.from([Buffer.from('other bytes')]),
      ),
    ).rejects.toThrow(/hash mismatch/);
    expect(getArtifact(db, bad.artifact.id)).toMatchObject({
      bytesState: 'missing',
      metadata: expect.objectContaining({ uploadError: 'HASH_MISMATCH' }),
    });
    const big = reserveArtifact(db, objects, run.id, { logicalName: 'big.bin' });
    await expect(
      uploadArtifactBytes(db, objects, big.artifact.id, Readable.from([Buffer.alloc(2048)]), 1024),
    ).rejects.toThrow(/exceeds/);
    expect(getArtifact(db, big.artifact.id)?.bytesState).toBe('missing');
    const gone = reserveArtifact(db, objects, run.id, {
      logicalName: 'never.png',
      role: 'screenshot',
    });
    expect(markArtifactMissing(db, gone.artifact.id, 'page closed before capture')).toMatchObject({
      bytesState: 'missing',
    });
    expect(getRunDetail(db, run.id)!.counts.missingArtifacts).toBe(3);
  });

  it('sniffs the real media type instead of trusting the declared one', async () => {
    const { run } = createRun(db, { projectId, adapter: 'test' });
    const r = reserveArtifact(db, objects, run.id, {
      logicalName: 'innocent.png',
      mediaType: 'image/png',
    });
    const a = await uploadArtifactBytes(
      db,
      objects,
      r.artifact.id,
      Readable.from([Buffer.from('<html><script>alert(1)</script></html>')]),
    );
    expect(a.mediaType).toBe('text/html');
    expect(a.metadata.mediaTypeMismatch).toBe(true);
  });
});
