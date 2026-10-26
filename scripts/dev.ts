/**
 * pnpm dev: starts a foreground daemon that allows the Vite dev origin, then Vite with an
 * /api proxy to it. Both children are stopped when this process exits.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { isProcessAlive, readDiscovery } from '@atlas/daemon/discovery';

const paths = resolveAtlasPaths();
const existing = await readDiscovery(paths.discoveryFile);
if (existing && isProcessAlive(existing.pid)) {
  console.error(
    `An atlas daemon is already running (pid ${existing.pid}). Stop it first: pnpm atlas daemon stop`,
  );
  process.exit(1);
}

const children: ChildProcess[] = [];
const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
};
process.on('SIGINT', () => (stop(), process.exit(0)));
process.on('SIGTERM', () => (stop(), process.exit(0)));

const daemon = spawn(process.execPath, ['--watch', 'apps/daemon/src/main.ts'], {
  stdio: 'inherit',
  env: { ...process.env, ATLAS_DEV_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173' },
});
children.push(daemon);

let rec = undefined as Awaited<ReturnType<typeof readDiscovery>>;
for (let i = 0; i < 50 && !rec; i++) {
  await sleep(100);
  const r = await readDiscovery(paths.discoveryFile);
  if (r && r.pid === daemon.pid) rec = r;
}
if (!rec) {
  console.error('daemon did not start');
  stop();
  process.exit(1);
}

const vite = spawn('pnpm', ['--filter', '@atlas/web', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, ATLAS_DAEMON_URL: `http://127.0.0.1:${rec.port}` },
});
children.push(vite);
console.log(`\n  Atlas UI (dev): http://127.0.0.1:5173/#token=${rec.token}\n`);
vite.on('exit', () => (stop(), process.exit(0)));
