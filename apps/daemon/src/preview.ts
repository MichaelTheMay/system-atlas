import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { getArtifact, isActiveContent, type ObjectStore } from '@atlas/evidence';
import type { Db } from '@atlas/store';
import { isAllowedHost } from './security.ts';

/**
 * Isolated preview origin (plan §10): artifact bytes are only ever served from this second loopback
 * port, never from the app origin that holds the UI token. Active content (HTML/SVG) is additionally
 * CSP-sandboxed into an opaque origin with all network access denied, and only the app may frame it.
 */
export interface PreviewServer {
  app: FastifyInstance;
  sign(artifactId: string, ttlSeconds?: number): { path: string; expiresAt: string };
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
  const mac = (id: string, exp: number) =>
    createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex');

  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host, opts.port()))
      return reply.code(421).send('host not allowed');
  });

  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>(
    '/a/:id',
    async (req, reply) => {
      const exp = Number(req.query.exp);
      const sig = req.query.sig ?? '';
      const want = mac(req.params.id, exp);
      if (
        !Number.isFinite(exp) ||
        exp < Date.now() / 1000 ||
        sig.length !== want.length ||
        !timingSafeEqual(Buffer.from(sig), Buffer.from(want))
      ) {
        return reply.code(403).send('invalid or expired preview link');
      }
      const a = getArtifact(opts.db, req.params.id);
      if (!a || a.bytesState !== 'available' || !opts.objects.has(a.sha256))
        return reply.code(404).send('bytes not available');
      const active = isActiveContent(a.mediaType);
      const frameAncestors = opts.appOrigins().join(' ') || "'none'";
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Cross-Origin-Resource-Policy', 'same-site');
      reply.header('Cache-Control', 'private, max-age=300');
      reply.header(
        'Content-Disposition',
        `inline; filename="${a.logicalName.replace(/[^\w.-]+/g, '_').slice(0, 100)}"`,
      );
      reply.header(
        'Content-Security-Policy',
        [
          // sandbox without allow-same-origin: an opaque origin even if the URL is opened directly
          active ? 'sandbox allow-scripts' : 'sandbox',
          "default-src 'none'",
          'img-src data: blob:',
          "style-src 'unsafe-inline'",
          active ? "script-src 'unsafe-inline'" : "script-src 'none'",
          "connect-src 'none'",
          "form-action 'none'",
          "base-uri 'none'",
          `frame-ancestors ${frameAncestors}`,
        ].join('; '),
      );
      reply.type(
        a.mediaType.startsWith('text/') || a.mediaType === 'image/svg+xml'
          ? `${a.mediaType}; charset=utf-8`
          : a.mediaType,
      );
      return reply.send(opts.objects.read(a.sha256));
    },
  );

  return {
    app,
    sign(artifactId, ttlSeconds = 600) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return {
        path: `/a/${artifactId}?exp=${exp}&sig=${mac(artifactId, exp)}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },
  };
}
