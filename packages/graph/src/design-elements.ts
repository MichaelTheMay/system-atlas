import {
  DesignElement,
  type DesignElementBody,
  DesignElementInput,
  DesignElementPatch,
  idSchema,
  newId,
} from '@atlas/schema';
import type { Db } from '@atlas/store';
import { z } from 'zod';
import { setOverride, subsystemSegments } from './overrides.ts';
import { evidenceChecker, proposeClaims, rejectClaim } from './proposals.ts';

/**
 * User-authored design layer (D02a, plan §4): boxes, flows, sticky notes and subsystems drawn on the
 * System design canvases. View data keyed by project, so it survives every rescan, and never read
 * as semantic facts: nothing here writes entities, relations or evidence. The only two paths that
 * touch other models are deliberate and go through their own validators:
 * - grouping detected boxes into a subsystem writes human `subsystem` claims via `proposeClaims`;
 * - hiding a detected box records a `suppress` view override whose target id is the box's anchor
 *   entity id (the `entityId` of the `box:` node in the design projection). Entity ids are stable
 *   across rescans and can never collide with the `cvs_` canvas ids other overrides target.
 *
 * Agent proposals land as `proposed` (ghosts) with citations validated like claim citations; a
 * person accepts them (author stays `agent`, status `active`) or deletes them, which only marks
 * them `rejected` and records an audit row. User elements are hard-deleted.
 */

export type DesignResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 404 | 409; error: string; current?: DesignElement };

/** Agent authorship for proposals (copilot actions and design generation, D02 wave 1b). */
export interface AgentAuthor {
  /** Model as reported by the runtime, for "agent: <model>" labels. */
  authorName: string;
  /** Latest snapshot the agent read; every citation is checked against it. */
  snapshotId: string;
  citations: string[];
  jobId?: string;
}

