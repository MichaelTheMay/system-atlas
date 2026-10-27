import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
import type { Db } from '@atlas/store';
import { runsForEntity } from '@atlas/evidence';

/** Entity details for the inspector: what it is, where it came from, how fresh, what is missing. */
export function entityDetails(db: Db, snapshotId: string, entityId: string) {
  const row = db
    .prepare('SELECT * FROM entities WHERE snapshot_id = ? AND id = ?')
    .get<Record<string, string | null>>(snapshotId, entityId);
  if (!row) return undefined;
  const snap = db
    .prepare('SELECT worktree_id, project_id FROM snapshots WHERE id = ?')
    .get<{ worktree_id: string; project_id: string }>(snapshotId)!;
  const latest = db
    .prepare(
      "SELECT id FROM snapshots WHERE worktree_id = ? AND state IN ('ready','partial') ORDER BY published_at DESC LIMIT 1",
    )
    .get<{ id: string }>(snap.worktree_id)?.id;
  const attributes = JSON.parse(row.attributes!) as Record<string, unknown> & {
    evidenceIds?: string[];
  };
  const owners: { id: string; displayName: string; kind: string }[] = [];
  let cur = row.owner_entity_id;
  for (let i = 0; cur && i < 50; i++) {
    const o = db
      .prepare(
        'SELECT id, display_name, kind, owner_entity_id FROM entities WHERE snapshot_id = ? AND id = ?',
      )
      .get<{ id: string; display_name: string; kind: string; owner_entity_id: string | null }>(
        snapshotId,
        cur,
      );
    if (!o) break;
    owners.unshift({ id: o.id, displayName: o.display_name, kind: o.kind });
    cur = o.owner_entity_id;
  }
  const children = db
    .prepare(
      'SELECT kind, count(*) AS n FROM entities WHERE snapshot_id = ? AND owner_entity_id = ? GROUP BY kind ORDER BY kind',
    )
    .all<{ kind: string; n: number }>(snapshotId, entityId);
  const rels = db
    .prepare(
      `SELECT r.id, r.kind, r.from_id, r.to_id, r.status, r.confidence, r.producer, r.evidence_ids, a.display_name AS from_name, b.display_name AS to_name
       FROM relations r LEFT JOIN entities a ON a.snapshot_id = r.snapshot_id AND a.id = r.from_id
       LEFT JOIN entities b ON b.snapshot_id = r.snapshot_id AND b.id = r.to_id
       WHERE r.snapshot_id = ? AND (r.from_id = ? OR r.to_id = ?) ORDER BY r.kind, from_name, to_name LIMIT 500`,
    )
    .all<Record<string, string>>(snapshotId, entityId, entityId)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      direction: r.from_id === entityId ? 'out' : 'in',
      other: {
        id: r.from_id === entityId ? r.to_id : r.from_id,
        displayName: r.from_id === entityId ? r.to_name : r.from_name,
      },
      status: r.status,
      confidence: r.confidence,
      producer: r.producer,
      evidenceCount: (JSON.parse(r.evidence_ids!) as string[]).length,
    }));
  const claims = db
    .prepare(
      'SELECT id, predicate, origin, status, body FROM claims WHERE snapshot_id = ? AND subject_id = ?',
    )
    .all<{ id: string; predicate: string; origin: string; status: string; body: string }>(
      snapshotId,
      entityId,
    )
    .map((c) => {
      const body = JSON.parse(c.body) as {
        value: unknown;
        evidenceIds?: string[];
        modelMetadata?: { provider: string; model: string };
      };
      const target =
        c.predicate === 'depends-on' &&
        typeof (body.value as { entityId?: unknown })?.entityId === 'string'
          ? db
              .prepare('SELECT display_name FROM entities WHERE snapshot_id = ? AND id = ?')
              .get<{ display_name: string }>(
                snapshotId,
                (body.value as { entityId: string }).entityId,
              )?.display_name
          : undefined;
      return {
        id: c.id,
        predicate: c.predicate,
        origin: c.origin,
        status: c.status,
        value: body.value,
        evidenceCount: body.evidenceIds?.length ?? 0,
        model: body.modelMetadata?.model,
        targetName: target,
      };
    });
  const lastChange = db
    .prepare(
      `SELECT c.snapshot_id, c.change, c.detail, s.published_at FROM snapshot_changes c JOIN snapshots s ON s.id = c.snapshot_id
       WHERE c.target = 'entity' AND c.id = ? AND s.worktree_id = ? AND s.published_at <= (SELECT published_at FROM snapshots WHERE id = ?)
       ORDER BY s.published_at DESC LIMIT 1`,
    )
    .get<{ snapshot_id: string; change: string; detail: string; published_at: string }>(
      entityId,
      snap.worktree_id,
      snapshotId,
    );
  return {
    snapshotId,
    latestSnapshotId: latest,
    entity: {
      id: row.id,
      kind: row.kind,
      canonicalName: row.canonical_name,
      displayName: row.display_name,
      lifecycle: row.lifecycle,
      producer: row.producer,
      firstSeenSnapshot: row.first_seen_snapshot,
      attributes: Object.fromEntries(
        Object.entries(attributes).filter(([k]) => k !== 'evidenceIds'),
      ),
    },
    owners,
    children,
    relations: rels,
    evidence: evidenceList(db, attributes.evidenceIds ?? [], latest),
    claims,
    // outputs: runs linked to this entity by correlation (plan §13 "Show outputs")
    runs: runsForEntity(db, entityId),
    lastChange: lastChange
      ? {
          snapshotId: lastChange.snapshot_id,
          change: lastChange.change,
          at: lastChange.published_at,
          detail: JSON.parse(lastChange.detail),
        }
      : null,
  };
}

