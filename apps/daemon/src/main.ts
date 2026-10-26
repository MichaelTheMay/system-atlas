import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { isProcessAlive, readDiscovery, removeDiscovery, writeDiscovery } from './discovery.ts';
import { buildServer, DAEMON_VERSION } from './server.ts';

/**
 * Daemon entry. One daemon per user data dir; it binds 127.0.0.1 only.
 * Env: ATLAS_PORT (default 0 = any free port), ATLAS_DEV_ORIGINS (comma list),
 * ATLAS_TOKEN (tests only; otherwise a random token is generated), ATLAS_DATA_DIR, ATLAS_RUNTIME_DIR.
 */
async function main() {
  const paths = resolveAtlasPaths();
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });

  const existing = await readDiscovery(paths.discoveryFile);
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    console.error(`atlas daemon already running (pid ${existing.pid}, port ${existing.port})`);
    process.exit(3);
  }

  const token = process.env.ATLAS_TOKEN ?? randomBytes(32).toString('hex');
  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  let port = Number(process.env.ATLAS_PORT ?? 0);
  const { app, startedAt } = buildServer({
    token,
    dataDir: paths.dataDir,
    webRoot: existsSync(webRoot) ? webRoot : undefined,
    devOrigins: (process.env.ATLAS_DEV_ORIGINS ?? '').split(',').filter(Boolean),
    port: () => port,
  });

  await app.listen({ host: '127.0.0.1', port });
  const addr = app.server.address();
  if (addr && typeof addr === 'object') port = addr.port;

  await writeDiscovery(paths.discoveryFile, {
    pid: process.pid,
    port,
    host: '127.0.0.1',
    token,
    version: DAEMON_VERSION,
    startedAt,
    dataDir: paths.dataDir,
  });
  console.log(
    `atlas daemon ${DAEMON_VERSION} listening on http://127.0.0.1:${port} (pid ${process.pid})`,
  );

  const shutdown = async () => {
    await removeDiscovery(paths.discoveryFile, process.pid);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('atlas daemon failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
