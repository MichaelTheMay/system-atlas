import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createBoard,
  deleteBoard,
  getBoard,
  listBoards,
  patchBoard,
  type BoardResult,
} from '@atlas/graph';
import { BOARD_TEMPLATES } from '@atlas/schema';
import type { Db } from '@atlas/store';
import type { EventBus } from '../events.ts';

const PROJECT_RE = /^proj_[0-9a-f]{16,64}$/;
const BOARD_RE = /^brd_[0-9a-f]{16,64}$/;

/**
 * Design boards (D03): design-first whiteboards per project. Every write publishes
 * `design.board.changed` so other tabs refresh. Boards are view data: nothing here touches the
 * semantic graph, and a board never becomes a fact or a claim.
 */
export function registerBoardRoutes(app: FastifyInstance, deps: { db: Db; bus: EventBus }): void {
  const { db, bus } = deps;
  const fail = (reply: FastifyReply, r: Extract<BoardResult<object>, { ok: false }>) =>
    reply.code(r.status).send({ error: r.error, ...(r.current ? { current: r.current } : {}) });
  const changed = (projectId: string, boardId: string, action: string) =>
    bus.publish({ type: 'design.board.changed', data: { projectId, boardId, action } });
  const projectExists = (id: string) =>
    PROJECT_RE.test(id) && !!db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(id);

  app.get('/api/v1/design/board-templates', async () => ({
    templates: BOARD_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      componentCount: t.spec.components.length,
    })),
  }));

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/boards', async (req, reply) => {
    if (!projectExists(req.params.id)) return reply.code(404).send({ error: 'unknown_project' });
    return { projectId: req.params.id, boards: listBoards(db, req.params.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/projects/:id/boards',
    async (req, reply) => {
      if (!projectExists(req.params.id)) return reply.code(404).send({ error: 'unknown_project' });
      const r = createBoard(db, req.params.id, req.body);
      if (!r.ok) return fail(reply, r);
      changed(req.params.id, r.board.id, 'created');
      return reply.code(201).send(r.board);
    },
  );

  app.get<{ Params: { boardId: string } }>('/api/v1/boards/:boardId', async (req, reply) => {
    const b = BOARD_RE.test(req.params.boardId) ? getBoard(db, req.params.boardId) : undefined;
    return b ?? reply.code(404).send({ error: 'unknown_board' });
  });

  app.patch<{ Params: { boardId: string }; Body: unknown }>(
    '/api/v1/boards/:boardId',
    async (req, reply) => {
      if (!BOARD_RE.test(req.params.boardId))
        return reply.code(404).send({ error: 'unknown_board' });
      const r = patchBoard(db, req.params.boardId, req.body);
      if (!r.ok) return fail(reply, r);
      changed(r.board.projectId, r.board.id, 'updated');
      return r.board;
    },
  );

  app.delete<{ Params: { boardId: string } }>('/api/v1/boards/:boardId', async (req, reply) => {
    const b = BOARD_RE.test(req.params.boardId) ? getBoard(db, req.params.boardId) : undefined;
    if (!b) return reply.code(404).send({ error: 'unknown_board' });
    const r = deleteBoard(db, b.id);
    if (!r.ok) return fail(reply, r);
    changed(b.projectId, b.id, 'deleted');
    return { deleted: r.deleted };
  });
}
