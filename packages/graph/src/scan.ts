import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CoverageReport,
  Entity,
  Evidence,
  newId,
  Relation,
  Snapshot,
  type CoverageGap,
  type Diagnostic,
  type SupportLevel,
  type Worktree,
} from '@atlas/schema';
import {
  buildInventory,
  ContentChangedError,
  redactExcerpt,
  type Analyzer,
  type AnalyzerContext,
  type AnalyzerOutput,
  type EvidenceRef,
  type Inventory,
  type InventoryFile,
} from '@atlas/analyzers';
import { json, type Db } from '@atlas/store';
import { buildCoverage, type AnalyzerRunRecord } from './coverage.ts';
import { stableId } from './ids.ts';
import { manifestDigest } from './manifest.ts';

export const CORE_PRODUCER = 'atlas-core';
export const SYSTEM_KEY = 'system';

export interface ScanOptions {
  analyzers: Analyzer[];
  signal?: AbortSignal;
  analyzerTimeoutMs?: number;
  maxFileBytes?: number;
  now?: () => Date;
  onProgress?: (p: { phase: 'inventory' | 'analyze' | 'publish'; detail?: string }) => void;
}

export interface ScanResult {
  snapshot: Snapshot;
  coverage: CoverageReport;
  counts: {
    files: number;
    entities: number;
    relations: number;
    evidence: number;
    carriedForward: number;
  };
}

interface Built {
  entities: Map<string, { entity: Entity; producer: string }>;
  relations: Map<string, { relation: Relation; producer: string }>;
  evidence: Map<string, Evidence>;
  gaps: CoverageGap[];
  diagnostics: Diagnostic[];
}

function hashPath(...parts: (string | number | undefined)[]) {
  return parts.map((p) => String(p ?? '')).join('\u0000');
}

/**
 * Scan one worktree and publish a new snapshot (plan §7). The previous published snapshot stays
 * visible until the single publish transaction commits. Never executes target code.
 */
