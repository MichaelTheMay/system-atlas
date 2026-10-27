import type { BoardDocument, DesignBoard, DesignBoardSummary } from '@atlas/schema';
import { api } from '../api.ts';

export type { BoardDocument, DesignBoard, DesignBoardSummary };

export interface BoardTemplateDto {
  id: string;
  name: string;
  description: string;
  componentCount: number;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const listBoards = (token: string, projectId: string) =>
  api<{ boards: DesignBoardSummary[] }>(`/projects/${projectId}/boards`, token).then(
    (r) => r.boards,
  );
export const listBoardTemplates = (token: string) =>
  api<{ templates: BoardTemplateDto[] }>('/design/board-templates', token).then((r) => r.templates);
export const getBoard = (token: string, boardId: string) =>
  api<DesignBoard>(`/boards/${boardId}`, token);
export const createBoard = (
  token: string,
  projectId: string,
  input: { name: string; source?: 'blank' | 'template'; templateId?: string },
) => api<DesignBoard>(`/projects/${projectId}/boards`, token, json(input));
export const deleteBoard = (token: string, boardId: string) =>
  api<{ deleted: string[] }>(`/boards/${boardId}`, token, { method: 'DELETE' });

export type SaveResult =
  | { ok: true; board: DesignBoard }
  | { ok: false; status: 409; current: DesignBoard }
  | { ok: false; status: number; error: string };

/** PATCH with optimistic revision; a conflict returns the stored board instead of throwing. */
export async function saveBoard(
  token: string,
  boardId: string,
  patch: { name?: string; document?: BoardDocument; revision: number },
): Promise<SaveResult> {
  const res = await fetch(`/api/v1/boards/${boardId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  const body = (await res.json()) as { current?: DesignBoard; error?: string } & DesignBoard;
  if (res.ok) return { ok: true, board: body };
  if (res.status === 409 && body.current) return { ok: false, status: 409, current: body.current };
  return { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
}
