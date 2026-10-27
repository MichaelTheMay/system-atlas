import { ViewOverlay } from '@atlas/schema';
import { resolveAlias, snapshotEntityExists } from '@atlas/graph';
import type { Db } from '@atlas/store';

export const LOCAL_PROFILE = 'local';

export function emptyOverlay(viewId: string): ViewOverlay {
  return {
    schemaVersion: 1,
    viewId,
    profileId: LOCAL_PROFILE,
    entityPositions: {},
    nodePositions: {},
    autoPositions: {},
    pinnedIds: [],
    annotations: [],
    displayOverrides: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    revision: 0,
  };
}

/**
 * Overlays are presentation only (plan §4) and survive regeneration. Entity positions, pins and
 * notes follow accepted rename aliases when read, so a moved file keeps its place on the canvas.
 */
export function getOverlay(
  db: Db,
  viewId: string,
  context?: { projectId: string; snapshotId: string },
): ViewOverlay {
  const row = db
    .prepare('SELECT body FROM view_overlays WHERE view_id = ? AND profile_id = ?')
    .get<{ body: string }>(viewId, LOCAL_PROFILE);
  if (!row) return emptyOverlay(viewId);
  const o = ViewOverlay.parse(JSON.parse(row.body));
  if (!context) return o;
  // follow a rename only when the snapshot being viewed lacks the old id and has the new one, so a
  // file moved on another worktree never moves this worktree's pins or notes
  const exists = snapshotEntityExists(db, context.snapshotId);
  const remap = (id: string) => resolveAlias(db, context.projectId, id, exists);
  return {
    ...o,
    entityPositions: Object.fromEntries(
      Object.entries(o.entityPositions).map(([id, p]) => [remap(id), p]),
    ),
    pinnedIds: [...new Set(o.pinnedIds.map(remap))],
    autoPositions: Object.fromEntries(
      Object.entries(o.autoPositions).map(([id, p]) => [id.startsWith('ent_') ? remap(id) : id, p]),
    ),
    annotations: o.annotations.map((a) =>
      a.targetId?.startsWith('ent_') ? { ...a, targetId: remap(a.targetId) } : a,
    ),
    displayOverrides: Object.fromEntries(
      Object.entries(o.displayOverrides).map(([id, d]) => [remap(id), d]),
    ),
  };
}

export type PutResult =
  | { ok: true; overlay: ViewOverlay }
  | { ok: false; status: 400 | 409; error: string; current?: ViewOverlay };

/** Optimistic concurrency: the client sends the revision it edited; a stale revision is a 409. */
export function putOverlay(db: Db, viewId: string, body: unknown): PutResult {
  const parsed = ViewOverlay.safeParse(body);
  if (!parsed.success)
    return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid overlay' };
  if (parsed.data.viewId !== viewId || parsed.data.profileId !== LOCAL_PROFILE)
    return { ok: false, status: 400, error: 'view/profile mismatch' };
  return db.transaction((): PutResult => {
    const cur = db
      .prepare('SELECT revision, body FROM view_overlays WHERE view_id = ? AND profile_id = ?')
      .get<{ revision: number; body: string }>(viewId, LOCAL_PROFILE);
    const currentRevision = cur?.revision ?? 0;
    if (parsed.data.revision !== currentRevision) {
      return {
        ok: false,
        status: 409,
        error: 'revision conflict',
        current: cur ? ViewOverlay.parse(JSON.parse(cur.body)) : emptyOverlay(viewId),
      };
    }
    const next = { ...parsed.data, revision: currentRevision + 1 };
    db.prepare(
      `INSERT INTO view_overlays (view_id, profile_id, revision, body, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (view_id, profile_id) DO UPDATE SET revision = excluded.revision, body = excluded.body, updated_at = excluded.updated_at`,
    ).run(viewId, LOCAL_PROFILE, next.revision, JSON.stringify(next), new Date().toISOString());
    return { ok: true, overlay: next };
  });
}