export async function scanWorktree(
  db: Db,
  worktree: Worktree,
  opts: ScanOptions,
): Promise<ScanResult> {
  const now = opts.now ?? (() => new Date());
  const signal = opts.signal ?? new AbortController().signal;
  const project = db
    .prepare('SELECT display_name FROM projects WHERE id = ?')
    .get<{ display_name: string }>(worktree.projectId);
  if (!project) throw new Error(`unknown project ${worktree.projectId}`);

  opts.onProgress?.({ phase: 'inventory' });
  const inventory = await buildInventory(worktree.rootPath, {
    signal,
    maxFileBytes: opts.maxFileBytes,
  });
  const digest = manifestDigest(inventory.files);
  const analyzerVersions = Object.fromEntries(opts.analyzers.map((a) => [a.id, a.version]));
  const configDigest = createHash('sha256')
    .update(json({ analyzerVersions, maxFileBytes: opts.maxFileBytes ?? null }))
    .digest('hex');

  const previous = db
    .prepare(
      `SELECT id FROM snapshots WHERE worktree_id = ? AND state IN ('ready','partial')
       ORDER BY published_at DESC, created_at DESC LIMIT 1`,
    )
    .get<{ id: string }>(worktree.id);

  const snapshotId = newId('snapshot');
  const createdAt = now().toISOString();
  db.prepare(
    `INSERT INTO snapshots (id, project_id, worktree_id, head_commit, dirty_tree_digest, dirty, created_at,
       analyzer_versions, config_digest, state, previous_snapshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', ?)`,
  ).run(
    snapshotId,
    worktree.projectId,
    worktree.id,
    inventory.git?.head ?? null,
    digest,
    inventory.git ? (inventory.git.dirty ? 1 : 0) : 1,
    createdAt,
    json(analyzerVersions),
    configDigest,
    previous?.id ?? null,
  );

  try {
    const byPath = new Map(inventory.files.map((f) => [f.path, f]));
    const ctx: AnalyzerContext = {
      rootPath: inventory.root,
      projectName: project.display_name,
      files: inventory.files,
      signal,
      async readFile(path) {
        const entry = byPath.get(path);
        if (!entry) throw new Error(`analyzers may only read inventoried files: ${path}`);
        const bytes = await readFile(join(inventory.root, path));
        if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
          throw new ContentChangedError(path);
        return bytes.toString('utf8');
      },
    };

    const runs: AnalyzerRunRecord[] = [];
    const outputs: { analyzer: Analyzer; output: AnalyzerOutput }[] = [];
    const failedProducers: string[] = [];
    const support = new Map<string, SupportLevel>();
    let changedDuringScan = new Set<string>();

    for (const analyzer of opts.analyzers) {
      signal.throwIfAborted();
      opts.onProgress?.({ phase: 'analyze', detail: analyzer.id });
      const t0 = performance.now();
      const rec: AnalyzerRunRecord = {
        id: analyzer.id,
        version: analyzer.version,
        status: 'ok',
        filesAnalyzed: 0,
        durationMs: 0,
        diagnostics: [],
      };
      try {
        if (!(await analyzer.detect(ctx))) {
          rec.status = 'skipped';
        } else {
          const output = await withTimeout(
            analyzer.extract(inventory.files, ctx),
            opts.analyzerTimeoutMs ?? 120_000,
            signal,
          );
          const resolved = analyzer.resolve
            ? await withTimeout(
                analyzer.resolve(output, ctx),
                opts.analyzerTimeoutMs ?? 120_000,
                signal,
              )
            : output;
          outputs.push({ analyzer, output: resolved });
          rec.filesAnalyzed = resolved.handled.length;
          rec.diagnostics = resolved.diagnostics;
          if (resolved.diagnostics.some((d) => d.severity === 'error')) rec.status = 'partial';
          for (const h of resolved.handled) {
            const cur = support.get(h.path);
            if (!cur || rank(h.support) > rank(cur)) support.set(h.path, h.support);
          }
        }
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ContentChangedError) {
          changedDuringScan.add(e.path);
          rec.status = 'failed';
          rec.diagnostics = [
            { severity: 'error', code: 'changed-during-scan', message: e.message, path: e.path },
          ];
        } else {
          rec.status = 'failed';
          const timeout = e instanceof TimeoutError;
          rec.diagnostics = [
            {
              severity: 'error',
              code: timeout ? 'analyzer-timeout' : 'analyzer-failed',
              message: String((e as Error).message ?? e).slice(0, 500),
            },
          ];
        }
        failedProducers.push(analyzer.id);
      }
      rec.durationMs = performance.now() - t0;
      runs.push(rec);
    }

    const built = assemble(
      worktree.projectId,
      project.display_name,
      snapshotId,
      inventory,
      outputs,
    );
    const carried = carryForward(db, previous?.id, failedProducers, snapshotId, built);

    // Re-validate the manifest right before publication (plan §9 filesystem races).
    changedDuringScan = new Set([...changedDuringScan, ...changedSince(inventory)]);
    const extraGaps: CoverageGap[] = [...built.gaps];
    for (const p of changedDuringScan)
      extraGaps.push({
        kind: 'changed-during-scan',
        path: p,
        detail: 'file changed while it was being analyzed; rescan to refresh',
      });

    const coverage = CoverageReport.parse(
      buildCoverage({
        snapshotId,
        manifestDigest: digest,
        inventory,
        support,
        analyzers: runs,
        extraGaps,
      }),
    );
    const partial =
      changedDuringScan.size > 0 ||
      runs.some((r) => r.status === 'failed' || r.status === 'partial');
    const state = partial ? 'partial' : 'ready';

    signal.throwIfAborted();
    opts.onProgress?.({ phase: 'publish' });
    const publishedAt = now().toISOString();
    db.transaction(() => {
      const insFile = db.prepare(
        'INSERT INTO snapshot_files (snapshot_id, path, sha256, size, language, support, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const f of inventory.files)
        insFile.run(
          snapshotId,
          f.path,
          f.sha256,
          f.size,
          f.language,
          support.get(f.path) ?? f.support,
          f.role,
        );
      const insEv = db.prepare(
        'INSERT OR IGNORE INTO evidence (id, project_id, body, path, content_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      );
      for (const ev of built.evidence.values())
        insEv.run(
          ev.id,
          worktree.projectId,
          json(ev),
          ev.repoRelativePath ?? null,
          ev.contentHash ?? null,
          ev.capturedAt,
        );
      const insEnt = db.prepare(
        `INSERT INTO entities (snapshot_id, id, project_id, kind, canonical_name, display_name, owner_entity_id, lifecycle, attributes,
           first_seen_snapshot, last_seen_snapshot, producer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insSearch = db.prepare(
        'INSERT INTO entity_search (snapshot_id, entity_id, kind, canonical_name, display_name) VALUES (?, ?, ?, ?, ?)',
      );
      const firstSeen = previous
        ? new Map(
            db
              .prepare('SELECT id, first_seen_snapshot AS f FROM entities WHERE snapshot_id = ?')
              .all<{ id: string; f: string }>(previous.id)
              .map((r) => [r.id, r.f]),
          )
        : new Map<string, string>();
      for (const { entity: e, producer } of built.entities.values()) {
        insEnt.run(
          snapshotId,
          e.id,
          e.projectId,
          e.kind,
          e.canonicalName,
          e.displayName,
          e.ownerEntityId ?? null,
          e.lifecycle,
          json(e.attributes),
          firstSeen.get(e.id) ?? e.firstSeenSnapshot,
          e.lastSeenSnapshot,
          producer,
        );
        insSearch.run(snapshotId, e.id, e.kind, e.canonicalName, e.displayName);
      }
      const insRel = db.prepare(
        `INSERT INTO relations (snapshot_id, id, from_id, to_id, kind, qualifiers, evidence_ids, status, confidence, producer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { relation: r, producer } of built.relations.values()) {
        insRel.run(
          snapshotId,
          r.id,
          r.fromId,
          r.toId,
          r.kind,
          json(r.qualifiers),
          json(r.evidenceIds),
          r.status,
          r.confidenceCategory,
          producer,
        );
      }
      db.prepare('INSERT INTO coverage_reports (id, snapshot_id, body) VALUES (?, ?, ?)').run(
        coverage.id,
        snapshotId,
        json(coverage),
      );
      db.prepare(
        `UPDATE snapshots SET state = 'superseded' WHERE worktree_id = ? AND id != ? AND state IN ('ready','partial')`,
      ).run(worktree.id, snapshotId);
      db.prepare(
        'UPDATE snapshots SET state = ?, published_at = ?, coverage_report_id = ? WHERE id = ?',
      ).run(state, publishedAt, coverage.id, snapshotId);
    });

    const snapshot = getSnapshot(db, snapshotId)!;
    return {
      snapshot,
      coverage,
      counts: {
        files: inventory.files.length,
        entities: built.entities.size,
        relations: built.relations.size,
        evidence: built.evidence.size,
        carriedForward: carried,
      },
    };
  } catch (e) {
    db.prepare("UPDATE snapshots SET state = 'failed' WHERE id = ? AND state = 'building'").run(
      snapshotId,
    );
    throw e;
  }
}

const rank = (s: SupportLevel) => ['skipped', 'inventory-only', 'syntax', 'deep'].indexOf(s);

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`analyzer exceeded ${ms} ms`)), ms);
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => (clearTimeout(t), signal.removeEventListener('abort', onAbort), resolve(v)),
      (e) => (clearTimeout(t), signal.removeEventListener('abort', onAbort), reject(e)),
    );
  });
}

