import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  Artifact,
  ArtifactRole,
  Assertion,
  Event,
  EventType,
  JsonObject,
  newId,
  redactValue,
  Run,
  RunStatus,
  type Correlation,
} from '@atlas/schema';
import { json, type Db } from '@atlas/store';
import type { ObjectStore } from './objects.ts';
import { sniffMediaType } from './sniff.ts';

export const LIMITS = {
  maxArtifactBytes: 100 * 1024 * 1024,
  maxEventsPerBatch: 1000,
  maxPayloadBytes: 256 * 1024,
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- runs ----------------------------------------------------------------------------------

export const CreateRunInput = z.object({
  projectId: z.string(),
  worktreeId: z.string().optional(),
  snapshotId: z.string().optional(),
  sourceManifestDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  adapter: z.string().min(1).max(100),
  commandSummary: z.string().max(2000).optional(),
  environmentSummary: JsonObject.default({}),
  instrumentationCapabilities: z.array(z.string().max(100)).max(50).default([]),
  captureGaps: z
    .array(z.object({ kind: z.string().max(100), detail: z.string().max(1000) }))
    .max(100)
    .default([]),
  startAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateRunInput = z.input<typeof CreateRunInput>;

/** Create a run and its scoped ingestion token (returned once; only its hash is stored). */
export function createRun(db: Db, input: CreateRunInput): { run: Run; ingestToken: string } {
  const i = CreateRunInput.parse(input);
  const env = redactValue(i.environmentSummary);
  const run = Run.parse({
    schemaVersion: 1,
    id: newId('run'),
    projectId: i.projectId,
    worktreeId: i.worktreeId,
    snapshotId: i.snapshotId,
    sourceManifestDigest: i.sourceManifestDigest,
    adapter: i.adapter,
    commandSummary: i.commandSummary ? redactValue(i.commandSummary).value : undefined,
    startAt: i.startAt ?? new Date().toISOString(),
    status: 'running',
    environmentSummary: env.value,
    instrumentationCapabilities: i.instrumentationCapabilities,
    captureGaps: i.captureGaps,
  });
  const ingestToken = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO runs (id, project_id, worktree_id, snapshot_id, status, start_at, end_at, body, ingest_token_hash, source_manifest_digest, worktree_digest_matched)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.projectId,
    run.worktreeId ?? null,
    run.snapshotId ?? null,
    run.status,
    run.startAt,
    json(run),
    sha(ingestToken),
    run.sourceManifestDigest ?? null,
    run.snapshotId ? 1 : 0,
  );
  return { run, ingestToken };
}

export function runTokenMatches(db: Db, runId: string, token: string | undefined): boolean {
  if (!token) return false;
  const r = db
    .prepare('SELECT ingest_token_hash FROM runs WHERE id = ?')
    .get<{ ingest_token_hash: string | null }>(runId);
  if (!r?.ingest_token_hash) return false;
  const a = Buffer.from(r.ingest_token_hash);
  const b = Buffer.from(sha(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function getRunRecord(db: Db, runId: string): Run | undefined {
  const r = db.prepare('SELECT body FROM runs WHERE id = ?').get<{ body: string }>(runId);
  return r ? Run.parse(JSON.parse(r.body)) : undefined;
}

function saveRun(db: Db, run: Run) {
  db.prepare('UPDATE runs SET status = ?, end_at = ?, snapshot_id = ?, body = ? WHERE id = ?').run(
    run.status,
    run.endAt ?? null,
    run.snapshotId ?? null,
    json(Run.parse(run)),
    run.id,
  );
}

export const FinishRunInput = z.object({
  status: RunStatus.exclude(['running']),
  exitCode: z.number().int().optional(),
  signal: z.string().max(50).optional(),
  endAt: z.iso.datetime({ offset: true }).optional(),
  captureGaps: z
    .array(z.object({ kind: z.string().max(100), detail: z.string().max(1000) }))
    .max(100)
    .optional(),
});

/** Process outcome. Idempotent for the same final status; a late finish after recovery is recorded. */
export function finishRun(
  db: Db,
  runId: string,
  input: z.input<typeof FinishRunInput>,
): { ok: true; run: Run } | { ok: false; error: string } {
  const f = FinishRunInput.parse(input);
  return db.transaction(() => {
    const run = getRunRecord(db, runId);
    if (!run) return { ok: false as const, error: 'unknown_run' };
    if (run.status !== 'running' && run.status !== 'interrupted') {
      if (run.status === f.status) return { ok: true as const, run };
      return { ok: false as const, error: `run already ${run.status}` };
    }
    const gaps = [...run.captureGaps, ...(f.captureGaps ?? [])];
    if (run.status === 'interrupted')
      gaps.push({
        kind: 'late-finish',
        detail: 'finish arrived after the run was marked interrupted by daemon recovery',
      });
    const next: Run = {
      ...run,
      status: f.status,
      exitCode: f.exitCode,
      signal: f.signal,
      endAt: f.endAt ?? new Date().toISOString(),
      captureGaps: gaps,
    };
    saveRun(db, next);
    return { ok: true as const, run: next };
  });
}

/** After a daemon restart, unfinished runs are interrupted, never assumed successful (plan §11). */
export function recoverInterruptedRuns(db: Db): number {
  const rows = db.prepare("SELECT id FROM runs WHERE status = 'running'").all<{ id: string }>();
  for (const r of rows) {
    const run = getRunRecord(db, r.id)!;
    saveRun(db, {
      ...run,
      status: 'interrupted',
      captureGaps: [
        ...run.captureGaps,
        {
          kind: 'interrupted',
          detail: 'daemon restarted while the run was in progress; outcome unknown',
        },
      ],
    });
  }
  return rows.length;
}

/**
 * Bind runs that started on an un-snapshotted tree to a snapshot of exactly that tree. A run is
 * never attached to a snapshot of a different (dirty) tree (plan §9).
 */
export function bindRunsToSnapshot(
  db: Db,
  snapshot: { id: string; worktreeId: string; dirtyTreeDigest: string },
): number {
  const rows = db
    .prepare(
      'SELECT id FROM runs WHERE worktree_id = ? AND snapshot_id IS NULL AND source_manifest_digest = ?',
    )
    .all<{ id: string }>(snapshot.worktreeId, snapshot.dirtyTreeDigest);
  for (const r of rows) {
    const run = getRunRecord(db, r.id)!;
    saveRun(db, { ...run, snapshotId: snapshot.id });
    db.prepare('UPDATE runs SET worktree_digest_matched = 1 WHERE id = ?').run(r.id);
  }
  return rows.length;
}

// ---- events --------------------------------------------------------------------------------

export const EventInput = z.object({
  producerId: z.string().min(1).max(200),
  producerEventId: z.string().min(1).max(200),
  type: EventType,
  occurredAt: z.iso.datetime({ offset: true }),
  sequence: z.number().int().nonnegative().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  parentEventId: z.string().optional(),
  causalEventIds: z.array(z.string()).max(50).default([]),
  entityRefs: z.array(z.string()).max(50).default([]),
  payload: JsonObject.default({}),
  artifactIds: z.array(z.string()).max(50).default([]),
});
export type EventInput = z.input<typeof EventInput>;

export const AssertionPayload = z.object({
  outcome: z.enum(['pass', 'fail', 'unknown']),
  description: z.string().min(1).max(2000),
  source: z.enum(['test', 'human', 'adapter']).default('test'),
  subjectArtifactId: z.string().optional(),
});

export interface AppendResult {
  accepted: { index: number; id: string }[];
  duplicates: { index: number; id: string }[];
  rejected: { index: number; error: string }[];
}

/**
 * Append events (plan §11): validate, redact, dedupe on (producerId, producerEventId). Duplicates
 * and out-of-order deliveries are normal; a duplicate returns the id of the event already stored.
 */
export function appendEvents(db: Db, runId: string, inputs: unknown[]): AppendResult {
  if (inputs.length > LIMITS.maxEventsPerBatch)
    throw new Error(`at most ${LIMITS.maxEventsPerBatch} events per batch`);
  const out: AppendResult = { accepted: [], duplicates: [], rejected: [] };
  const run = getRunRecord(db, runId);
  if (!run) throw new Error('unknown_run');
  db.transaction(() => {
    inputs.forEach((raw, index) => {
      const parsed = EventInput.safeParse(raw);
      if (!parsed.success)
        return out.rejected.push({
          index,
          error: parsed.error.issues[0]?.message ?? 'invalid event',
        });
      const i = parsed.data;
      if (Buffer.byteLength(JSON.stringify(i.payload)) > LIMITS.maxPayloadBytes)
        return out.rejected.push({
          index,
          error: 'payload too large; send large content as an artifact',
        });
      const existing = db
        .prepare('SELECT id FROM events WHERE producer_id = ? AND producer_event_id = ?')
        .get<{ id: string }>(i.producerId, i.producerEventId);
      if (existing) return out.duplicates.push({ index, id: existing.id });
      const red = redactValue(i.payload);
      const ev = Event.safeParse({
        schemaVersion: 1,
        id: newId('event'),
        runId,
        receivedAt: new Date().toISOString(),
        ...i,
        payload: red.redacted ? { ...red.value, _redaction: 'redacted' } : red.value,
      });
      if (!ev.success)
        return out.rejected.push({ index, error: ev.error.issues[0]?.message ?? 'invalid event' });
      const e = ev.data;
      db.prepare(
        `INSERT INTO events (id, producer_id, producer_event_id, run_id, type, occurred_at, received_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        e.id,
        e.producerId,
        e.producerEventId,
        runId,
        e.type,
        e.occurredAt,
        e.receivedAt,
        json(e),
      );
      out.accepted.push({ index, id: e.id });

      if (e.type === 'assertion.result') {
        const a = AssertionPayload.safeParse(e.payload);
        if (a.success) {
          const assertion = Assertion.parse({
            schemaVersion: 1,
            id: newId('assertion'),
            runId,
            eventId: e.id,
            subjectArtifactId: a.data.subjectArtifactId,
            source: a.data.source,
            outcome: a.data.outcome,
            description: a.data.description,
            evidenceIds: [],
          });
          db.prepare(
            'INSERT INTO assertions (id, run_id, outcome, body, event_id) VALUES (?, ?, ?, ?, ?)',
          ).run(assertion.id, runId, assertion.outcome, json(assertion), e.id);
        }
      }
      // explicit entity ids are the strongest correlation (plan §10): record them as supported
      for (const entityId of e.entityRefs) {
        const evidenceId = newId('evidence');
        db.prepare(
          'INSERT INTO evidence (id, project_id, body, path, content_hash, run_id, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)',
        ).run(
          evidenceId,
          run.projectId,
          json({
            schemaVersion: 1,
            id: evidenceId,
            sourceKind: 'runtime-event',
            runId,
            eventId: e.id,
            extractorId: e.producerId,
            extractorVersion: '1',
            capturedAt: e.receivedAt,
            redactionState: 'none',
          }),
          runId,
          e.receivedAt,
        );
        insertCorrelation(db, {
          eventOrArtifactId: e.id,
          entityId,
          method: 'explicit-entity-id',
          evidenceIds: [evidenceId],
          status: 'supported',
        });
      }
    });
  });
  return out;
}

export function insertCorrelation(db: Db, c: Omit<Correlation, 'id' | 'schemaVersion'>) {
  const id = newId('correlation');
  db.prepare(
    'INSERT INTO correlations (id, event_or_artifact_id, entity_id, status, body) VALUES (?, ?, ?, ?, ?)',
  ).run(id, c.eventOrArtifactId, c.entityId, c.status, json({ schemaVersion: 1, id, ...c }));
  return id;
}

// ---- artifacts -----------------------------------------------------------------------------

export const ReserveArtifactInput = z.object({
  logicalName: z.string().min(1).max(500),
  mediaType: z.string().min(1).max(200).default('application/octet-stream'),
  role: ArtifactRole.default('other'),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  byteLength: z.number().int().nonnegative().max(LIMITS.maxArtifactBytes).optional(),
  eventId: z.string().optional(),
  capturedAt: z.iso.datetime({ offset: true }).optional(),
  sourceRevision: z.string().max(100).optional(),
  metadata: JsonObject.default({}),
  retentionClass: z.enum(['ephemeral', 'standard', 'pinned']).default('standard'),
});

/**
 * Reserve an artifact record before its bytes arrive (events may reference pending artifacts). If
 * the declared hash is already stored, the bytes are deduplicated and no upload is required.
 */
export function reserveArtifact(
  db: Db,
  objects: ObjectStore,
  runId: string,
  input: z.input<typeof ReserveArtifactInput>,
): { artifact: Artifact; uploadRequired: boolean } {
  const i = ReserveArtifactInput.parse(input);
  if (!getRunRecord(db, runId)) throw new Error('unknown_run');
  const known =
    i.sha256 && objects.has(i.sha256)
      ? db
          .prepare('SELECT byte_length, sniffed_type FROM objects WHERE sha256 = ?')
          .get<{ byte_length: number; sniffed_type: string }>(i.sha256)
      : undefined;
  const dedupe = !!known && (i.byteLength === undefined || i.byteLength === known.byte_length);
  const meta = redactValue(i.metadata);
  const artifact = Artifact.parse({
    schemaVersion: 1,
    id: newId('artifact'),
    sha256: i.sha256 ?? '0'.repeat(64),
    mediaType: dedupe ? known!.sniffed_type : i.mediaType,
    byteLength: dedupe ? known!.byte_length : (i.byteLength ?? 0),
    localObjectKey: i.sha256 ? `sha256/${i.sha256}` : 'pending',
    runId,
    eventId: i.eventId,
    logicalName: i.logicalName,
    role: i.role,
    capturedAt: i.capturedAt ?? new Date().toISOString(),
    sourceRevision: i.sourceRevision,
    redactionState: meta.redacted ? 'redacted' : 'none',
    previewState: 'none',
    retentionClass: i.retentionClass,
    bytesState: dedupe ? 'available' : 'pending',
    metadata: { ...meta.value, declaredMediaType: i.mediaType },
  });
  db.prepare(
    'INSERT INTO artifacts (id, run_id, sha256, bytes_state, body, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    artifact.id,
    runId,
    artifact.sha256,
    artifact.bytesState,
    json(artifact),
    i.eventId ?? null,
    new Date().toISOString(),
  );
  return { artifact, uploadRequired: !dedupe };
}

export function getArtifact(db: Db, id: string): Artifact | undefined {
  const r = db.prepare('SELECT body FROM artifacts WHERE id = ?').get<{ body: string }>(id);
  return r ? Artifact.parse(JSON.parse(r.body)) : undefined;
}

function saveArtifact(db: Db, a: Artifact) {
  db.prepare('UPDATE artifacts SET sha256 = ?, bytes_state = ?, body = ? WHERE id = ?').run(
    a.sha256,
    a.bytesState,
    json(Artifact.parse(a)),
    a.id,
  );
}

/** Stream bytes for a reserved artifact; verifies declared hash/size and sniffs the real type. */
export async function uploadArtifactBytes(
  db: Db,
  objects: ObjectStore,
  artifactId: string,
  body: Readable,
  maxBytes = LIMITS.maxArtifactBytes,
): Promise<Artifact> {
  const a = getArtifact(db, artifactId);
  if (!a) throw Object.assign(new Error('unknown_artifact'), { code: 'NOT_FOUND' });
  if (a.bytesState === 'available') return a;
  const declaredSha = a.sha256 === '0'.repeat(64) ? undefined : a.sha256;
  const declaredSize =
    (a.metadata as { declaredSize?: number }).declaredSize ?? (a.byteLength || undefined);
  try {
    const put = await objects.put(body, {
      expectedSha256: declaredSha,
      expectedSize: declaredSize,
      maxBytes,
    });
    const sniffed = sniffMediaType(put.head, String(a.metadata.declaredMediaType ?? a.mediaType));
    db.prepare(
      'INSERT OR IGNORE INTO objects (sha256, byte_length, sniffed_type, created_at) VALUES (?, ?, ?, ?)',
    ).run(put.sha256, put.byteLength, sniffed, new Date().toISOString());
    const next: Artifact = {
      ...a,
      sha256: put.sha256,
      byteLength: put.byteLength,
      mediaType: sniffed,
      localObjectKey: `sha256/${put.sha256}`,
      bytesState: 'available',
      metadata: { ...a.metadata, mediaTypeMismatch: sniffed !== a.metadata.declaredMediaType },
    };
    saveArtifact(db, next);
    return next;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // the artifact record stays: its bytes are reported missing instead of disappearing
    saveArtifact(db, {
      ...a,
      bytesState: 'missing',
      metadata: {
        ...a.metadata,
        uploadError: code ?? 'UPLOAD_FAILED',
        uploadErrorDetail: String((e as Error).message).slice(0, 300),
      },
    });
    throw e;
  }
}

/** Record that expected bytes will not arrive (capture failure); shown as missing, never hidden. */
export function markArtifactMissing(
  db: Db,
  artifactId: string,
  reason: string,
): Artifact | undefined {
  const a = getArtifact(db, artifactId);
  if (!a || a.bytesState === 'available') return a;
  const next = {
    ...a,
    bytesState: 'missing' as const,
    metadata: { ...a.metadata, missingReason: reason.slice(0, 500) },
  };
  saveArtifact(db, next);
  return next;
}

// ---- reads ---------------------------------------------------------------------------------

export interface RunSummary {
  run: Run;
  outcome: {
    process: Run['status'];
    task: 'passed' | 'failed' | 'unknown';
    assertions: { pass: number; fail: number; unknown: number };
  };
  counts: { events: number; artifacts: number; missingArtifacts: number; screenshots: number };
}

export function summarizeRun(db: Db, run: Run): RunSummary {
  const a = db
    .prepare('SELECT outcome, count(*) AS n FROM assertions WHERE run_id = ? GROUP BY outcome')
    .all<{ outcome: 'pass' | 'fail' | 'unknown'; n: number }>(run.id);
  const assertions = { pass: 0, fail: 0, unknown: 0 };
  for (const r of a) assertions[r.outcome] = r.n;
  const task =
    assertions.fail > 0
      ? 'failed'
      : assertions.pass > 0 && assertions.unknown === 0
        ? 'passed'
        : 'unknown';
  const events = db
    .prepare('SELECT count(*) AS n FROM events WHERE run_id = ?')
    .get<{ n: number }>(run.id)!.n;
  const arts = db
    .prepare(
      "SELECT count(*) AS n, sum(bytes_state = 'missing') AS missing FROM artifacts WHERE run_id = ?",
    )
    .get<{ n: number; missing: number | null }>(run.id)!;
  const shots = db
    .prepare(
      "SELECT count(*) AS n FROM artifacts WHERE run_id = ? AND json_extract(body, '$.role') = 'screenshot'",
    )
    .get<{ n: number }>(run.id)!.n;
  return {
    run,
    outcome: { process: run.status, task, assertions },
    counts: { events, artifacts: arts.n, missingArtifacts: arts.missing ?? 0, screenshots: shots },
  };
}

export function listRuns(db: Db, projectId: string, limit = 50): RunSummary[] {
  return db
    .prepare('SELECT body FROM runs WHERE project_id = ? ORDER BY start_at DESC, id DESC LIMIT ?')
    .all<{ body: string }>(projectId, Math.min(Math.max(limit, 1), 500))
    .map((r) => summarizeRun(db, Run.parse(JSON.parse(r.body))));
}

export function getRunDetail(db: Db, runId: string) {
  const run = getRunRecord(db, runId);
  if (!run) return undefined;
  const events = db
    .prepare('SELECT body FROM events WHERE run_id = ? ORDER BY seq')
    .all<{ body: string }>(runId)
    .map((r) => Event.parse(JSON.parse(r.body)));
  // order by producer sequence where present (cross-machine timestamps are not trusted for order)
  events.sort(
    (x, y) =>
      (x.sequence ?? Number.MAX_SAFE_INTEGER) - (y.sequence ?? Number.MAX_SAFE_INTEGER) ||
      x.occurredAt.localeCompare(y.occurredAt),
  );
  const ids = new Set(events.map((e) => e.id));
  const missingParents = [
    ...new Set(events.map((e) => e.parentEventId).filter((p): p is string => !!p && !ids.has(p))),
  ];
  const artifacts = db
    .prepare('SELECT body FROM artifacts WHERE run_id = ? ORDER BY created_at, id')
    .all<{ body: string }>(runId)
    .map((r) => Artifact.parse(JSON.parse(r.body)));
  const assertions = db
    .prepare('SELECT body FROM assertions WHERE run_id = ? ORDER BY rowid')
    .all<{ body: string }>(runId)
    .map((r) => Assertion.parse(JSON.parse(r.body)));
  const correlations = db
    .prepare(
      `SELECT body FROM correlations WHERE event_or_artifact_id IN (SELECT id FROM events WHERE run_id = ? UNION SELECT id FROM artifacts WHERE run_id = ? UNION SELECT ?)`,
    )
    .all<{ body: string }>(runId, runId, runId)
    .map((r) => JSON.parse(r.body) as Correlation);
  return { ...summarizeRun(db, run), events, artifacts, assertions, correlations, missingParents };
}
