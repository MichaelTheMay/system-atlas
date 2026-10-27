/**
 * Client for the user-authored design layer (D02a): design elements, grouping detected boxes into
 * subsystems (human claims) and hiding detected boxes. Unlike `api()`, failures keep the response
 * body: a 409 carries the stored element, and grouping reports what the claim validator refused.
 * Bodiless calls (DELETE) send no content-type.
 */

export type Archetype =
  | 'client'
  | 'api-service'
  | 'worker'
  | 'queue'
  | 'datastore'
  | 'cache'
  | 'external-api'
  | 'library'
  | 'service';

export const ARCHETYPES: Archetype[] = [
  'client',
  'api-service',
  'worker',
  'queue',
  'datastore',
  'cache',
  'external-api',
  'library',
  'service',
];

export type FlowEnd = { elementId: string } | { entityId: string };

export type DesignBody =
  | {
      kind: 'box';
      label: string;
      archetype: Archetype;
      responsibility?: string;
      parentId?: string;
    }
  | { kind: 'flow'; from: FlowEnd; to: FlowEnd; label?: string }
  | { kind: 'sticky'; text: string; canvasId: string }
  | { kind: 'subsystem'; label: string; responsibility?: string; parentId?: string };

export interface DesignElementDto {
  id: string;
  projectId: string;
  body: DesignBody;
  boundEntityIds: string[];
  author: 'user' | 'agent';
  authorName?: string;
  citations: string[];
  status: 'active' | 'proposed' | 'rejected';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export class DesignApiError extends Error {
  readonly status: number;
  /** On a 409: the element as stored now. */
  readonly current?: DesignElementDto;
  constructor(status: number, message: string, current?: DesignElementDto) {
    super(message);
    this.status = status;
    this.current = current;
  }
}

async function call<T>(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  /** Statuses whose body is a result, not an error (grouping: 409 = everything refused). */
  okStatuses: number[] = [],
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const out = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    current?: DesignElementDto;
  };
  if (!res.ok && !okStatuses.includes(res.status))
    throw new DesignApiError(res.status, out.error ?? `HTTP ${res.status}`, out.current);
  return out;
}

export interface GroupResult {
  accepted: { entityId: string; claimId: string; status: string }[];
  rejected: { entityId: string; reasons: string[] }[];
  alreadyGrouped: string[];
  moved: string[];
}

export interface DeleteResult {
  deleted: string[];
  rejected: string[];
  reparented: string[];
}

export function designApi(token: string, projectId: string) {
  const base = `/projects/${projectId}/design`;
  return {
    list: async () =>
      (await call<{ elements: DesignElementDto[] }>(token, 'GET', `${base}/elements`)).elements,
    create: (body: DesignBody, boundEntityIds: string[] = []) =>
      call<DesignElementDto>(token, 'POST', `${base}/elements`, { body, boundEntityIds }),
    patch: (
      id: string,
      revision: number,
      patch: { body?: DesignBody; boundEntityIds?: string[] },
    ) => call<DesignElementDto>(token, 'PATCH', `${base}/elements/${id}`, { ...patch, revision }),
    remove: (id: string, revision?: number) =>
      call<DeleteResult>(
        token,
        'DELETE',
        `${base}/elements/${id}${revision !== undefined ? `?revision=${revision}` : ''}`,
      ),
    accept: (id: string, revision: number) =>
      call<DesignElementDto>(token, 'POST', `${base}/elements/${id}/accept`, { revision }),
    group: (snapshotId: string, path: string, entityIds: string[]) =>
      call<GroupResult>(token, 'POST', `${base}/group`, { snapshotId, path, entityIds }, [409]),
    hide: (entityId: string, enabled: boolean) =>
      call<{ enabled: boolean }>(token, 'POST', `${base}/hide`, { entityId, enabled }),
    rejectClaim: (claimId: string, reason: string) =>
      call<unknown>(token, 'POST', `/claims/${claimId}/reject`, { reason }),
  };
}
export type DesignApi = ReturnType<typeof designApi>;

/**
 * Canvas id of a drawn subsystem: mirrors `designElementCanvasId` in packages/planner (sha-256 of
 * the project id and the NUL-separated parts), so the UI knows which element a canvas draws.
 */
export async function drawnSubsystemCanvasId(projectId: string, elementId: string) {
  const text = [projectId, 'design', 'design-subsystem', 'element', elementId].join('\u0000');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `cvs_${hex.slice(0, 32)}`;
}