function changedSince(inv: Inventory): string[] {
  const out: string[] = [];
  for (const f of inv.files) {
    try {
      const st = statSync(join(inv.root, f.path));
      if (st.size !== f.size || st.mtimeMs !== f.mtimeMs) out.push(f.path);
    } catch {
      out.push(f.path);
    }
  }
  return out;
}

function evidenceSourceKind(f: InventoryFile | undefined): Evidence['sourceKind'] {
  if (!f) return 'source-file';
  if (f.role === 'manifest' || f.role === 'lockfile') return 'manifest';
  if (['config', 'deploy', 'ci', 'schema'].includes(f.role)) return 'config';
  return 'source-file';
}

/** Turn analyzer observations into validated, ID-assigned graph records. */
function assemble(
  projectId: string,
  projectName: string,
  snapshotId: string,
  inventory: Inventory,
  outputs: { analyzer: Analyzer; output: AnalyzerOutput }[],
): Built {
  const built: Built = {
    entities: new Map(),
    relations: new Map(),
    evidence: new Map(),
    gaps: [],
    diagnostics: [],
  };
  const files = new Map(inventory.files.map((f) => [f.path, f]));
  const keyToId = new Map<string, string>();
  const capturedAt = new Date().toISOString();

  const addEvidence = (ref: EvidenceRef, analyzer: Analyzer): string | undefined => {
    const f = files.get(ref.path);
    if (!f || f.sha256 !== ref.contentHash) {
      built.diagnostics.push({
        severity: 'warning',
        code: 'evidence-not-in-manifest',
        message: `evidence for ${ref.path} does not match the snapshot manifest`,
        path: ref.path,
      });
      return undefined;
    }
    const id = stableId(
      'evidence',
      projectId,
      hashPath(
        analyzer.id,
        analyzer.version,
        ref.path,
        ref.contentHash,
        ref.startLine,
        ref.endLine,
      ),
    );
    if (!built.evidence.has(id)) {
      const red = ref.excerpt !== undefined ? redactExcerpt(ref.excerpt.slice(0, 4000)) : undefined;
      built.evidence.set(
        id,
        Evidence.parse({
          schemaVersion: 1,
          id,
          sourceKind: evidenceSourceKind(f),
          repoRelativePath: ref.path,
          contentHash: ref.contentHash,
          startLine: ref.startLine,
          endLine: ref.endLine,
          snapshotId,
          extractorId: analyzer.id,
          extractorVersion: analyzer.version,
          capturedAt,
          excerpt: red?.text,
          redactionState: red?.redacted ? 'redacted' : 'none',
        }),
      );
    }
    return id;
  };

  const systemId = stableId('entity', projectId, SYSTEM_KEY);
  keyToId.set(SYSTEM_KEY, systemId);
  built.entities.set(systemId, {
    producer: CORE_PRODUCER,
    entity: Entity.parse({
      schemaVersion: 1,
      id: systemId,
      projectId,
      kind: 'system',
      canonicalName: `system:${projectName}`,
      displayName: projectName,
      lifecycle: 'active',
      attributes: { rootPath: inventory.root },
      firstSeenSnapshot: snapshotId,
      lastSeenSnapshot: snapshotId,
    }),
  });

  // First pass: identities. Second pass: owners (all keys known by then).
  const pendingOwners: { id: string; ownerKey?: string; producer: string }[] = [];
  for (const { analyzer, output } of outputs) {
    for (const o of output.entities) {
      const id = stableId('entity', projectId, o.key);
      if (built.entities.has(id)) {
        built.diagnostics.push({
          severity: 'info',
          code: 'duplicate-entity-key',
          message: `${analyzer.id} re-declared ${o.key}; first declaration kept`,
        });
        continue;
      }
      keyToId.set(o.key, id);
      const attributes = {
        ...(o.attributes ?? {}),
        evidenceIds: o.evidence
          .map((r) => addEvidence(r, analyzer))
          .filter((x): x is string => !!x),
      };
      built.entities.set(id, {
        producer: analyzer.id,
        entity: Entity.parse({
          schemaVersion: 1,
          id,
          projectId,
          kind: o.kind,
          canonicalName: o.canonicalName,
          displayName: o.displayName,
          lifecycle: 'active',
          attributes,
          firstSeenSnapshot: snapshotId,
          lastSeenSnapshot: snapshotId,
        }),
      });
      pendingOwners.push({ id, ownerKey: o.ownerKey, producer: analyzer.id });
    }
  }
  for (const p of pendingOwners) {
    const ownerId = p.ownerKey ? keyToId.get(p.ownerKey) : systemId;
    const e = built.entities.get(p.id)!.entity;
    e.ownerEntityId = ownerId ?? systemId;
    if (p.ownerKey && !ownerId)
      built.diagnostics.push({
        severity: 'warning',
        code: 'unknown-owner',
        message: `owner ${p.ownerKey} not found; attached to system`,
      });
  }
  breakOwnershipCycles(built, systemId);

  for (const { analyzer, output } of outputs) {
    for (const r of output.relations) {
      const fromId = keyToId.get(r.fromKey);
      const toId = keyToId.get(r.toKey);
      if (!fromId || !toId || !r.resolved) {
        const ref = r.evidence[0];
        built.gaps.push({
          kind: 'unresolved-reference',
          path: ref?.path,
          analyzerId: analyzer.id,
          detail: `${r.kind} reference from ${r.fromKey} to ${r.toKey.replace(/^unresolved:/, '')} could not be resolved`,
        });
        continue;
      }
      const qualifiers = r.qualifiers ?? {};
      const id = stableId(
        'relation',
        projectId,
        hashPath(r.kind, fromId, toId, json(Object.entries(qualifiers).sort())),
      );
      const evidenceIds = r.evidence
        .map((ref) => addEvidence(ref, analyzer))
        .filter((x): x is string => !!x);
      const existing = built.relations.get(id);
      if (existing) {
        existing.relation.evidenceIds = [
          ...new Set([...existing.relation.evidenceIds, ...evidenceIds]),
        ];
        continue;
      }
      const supported =
        evidenceIds.length > 0 &&
        (r.confidence === 'exact' || r.confidence === 'resolved' || r.confidence === 'observed');
      built.relations.set(id, {
        producer: analyzer.id,
        relation: Relation.parse({
          schemaVersion: 1,
          id,
          fromId,
          toId,
          kind: r.kind,
          qualifiers,
          evidenceIds,
          status: supported ? 'supported' : 'inferred',
          confidenceCategory: r.confidence,
          snapshotId,
        }),
      });
    }
  }
  return built;
}

