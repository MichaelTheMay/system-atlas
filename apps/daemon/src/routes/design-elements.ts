import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  acceptDesignElement,
  createDesignElement,
  deleteDesignElement,
  getSnapshot,
  groupIntoSubsystem,
  hideDetectedBox,
  listDesignElements,
  patchDesignElement,
  type DesignResult,
} from '@atlas/graph';
import type { Db } from '@atlas/store';
import type { EventBus } from '../events.ts';

const PREFIX = '/api/v1/projects/:id/design';
const PROJECT_RE = /^proj_[0-9a-f]{16,64}$/;
const ELEMENT_RE = /^dsg_[0-9a-f]{16,64}$/;

interface Params {
  id: string;
  elementId?: string;
}

/**
 * User-authored design layer (D02a): whiteboard elements, grouping detected boxes into subsystems
 * (human claims) and hiding detected boxes (suppress overrides). Every write publishes
 * `design.changed`, which moves the project's design catalog revision. Elements created here are
 * always the person's (`author: 'user'`, `status: 'active'`); agent proposals come from design jobs.
 */
export function registerDesignElementRoutes(
  app: FastifyInstance,
  deps: { db: Db; bus: EventBus },
): void {
  const { db, bus } = deps;
  const projectExists = (id: string) =>
    PROJECT_RE.test(id) && !!db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(id);
  const changed = (projectId: string, action: string, ids: string[] = []) =>
    bus.publish({ type: 'design.changed', data: { projectId, action, elementIds: ids } });
  const fail = (reply: FastifyReply, r: Extract<DesignResult<object>, { ok: false }>) =>
    reply.code(r.status).send({ error: r.error, ...(r.current ? { current: r.current } : {}) });
  /** 404s an unknown project or a malformed element id; returns true when the request may go on. */
  const guard = (p: Params, reply: FastifyReply): boolean => {
    if (!projectExists(p.id)) {
      void reply.code(404).send({ error: 'unknown_project' });
      return false;
    }
    if (p.elementId !== undefined && !ELEMENT_RE.test(p.elementId)) {
      void reply.code(404).send({ error: 'unknown_design_element' });
      return false;
    }
    return true;
  };
  const revisionOf = (raw: unknown): number | undefined | null => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  app.get<{ Params: Params; Querystring: { all?: string } }>(
    `${PREFIX}/elements`,
    async (req, reply) => {
      if (!guard(req.params, reply)) return reply;
      return {
        projectId: req.params.id,
        elements: listDesignElements(db, req.params.id, { includeRejected: req.query.all === '1' }),
      };
    },
  );

  app.post<{ Params: Params }>(`${PREFIX}/elements`, async (req, reply) => {
    if (!guard(req.params, reply)) return reply;
    const r = createDesignElement(db, req.params.id, req.body);
    if (!r.ok) return fail(reply, r);
    changed(req.params.id, 'create', [r.element.id]);
    return reply.code(201).send(r.element);
  });

  app.patch<{ Params: Params }>(`${PREFIX}/elements/:elementId`, async (req, reply) => {
    if (!guard(req.params, reply)) return reply;
    const r = patchDesignElement(db, req.params.id, req.params.elementId!, req.body);
    if (!r.ok) return fail(reply, r);
    changed(req.params.id, 'update', [r.element.id]);
    return r.element;
  });

  app.delete<{ Params: Params; Querystring: { revision?: string } }>(
    `${PREFIX}/elements/:elementId`,
    async (req, reply) => {
      if (!guard(req.params, reply)) return reply;
      const revision = revisionOf(req.query.revision);
      if (revision === null) return reply.code(400).send({ error: 'revision must be an integer' });
      const r = deleteDesignElement(db, req.params.id, req.params.elementId!, revision);
      if (!r.ok) return fail(reply, r);
      const { ok: _ok, ...out } = r;
      changed(req.params.id, 'delete', [...out.deleted, ...out.rejected, ...out.reparented]);
      return out;
    },
  );

  app.post<{ Params: Params; Body: { revision?: unknown } | undefined }>(
    `${PREFIX}/elements/:elementId/accept`,
    async (req, reply) => {
      if (!guard(req.params, reply)) return reply;
      const revision = revisionOf(req.body?.revision);
      if (revision === null) return reply.code(400).send({ error: 'revision must be an integer' });
      const r = acceptDesignElement(db, req.params.id, req.params.elementId!, revision);
      if (!r.ok) return fail(reply, r);
      changed(req.params.id, 'accept', [r.element.id]);
      return r.element;
    },
  );

  /** Group detected boxes into a subsystem: human `subsystem` claims through the claim validator. */
  app.post<{ Params: Params }>(`${PREFIX}/group`, async (req, reply) => {
    if (!guard(req.params, reply)) return reply;
    const snapshotId = (req.body as { snapshotId?: unknown } | undefined)?.snapshotId;
    const snap = typeof snapshotId === 'string' ? getSnapshot(db, snapshotId) : undefined;
    if (snap && snap.projectId !== req.params.id)
      return reply.code(400).send({ error: 'snapshot belongs to another project' });
    const r = await groupIntoSubsystem(db, req.body);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    if (r.accepted.length || r.moved.length) {
      bus.publish({
        type: 'claims.proposed',
        data: {
          proposalId: r.proposalIds.at(-1),
          projectId: req.params.id,
          worktreeId: snap?.worktreeId,
          accepted: r.accepted.length,
          rejected: r.rejected.length,
        },
      });
    }
    changed(req.params.id, 'group');
    const { ok: _ok, ...out } = r;
    // whatever the validator refused is reported, never forced
    return reply.code(r.rejected.length && !r.accepted.length ? 409 : 200).send(out);
  });

  const HideBody = z.object({ entityId: z.string().max(100), enabled: z.boolean() }).strict();
  /** Hide (or show) a detected box: a suppress override on its anchor entity id. */
  app.post<{ Params: Params }>(`${PREFIX}/hide`, async (req, reply) => {
    if (!guard(req.params, reply)) return reply;
    const body = HideBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'expected { entityId: ent_…, enabled: boolean }' });
    const r = hideDetectedBox(db, req.params.id, body.data.entityId, body.data.enabled);
    if (!r.ok) return fail(reply, r);
    changed(req.params.id, body.data.enabled ? 'hide' : 'show');
    return {
      projectId: req.params.id,
      targetId: r.targetId,
      action: 'suppress',
      enabled: r.enabled,
    };
  });
}
