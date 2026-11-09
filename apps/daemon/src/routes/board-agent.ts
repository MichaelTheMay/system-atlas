import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  applyBoardProposal,
  boardSpecOf,
  createProposedBoard,
  getBoard,
  reviewBoardItems,
} from '@atlas/graph';
import type { Db } from '@atlas/store';
import type { DesignJobs } from '../design-jobs.ts';
import type { EventBus } from '../events.ts';

const PROJECT_RE = /^proj_[0-9a-f]{16,64}$/;
const BOARD_RE = /^brd_[0-9a-f]{16,64}$/;

/** What an agent may say about itself; the daemon decides the rest. */
const AgentOrigin = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    jobId: z.string().max(80).optional(),
  })
  .default({});

/**
 * Agent side of design boards (D03c): the BoardSpec view agents read, proposals (merged as
 * `proposed`, never replacing anything), drafts of new boards, and the person's accept/reject
 * review. Proposals are always authored by "agent"; a job id is kept only when it is the
 * project's running design job, so a stray client cannot attribute work to a job.
 */
export function registerBoardAgentRoutes(
  app: FastifyInstance,
  deps: { db: Db; bus: EventBus; designJobs: DesignJobs },
): void {
  const { db, bus, designJobs } = deps;
  const changed = (projectId: string, boardId: string, action: string) =>
    bus.publish({ type: 'design.board.changed', data: { projectId, boardId, action } });
  const origin = (projectId: string, raw: unknown) => {
    const o = AgentOrigin.safeParse(raw ?? {});
    const v = o.success ? o.data : {};
    const jobId = v.jobId && designJobs.activeJobId(projectId) === v.jobId ? v.jobId : undefined;
    return {
      author: 'agent' as const,
      name: v.name ?? 'unknown',
      ...(jobId ? { jobId } : {}),
    };
  };
  const board = (id: string) => (BOARD_RE.test(id) ? getBoard(db, id) : undefined);

  app.get<{ Params: { boardId: string } }>('/api/v1/boards/:boardId/spec', async (req, reply) => {
    const b = board(req.params.boardId);
    if (!b) return reply.code(404).send({ error: 'unknown_board' });
    return {
      boardId: b.id,
      name: b.name,
      source: b.source,
      revision: b.revision,
      spec: boardSpecOf(b.document, b.name),
      ...(b.document.doc.plan ? { plan: b.document.doc.plan } : {}),
    };
  });

  app.post<{ Params: { boardId: string }; Body: { spec?: unknown; origin?: unknown } }>(
    '/api/v1/boards/:boardId/proposals',
    async (req, reply) => {
      const b = board(req.params.boardId);
      if (!b) return reply.code(404).send({ error: 'unknown_board' });
      const r = applyBoardProposal(db, b.id, req.body?.spec, origin(b.projectId, req.body?.origin));
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      if (r.accepted.length) changed(b.projectId, b.id, 'proposed');
      return {
        boardId: b.id,
        revision: r.board.revision,
        accepted: r.accepted,
        rejected: r.rejected,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { name?: unknown; spec?: unknown; origin?: unknown } }>(
    '/api/v1/projects/:id/boards/proposed',
    async (req, reply) => {
      const projectId = req.params.id;
      if (
        !PROJECT_RE.test(projectId) ||
        !db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(projectId)
      )
        return reply.code(404).send({ error: 'unknown_project' });
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
      if (!name) return reply.code(400).send({ error: 'name is required' });
      const r = createProposedBoard(
        db,
        projectId,
        { name, spec: req.body?.spec },
        origin(projectId, req.body?.origin),
      );
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      changed(projectId, r.board.id, 'created');
      const { document: _d, ...summary } = r.board;
      return reply.code(201).send({ board: summary, accepted: r.accepted, rejected: r.rejected });
    },
  );

  /** `{ accept: ids, reject: ids }`: a person's review of proposed items (audited). */
  app.post<{ Params: { boardId: string }; Body: { accept?: unknown; reject?: unknown } }>(
    '/api/v1/boards/:boardId/review',
    async (req, reply) => {
      const b = board(req.params.boardId);
      if (!b) return reply.code(404).send({ error: 'unknown_board' });
      const r = reviewBoardItems(db, b.id, req.body ?? {});
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      if (r.accepted.length || r.rejected.length) changed(b.projectId, b.id, 'reviewed');
      return { accepted: r.accepted, rejected: r.rejected, ignored: r.ignored, board: r.board };
    },
  );
}
