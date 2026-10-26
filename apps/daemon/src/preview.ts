import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { getArtifact, isActiveContent, type ObjectStore } from '@atlas/evidence';
import type { Db } from '@atlas/store';
import { isAllowedHost } from './security.ts';
import { MAX_VIEW_BYTES, renderViewer } from './viewer.ts';

/**
 * Isolated preview origin (plan §10): artifact bytes are only ever served from this second loopback
 * port, never from the app origin that holds the UI token. Responses are CSP-sandboxed into an
 * opaque origin with all network access denied, and only the app may frame them.
 *
 * - `/a/:id` raw bytes (images, video, HTML/SVG/PDF in a sandboxed frame, downloads)
 * - `/v/:id` escaped, script-free viewer page for text-like artifacts (JSON, CSV, logs, text)
 */
export interface PreviewServer {
  app: FastifyInstance;
  sign(
    artifactId: string,
    kind?: 'a' | 'v',
    ttlSeconds?: number,
  ): { path: string; expiresAt: string };
}

export function buildPreviewServer(opts: {
  db: Db;
  objects: ObjectStore;
  port: () => number;
  appOrigins: () => string[];
  secret?: Buffer;
}): PreviewServer {
  const secret = opts.secret ?? randomBytes(32);
  const app = Fastify({ logger: false });
  const mac = (kind: string, id: string, exp: number) =>
    createHmac('sha256', secret).update(`${kind}:${id}.${exp}`).digest('hex');
  const valid = (kind: string, id: string, q: { exp?: string; sig?: string }) => {
    const exp = Number(q.exp);
    const sig = q.sig ?? '';
    const want = mac(kind, id, exp);
    return (
      Number.isFinite(exp) &&
      exp >= Date.now() / 1000 &&
      sig.length === want.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(want))
    );
  };
  const csp = (scripts: boolean) =>
    [
      // sandbox without allow-same-origin: an opaque origin even if the URL is opened directly
      scripts ? 'sandbox allow-scripts' : 'sandbox',
      "default-src 'none'",
      "img-src data: blob: 'self'",
      "media-src 'self'",
      "style-src 'unsafe-inline'",
      scripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${opts.appOrigins().join(' ') || "'none'"}`,
    ].join('; ');

  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host, opts.port()))
      return reply.code(421).send('host not allowed');
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'private, max-age=300');
    return payload;
  });

  const available = (id: string) => {
    const a = getArtifact(opts.db, id);
    return a && a.bytesState === 'available' && opts.objects.has(a.sha256) ? a : undefined;
  };

  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>(
    '/a/:id',
    async (req, reply) => {
      if (!valid('a', req.params.id, req.query))
        return reply.code(403).send('invalid or expired preview link');
      const a = available(req.params.id);
      if (!a) return reply.code(404).send('bytes not available');
      // Chrome does not treat two loopback ports as same-site for CORP, and the app must embed these
      // bytes; access is already limited by the short-lived HMAC signature in the URL.
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
      reply.header(
        'Content-Disposition',
        `inline; filename="${a.logicalName.replace(/[^\w.-]+/g, '_').slice(0, 100)}"`,
      );
      reply.header('Content-Security-Policy', csp(isActiveContent(a.mediaType)));
      reply.type(
        a.mediaType.startsWith('text/') || a.mediaType === 'image/svg+xml'
          ? `${a.mediaType}; charset=utf-8`
          : a.mediaType,
      );
      return reply.send(opts.objects.read(a.sha256));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>(
    '/v/:id',
    async (req, reply) => {
      if (!valid('v', req.params.id, req.query))
        return reply.code(403).send('invalid or expired preview link');
      const a = available(req.params.id);
      if (!a) return reply.code(404).send('bytes not available');
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of opts.objects.read(a.sha256)) {
        const b = c as Buffer;
        chunks.push(b.subarray(0, Math.max(0, MAX_VIEW_BYTES - n)));
        n += b.length;
        if (n >= MAX_VIEW_BYTES) break;
      }
      reply.header('Content-Security-Policy', csp(false));
      reply.type('text/html; charset=utf-8');
      return renderViewer(
        a.mediaType,
        a.logicalName,
        Buffer.concat(chunks),
        a.byteLength > MAX_VIEW_BYTES,
      );
    },
  );

  return {
    app,
    sign(artifactId, kind = 'a', ttlSeconds = 600) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return {
        path: `/${kind}/${artifactId}?exp=${exp}&sig=${mac(kind, artifactId, exp)}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },
  };
}
