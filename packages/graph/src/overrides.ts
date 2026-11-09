import type { Db } from '@atlas/store';
import { proposeClaims } from './proposals.ts';

/**
 * View overrides (plan §8, D01): user decisions about views — pin, suppress, promote — keyed on
 * stable canvas ids so they survive regeneration. They are presentation decisions, not facts: the
 * only override that touches the semantic model is promote, and it does so through the claim
 * validator (as human claims citing the original evidence), never by writing rows directly.
 */
export type OverrideAction = 'pin' | 'suppress' | 'promote';
export const OVERRIDE_ACTIONS: readonly OverrideAction[] = ['pin', 'suppress', 'promote'];

export interface OverrideRow {
  targetId: string;
  action: OverrideAction;
  createdAt: string;
}

/** Records (enabled) or removes (disabled) one override. Idempotent. */
export function setOverride(
  db: Db,
  projectId: string,
  targetId: string,
  action: OverrideAction,
  enabled: boolean,
): void {
  if (enabled)
    db.prepare(
      'INSERT OR IGNORE INTO view_overrides (project_id, target_id, action, created_at) VALUES (?, ?, ?, ?)',
    ).run(projectId, targetId, action, new Date().toISOString());
  else
    db.prepare(
      'DELETE FROM view_overrides WHERE project_id = ? AND target_id = ? AND action = ?',
    ).run(projectId, targetId, action);
}

export function listOverrides(db: Db, projectId: string): OverrideRow[] {
  return db
    .prepare(
      'SELECT target_id, action, created_at FROM view_overrides WHERE project_id = ? ORDER BY target_id, action',
    )
    .all<{ target_id: string; action: OverrideAction; created_at: string }>(projectId)
    .map((r) => ({ targetId: r.target_id, action: r.action, createdAt: r.created_at }));
}

/** Subsystem path segments: split on '/', each trimmed, whitespace collapsed, lowercased. */
export function subsystemSegments(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split('/')
    .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

/** A claim belongs to a subsystem path when its segments equal it or are nested beneath it. */
export function inSubsystem(value: unknown, path: string[]): boolean {
  const segs = subsystemSegments(value);
  return path.length > 0 && segs.length >= path.length && path.every((p, i) => segs[i] === p);
}

export interface PromoteInput {
  snapshotId: string;
  canvasId: string;
  subsystemPath: string;
}

export type PromoteOutcome =
  | {
      ok: true;
      proposalIds: string[];
      accepted: { sourceClaimId: string; claimId: string; subjectId: string; status: string }[];
      rejected: { sourceClaimId: string; subjectId: string; reasons: string[] }[];
      /** Matching claims whose subject already has an equal human subsystem claim. */
      alreadyAccepted: number;
      /** Whether the 'promote' override was recorded (only when nothing was rejected). */
      overrideRecorded: boolean;
    }
  | { ok: false; status: 400 | 404 | 409; error: string };

const BATCH = 25;

/**
 * Promote a proposed subsystem: every non-rejected model-origin `subsystem` claim of the snapshot
 * whose path equals `subsystemPath` (or is nested beneath it) is re-proposed as a human claim citing
 * the same evidence ids. The validator decides: evidence that no longer matches the snapshot (an
 * edited file) is rejected with its reasons; nothing is forced. The 'promote' override is recorded
 * only when every re-proposal was accepted.
 */
export async function promoteSubsystem(db: Db, input: PromoteInput): Promise<PromoteOutcome> {
  const path = subsystemSegments(input.subsystemPath);
  if (path.length === 0) return { ok: false, status: 400, error: 'subsystemPath is empty' };
  const snap = db
    .prepare('SELECT project_id FROM snapshots WHERE id = ?')
    .get<{ project_id: string }>(input.snapshotId);
  if (!snap) return { ok: false, status: 404, error: 'unknown_snapshot' };

  const rows = db
    .prepare(
      "SELECT id, subject_id, origin, status, body FROM claims WHERE snapshot_id = ? AND predicate = 'subsystem' AND status != 'rejected' ORDER BY id",
    )
    .all<{ id: string; subject_id: string; origin: string; status: string; body: string }>(
      input.snapshotId,
    )
    .map((r) => {
      const body = JSON.parse(r.body) as { value?: unknown; evidenceIds?: string[] };
      return { ...r, value: body.value, evidenceIds: body.evidenceIds ?? [] };
    })
    .filter((r) => inSubsystem(r.value, path));
  const model = rows.filter((r) => r.origin === 'model');
  if (model.length === 0)
    return {
      ok: false,
      status: 404,
      error: `no proposed subsystem claims match "${input.subsystemPath}" in this snapshot`,
    };

  // idempotent: a subject that already carries the same human subsystem is not re-proposed
  const key = (subjectId: string, value: unknown) =>
    `${subjectId}\u0000${subsystemSegments(value).join('/')}`;
  const human = new Set(
    rows
      .filter((r) => r.origin === 'human' && r.status !== 'stale')
      .map((r) => key(r.subject_id, r.value)),
  );
  const todo: typeof model = [];
  const seen = new Set<string>();
  let alreadyAccepted = 0;
  for (const r of model) {
    const k = key(r.subject_id, r.value);
    if (human.has(k)) alreadyAccepted++;
    else if (!seen.has(k)) {
      seen.add(k);
      todo.push(r);
    }
  }

  const out: Extract<PromoteOutcome, { ok: true }> = {
    ok: true,
    proposalIds: [],
    accepted: [],
    rejected: [],
    alreadyAccepted,
    overrideRecorded: false,
  };
  for (let off = 0; off < todo.length; off += BATCH) {
    const chunk = todo.slice(off, off + BATCH);
    const r = await proposeClaims(db, {
      snapshotId: input.snapshotId,
      origin: 'human',
      claims: chunk.map((c) => ({
        subjectId: c.subject_id,
        predicate: 'subsystem',
        value: typeof c.value === 'string' ? c.value.replace(/\s+/g, ' ').trim() : c.value,
        citations: c.evidenceIds.slice(0, 10).map((evidenceId) => ({ evidenceId })),
        rationale: `promoted from proposed claim ${c.id}`,
      })),
    });
    if (!r.ok) return r;
    out.proposalIds.push(r.proposalId);
    for (const a of r.accepted) {
      const src = chunk[a.index]!;
      out.accepted.push({
        sourceClaimId: src.id,
        claimId: a.claimId,
        subjectId: src.subject_id,
        status: a.status,
      });
    }
    for (const x of r.rejected) {
      const src = chunk[x.index]!;
      out.rejected.push({ sourceClaimId: src.id, subjectId: src.subject_id, reasons: x.reasons });
    }
  }
  if (out.rejected.length === 0) {
    setOverride(db, snap.project_id, input.canvasId, 'promote', true);
    out.overrideRecorded = true;
  }
  return out;
}
