import { isAbsolute } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getLatestSnapshot,
  getSnapshot,
  isCompacted,
  getWorktree,
  listProjects,
  loadCatalog,
  loadPlannerGraph,
  registerRoot,
} from '@atlas/graph';
import { projectView, type Catalog, type PlannerGraph } from '@atlas/planner';
import { defaultAnalyzers, type Analyzer } from '@atlas/analyzers';
import { JobRunner } from './jobs.ts';
import { canvasForEntity, entityDetails, readSource, relationDetails } from './routes/inspect.ts';
import { getOverlay, putOverlay } from './routes/overlays.ts';
import { registerRunRoutes, runScopedTarget } from './routes/runs.ts';
import { ObjectStore } from '@atlas/evidence';
import type { Db } from '@atlas/store';
import { EventBus } from './events.ts';
import { isAllowedHost, isAllowedOrigin, tokenMatches } from './security.ts';
import { readStatic, resolveStatic } from './static.ts';

export const DAEMON_VERSION = '0.1.0';
export const API_PREFIX = '/api/v1';

export interface ServerOptions {
  token: string;
  db: Db;
  dataDir: string;
  /** Built web UI directory; when absent the daemon serves only the API. */
  webRoot?: string;
  /** Extra allowed browser origins (dev server). Loopback only. */
  devOrigins?: string[];
  /** Port used for Host/Origin validation; set after listen for port 0. */
  port: () => number;
  heartbeatMs?: number;
  analyzers?: () => Analyzer[];
  objects?: ObjectStore;
  /** Origin of the isolated preview server (e.g. http://127.0.0.1:43123). */
  previewOrigin?: () => string | undefined;
  /** Signs a preview path for an artifact (provided by the preview server). */
  signPreview?: (artifactId: string, kind: 'a' | 'v') => { path: string; expiresAt: string };
}

export interface AtlasServer {
  app: FastifyInstance;
  bus: EventBus;
  jobs: JobRunner;
  startedAt: string;
}

