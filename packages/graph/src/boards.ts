import {
  BoardSpec,
  boardTemplate,
  DesignBoard,
  DesignBoardCreate,
  DesignBoardPatch,
  emptyBoardDocument,
  newId,
  type BoardDocument,
  type DesignBoardSummary,
} from '@atlas/schema';
import type { Db } from '@atlas/store';

/**
 * Design boards (D03, plan §4): design-first whiteboards kept per project, independent of snapshots.
 * View data only: nothing here reads or writes entities, relations, claims or evidence. A board
 * created from a template stores the template's spec in its document registry and leaves the
 * scene empty; the web materializer draws it on first open (layout is a presentation concern).
 */
export type BoardResult<T> =
  ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409; error: string; current?: DesignBoard };

interface Row {
  id: string;
  project_id: string;
  name: string;
  document: string;
  source: DesignBoard['source'];
  template_id: string | null;
  parent_board_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

const toBoard = (r: Row): DesignBoard =>
  DesignBoard.parse({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    document: JSON.parse(r.document),
    source: r.source,
    templateId: r.template_id ?? undefined,
    parentBoardId: r.parent_board_id ?? undefined,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

const projectExists = (db: Db, projectId: string) =>
  !!db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(projectId);

export function listBoards(db: Db, projectId: string): DesignBoardSummary[] {
  return db
    .prepare('SELECT * FROM design_boards WHERE project_id = ? ORDER BY updated_at DESC, id')
    .all<Row>(projectId)
    .map((r) => {
      const { document, ...rest } = toBoard(r);
      return { ...rest, componentCount: Object.keys(document.components).length };
    });
}

export function getBoard(db: Db, boardId: string): DesignBoard | undefined {
  const r = db.prepare('SELECT * FROM design_boards WHERE id = ?').get<Row>(boardId);
  return r ? toBoard(r) : undefined;
}

/** Document of a template: its spec in the registry, scene empty until the web lays it out. */
export function documentFromSpec(spec: BoardSpec, source: DesignBoard['source']): BoardDocument {
  const origin = (o: { author: string }) =>
    o.author === 'user' ? { author: source === 'template' ? 'template' : o.author } : o;
  const doc = emptyBoardDocument();
  for (const c of spec.components)
    doc.components[c.id] = { ...c, origin: origin(c.origin) as never, elementIds: [] };
  for (const k of spec.connections)
    doc.connections[k.id] = { ...k, origin: origin(k.origin) as never };
  doc.scenarios = spec.scenarios.map((s) => ({ ...s, origin: origin(s.origin) as never }));
  doc.doc = {
    summary: spec.summary,
    items: spec.doc.items.map((i) => ({ ...i, origin: origin(i.origin) as never })),
  };
  doc.frames = spec.frames.map((f) => ({ ...f }));
  return doc;
}

export function createBoard(
  db: Db,
  projectId: string,
  input: unknown,
): BoardResult<{ board: DesignBoard }> {
  if (!projectExists(db, projectId)) return { ok: false, status: 404, error: 'unknown_project' };
  const parsed = DesignBoardCreate.safeParse(input);
  if (!parsed.success)
    return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid board' };
  const { name, source, templateId, parentBoardId } = parsed.data;
  let document = parsed.data.document;
  if (source === 'template') {
    const tpl = templateId ? boardTemplate(templateId) : undefined;
    if (!tpl) return { ok: false, status: 400, error: `unknown template: ${templateId ?? ''}` };
    document ??= documentFromSpec(BoardSpec.parse(tpl.spec), 'template');
  }
  if (parentBoardId) {
    const parent = getBoard(db, parentBoardId);
    if (!parent || parent.projectId !== projectId)
      return { ok: false, status: 400, error: 'parentBoardId is not a board of this project' };
    // nesting stays shallow: system > internals > internals of those (depth ≤ 3)
    let depth = 1;
    for (let p: DesignBoard | undefined = parent; p?.parentBoardId; depth++)
      p = getBoard(db, p.parentBoardId);
    if (depth >= 3) return { ok: false, status: 400, error: 'boards nest at most three levels' };
  }
  const now = new Date().toISOString();
  const board = DesignBoard.parse({
    id: newId('board'),
    projectId,
    name,
    document: document ?? emptyBoardDocument(),
    source,
    templateId,
    parentBoardId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
  db.prepare(
    `INSERT INTO design_boards (id, project_id, name, document, source, template_id, parent_board_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    board.id,
    projectId,
    board.name,
    JSON.stringify(board.document),
    source,
    templateId ?? null,
    parentBoardId ?? null,
    now,
    now,
  );
  return { ok: true, board };
}

/** Optimistic concurrency: a stale revision is a 409 carrying the stored board. */
export function patchBoard(
  db: Db,
  boardId: string,
  input: unknown,
): BoardResult<{ board: DesignBoard }> {
  const parsed = DesignBoardPatch.safeParse(input);
  if (!parsed.success)
    return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid patch' };
  return db.transaction((): BoardResult<{ board: DesignBoard }> => {
    const cur = getBoard(db, boardId);
    if (!cur) return { ok: false, status: 404, error: 'unknown_board' };
    if (parsed.data.revision !== cur.revision)
      return { ok: false, status: 409, error: 'revision conflict', current: cur };
    const next: DesignBoard = {
      ...cur,
      name: parsed.data.name ?? cur.name,
      document: parsed.data.document ?? cur.document,
      revision: cur.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    db.prepare(
      'UPDATE design_boards SET name = ?, document = ?, revision = ?, updated_at = ? WHERE id = ?',
    ).run(next.name, JSON.stringify(next.document), next.revision, next.updatedAt, boardId);
    return { ok: true, board: next };
  });
}

export function deleteBoard(db: Db, boardId: string): BoardResult<{ deleted: string[] }> {
  const cur = getBoard(db, boardId);
  if (!cur) return { ok: false, status: 404, error: 'unknown_board' };
  // internals boards go with their parent
  const children = db
    .prepare('SELECT id FROM design_boards WHERE parent_board_id = ?')
    .all<{ id: string }>(boardId)
    .map((r) => r.id);
  const deleted = [boardId];
  for (const child of children) {
    const r = deleteBoard(db, child);
    if (r.ok) deleted.push(...r.deleted);
  }
  db.prepare('DELETE FROM design_boards WHERE id = ?').run(boardId);
  return { ok: true, deleted };
}
