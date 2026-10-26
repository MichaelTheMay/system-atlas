import Fastify, { type FastifyInstance } from 'fastify';
import { EventBus } from './events.ts';
import { isAllowedHost, isAllowedOrigin, tokenMatches } from './security.ts';
import { readStatic, resolveStatic } from './static.ts';

export const DAEMON_VERSION = '0.1.0';
export const API_PREFIX = '/api/v1';

export interface ServerOptions {
  token: string;
  dataDir: string;
  /** Built web UI directory; when absent the daemon serves only the API. */
  webRoot?: string;
  /** Extra allowed browser origins (dev server). Loopback only. */
  devOrigins?: string[];
  /** Port used for Host/Origin validation; set after listen for port 0. */
  port: () => number;
  heartbeatMs?: number;
}

export interface AtlasServer {
  app: FastifyInstance;
  bus: EventBus;
  startedAt: string;
}

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function buildServer(opts: ServerOptions): AtlasServer {
  // Logger disabled: request logs would include Authorization headers and local paths.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const bus = new EventBus();
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
    if (req.url.startsWith(API_PREFIX) && !tokenMatches(req.headers.authorization, opts.token)) {
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
      reply.header('Content-Security-Policy', UI_CSP);
      reply.header('X-Frame-Options', 'DENY');
    }
    return reply.send(await readStatic(hit.file));
  });

  return { app, bus, startedAt };
}
