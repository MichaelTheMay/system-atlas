/**
 * pnpm demo — the reproducible local end-to-end demo (plan §18): a copy of fixtures/research-demo is
 * scanned, its worker is run twice through `atlas run` (one failing assertion despite exit 0, one
 * passing), and the browser journey is captured with real screenshots. Everything stays local.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { resolveAtlasPaths } from '@atlas/schema/node';
import { runProcess } from '@atlas/adapters';
import { ensureDaemon } from '../apps/cli/src/client.ts';
import { runResearchJourney } from './research-journey.ts';

const paths = resolveAtlasPaths();
const root = join(paths.dataDir, 'demo', 'research-demo');
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(join(paths.dataDir, 'demo'), { recursive: true });
cpSync(new URL('../fixtures/research-demo', import.meta.url).pathname, root, { recursive: true });
console.log(`demo project: ${root}`);

const { daemon } = await ensureDaemon(paths);
const d = { baseUrl: daemon.baseUrl, token: daemon.rec.token };
const outputs = ['out/report.json', 'out/chart.png', 'out/report.html'];

const weak = await runProcess({
  daemon: d,
  rootPath: root,
  cwd: root,
  command: process.execPath,
  args: [
    'worker/generate-report.mjs',
    '--topic',
    'solar storage',
    '--sources',
    '2',
    '--out',
    'out',
  ],
  outputs,
  name: 'report (2 sources)',
});
console.log(
  `run ${weak.runId}: process ${weak.status}; this report fails the "at least 3 sources" assertion`,
);
const good = await runProcess({
  daemon: d,
  rootPath: root,
  cwd: root,
  command: process.execPath,
  args: ['worker/generate-report.mjs', '--topic', 'solar storage', '--out', 'out'],
  outputs,
  name: 'report (5 sources)',
});
console.log(`run ${good.runId}: process ${good.status}`);

const browser = await chromium.launch();
try {
  const j = await runResearchJourney({ browser, daemon: d, rootPath: root });
  console.log(
    `run ${j.runId}: browser journey${j.failedStep ? ` (step "${j.failedStep}" fails on purpose)` : ''}`,
  );
} finally {
  await browser.close();
}
console.log(
  `\nOpen: ${daemon.baseUrl}/#token=${daemon.rec.token}\nThen choose "research-demo" and the Outputs & Audit root.`,
);
