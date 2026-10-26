import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { migrate, openDb } from '@atlas/store';
import { isProcessAlive, readDiscovery, removeDiscovery, writeDiscovery } from './discovery.ts';
import { buildServer, DAEMON_VERSION } from './server.ts';
import { buildPreviewServer } from './preview.ts';
import { ObjectStore, recoverInterruptedRuns } from '@atlas/evidence';

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

  const db = openDb(paths.dbFile);
  const migration = migrate(db, { backupsDir: paths.backupsDir });
  if (migration.applied.length) {
    console.log(
      `applied migrations ${migration.applied.join(', ')}${migration.backupFile ? ` (backup: ${migration.backupFile})` : ''}`,
    );
  }

  const interrupted = recoverInterruptedRuns(db);
  if (interrupted) console.log(`marked ${interrupted} unfinished run(s) interrupted`);
  const objects = new ObjectStore(paths.objectsDir);

  const token = process.env.ATLAS_TOKEN ?? randomBytes(32).toString('hex');
  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  let port = Number(process.env.ATLAS_PORT ?? 0);
  let previewPort = Number(process.env.ATLAS_PREVIEW_PORT ?? 0);
  const devOrigins = (process.env.ATLAS_DEV_ORIGINS ?? '').split(',').filter(Boolean);
  // the isolated preview origin: a second loopback port that never sees the UI token
  const preview = buildPreviewServer({
    db,
    objects,
    port: () => previewPort,
    appOrigins: () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...devOrigins],
  });
  const { app, startedAt } = buildServer({
    objects,
    previewOrigin: () => (previewPort ? `http://127.0.0.1:${previewPort}` : undefined),
    signPreview: (id) => preview.sign(id),
    token,
    db,
    dataDir: paths.dataDir,
    webRoot: existsSync(webRoot) ? webRoot : undefined,
    devOrigins,
    port: () => port,
  });

  await app.listen({ host: '127.0.0.1', port });
  const addr = app.server.address();
  if (addr && typeof addr === 'object') port = addr.port;
  await preview.app.listen({ host: '127.0.0.1', port: previewPort });
  const paddr = preview.app.server.address();
  if (paddr && typeof paddr === 'object') previewPort = paddr.port;

  await writeDiscovery(paths.discoveryFile, {
    pid: process.pid,
    port,
    previewPort,
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
    await preview.app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('atlas daemon failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
