import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { z } from 'zod';
import {
  Claim,
  Evidence,
  ModelMetadata,
  RepoRelativePath,
  idSchema,
  newId,
  redactExcerpt,
  redactValue,
  type JsonValue,
} from '@atlas/schema';
import type { Db } from '@atlas/store';

/**
 * Validation of claims proposed by models (through MCP or a provider) and by people (plan §6, §7.5,
 * §12). Proposals add labeled claims; they can never overwrite observed facts or create relations.
 * Every citation must point at real evidence of the precondition snapshot: an existing evidence row
 * of this project that matches the snapshot's manifest, a run of this project, or a file range of
 * the snapshot whose bytes still match (and whose quote, if given, is really there). Citations to
 * files are stored as evidence pinned to the file's hash, so an edit makes the claim stale.
 */

/** The closed set of things a proposal may say. Anything else is rejected. */
export const PREDICATES = {
  summary: z.string().trim().min(1).max(600),
  responsibility: z.string().trim().min(1).max(300),
  subsystem: z.string().trim().min(1).max(80),
  role: z.enum([
    'entrypoint',
    'api',
    'worker',
    'library',
    'storage',
    'ui',
    'test',
    'config',
    'tooling',
    'other',
  ]),
  concern: z.string().trim().min(1).max(400),
  /** A relationship the model believes in. Stays a claim: it never becomes a relation row. */
  'depends-on': z.object({
    entityId: idSchema('entity'),
    reason: z.string().trim().min(1).max(300),
  }),
} as const;
export type Predicate = keyof typeof PREDICATES;

const MAX_LINES_PER_CITATION = 200;

export const Citation = z.union([
  z.object({ evidenceId: idSchema('evidence') }).strict(),
  z
    .object({
      path: RepoRelativePath,
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      quote: z.string().min(1).max(400).optional(),
    })
    .strict(),
]);
export type Citation = z.infer<typeof Citation>;

export const ClaimProposal = z.object({
  subjectId: z.union([idSchema('entity'), idSchema('relation')]),
  predicate: z.enum(Object.keys(PREDICATES) as [Predicate, ...Predicate[]]),
  value: z.unknown(),
  citations: z.array(Citation).max(10).default([]),
  /** Short public explanation for reviewers; never hidden reasoning. */
  rationale: z.string().max(500).optional(),
});

export const ProposalBatch = z.object({
  snapshotId: idSchema('snapshot'),
  origin: z.enum(['model', 'human']),
  claims: z.array(ClaimProposal).min(1).max(25),
  modelMetadata: ModelMetadata.optional(),
});
export type ProposalBatch = z.input<typeof ProposalBatch>;

export interface ProposalResult {
  proposalId: string;
  accepted: { index: number; claimId: string; status: 'supported' | 'inferred' }[];
  rejected: { index: number; reasons: string[] }[];
}

export type ProposeOutcome =
  ({ ok: true } & ProposalResult) | { ok: false; status: 400 | 404 | 409; error: string };

