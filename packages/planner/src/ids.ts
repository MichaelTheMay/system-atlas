import { createHash } from 'node:crypto';

/** Stable canvas/view ids: the same (project, workspace, lens, owner[, focus]) always maps to the same id. */
export function canvasId(projectId: string, ...parts: string[]): string {
  const h = createHash('sha256').update(projectId);
  for (const p of parts) h.update('\u0000').update(p);
  return `cvs_${h.digest('hex').slice(0, 32)}`;
}

export function shortHash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\u0000');
  return h.digest('hex').slice(0, 16);
}