/** Ownership must be acyclic (plan §4). A cycle is broken by re-parenting to the system. */
function breakOwnershipCycles(built: Built, systemId: string) {
  for (const { entity } of built.entities.values()) {
    const seen = new Set<string>([entity.id]);
    let cur = entity.ownerEntityId;
    while (cur) {
      if (seen.has(cur)) {
        built.diagnostics.push({
          severity: 'warning',
          code: 'ownership-cycle',
          message: `ownership cycle at ${entity.canonicalName}; attached to system`,
        });
        entity.ownerEntityId = systemId;
        break;
      }
      seen.add(cur);
      cur = built.entities.get(cur)?.entity.ownerEntityId;
    }
  }
}

/**
 * A failing analyzer must not erase what it previously found (plan §7). Its rows from the previous
 * snapshot are carried into the new one marked stale.
 */
function carryForward(
  db: Db,
  previousId: string | undefined,
  producers: string[],
  snapshotId: string,
  built: Built,
): number {
  if (!previousId || producers.length === 0) return 0;
  let n = 0;
  const marks = producers.map(() => '?').join(',');
  const ents = db
    .prepare(`SELECT * FROM entities WHERE snapshot_id = ? AND producer IN (${marks})`)
    .all<Record<string, string>>(previousId, ...producers);
  for (const r of ents) {
    if (built.entities.has(r.id!)) continue;
    built.entities.set(r.id!, {
      producer: r.producer!,
      entity: Entity.parse({
        schemaVersion: 1,
        id: r.id,
        projectId: r.project_id,
        kind: r.kind,
        canonicalName: r.canonical_name,
        displayName: r.display_name,
        ownerEntityId: r.owner_entity_id ?? undefined,
        lifecycle: 'stale',
        attributes: JSON.parse(r.attributes!),
        firstSeenSnapshot: r.first_seen_snapshot,
        lastSeenSnapshot: r.last_seen_snapshot,
      }),
    });
    n++;
  }
  const rels = db
    .prepare(`SELECT * FROM relations WHERE snapshot_id = ? AND producer IN (${marks})`)
    .all<Record<string, string>>(previousId, ...producers);
  for (const r of rels) {
    if (
      built.relations.has(r.id!) ||
      !built.entities.has(r.from_id!) ||
      !built.entities.has(r.to_id!)
    )
      continue;
    built.relations.set(r.id!, {
      producer: r.producer!,
      relation: Relation.parse({
        schemaVersion: 1,
        id: r.id,
        fromId: r.from_id,
        toId: r.to_id,
        kind: r.kind,
        qualifiers: JSON.parse(r.qualifiers!),
        evidenceIds: JSON.parse(r.evidence_ids!),
        status: 'stale',
        confidenceCategory: r.confidence,
        snapshotId,
      }),
    });
    n++;
  }
  return n;
}

