import type { FastifyInstance } from 'fastify';
import { boardToMarkdown } from '@atlas/export';
import { createBoardFromCode, getBoard, latestProjectSnapshot } from '@atlas/graph';
import type { Db } from '@atlas/store';
import type { EventBus } from '../events.ts';

const PROJECT_RE = /^proj_[0-9a-f]{16,64}$/;
const BOARD_RE = /^brd_[0-9a-f]{16,64}$/;
const SNAPSHOT_RE = /^snap_[0-9a-f]{16,64}$/;

/**
 * Design board exports and the "from code" import (D03 wave 1b).
 * - `GET /boards/:boardId/export/markdown`: the board as a Markdown design doc (same text as the
 *   web export, without the PNG), for the CLI and agents.
 * - `GET /projects/:id/boards/from-code`: whether a snapshot exists to import from.
 * - `POST /projects/:id/boards/from-code { snapshotId?, name? }`: a new board (`source: 'code'`)
 *   holding the derived design lens of the snapshot, drawn faded in one "as built" frame. The board
 *   is a copy: it never becomes a fact and does not follow later scans.
 */
export function registerBoardExportRoutes(
  app: FastifyInstance,
  deps: { db: Db; bus: EventBus },
): void {
  const { db, bus } = deps;
  const projectExists = (id: string) =>
    PROJECT_RE.test(id) && !!db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(id);

  app.get<{ Params: { boardId: string } }>(
    '/api/v1/boards/:boardId/export/markdown',
    async (req, reply) => {
      const b = BOARD_RE.test(req.params.boardId) ? getBoard(db, req.params.boardId) : undefined;
      if (!b) return reply.code(404).send({ error: 'unknown_board' });
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .send(boardToMarkdown(b));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/boards/from-code',
    async (req, reply) => {
      if (!projectExists(req.params.id)) return reply.code(404).send({ error: 'unknown_project' });
      const snapshotId = latestProjectSnapshot(db, req.params.id);
      return { available: !!snapshotId, ...(snapshotId ? { snapshotId } : {}) };
    },
  );

  app.post<{ Params: { id: string }; Body: { snapshotId?: unknown; name?: unknown } | undefined }>(
    '/api/v1/projects/:id/boards/from-code',
    async (req, reply) => {
      if (!projectExists(req.params.id)) return reply.code(404).send({ error: 'unknown_project' });
      const { snapshotId, name } = req.body ?? {};
      if (
        snapshotId !== undefined &&
        (typeof snapshotId !== 'string' || !SNAPSHOT_RE.test(snapshotId))
      )
        return reply.code(400).send({ error: 'invalid snapshotId' });
      if (name !== undefined && (typeof name !== 'string' || name.length > 120))
        return reply.code(400).send({ error: 'invalid name' });
      const r = createBoardFromCode(db, req.params.id, { snapshotId, name });
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      bus.publish({
        type: 'design.board.changed',
        data: { projectId: req.params.id, boardId: r.board.id, action: 'created' },
      });
      return reply.code(201).send(r.board);
    },
  );
}