/** UI CSP: artifact bytes may only come from the isolated preview origin, never this origin. */
function uiCsp(previewOrigin?: string): string {
  const p = previewOrigin ? ` ${previewOrigin}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${p}`,
    `media-src${p || " 'none'"}`,
    "connect-src 'self'",
    `frame-src${p || " 'none'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function buildServer(opts: ServerOptions): AtlasServer {
  // Logger disabled: request logs would include Authorization headers and local paths.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const bus = new EventBus();
  const jobs = new JobRunner(opts.db, bus, opts.analyzers ?? defaultAnalyzers);
  const runs = registerRunRoutes(app, {
    db: opts.db,
    objects: opts.objects ?? new ObjectStore(`${opts.dataDir}/objects`),
    bus,
    jobs,
    token: opts.token,
    previewUrl(artifactId, kind) {
      const origin = opts.previewOrigin?.();
      const signed = opts.signPreview?.(artifactId, kind);
      if (!origin || !signed) throw new Error('preview server not running');
      return { url: `${origin}${signed.path}`, expiresAt: signed.expiresAt };
    },
  });
  bus.subscribe((m) => {
    if (m.type !== 'snapshot.published') return;
    const snap = getSnapshot(opts.db, String(m.data.snapshotId));
    if (snap)
      runs.onSnapshotPublished({
        id: snap.id,
        worktreeId: snap.worktreeId,
        dirtyTreeDigest: snap.dirtyTreeDigest,
      });
  });
  const startedAt = new Date().toISOString();
  const devOrigins = (opts.devOrigins ?? []).filter((o) =>
    /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(o),
  );

  app.addHook('onRequest', async (req, reply) => {
    const port = opts.port();
    if (!isAllowedHost(req.headers.host, port)) {
      return reply.code(421).send({ error: 'host_not_allowed' });
    }
    if (!isAllowedOrigin(req.headers.origin, port, devOrigins)) {
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    // run-scoped ingestion may authenticate with the run's own token; the route checks it
    const scoped = req.headers['x-atlas-run-token'] && runScopedTarget(req.url);
    if (
      req.url.startsWith(API_PREFIX) &&
      !scoped &&
      !tokenMatches(req.headers.authorization, opts.token)
    ) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.get('/healthz', async () => ({
    ok: true,
    service: 'system-atlas-daemon',
    version: DAEMON_VERSION,
  }));

  app.get(`${API_PREFIX}/status`, async () => ({
    version: DAEMON_VERSION,
    pid: process.pid,
    startedAt,
    dataDir: opts.dataDir,
    node: process.version,
  }));

  app.get(`${API_PREFIX}/projects`, async () => ({ projects: listProjects(opts.db) }));

  const RegisterBody = z.object({
    rootPath: z.string().min(1).max(4096).refine(isAbsolute, 'rootPath must be absolute'),
  });
  app.post(`${API_PREFIX}/projects`, async (req, reply) => {
    const body = RegisterBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    try {
      const reg = await registerRoot(opts.db, body.data.rootPath);
      if (reg.created.worktree)
        bus.publish({
          type: 'project.registered',
          data: { projectId: reg.project.id, worktreeId: reg.worktree.id },
        });
      return reply.code(reg.created.worktree ? 201 : 200).send(reg);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || /not a directory/.test(String(e))) {
        return reply.code(400).send({ error: 'not_a_directory' });
      }
      throw e;
    }
  });

  app.post<{ Params: { id: string } }>(`${API_PREFIX}/worktrees/:id/scans`, async (req, reply) => {
    const wt = getWorktree(opts.db, req.params.id);
    if (!wt) return reply.code(404).send({ error: 'unknown_worktree' });
    return reply.code(202).send(jobs.enqueueScan(wt));
  });

  app.get<{ Params: { id: string } }>(`${API_PREFIX}/jobs/:id`, async (req, reply) => {
    const job = jobs.get(req.params.id);
    return job ?? reply.code(404).send({ error: 'unknown_job' });
  });

  app.get<{ Params: { id: string } }>(
    `${API_PREFIX}/worktrees/:id/snapshot`,
    async (req, reply) => {
      const latest = getLatestSnapshot(opts.db, req.params.id);
      if (!latest) return reply.code(404).send({ error: 'no_snapshot' });
      const sid = latest.snapshot.id;
      const entitiesByKind = Object.fromEntries(
        opts.db
          .prepare('SELECT kind, count(*) AS n FROM entities WHERE snapshot_id = ? GROUP BY kind')
          .all<{ kind: string; n: number }>(sid)
          .map((r) => [r.kind, r.n]),
      );
      const relationsByKind = Object.fromEntries(
        opts.db
          .prepare('SELECT kind, count(*) AS n FROM relations WHERE snapshot_id = ? GROUP BY kind')
          .all<{ kind: string; n: number }>(sid)
          .map((r) => [r.kind, r.n]),
      );
      const summary = opts.db
        .prepare('SELECT change_summary FROM snapshots WHERE id = ?')
        .get<{ change_summary: string | null }>(sid);
      const openIssues = opts.db
        // issues belong to the snapshot that detected them but stay open across later snapshots
        .prepare("SELECT count(*) AS n FROM issues WHERE project_id = ? AND status = 'open'")
        .get<{ n: number }>(latest.snapshot.projectId)!.n;
      return {
        ...latest,
        counts: { entitiesByKind, relationsByKind },
        changes: summary?.change_summary ? JSON.parse(summary.change_summary) : null,
        openIssues,
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    `${API_PREFIX}/snapshots/:id/changes`,
    async (req, reply) => {
      const snap = opts.db
        .prepare('SELECT id, change_summary FROM snapshots WHERE id = ?')
        .get<{ id: string; change_summary: string | null }>(req.params.id);
      if (!snap) return reply.code(404).send({ error: 'unknown_snapshot' });
      const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 2000);
      const changes = opts.db
        .prepare(
          'SELECT target, id, change, previous_id AS previousId, detail FROM snapshot_changes WHERE snapshot_id = ? ORDER BY target, change, id LIMIT ?',
        )
        .all<{
          target: string;
          id: string;
          change: string;
          previousId: string | null;
          detail: string;
        }>(snap.id, limit)
        .map((c) => ({ ...c, detail: JSON.parse(c.detail) }));
      const issues = opts.db
        .prepare(
          'SELECT id, kind, status, body, created_at AS createdAt FROM issues WHERE snapshot_id = ? ORDER BY created_at',
        )
        .all<{ id: string; kind: string; status: string; body: string; createdAt: string }>(snap.id)
        .map((i) => ({ ...i, body: JSON.parse(i.body) }));
      return {
        snapshotId: snap.id,
        summary: snap.change_summary ? JSON.parse(snap.change_summary) : null,
        changes,
        issues,
      };
    },
  );

  // Snapshot-scoped views (plan §8): catalogs are cheap rows; projections are computed on demand.
  const viewCache = new Map<string, { graph: PlannerGraph; catalog: Catalog }>();
  const views = (snapshotId: string) => {
    let hit = viewCache.get(snapshotId);
    if (!hit) {
      hit = {
        graph: loadPlannerGraph(opts.db, snapshotId),
        catalog: loadCatalog(opts.db, snapshotId),
      };
      viewCache.set(snapshotId, hit);
      if (viewCache.size > 4) viewCache.delete(viewCache.keys().next().value!);
    }
    return hit;
  };
  const snapshotExists = (id: string) =>
    !!opts.db
      .prepare(
        "SELECT 1 AS ok FROM snapshots WHERE id = ? AND state IN ('ready','partial','superseded')",
      )
      .get(id);
  const compacted = (id: string) => isCompacted(opts.db, id);

  app.get<{ Params: { id: string } }>(
    `${API_PREFIX}/snapshots/:id/canvases`,
    async (req, reply) => {
      if (!snapshotExists(req.params.id))
        return reply.code(404).send({ error: 'unknown_snapshot' });
      if (compacted(req.params.id))
        return reply.code(410).send({
          error: 'compacted',
          detail: 'this superseded snapshot was compacted; its graph is no longer stored',
        });
      return { snapshotId: req.params.id, ...views(req.params.id).catalog };
    },
  );

  app.get<{ Params: { id: string; cid: string }; Querystring: { focus?: string } }>(
    `${API_PREFIX}/snapshots/:id/canvases/:cid/projection`,
    async (req, reply) => {
      if (!snapshotExists(req.params.id))
        return reply.code(404).send({ error: 'unknown_snapshot' });
      if (compacted(req.params.id))
        return reply.code(410).send({
          error: 'compacted',
          detail: 'this superseded snapshot was compacted; its graph is no longer stored',
        });
      const v = views(req.params.id);
      if (!v.catalog.canvases.some((c) => c.id === req.params.cid))
        return reply.code(404).send({ error: 'unknown_canvas' });
      const focus =
        typeof req.query.focus === 'string' && req.query.focus.length <= 500
          ? req.query.focus
          : undefined;
      return projectView(v.graph, v.catalog, req.params.cid, focus);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${API_PREFIX}/worktrees/:id/canvases`,
    async (req, reply) => {
      const latest = getLatestSnapshot(opts.db, req.params.id);
      if (!latest) return reply.code(404).send({ error: 'no_snapshot' });
      return { snapshotId: latest.snapshot.id, ...views(latest.snapshot.id).catalog };
    },
  );

  app.get<{ Params: { id: string; eid: string } }>(
    `${API_PREFIX}/snapshots/:id/entities/:eid`,
    async (req, reply) => {
      if (compacted(req.params.id)) return reply.code(410).send({ error: 'compacted' });
      const d = entityDetails(opts.db, req.params.id, req.params.eid);
      return d ?? reply.code(404).send({ error: 'unknown_entity' });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { ids?: string } }>(
    `${API_PREFIX}/snapshots/:id/relations`,
    async (req, reply) => {
      const ids = (req.query.ids ?? '').split(',').filter((x) => /^rel_[0-9a-f]{16,64}$/.test(x));
      const d = relationDetails(opts.db, req.params.id, ids);
      return d ? { relations: d } : reply.code(404).send({ error: 'unknown_snapshot' });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    `${API_PREFIX}/snapshots/:id/source`,
    async (req, reply) => {
      const path = req.query.path ?? '';
      if (!path || path.length > 4096 || path.startsWith('/') || path.split('/').includes('..'))
        return reply.code(400).send({ error: 'invalid_path' });
      const r = await readSource(opts.db, req.params.id, path);
      if (r.status !== 200) return reply.code(r.status).send({ error: r.error });
      const { status: _s, ...body } = r;
      return body;
    },
  );

  app.get<{ Params: { viewId: string }; Querystring: { project?: string; snapshot?: string } }>(
    `${API_PREFIX}/views/:viewId/overlay`,
    async (req, reply) => {
      if (!/^cvs_[0-9a-f]{16,64}$/.test(req.params.viewId))
        return reply.code(400).send({ error: 'invalid_view' });
      const { project, snapshot } = req.query;
      // aliases are followed only relative to the snapshot being viewed (worktree isolation)
      const context =
        project &&
        snapshot &&
        /^proj_[0-9a-f]{16,64}$/.test(project) &&
        /^snap_[0-9a-f]{16,64}$/.test(snapshot)
          ? { projectId: project, snapshotId: snapshot }
          : undefined;
      return getOverlay(opts.db, req.params.viewId, context);
    },
  );

  app.put<{ Params: { viewId: string } }>(
    `${API_PREFIX}/views/:viewId/overlay`,
    async (req, reply) => {
      const r = putOverlay(opts.db, req.params.viewId, req.body);
      if (!r.ok) return reply.code(r.status).send({ error: r.error, current: r.current });
      return r.overlay;
    },
  );

  app.get<{ Params: { id: string; eid: string } }>(
    `${API_PREFIX}/snapshots/:id/entities/:eid/canvas`,
    async (req, reply) => {
      const c = canvasForEntity(opts.db, req.params.id, req.params.eid);
      return c ?? reply.code(404).send({ error: 'no_canvas' });
    },
  );

  app.get(`${API_PREFIX}/stream`, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    const send = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { version: DAEMON_VERSION, startedAt });
    const unsubscribe = bus.subscribe((m) => send(m.type, m.data));
    const hb = setInterval(() => res.write(': heartbeat\n\n'), opts.heartbeatMs ?? 15_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      unsubscribe();
    });
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith(API_PREFIX) || !opts.webRoot) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const hit = await resolveStatic(opts.webRoot, req.url);
    if (!hit) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', hit.type);
    if (hit.type.startsWith('text/html')) {
      reply.header('Content-Security-Policy', uiCsp(opts.previewOrigin?.()));
      reply.header('X-Frame-Options', 'DENY');
    }
    return reply.send(await readStatic(hit.file));
  });

  return { app, bus, jobs, startedAt };
}
