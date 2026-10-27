import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  appendEvents,
  bindRunsToSnapshot,
  correlateRun,
  createRun,
  finishRun,
  FinishRunInput,
  getArtifact,
  getRunDetail,
  listRuns,
  markArtifactMissing,
  reopenImportedRun,
  reserveArtifact,
  runTokenMatches,
  uploadArtifactBytes,
  type ObjectStore,
} from '@atlas/evidence';
import { currentTreeDigest, getLatestSnapshot, getWorktree, registerRoot } from '@atlas/graph';
import type { Db } from '@atlas/store';
import type { EventBus } from '../events.ts';
import type { JobRunner } from '../jobs.ts';
import { tokenMatches } from '../security.ts';

/** Run-scoped ingestion endpoints accept the run's own token instead of the daemon token. */
export const RUN_SCOPED = [
  /^\/api\/v1\/runs\/(run_[0-9a-f]+)\/(events|artifacts|finish)$/,
  /^\/api\/v1\/artifacts\/(art_[0-9a-f]+)\/(content|missing)$/,
];

export function runScopedTarget(url: string): { kind: 'run' | 'artifact'; id: string } | undefined {
  const path = url.split('?')[0]!;
  for (const [i, re] of RUN_SCOPED.entries()) {
    const m = re.exec(path);
    if (m) return { kind: i === 0 ? 'run' : 'artifact', id: m[1]! };
  }
  return undefined;
}

const CreateRunBody = z.object({
  rootPath: z.string().refine(isAbsolute, 'rootPath must be absolute').optional(),
  worktreeId: z.string().optional(),
  adapter: z.string().min(1).max(100),
  commandSummary: z.string().max(2000).optional(),
  environmentSummary: z.record(z.string(), z.unknown()).optional(),
  instrumentationCapabilities: z.array(z.string()).max(50).optional(),
  captureGaps: z
    .array(z.object({ kind: z.string(), detail: z.string() }))
    .max(100)
    .optional(),
  /** Snapshot the current tree before returning, so the run binds before the command changes it. */
  waitForSnapshot: z.boolean().optional(),
  /**
   * `none` for imported evidence: it did not run against the current tree, so it is never bound to
   * a snapshot (a capture gap says so) and no scan is started.
   */
  binding: z.enum(['current-tree', 'none']).default('current-tree'),
  externalRef: z.string().min(1).max(300).optional(),
  startAt: z.iso.datetime({ offset: true }).optional(),
});

