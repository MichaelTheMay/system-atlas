import { newId } from '@atlas/schema';
import { json, type Db } from '@atlas/store';
import { getRunRecord, insertCorrelation } from './store.ts';

/**
 * Link a run to architecture entities of the snapshot it ran against (plan §10), strongest first:
 * explicit entity ids (recorded at ingestion) > command mapping (argv names a source file) > route
 * signature (browser URL path matches a declared UI route, inferred). Unmatched runs stay unknown;
 * nothing is guessed from file names or timing.
 */
export function correlateRun(db: Db, runId: string): number {
  const run = getRunRecord(db, runId);
  if (!run?.snapshotId) return 0;
  const snapshotId = run.snapshotId;
  const exists = db.prepare(
    'SELECT 1 AS ok FROM correlations WHERE event_or_artifact_id = ? AND entity_id = ? AND json_extract(body, ?) = ?',
  );
  let added = 0;
  const link = (
    subjectId: string,
    entityId: string,
    method: 'command-mapping' | 'route-signature',
    status: 'supported' | 'inferred',
    eventId: string,
    detail: string,
  ) => {
    if (exists.get(subjectId, entityId, '$.method', method)) return;
    const evidenceId = newId('evidence');
    db.prepare(
      'INSERT INTO evidence (id, project_id, body, path, content_hash, run_id, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)',
    ).run(
      evidenceId,
      run.projectId,
      json({
        schemaVersion: 1,
        id: evidenceId,
        sourceKind: 'runtime-event',
        runId,
        eventId,
        extractorId: 'atlas-correlate',
        extractorVersion: '1',
        capturedAt: new Date().toISOString(),
        excerpt: detail.slice(0, 400),
        redactionState: 'none',
      }),
      runId,
      new Date().toISOString(),
    );
    insertCorrelation(db, {
      eventOrArtifactId: subjectId,
      entityId,
      method,
      evidenceIds: [evidenceId],
      status,
    });
    added++;
  };

  const events = db
    .prepare('SELECT id, type, body FROM events WHERE run_id = ? ORDER BY seq')
    .all<{ id: string; type: string; body: string }>(runId);
  const moduleByPath = db.prepare(
    "SELECT id FROM entities WHERE snapshot_id = ? AND kind = 'module' AND json_extract(attributes, '$.path') = ?",
  );
  const cwd = String((run.environmentSummary as { cwd?: string }).cwd ?? '.');

  // command mapping: an argv element that is a source file of the snapshot
  const started = events.find((e) => e.type === 'run.started');
  if (started) {
    const argv = ((JSON.parse(started.body) as { payload: { argv?: unknown } }).payload.argv ??
      []) as unknown[];
    for (const a of argv) {
      if (typeof a !== 'string' || !/\.[cm]?[jt]sx?$|\.py$/.test(a)) continue;
      const rel = normalize(cwd === '.' ? a : `${cwd}/${a}`);
      const m = moduleByPath.get<{ id: string }>(snapshotId, rel);
      if (m) {
        link(runId, m.id, 'command-mapping', 'supported', started.id, `argv names ${rel}`);
        // outputs produced by this command are attributed to the same module
        for (const art of db
          .prepare(
            "SELECT id FROM artifacts WHERE run_id = ? AND json_extract(body, '$.role') IN ('output-file','report','render')",
          )
          .all<{ id: string }>(runId)) {
          link(
            art.id,
            m.id,
            'command-mapping',
            'supported',
            started.id,
            `produced by the command that runs ${rel}`,
          );
        }
      }
    }
  }

  // route signature: screenshot URLs whose path matches a declared UI route (heuristic → inferred)
  const routes = db
    .prepare(
      "SELECT id, json_extract(attributes, '$.path') AS path FROM entities WHERE snapshot_id = ? AND kind = 'ui-surface'",
    )
    .all<{ id: string; path: string }>(snapshotId)
    .map((r) => ({ ...r, re: routeRegex(r.path) }));
  if (routes.length) {
    for (const e of events.filter((x) => x.type === 'screenshot.captured')) {
      const url = (JSON.parse(e.body) as { payload: { url?: string } }).payload.url;
      let path: string;
      try {
        path = new URL(String(url)).pathname;
      } catch {
        continue;
      }
      const hits = routes.filter((r) => r.re.test(path));
      if (hits.length === 1) {
        const shot = db
          .prepare('SELECT id FROM artifacts WHERE event_id = ?')
          .get<{ id: string }>(e.id);
        link(
          shot?.id ?? e.id,
          hits[0]!.id,
          'route-signature',
          'inferred',
          e.id,
          `screenshot URL path ${path} matches route ${hits[0]!.path}`,
        );
      }
    }
  }
  return added;
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

function routeRegex(route: string): RegExp {
  const parts = route
    .replace(/\/+$/, '')
    .split('/')
    .map((s) =>
      /^(:\w+|\{[^}]+\}|\*)$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
  return new RegExp(`^${parts.join('/') || ''}/?$`);
}

/** Runs linked to an entity (directly, or through their events/artifacts). */
export function runsForEntity(db: Db, entityId: string, limit = 20) {
  return db
    .prepare(
      `SELECT DISTINCT r.id, r.status, r.start_at AS startAt, json_extract(r.body, '$.adapter') AS adapter,
              json_extract(r.body, '$.commandSummary') AS commandSummary, json_extract(c.body, '$.method') AS method, c.status AS correlation
       FROM correlations c
       JOIN runs r ON r.id = c.event_or_artifact_id
          OR r.id = (SELECT run_id FROM events WHERE id = c.event_or_artifact_id)
          OR r.id = (SELECT run_id FROM artifacts WHERE id = c.event_or_artifact_id)
       WHERE c.entity_id = ? ORDER BY r.start_at DESC LIMIT ?`,
    )
    .all<{
      id: string;
      status: string;
      startAt: string;
      adapter: string;
      commandSummary: string | null;
      method: string;
      correlation: string;
    }>(entityId, limit);
}
