import type { FastifyInstance } from 'fastify';
import type { DesignJobs } from '../design-jobs.ts';

/** Design-agent settings and jobs (D02c). Jobs start only from an explicit POST. */
export function registerDesignJobRoutes(app: FastifyInstance, jobs: DesignJobs) {
  const prefix = '/api/v1';

  app.get(`${prefix}/settings/design-agent`, async () => jobs.settingsView());

  /** `{ runtime?, model?, consent?, apiKey? }`; the key goes to the 0600 secrets file and is never echoed. */
  app.put(`${prefix}/settings/design-agent`, async (req, reply) => {
    const r = await jobs.setSettings(req.body);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return jobs.settingsView();
  });

  app.get<{
    Params: { id: string };
    Querystring: { depth?: string; runtime?: string; snapshotId?: string };
  }>(`${prefix}/projects/:id/design/jobs/estimate`, async (req, reply) => {
    const r = jobs.estimate(req.params.id, {
      depth: req.query.depth ? Number(req.query.depth) : undefined,
      runtime: req.query.runtime,
      snapshotId:
        req.query.snapshotId && /^snap_[0-9a-f]{16,64}$/.test(req.query.snapshotId)
          ? req.query.snapshotId
          : undefined,
    });
    return r.ok ? r.body : reply.code(r.status).send({ error: r.error });
  });

  /** Subsystem/responsibility claims of a snapshot (review sheet and copilot; D02b). */
  app.get<{ Params: { id: string } }>(
    `${prefix}/snapshots/:id/design/claims`,
    async (req, reply) => {
      if (!/^snap_[0-9a-f]{16,64}$/.test(req.params.id))
        return reply.code(404).send({ error: 'unknown_snapshot' });
      return { snapshotId: req.params.id, claims: jobs.designClaims(req.params.id) };
    },
  );

  app.post<{ Params: { id: string } }>(`${prefix}/projects/:id/design/jobs`, async (req, reply) => {
    const r = await jobs.start(req.params.id, req.body);
    if (!r.ok) return reply.code(r.status).send({ error: r.error, detail: r.detail });
    return reply.code(202).send(r.job);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    `${prefix}/projects/:id/design/jobs`,
    async (req) => ({ jobs: jobs.list(req.params.id, Number(req.query.limit) || 20) }),
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    `${prefix}/projects/:id/design/jobs/:jobId`,
    async (req, reply) =>
      jobs.get(req.params.id, req.params.jobId) ?? reply.code(404).send({ error: 'unknown_job' }),
  );

  app.delete<{ Params: { id: string; jobId: string } }>(
    `${prefix}/projects/:id/design/jobs/:jobId`,
    async (req, reply) => {
      const r = jobs.cancel(req.params.id, req.params.jobId);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return reply.code(202).send(r.job);
    },
  );
}