/** Evidence with freshness against the latest snapshot's manifest of the same worktree. */
export function evidenceList(db: Db, ids: string[], latestSnapshotId?: string) {
  const fileHash = db.prepare(
    'SELECT sha256 FROM snapshot_files WHERE snapshot_id = ? AND path = ?',
  );
  return ids.slice(0, 50).flatMap((id) => {
    const r = db.prepare('SELECT body FROM evidence WHERE id = ?').get<{ body: string }>(id);
    if (!r) return [];
    const ev = JSON.parse(r.body) as { repoRelativePath?: string; contentHash?: string } & Record<
      string,
      unknown
    >;
    let freshness: 'current' | 'changed' | 'deleted' | 'unknown' = 'unknown';
    if (ev.repoRelativePath && latestSnapshotId) {
      const cur = fileHash.get<{ sha256: string }>(latestSnapshotId, ev.repoRelativePath);
      freshness = !cur ? 'deleted' : cur.sha256 === ev.contentHash ? 'current' : 'changed';
    }
    return [{ ...ev, freshness }];
  });
}

export function relationDetails(db: Db, snapshotId: string, ids: string[]) {
  const snap = db
    .prepare('SELECT worktree_id FROM snapshots WHERE id = ?')
    .get<{ worktree_id: string }>(snapshotId);
  if (!snap) return undefined;
  const latest = db
    .prepare(
      "SELECT id FROM snapshots WHERE worktree_id = ? AND state IN ('ready','partial') ORDER BY published_at DESC LIMIT 1",
    )
    .get<{ id: string }>(snap.worktree_id)?.id;
  return ids.slice(0, 50).flatMap((id) => {
    const r = db
      .prepare(
        `SELECT r.*, a.display_name AS from_name, a.kind AS from_kind, b.display_name AS to_name, b.kind AS to_kind FROM relations r
         LEFT JOIN entities a ON a.snapshot_id = r.snapshot_id AND a.id = r.from_id
         LEFT JOIN entities b ON b.snapshot_id = r.snapshot_id AND b.id = r.to_id WHERE r.snapshot_id = ? AND r.id = ?`,
      )
      .get<Record<string, string>>(snapshotId, id);
    if (!r) return [];
    return [
      {
        id: r.id,
        kind: r.kind,
        from: { id: r.from_id, displayName: r.from_name, kind: r.from_kind },
        to: { id: r.to_id, displayName: r.to_name, kind: r.to_kind },
        status: r.status,
        confidence: r.confidence,
        producer: r.producer,
        qualifiers: JSON.parse(r.qualifiers!),
        evidence: evidenceList(db, JSON.parse(r.evidence_ids!) as string[], latest),
      },
    ];
  });
}

