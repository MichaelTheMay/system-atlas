/**
 * pnpm demo — the reproducible local end-to-end demo (plan §18): a copy of fixtures/research-demo is
 * scanned, its worker is run twice through `atlas run` (one failing assertion despite exit 0, one
 * passing), the browser journey is captured with real screenshots, and a mock agent proposes one
 * system-design subsystem through the claim API (no model is called). Everything stays local.
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
// System design (D01): a mock agent proposes one subsystem, the way an MCP client would with
// atlas_propose_view. It goes through the same validator as any proposal and cites evidence the scan
// recorded. Nothing calls a model; "demo-mock" is only the label the claims carry.
const api = async <T>(path: string, init?: { method: string; body?: unknown }): Promise<T> => {
  const res = await fetch(`${d.baseUrl}/api/v1${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${d.token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
};
const reg = await api<{ worktree: { id: string } }>('/projects', {
  method: 'POST',
  body: { rootPath: root },
});
let job = await api<{ id: string; state: string; error?: string }>(
  `/worktrees/${reg.worktree.id}/scans`,
  { method: 'POST' },
);
while (job.state === 'queued' || job.state === 'running') {
  await new Promise((r) => setTimeout(r, 150));
  job = await api(`/jobs/${job.id}`);
}
if (job.state !== 'succeeded') throw new Error(`scan ${job.state}: ${job.error ?? ''}`);
const snapshotId = (
  await api<{ snapshot: { id: string } }>(`/worktrees/${reg.worktree.id}/snapshot`)
).snapshot.id;
const members: { subjectId: string; name: string; evidenceIds: string[] }[] = [];
for (const name of ['@research/api', '@research/worker']) {
  const { hits } = await api<{ hits: { id: string; displayName: string }[] }>(
    `/snapshots/${snapshotId}/search?q=${encodeURIComponent(name)}&kind=package`,
  );
  const hit = hits.find((h) => h.displayName === name);
  if (!hit) throw new Error(`demo: package ${name} not found in snapshot ${snapshotId}`);
  const detail = await api<{ evidence: { id: string }[] }>(
    `/snapshots/${snapshotId}/entities/${hit.id}`,
  );
  const evidenceIds = detail.evidence.map((e) => e.id).slice(0, 3);
  if (!evidenceIds.length) throw new Error(`demo: ${name} has no evidence to cite`);
  members.push({ subjectId: hit.id, name, evidenceIds });
}
const proposal = await api<{ accepted: unknown[]; rejected: { reasons: string[] }[] }>(
  '/proposals/claims',
  {
    method: 'POST',
    body: {
      snapshotId,
      origin: 'model',
      modelMetadata: { provider: 'mock', model: 'demo-mock', promptTemplateVersion: 'demo-1' },
      claims: members.map((m) => ({
        subjectId: m.subjectId,
        predicate: 'subsystem',
        value: 'Research backend',
        citations: m.evidenceIds.map((evidenceId) => ({ evidenceId })),
        rationale: `${m.name} serves or produces the research reports (demo proposal).`,
      })),
    },
  },
);
if (proposal.accepted.length !== members.length)
  throw new Error(
    `demo: subsystem proposal not fully accepted: ${JSON.stringify(proposal.rejected)}`,
  );
const { canvases } = await api<{
  canvases: { title: string; lens: string; provenance?: string; relevanceReason: string }[];
}>(`/worktrees/${reg.worktree.id}/canvases`);
const sub = canvases.find((c) => c.lens === 'design-subsystem' && c.provenance === 'proposed');
if (!sub) throw new Error('demo: the proposed design subsystem is not in the catalog');
console.log(`system design: "${sub.title}" (${sub.provenance}): ${sub.relevanceReason}`);

console.log(
  `\nOpen: ${daemon.baseUrl}/#token=${daemon.rec.token}\nThen choose "research-demo": Architecture and Outputs & Audit (System design once the D01c UI lands).`,
);
