import type { DesignBoard } from '@atlas/schema';
import { api } from '../api.ts';

/**
 * "From code" start of a board (D03 wave 1b): the daemon copies the derived design lens of the
 * project's latest snapshot into a new board (`source: 'code'`, components drawn faded inside an
 * "As built" frame). Offered only when the project has a snapshot.
 */
export const fromCodeStatus = (token: string, projectId: string) =>
  api<{ available: boolean; snapshotId?: string }>(
    `/projects/${projectId}/boards/from-code`,
    token,
  );

export const createBoardFromCode = (
  token: string,
  projectId: string,
  input: { name?: string; snapshotId?: string } = {},
) =>
  api<DesignBoard>(`/projects/${projectId}/boards/from-code`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