interface SnapshotRow {
  id: string;
  project_id: string;
  worktree_id: string;
  head_commit: string | null;
  dirty_tree_digest: string;
  dirty: number;
  created_at: string;
  published_at: string | null;
  analyzer_versions: string;
  config_digest: string;
  state: Snapshot['state'];
  previous_snapshot_id: string | null;
  coverage_report_id: string | null;
}

export function getSnapshot(db: Db, id: string): Snapshot | undefined {
  const r = db.prepare('SELECT * FROM snapshots WHERE id = ?').get<SnapshotRow>(id);
  if (!r) return undefined;
  return Snapshot.parse({
    schemaVersion: 1,
    id: r.id,
    projectId: r.project_id,
    worktreeId: r.worktree_id,
    headCommit: r.head_commit ?? undefined,
    dirtyTreeDigest: r.dirty_tree_digest,
    dirty: r.dirty === 1,
    createdAt: r.created_at,
    publishedAt: r.published_at ?? undefined,
    analyzerVersions: JSON.parse(r.analyzer_versions),
    configDigest: r.config_digest,
    state: r.state,
    previousSnapshotId: r.previous_snapshot_id ?? undefined,
    coverageReportId: r.coverage_report_id ?? undefined,
  });
}

/** Latest published snapshot of a worktree (ready or partial), with its coverage report. */
export function getLatestSnapshot(
  db: Db,
  worktreeId: string,
): { snapshot: Snapshot; coverage?: CoverageReport } | undefined {
  const r = db
    .prepare(
      `SELECT id, coverage_report_id FROM snapshots WHERE worktree_id = ? AND state IN ('ready','partial') ORDER BY published_at DESC LIMIT 1`,
    )
    .get<{ id: string; coverage_report_id: string | null }>(worktreeId);
  if (!r) return undefined;
  const cov = r.coverage_report_id
    ? db
        .prepare('SELECT body FROM coverage_reports WHERE id = ?')
        .get<{ body: string }>(r.coverage_report_id)
    : undefined;
  return {
    snapshot: getSnapshot(db, r.id)!,
    coverage: cov ? (JSON.parse(cov.body) as CoverageReport) : undefined,
  };
}