export function registerRunRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    objects: ObjectStore;
    bus: EventBus;
    jobs: JobRunner;
    token: string;
    previewUrl(artifactId: string, kind: 'a' | 'v'): { url: string; expiresAt: string };
  },
) {
  const { db, objects, bus, jobs } = deps;
  const prefix = '/api/v1';

  /** Either the daemon token or the run's own token for the run that owns the target. */
  const authorizedFor = (headers: Record<string, unknown>, runId: string) =>
    tokenMatches(headers.authorization as string | undefined, deps.token) ||
    runTokenMatches(db, runId, headers['x-atlas-run-token'] as string | undefined);

  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  app.post(`${prefix}/runs`, async (req, reply) => {
    const body = CreateRunBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    const b = body.data;
    let worktree = b.worktreeId ? getWorktree(db, b.worktreeId) : undefined;
    if (!worktree && b.rootPath) worktree = (await registerRoot(db, b.rootPath)).worktree;
    if (!worktree) return reply.code(400).send({ error: 'rootPath or worktreeId required' });

    if (b.externalRef) {
      const again = reopenImportedRun(db, worktree.projectId, b.externalRef);
      if (again)
        return reply
          .code(200)
          .send({ ...again, snapshotBound: !!again.run.snapshotId, existing: true });
    }
    if (b.binding === 'none') {
      const { run, ingestToken } = createRun(db, {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        adapter: b.adapter,
        commandSummary: b.commandSummary,
        environmentSummary: (b.environmentSummary ?? {}) as never,
        instrumentationCapabilities: b.instrumentationCapabilities,
        captureGaps: [
          ...(b.captureGaps ?? []),
          {
            kind: 'imported',
            detail:
              'imported evidence: the source tree it ran against is unknown, so it is not linked to a snapshot',
          },
        ],
        startAt: b.startAt,
        externalRef: b.externalRef,
      });
      bus.publish({
        type: 'run.started',
        data: { runId: run.id, projectId: run.projectId, worktreeId: worktree.id },
      });
      return reply.code(201).send({ run, ingestToken, snapshotBound: false, existing: false });
    }

    // Bind the run to the snapshot of exactly the tree it runs against; otherwise scan that tree and
    // bind when a snapshot with the same digest is published (never to a different dirty tree).
    const digest = await currentTreeDigest(worktree.rootPath);
    let latest = getLatestSnapshot(db, worktree.id);
    let matches = latest?.snapshot.dirtyTreeDigest === digest;
    const gaps = [...(b.captureGaps ?? [])];
    if (!matches && b.waitForSnapshot) {
      // the command may write into the tree (outputs), so snapshot it *before* the run starts
      const job = jobs.enqueueScan(worktree);
      await jobs.wait(job.id);
      latest = getLatestSnapshot(db, worktree.id);
      matches = latest?.snapshot.dirtyTreeDigest === digest;
      if (!matches) {
        gaps.push({
          kind: 'source-not-snapshotted',
          detail:
            'the tree changed while it was being snapshotted; this run is not bound to a snapshot',
        });
      }
    }
    const { run, ingestToken } = createRun(db, {
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      snapshotId: matches ? latest!.snapshot.id : undefined,
      sourceManifestDigest: digest,
      adapter: b.adapter,
      commandSummary: b.commandSummary,
      environmentSummary: (b.environmentSummary ?? {}) as never,
      instrumentationCapabilities: b.instrumentationCapabilities,
      captureGaps: gaps,
      startAt: b.startAt,
      externalRef: b.externalRef,
    });
    if (!matches && !b.waitForSnapshot) jobs.enqueueScan(worktree);
    bus.publish({
      type: 'run.started',
      data: { runId: run.id, projectId: run.projectId, worktreeId: worktree.id },
    });
    return reply.code(201).send({ run, ingestToken, snapshotBound: matches });
  });

  app.post<{ Params: { id: string } }>(`${prefix}/runs/:id/events`, async (req, reply) => {
    if (!authorizedFor(req.headers, req.params.id))
      return reply.code(401).send({ error: 'unauthorized' });
    const events = Array.isArray(req.body)
      ? req.body
      : (req.body as { events?: unknown[] })?.events;
    if (!Array.isArray(events))
      return reply.code(400).send({ error: 'expected an array of events' });
    try {
      const r = appendEvents(db, req.params.id, events);
      if (r.accepted.length)
        bus.publish({
          type: 'run.updated',
          data: { runId: req.params.id, events: r.accepted.length },
        });
      return reply
        .code(r.rejected.length && !r.accepted.length && !r.duplicates.length ? 400 : 200)
        .send(r);
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg === 'unknown_run' ? 404 : 400).send({ error: msg });
    }
  });

  app.post<{ Params: { id: string } }>(`${prefix}/runs/:id/artifacts`, async (req, reply) => {
    if (!authorizedFor(req.headers, req.params.id))
      return reply.code(401).send({ error: 'unauthorized' });
    try {
      const r = reserveArtifact(db, objects, req.params.id, req.body as never);
      return reply.code(201).send({
        ...r,
        uploadPath: r.uploadRequired ? `${prefix}/artifacts/${r.artifact.id}/content` : undefined,
      });
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg === 'unknown_run' ? 404 : 400).send({ error: msg.slice(0, 300) });
    }
  });

  app.put<{ Params: { id: string } }>(`${prefix}/artifacts/:id/content`, async (req, reply) => {
    const a = getArtifact(db, req.params.id);
    if (!a) return reply.code(404).send({ error: 'unknown_artifact' });
    if (!authorizedFor(req.headers, a.runId))
      return reply.code(401).send({ error: 'unauthorized' });
    if (!(req.body && typeof (req.body as NodeJS.ReadableStream).pipe === 'function'))
      return reply.code(415).send({ error: 'send bytes as application/octet-stream' });
    try {
      const done = await uploadArtifactBytes(db, objects, a.id, req.body as never);
      bus.publish({ type: 'run.updated', data: { runId: a.runId, artifactId: a.id } });
      return done;
    } catch (e) {
      const code = (e as { code?: string }).code;
      return reply
        .code(
          code === 'TOO_LARGE'
            ? 413
            : code === 'HASH_MISMATCH' || code === 'SIZE_MISMATCH'
              ? 422
              : 400,
        )
        .send({ error: (e as Error).message.slice(0, 300), artifact: getArtifact(db, a.id) });
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    `${prefix}/artifacts/:id/missing`,
    async (req, reply) => {
      const a = getArtifact(db, req.params.id);
      if (!a) return reply.code(404).send({ error: 'unknown_artifact' });
      if (!authorizedFor(req.headers, a.runId))
        return reply.code(401).send({ error: 'unauthorized' });
      return markArtifactMissing(db, a.id, String(req.body?.reason ?? 'not captured'));
    },
  );

  app.post<{ Params: { id: string } }>(`${prefix}/runs/:id/finish`, async (req, reply) => {
    if (!authorizedFor(req.headers, req.params.id))
      return reply.code(401).send({ error: 'unauthorized' });
    const body = FinishRunInput.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    const r = finishRun(db, req.params.id, body.data);
    if (!r.ok) return reply.code(r.error === 'unknown_run' ? 404 : 409).send({ error: r.error });
    correlateRun(db, r.run.id);
    bus.publish({
      type: 'run.finished',
      data: { runId: r.run.id, status: r.run.status, projectId: r.run.projectId },
    });
    return r.run;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    `${prefix}/projects/:id/runs`,
    async (req) => ({ runs: listRuns(db, req.params.id, Number(req.query.limit ?? 50) || 50) }),
  );

  app.get<{ Params: { id: string } }>(`${prefix}/runs/:id`, async (req, reply) => {
    const d = getRunDetail(db, req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown_run' });
    // linked components, named from the run's own snapshot (not whatever is current)
    const ent = db.prepare(
      'SELECT display_name AS displayName, kind, canonical_name AS canonicalName FROM entities WHERE snapshot_id = ? AND id = ?',
    );
    const links = d.correlations.map((c) => ({
      ...c,
      entity: d.run.snapshotId
        ? (ent.get<{ displayName: string; kind: string; canonicalName: string }>(
            d.run.snapshotId,
            c.entityId,
          ) ?? null)
        : null,
    }));
    return { ...d, links };
  });

  app.get<{ Params: { id: string } }>(`${prefix}/artifacts/:id`, async (req, reply) => {
    const a = getArtifact(db, req.params.id);
    return a ?? reply.code(404).send({ error: 'unknown_artifact' });
  });

  app.get<{ Params: { id: string } }>(`${prefix}/artifacts/:id/preview-url`, async (req, reply) => {
    const a = getArtifact(db, req.params.id);
    if (!a) return reply.code(404).send({ error: 'unknown_artifact' });
    if (a.bytesState !== 'available')
      return reply.code(409).send({ error: `bytes ${a.bytesState}`, artifact: a });
    const textLike = /^(application\/json|text\/(csv|plain|markdown))$/.test(a.mediaType);
    return {
      artifact: a,
      viewer: textLike ? 'text' : 'raw',
      ...deps.previewUrl(a.id, textLike ? 'v' : 'a'),
    };
  });

  return {
    /** Called after a snapshot is published: bind runs that executed against exactly that tree. */
    onSnapshotPublished(s: { id: string; worktreeId: string; dirtyTreeDigest: string }) {
      const n = bindRunsToSnapshot(db, s);
      // runs that just gained a snapshot can now be linked to its entities
      for (const r of db
        .prepare("SELECT id FROM runs WHERE snapshot_id = ? AND status != 'running'")
        .all<{ id: string }>(s.id))
        correlateRun(db, r.id);
      if (n) bus.publish({ type: 'run.updated', data: { boundToSnapshot: s.id, runs: n } });
    },
  };
}