interface FileCheck {
  path: string;
  sha256: string;
  lines: string[];
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

export async function proposeClaims(db: Db, raw: unknown): Promise<ProposeOutcome> {
  const parsed = ProposalBatch.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      status: 400,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 800),
    };
  const batch = parsed.data;
  if (batch.origin === 'model' && !batch.modelMetadata)
    return {
      ok: false,
      status: 400,
      error: 'model proposals need modelMetadata (provider, model, promptTemplateVersion)',
    };
  const snap = db
    .prepare(
      `SELECT s.id, s.project_id, s.worktree_id, s.state, w.root_path FROM snapshots s JOIN worktrees w ON w.id = s.worktree_id WHERE s.id = ?`,
    )
    .get<{ id: string; project_id: string; worktree_id: string; state: string; root_path: string }>(
      batch.snapshotId,
    );
  if (!snap) return { ok: false, status: 404, error: 'unknown_snapshot' };
  const latest = () =>
    db
      .prepare(
        "SELECT id FROM snapshots WHERE worktree_id = ? AND state IN ('ready','partial') ORDER BY published_at DESC LIMIT 1",
      )
      .get<{ id: string }>(snap.worktree_id)?.id;
  if (latest() !== snap.id)
    return {
      ok: false,
      status: 409,
      error: 'stale_precondition: a newer snapshot exists; re-read and propose against it',
    };

  const entityExists = db.prepare('SELECT 1 AS ok FROM entities WHERE snapshot_id = ? AND id = ?');
  const relationExists = db.prepare(
    'SELECT 1 AS ok FROM relations WHERE snapshot_id = ? AND id = ?',
  );
  const manifest = db.prepare(
    'SELECT sha256, size FROM snapshot_files WHERE snapshot_id = ? AND path = ?',
  );
  const evidenceRow = db.prepare(
    'SELECT project_id, path, content_hash, run_id, body FROM evidence WHERE id = ?',
  );
  const runRow = db.prepare('SELECT project_id FROM runs WHERE id = ?');
  const files = new Map<string, FileCheck | string>();
  const root = await realpath(snap.root_path).catch(() => snap.root_path);

  /** The snapshot's bytes of a file, or why they cannot be used. */
  const fileAt = async (path: string): Promise<FileCheck | string> => {
    const hit = files.get(path);
    if (hit) return hit;
    let out: FileCheck | string;
    const m = manifest.get<{ sha256: string; size: number }>(snap.id, path);
    if (!m) out = `${path} is not part of this snapshot`;
    else if (m.size > 2 * 1024 * 1024) out = `${path} is too large to cite`;
    else {
      try {
        const abs = await realpath(join(root, path));
        if (!abs.startsWith(root + sep)) throw new Error('outside root');
        const bytes = await readFile(abs);
        out =
          createHash('sha256').update(bytes).digest('hex') === m.sha256
            ? { path, sha256: m.sha256, lines: bytes.toString('utf8').split('\n') }
            : `${path} changed since the snapshot; rescan and cite the current text`;
      } catch {
        out = `${path} cannot be read`;
      }
    }
    files.set(path, out);
    return out;
  };

  const now = new Date().toISOString();
  const extractorId = batch.origin === 'model' ? 'model-citation' : 'human-citation';
  type Prepared = {
    index: number;
    claim: Claim;
    evidence: { id: string; body: Evidence; path: string | null; hash: string | null }[];
  };
  const prepared: Prepared[] = [];
  const rejected: ProposalResult['rejected'] = [];

  for (const [index, c] of batch.claims.entries()) {
    const reasons: string[] = [];
    const isEntity = c.subjectId.startsWith('ent_');
    if (!(isEntity ? entityExists : relationExists).get(snap.id, c.subjectId))
      reasons.push(`subject ${c.subjectId} does not exist in snapshot ${snap.id}`);
    const value = PREDICATES[c.predicate].safeParse(c.value);
    if (!value.success)
      reasons.push(`value for "${c.predicate}": ${value.error.issues[0]?.message ?? 'invalid'}`);
    else if (c.predicate === 'depends-on') {
      const target = (value.data as { entityId: string }).entityId;
      if (target === c.subjectId) reasons.push('depends-on cannot point at its own subject');
      else if (!entityExists.get(snap.id, target))
        reasons.push(`depends-on target ${target} does not exist in this snapshot`);
    }
    if (batch.origin === 'model' && c.citations.length === 0)
      reasons.push('model claims must cite evidence');

    const evidenceIds: string[] = [];
    const newEvidence: Prepared['evidence'] = [];
    for (const [ci, cit] of c.citations.entries()) {
      const where = `citation ${ci + 1}`;
      if ('evidenceId' in cit) {
        const ev = evidenceRow.get<{
          project_id: string;
          path: string | null;
          content_hash: string | null;
          run_id: string | null;
          body: string;
        }>(cit.evidenceId);
        if (!ev || ev.project_id !== snap.project_id) {
          reasons.push(`${where}: evidence ${cit.evidenceId} does not exist in this project`);
          continue;
        }
        if (ev.path) {
          const m = manifest.get<{ sha256: string }>(snap.id, ev.path);
          if (!m || m.sha256 !== ev.content_hash) {
            reasons.push(
              `${where}: evidence ${cit.evidenceId} describes a different version of ${ev.path} than this snapshot`,
            );
            continue;
          }
        } else {
          // pathless evidence can never go stale, so only run evidence of this project qualifies
          const runId = ev.run_id ?? (JSON.parse(ev.body) as { runId?: string }).runId;
          if (!runId || runRow.get<{ project_id: string }>(runId)?.project_id !== snap.project_id) {
            reasons.push(
              `${where}: evidence ${cit.evidenceId} is neither file evidence of this snapshot nor run evidence of this project`,
            );
            continue;
          }
        }
        evidenceIds.push(cit.evidenceId);
        continue;
      }
      if (cit.endLine < cit.startLine) {
        reasons.push(`${where}: endLine is before startLine`);
        continue;
      }
      if (cit.endLine - cit.startLine + 1 > MAX_LINES_PER_CITATION) {
        reasons.push(`${where}: cite at most ${MAX_LINES_PER_CITATION} lines`);
        continue;
      }
      const f = await fileAt(cit.path);
      if (typeof f === 'string') {
        reasons.push(`${where}: ${f}`);
        continue;
      }
      const lineCount = f.lines.at(-1) === '' ? f.lines.length - 1 : f.lines.length;
      if (cit.endLine > lineCount) {
        reasons.push(`${where}: ${cit.path} has ${lineCount} lines, not ${cit.endLine}`);
        continue;
      }
      const text = f.lines.slice(cit.startLine - 1, cit.endLine).join('\n');
      if (cit.quote && !normalize(text).includes(normalize(cit.quote))) {
        reasons.push(
          `${where}: the quote does not appear in ${cit.path}:${cit.startLine}-${cit.endLine}`,
        );
        continue;
      }
      const id = newId('evidence');
      const body = Evidence.parse({
        schemaVersion: 1,
        id,
        sourceKind: 'source-file',
        repoRelativePath: cit.path,
        contentHash: f.sha256,
        startLine: cit.startLine,
        endLine: cit.endLine,
        snapshotId: snap.id,
        extractorId,
        extractorVersion: '1',
        capturedAt: now,
        excerpt: redactExcerpt(text.slice(0, 400)).text,
        redactionState: redactExcerpt(text.slice(0, 400)).redacted ? 'redacted' : 'none',
      });
      newEvidence.push({ id, body, path: cit.path, hash: f.sha256 });
      evidenceIds.push(id);
    }

    if (reasons.length) {
      rejected.push({ index, reasons });
      continue;
    }
    // models label and explain; they never produce supported facts (plan §7.5)
    const status = batch.origin === 'human' && evidenceIds.length ? 'supported' : 'inferred';
    const claim = Claim.parse({
      schemaVersion: 1,
      id: newId('claim'),
      subjectId: c.subjectId,
      predicate: c.predicate,
      value: value.success ? (value.data as JsonValue) : null,
      origin: batch.origin,
      evidenceIds,
      status,
      snapshotId: snap.id,
      modelMetadata: batch.origin === 'model' ? batch.modelMetadata : undefined,
    });
    prepared.push({ index, claim, evidence: newEvidence });
  }

  const proposalId = newId('proposal');
  const result: ProposalResult = {
    proposalId,
    accepted: prepared.map((p) => ({
      index: p.index,
      claimId: p.claim.id,
      status: p.claim.status as 'supported' | 'inferred',
    })),
    rejected,
  };
  const audit = {
    origin: batch.origin,
    modelMetadata: batch.modelMetadata,
    items: batch.claims.map((c, index) => ({
      index,
      subjectId: c.subjectId,
      predicate: c.predicate,
      value: redactValue(c.value as JsonValue).value,
      citations: c.citations,
      rationale: c.rationale,
      outcome:
        result.accepted.find((a) => a.index === index) ??
        result.rejected.find((r) => r.index === index),
    })),
  };
  let stale = false;
  db.transaction(() => {
    // a publish between validation and here would have carried claims forward without these
    if (latest() !== snap.id) {
      stale = true;
      return;
    }
    const insEv = db.prepare(
      'INSERT INTO evidence (id, project_id, body, path, content_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    );
    const insClaim = db.prepare(
      'INSERT INTO claims (snapshot_id, id, subject_id, predicate, origin, status, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const p of prepared) {
      for (const e of p.evidence)
        insEv.run(e.id, snap.project_id, JSON.stringify(e.body), e.path, e.hash, now);
      insClaim.run(
        snap.id,
        p.claim.id,
        p.claim.subjectId,
        p.claim.predicate,
        p.claim.origin,
        p.claim.status,
        JSON.stringify(p.claim),
      );
    }
    db.prepare(
      'INSERT INTO proposals (id, project_id, snapshot_id, origin, kind, accepted, rejected, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      proposalId,
      snap.project_id,
      snap.id,
      batch.origin,
      'claims',
      prepared.length,
      rejected.length,
      JSON.stringify(audit),
      now,
    );
  });
  if (stale)
    return {
      ok: false,
      status: 409,
      error:
        'stale_precondition: a newer snapshot was published while validating; re-read and propose again',
    };
  return { ok: true, ...result };
}