/**
 * Source text for evidence navigation. Only files in the snapshot's manifest can be read (never
 * skipped/secret files), the path must stay inside the registered root, and the bytes must still
 * match the snapshot hash; otherwise the caller is told the file changed instead of being shown
 * different code under old evidence.
 */
export async function readSource(db: Db, snapshotId: string, path: string, maxBytes = 512 * 1024) {
  const snap = db
    .prepare(
      'SELECT w.root_path FROM snapshots s JOIN worktrees w ON w.id = s.worktree_id WHERE s.id = ?',
    )
    .get<{ root_path: string }>(snapshotId);
  if (!snap) return { status: 404 as const, error: 'unknown_snapshot' };
  const f = db
    .prepare('SELECT sha256, size, language FROM snapshot_files WHERE snapshot_id = ? AND path = ?')
    .get<{ sha256: string; size: number; language: string }>(snapshotId, path);
  if (!f) return { status: 404 as const, error: 'not_in_snapshot' };
  if (f.size > maxBytes) return { status: 413 as const, error: 'too_large' };
  const root = realpathSync(snap.root_path);
  let abs: string;
  try {
    abs = realpathSync(join(root, path));
  } catch {
    return {
      status: 200 as const,
      path,
      language: f.language,
      state: 'deleted' as const,
      text: null,
    };
  }
  if (!abs.startsWith(root + sep)) return { status: 403 as const, error: 'outside_root' };
  const bytes = await readFile(abs);
  const same = createHash('sha256').update(bytes).digest('hex') === f.sha256;
  return {
    status: 200 as const,
    path,
    language: f.language,
    state: same ? ('current' as const) : ('changed' as const),
    text: same ? bytes.toString('utf8') : null,
  };
}

/**
 * The canvas that best shows an entity: its own child view if it has one, otherwise the view of its
 * nearest owner that has a container canvas (where it appears as a node).
 */
export function canvasForEntity(
  db: Db,
  snapshotId: string,
  entityId: string,
): { canvasId: string; viaEntityId: string } | undefined {
  const own = db
    .prepare(
      "SELECT id FROM canvases WHERE snapshot_id = ? AND root_entity_id = ? AND lens IN ('component','module-detail')",
    )
    .get<{ id: string }>(snapshotId, entityId);
  if (own) return { canvasId: own.id, viaEntityId: entityId };
  let cur = db
    .prepare('SELECT owner_entity_id FROM entities WHERE snapshot_id = ? AND id = ?')
    .get<{ owner_entity_id: string | null }>(snapshotId, entityId)?.owner_entity_id;
  const canvasOf = db.prepare(
    "SELECT id FROM canvases WHERE snapshot_id = ? AND root_entity_id = ? AND lens IN ('component','module-detail')",
  );
  const ownerOf = db.prepare(
    'SELECT owner_entity_id, kind FROM entities WHERE snapshot_id = ? AND id = ?',
  );
  for (let i = 0; cur && i < 50; i++) {
    const c = canvasOf.get<{ id: string }>(snapshotId, cur);
    if (c) return { canvasId: c.id, viaEntityId: entityId };
    const o = ownerOf.get<{ owner_entity_id: string | null; kind: string }>(snapshotId, cur);
    if (o?.kind === 'system') break;
    cur = o?.owner_entity_id ?? null;
  }
  const structure = db
    .prepare(
      "SELECT id FROM canvases WHERE snapshot_id = ? AND lens = 'component' AND owner_canvas_id IS NULL",
    )
    .get<{ id: string }>(snapshotId);
  return structure ? { canvasId: structure.id, viaEntityId: entityId } : undefined;
}