interface Row {
  id: string;
  project_id: string;
  kind: string;
  body: string;
  bound_entity_ids: string;
  author: 'user' | 'agent';
  author_name: string | null;
  citations: string;
  status: 'active' | 'proposed' | 'rejected';
  job_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

const toElement = (r: Row): DesignElement =>
  DesignElement.parse({
    id: r.id,
    projectId: r.project_id,
    body: JSON.parse(r.body),
    boundEntityIds: JSON.parse(r.bound_entity_ids),
    author: r.author,
    ...(r.author_name ? { authorName: r.author_name } : {}),
    citations: JSON.parse(r.citations),
    status: r.status,
    ...(r.job_id ? { jobId: r.job_id } : {}),
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

const issues = (e: z.ZodError) =>
  e.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ')
    .slice(0, 800);

function rowOf(db: Db, projectId: string, id: string): Row | undefined {
  return db
    .prepare('SELECT * FROM design_elements WHERE id = ? AND project_id = ?')
    .get<Row>(id, projectId);
}

export function getDesignElement(db: Db, projectId: string, id: string): DesignElement | undefined {
  const r = rowOf(db, projectId, id);
  return r ? toElement(r) : undefined;
}

/** Elements of a project; by default everything a canvas draws (active and proposed). */
export function listDesignElements(
  db: Db,
  projectId: string,
  opts: { includeRejected?: boolean } = {},
): DesignElement[] {
  return db
    .prepare(
      `SELECT * FROM design_elements WHERE project_id = ? ${opts.includeRejected ? '' : "AND status != 'rejected'"} ORDER BY created_at, id`,
    )
    .all<Row>(projectId)
    .map(toElement);
}

/** Latest published snapshot of each worktree of the project (where bound entities must exist). */
function latestSnapshots(db: Db, projectId: string): string[] {
  return db
    .prepare(
      `SELECT s.id FROM snapshots s WHERE s.project_id = ? AND s.state IN ('ready','partial')
       AND s.published_at = (SELECT max(t.published_at) FROM snapshots t WHERE t.worktree_id = s.worktree_id AND t.state IN ('ready','partial'))`,
    )
    .all<{ id: string }>(projectId)
    .map((r) => r.id);
}

function missingEntities(db: Db, projectId: string, ids: string[]): string[] {
  if (!ids.length) return [];
  const snaps = latestSnapshots(db, projectId);
  const q = db.prepare('SELECT 1 AS ok FROM entities WHERE snapshot_id = ? AND id = ?');
  return [...new Set(ids)].filter((id) => !snaps.some((s) => q.get(s, id)));
}

/**
 * Reference checks for a body: parents are live subsystem elements of the project (no cycles),
 * flow endpoints are live boxes/subsystems of the project or entities of its latest snapshots, and
 * bound entities exist. `selfId` is set for patches (an element can never be its own ancestor).
 */
function checkReferences(
  db: Db,
  projectId: string,
  body: DesignElementBody,
  bound: string[],
  selfId?: string,
): string[] {
  const reasons: string[] = [];
  const live = (id: string) => {
    const r = rowOf(db, projectId, id);
    return r && r.status !== 'rejected' ? r : undefined;
  };
  if ((body.kind === 'box' || body.kind === 'subsystem') && body.parentId) {
    const p = live(body.parentId);
    if (!p || p.kind !== 'subsystem')
      reasons.push(`parentId ${body.parentId} is not a subsystem element of this project`);
    else if (selfId) {
      // walk up from the new parent: reaching selfId would make the navigation tree cyclic
      const seen = new Set<string>();
      let cur: string | undefined = body.parentId;
      while (cur && !seen.has(cur)) {
        if (cur === selfId) {
          reasons.push('parentId would make the subsystem tree cyclic');
          break;
        }
        seen.add(cur);
        const r = rowOf(db, projectId, cur);
        cur = r ? (JSON.parse(r.body) as { parentId?: string }).parentId : undefined;
      }
    }
  }
  if (body.kind === 'flow') {
    const key = (e: typeof body.from) => ('elementId' in e ? e.elementId : e.entityId);
    if (key(body.from) === key(body.to)) reasons.push('a flow needs two different ends');
    for (const [name, end] of [
      ['from', body.from],
      ['to', body.to],
    ] as const) {
      if ('elementId' in end) {
        const r = live(end.elementId);
        if (!r || (r.kind !== 'box' && r.kind !== 'subsystem'))
          reasons.push(
            `${name}: ${end.elementId} is not a box or subsystem element of this project`,
          );
        else if (selfId && end.elementId === selfId)
          reasons.push(`${name}: a flow cannot end at itself`);
      } else if (missingEntities(db, projectId, [end.entityId]).length)
        reasons.push(
          `${name}: entity ${end.entityId} does not exist in this project's latest snapshot`,
        );
    }
  }
  const missing = missingEntities(db, projectId, bound);
  if (missing.length)
    reasons.push(
      `boundEntityIds: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''} do not exist in this project's latest snapshot`,
    );
  return reasons;
}

const projectExists = (db: Db, id: string) =>
  !!db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(id);

/**
 * Create an element. People get `author: 'user'`, `status: 'active'`. With `agent`, the element is
 * a `proposed` ghost whose citations (at least one) must be evidence the snapshot can cite.
 */
export function createDesignElement(
  db: Db,
  projectId: string,
  raw: unknown,
  agent?: AgentAuthor,
): DesignResult<{ element: DesignElement }> {
  if (!projectExists(db, projectId)) return { ok: false, status: 404, error: 'unknown_project' };
  const parsed = DesignElementInput.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: issues(parsed.error) };
  const { body, boundEntityIds } = parsed.data;
  const reasons = checkReferences(db, projectId, body, boundEntityIds);
  let citations: string[] = [];
  if (agent) {
    const a = z
      .object({
        authorName: z.string().trim().min(1).max(100),
        snapshotId: idSchema('snapshot'),
        citations: z.array(idSchema('evidence')).min(1).max(50),
        jobId: idSchema('designJob').optional(),
      })
      .safeParse(agent);
    if (!a.success) return { ok: false, status: 400, error: issues(a.error) };
    const snap = db
      .prepare('SELECT project_id, worktree_id FROM snapshots WHERE id = ?')
      .get<{ project_id: string; worktree_id: string }>(a.data.snapshotId);
    if (!snap || snap.project_id !== projectId)
      return { ok: false, status: 404, error: 'unknown_snapshot' };
    const latest = db
      .prepare(
        "SELECT id FROM snapshots WHERE worktree_id = ? AND state IN ('ready','partial') ORDER BY published_at DESC LIMIT 1",
      )
      .get<{ id: string }>(snap.worktree_id)?.id;
    if (latest !== a.data.snapshotId)
      return {
        ok: false,
        status: 409,
        error: 'stale_precondition: a newer snapshot exists; re-read and propose against it',
      };
    const check = evidenceChecker(db, a.data.snapshotId, projectId);
    citations = [...new Set(a.data.citations)];
    for (const [i, id] of citations.entries()) {
      const problem = check(id);
      if (problem) reasons.push(`citation ${i + 1}: ${problem}`);
    }
  }
  if (reasons.length) return { ok: false, status: 400, error: reasons.join('; ').slice(0, 800) };
  const now = new Date().toISOString();
  const id = newId('designElement');
  db.prepare(
    `INSERT INTO design_elements (id, project_id, kind, body, bound_entity_ids, author, author_name, citations, status, job_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    projectId,
    body.kind,
    JSON.stringify(body),
    JSON.stringify([...new Set(boundEntityIds)]),
    agent ? 'agent' : 'user',
    agent ? agent.authorName.trim() : null,
    JSON.stringify(citations),
    agent ? 'proposed' : 'active',
    agent?.jobId ?? null,
    now,
    now,
  );
  return { ok: true, element: toElement(rowOf(db, projectId, id)!) };
}

/**
 * Optimistic-revision patch. The kind of an element never changes (references would break).
 * Status may only move proposed -> active (accept) or proposed -> rejected (reject).
 */
export function patchDesignElement(
  db: Db,
  projectId: string,
  id: string,
  raw: unknown,
): DesignResult<{ element: DesignElement }> {
  const parsed = DesignElementPatch.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: issues(parsed.error) };
  const patch = parsed.data;
  return db.transaction((): DesignResult<{ element: DesignElement }> => {
    const cur = rowOf(db, projectId, id);
    if (!cur) return { ok: false, status: 404, error: 'unknown_design_element' };
    const current = toElement(cur);
    if (patch.revision !== cur.revision)
      return { ok: false, status: 409, error: 'revision conflict', current };
    if (cur.status === 'rejected')
      return { ok: false, status: 409, error: 'element was rejected', current };
    const body = patch.body ?? current.body;
    if (body.kind !== cur.kind)
      return { ok: false, status: 400, error: `kind cannot change (${cur.kind} -> ${body.kind})` };
    const status = patch.status ?? cur.status;
    if (status !== cur.status && !(cur.status === 'proposed' && status !== 'proposed'))
      return {
        ok: false,
        status: 400,
        error: `status cannot change from ${cur.status} to ${status}`,
      };
    const bound = patch.boundEntityIds ?? current.boundEntityIds;
    const reasons = checkReferences(db, projectId, body, bound, id);
    if (reasons.length) return { ok: false, status: 400, error: reasons.join('; ').slice(0, 800) };
    if (status === 'active' && cur.status === 'proposed') {
      const refs = references(body).filter((r) => rowOf(db, projectId, r)?.status !== 'active');
      if (refs.length)
        return {
          ok: false,
          status: 409,
          error: `accept ${refs.join(', ')} first: this element refers to it`,
          current,
        };
    }
    if (status === 'rejected') auditReject(db, projectId, current);
    db.prepare(
      'UPDATE design_elements SET body = ?, bound_entity_ids = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
    ).run(
      JSON.stringify(body),
      JSON.stringify([...new Set(bound)]),
      status,
      new Date().toISOString(),
      id,
    );
    return { ok: true, element: toElement(rowOf(db, projectId, id)!) };
  });
}

/** Accept a proposed (agent) element: it becomes active; author stays `agent`. */
export function acceptDesignElement(
  db: Db,
  projectId: string,
  id: string,
  revision?: number,
): DesignResult<{ element: DesignElement }> {
  return db.transaction((): DesignResult<{ element: DesignElement }> => {
    const cur = rowOf(db, projectId, id);
    if (!cur) return { ok: false, status: 404, error: 'unknown_design_element' };
    const current = toElement(cur);
    if (revision !== undefined && revision !== cur.revision)
      return { ok: false, status: 409, error: 'revision conflict', current };
    if (cur.status !== 'proposed')
      return { ok: false, status: 409, error: `element is ${cur.status}, not proposed`, current };
    // an accepted element must not hang off a ghost: its parent/endpoints must be accepted first
    const refs = references(current.body).filter(
      (r) => rowOf(db, projectId, r)?.status !== 'active',
    );
    if (refs.length)
      return {
        ok: false,
        status: 409,
        error: `accept ${refs.join(', ')} first: this element refers to it`,
        current,
      };
    db.prepare(
      "UPDATE design_elements SET status = 'active', revision = revision + 1, updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), id);
    return { ok: true, element: toElement(rowOf(db, projectId, id)!) };
  });
}

/** Design element ids a body refers to (parent, flow endpoints). */
function references(body: DesignElementBody): string[] {
  if (body.kind === 'box' || body.kind === 'subsystem') return body.parentId ? [body.parentId] : [];
  if (body.kind === 'flow')
    return [body.from, body.to].flatMap((e) => ('elementId' in e ? [e.elementId] : []));
  return [];
}

function auditReject(db: Db, projectId: string, e: DesignElement): void {
  // the audit row needs a snapshot: the latest one of the project, if any was published yet
  const snap = db
    .prepare(
      "SELECT id FROM snapshots WHERE project_id = ? AND state IN ('ready','partial') ORDER BY published_at DESC LIMIT 1",
    )
    .get<{ id: string }>(projectId);
  if (!snap) return;
  db.prepare(
    'INSERT INTO proposals (id, project_id, snapshot_id, origin, kind, accepted, rejected, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    newId('proposal'),
    projectId,
    snap.id,
    'human',
    'design-review',
    0,
    1,
    JSON.stringify({
      designElementId: e.id,
      action: 'reject',
      kind: e.body.kind,
      authorName: e.authorName,
      jobId: e.jobId,
    }),
    new Date().toISOString(),
  );
}

export interface DeleteOutcome {
  /** Elements removed (user) or marked rejected (agent), the target first. */
  deleted: string[];
  rejected: string[];
  /** Children moved up to the deleted subsystem's parent. */
  reparented: string[];
}

/**
 * Delete an element. User elements are hard-deleted; agent elements (proposed or accepted) are
 * marked `rejected` and audited. Flows ending at the element go with it; boxes and subsystems
 * inside a deleted subsystem move up to its parent, so nothing is left dangling.
 */
export function deleteDesignElement(
  db: Db,
  projectId: string,
  id: string,
  revision?: number,
): DesignResult<DeleteOutcome> {
  return db.transaction((): DesignResult<DeleteOutcome> => {
    const cur = rowOf(db, projectId, id);
    if (!cur || cur.status === 'rejected')
      return { ok: false, status: 404, error: 'unknown_design_element' };
    if (revision !== undefined && revision !== cur.revision)
      return { ok: false, status: 409, error: 'revision conflict', current: toElement(cur) };
    const out: DeleteOutcome = { deleted: [], rejected: [], reparented: [] };
    const now = new Date().toISOString();
    const remove = (r: Row) => {
      if (r.author === 'agent') {
        auditReject(db, projectId, toElement(r));
        db.prepare(
          "UPDATE design_elements SET status = 'rejected', revision = revision + 1, updated_at = ? WHERE id = ?",
        ).run(now, r.id);
        out.rejected.push(r.id);
      } else {
        db.prepare('DELETE FROM design_elements WHERE id = ?').run(r.id);
        out.deleted.push(r.id);
      }
    };
    const others = db
      .prepare(
        "SELECT * FROM design_elements WHERE project_id = ? AND status != 'rejected' AND id != ?",
      )
      .all<Row>(projectId, id);
    remove(cur);
    const parentId = (JSON.parse(cur.body) as { parentId?: string }).parentId;
    for (const o of others) {
      const body = JSON.parse(o.body) as DesignElementBody;
      if (body.kind === 'flow' && references(body).includes(id)) remove(o);
      else if ((body.kind === 'box' || body.kind === 'subsystem') && body.parentId === id) {
        const next = { ...body, parentId };
        if (!parentId) delete next.parentId;
        db.prepare(
          'UPDATE design_elements SET body = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        ).run(JSON.stringify(next), now, o.id);
        out.reparented.push(o.id);
      }
    }
    return { ok: true, ...out };
  });
}

/** Reject every proposed element of the project (generation's "replace proposals"); returns how many. */
export function rejectProposedDesignElements(db: Db, projectId: string): number {
  const ids = db
    .prepare("SELECT id FROM design_elements WHERE project_id = ? AND status = 'proposed'")
    .all<{ id: string }>(projectId)
    .map((r) => r.id);
  let n = 0;
  // a cascade may already have rejected a later id (its flow ended at an earlier one)
  for (const id of ids) {
    const r = deleteDesignElement(db, projectId, id);
    if (r.ok) n += r.rejected.length + r.deleted.length;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Grouping and hiding detected boxes

export interface GroupInput {
  snapshotId: string;
  /** Subsystem path, '/'-separated, up to three levels (e.g. "Backend/Storage"). */
  path: string;
  /** Anchor entity ids of the boxes to group (the `entityId` of their design nodes). */
  entityIds: string[];
}

export type GroupOutcome =
  | {
      ok: true;
      proposalIds: string[];
      accepted: { entityId: string; claimId: string; status: string }[];
      rejected: { entityId: string; reasons: string[] }[];
      /** Entities that already carried this human subsystem claim. */
      alreadyGrouped: string[];
      /** Earlier human subsystem claims (other paths) rejected so the box moves. */
      moved: string[];
    }
  | { ok: false; status: 400 | 404 | 409; error: string };

const GroupBody = z.object({
  snapshotId: idSchema('snapshot'),
  path: z.string().trim().min(1).max(80),
  entityIds: z.array(idSchema('entity')).min(1).max(200),
});
const BATCH = 25;

/**
 * Group detected boxes into a subsystem by writing human `subsystem` claims (one per entity),
 * citing each entity's own analyzer evidence, through `proposeClaims`. Grouping again under another
 * path moves the box: its earlier human subsystem claims are rejected (audited) first.
 */
export async function groupIntoSubsystem(db: Db, raw: unknown): Promise<GroupOutcome> {
  const parsed = GroupBody.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: issues(parsed.error) };
  const input = parsed.data;
  const segs = input.path
    .split('/')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!segs.length) return { ok: false, status: 400, error: 'path is empty' };
  if (segs.length > 3) return { ok: false, status: 400, error: 'path has more than 3 levels' };
  const value = segs.join('/');
  const norm = subsystemSegments(value).join('/');
  const snap = db
    .prepare('SELECT project_id FROM snapshots WHERE id = ?')
    .get<{ project_id: string }>(input.snapshotId);
  if (!snap) return { ok: false, status: 404, error: 'unknown_snapshot' };

  const entityRow = db.prepare('SELECT attributes FROM entities WHERE snapshot_id = ? AND id = ?');
  const humanClaims = db.prepare(
    "SELECT id, status, body FROM claims WHERE snapshot_id = ? AND subject_id = ? AND predicate = 'subsystem' AND origin = 'human' AND status NOT IN ('rejected','stale')",
  );
  const out: Extract<GroupOutcome, { ok: true }> = {
    ok: true,
    proposalIds: [],
    accepted: [],
    rejected: [],
    alreadyGrouped: [],
    moved: [],
  };
  const todo: { entityId: string; evidenceIds: string[] }[] = [];
  const stale: string[] = [];
  for (const entityId of [...new Set(input.entityIds)]) {
    const e = entityRow.get<{ attributes: string }>(input.snapshotId, entityId);
    if (!e) {
      out.rejected.push({ entityId, reasons: [`entity ${entityId} is not in this snapshot`] });
      continue;
    }
    const prior = humanClaims
      .all<{ id: string; status: string; body: string }>(input.snapshotId, entityId)
      .map((c) => ({
        id: c.id,
        path: subsystemSegments((JSON.parse(c.body) as { value?: unknown }).value).join('/'),
      }));
    if (prior.some((c) => c.path === norm)) {
      out.alreadyGrouped.push(entityId);
      stale.push(...prior.filter((c) => c.path !== norm).map((c) => c.id));
      continue;
    }
    stale.push(...prior.map((c) => c.id));
    const attrs = JSON.parse(e.attributes) as { evidenceIds?: unknown };
    const evidenceIds = Array.isArray(attrs.evidenceIds)
      ? attrs.evidenceIds.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [];
    todo.push({ entityId, evidenceIds });
  }
  for (let off = 0; off < todo.length; off += BATCH) {
    const chunk = todo.slice(off, off + BATCH);
    const r = await proposeClaims(db, {
      snapshotId: input.snapshotId,
      origin: 'human',
      claims: chunk.map((c) => ({
        subjectId: c.entityId,
        predicate: 'subsystem',
        value,
        citations: c.evidenceIds.map((evidenceId) => ({ evidenceId })),
        rationale: 'grouped on the System design whiteboard',
      })),
    });
    if (!r.ok) return r;
    out.proposalIds.push(r.proposalId);
    for (const a of r.accepted)
      out.accepted.push({
        entityId: chunk[a.index]!.entityId,
        claimId: a.claimId,
        status: a.status,
      });
    for (const x of r.rejected)
      out.rejected.push({ entityId: chunk[x.index]!.entityId, reasons: x.reasons });
  }
  // move: only boxes whose new claim was stored (or already existed) drop their older grouping
  const keep = new Set([...out.accepted.map((a) => a.entityId), ...out.alreadyGrouped]);
  const subjectOf = db.prepare('SELECT subject_id FROM claims WHERE snapshot_id = ? AND id = ?');
  for (const id of stale) {
    const s = subjectOf.get<{ subject_id: string }>(input.snapshotId, id)?.subject_id;
    if (s && keep.has(s) && rejectClaim(db, id, `regrouped into ${value}`).ok) out.moved.push(id);
  }
  return out;
}

/**
 * Hide (or show again) a detected box: a `suppress` override on its anchor entity id. Only the view
 * changes; the entity and its relations stay in the snapshot.
 */
export function hideDetectedBox(
  db: Db,
  projectId: string,
  entityId: string,
  enabled: boolean,
): DesignResult<{ targetId: string; enabled: boolean }> {
  if (!projectExists(db, projectId)) return { ok: false, status: 404, error: 'unknown_project' };
  if (!idSchema('entity').safeParse(entityId).success)
    return { ok: false, status: 400, error: 'entityId must be an ent_ id' };
  if (enabled && missingEntities(db, projectId, [entityId]).length)
    return {
      ok: false,
      status: 404,
      error: `entity ${entityId} does not exist in this project's latest snapshot`,
    };
  setOverride(db, projectId, entityId, 'suppress', enabled);
  return { ok: true, targetId: entityId, enabled };
}