/** A person rejects a claim. The rejection is kept across later snapshots (carry-forward keeps it). */
export function rejectClaim(
  db: Db,
  claimId: string,
  reason: string,
): { ok: true } | { ok: false; status: 404 | 409; error: string } {
  const row = db
    .prepare(
      `SELECT c.snapshot_id, c.body, s.project_id, s.worktree_id FROM claims c JOIN snapshots s ON s.id = c.snapshot_id
       WHERE c.id = ? ORDER BY s.published_at DESC LIMIT 1`,
    )
    .get<{ snapshot_id: string; body: string; project_id: string; worktree_id: string }>(claimId);
  if (!row) return { ok: false, status: 404, error: 'unknown_claim' };
  const body = JSON.parse(row.body) as Record<string, unknown>;
  if (body.status === 'rejected') return { ok: false, status: 409, error: 'already rejected' };
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      "UPDATE claims SET status = 'rejected', body = ? WHERE snapshot_id = ? AND id = ?",
    ).run(JSON.stringify({ ...body, status: 'rejected' }), row.snapshot_id, claimId);
    db.prepare(
      'INSERT INTO proposals (id, project_id, snapshot_id, origin, kind, accepted, rejected, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      newId('proposal'),
      row.project_id,
      row.snapshot_id,
      'human',
      'review',
      0,
      1,
      JSON.stringify({ claimId, action: 'reject', reason: reason.slice(0, 500) }),
      now,
    );
  });
  return { ok: true };
}

export function listProposals(db: Db, projectId: string, limit = 50) {
  return db
    .prepare(
      'SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    )
    .all<{
      id: string;
      snapshot_id: string;
      origin: string;
      kind: string;
      accepted: number;
      rejected: number;
      body: string;
      created_at: string;
    }>(projectId, Math.min(Math.max(limit, 1), 200))
    .map((r) => ({
      id: r.id,
      snapshotId: r.snapshot_id,
      origin: r.origin,
      kind: r.kind,
      accepted: r.accepted,
      rejected: r.rejected,
      createdAt: r.created_at,
      detail: JSON.parse(r.body) as unknown,
    }));
}
