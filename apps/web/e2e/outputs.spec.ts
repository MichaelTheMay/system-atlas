import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { runProcess } from '@atlas/adapters';
import { E2E_PORT, E2E_TOKEN } from '../../../playwright.config.ts';
import { runResearchJourney } from '../../../scripts/research-journey.ts';

const auth = { authorization: `Bearer ${E2E_TOKEN}` };
const daemon = { baseUrl: `http://127.0.0.1:${E2E_PORT}`, token: E2E_TOKEN };
test.use({ trace: 'off' });
test.describe.configure({ mode: 'serial' });

let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

let root: string;
let worktreeId: string;
let runs: { worker: string; journey: string };

test.beforeAll(async ({ browser, request }) => {
  root = join(mkdtempSync(join(tmpdir(), 'atlas-outputs-')), 'research-demo');
  cpSync(new URL('../../../fixtures/research-demo', import.meta.url).pathname, root, {
    recursive: true,
  });
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: root } })
  ).json();
  worktreeId = reg.worktree.id;
  const worker = await runProcess({
    daemon,
    rootPath: root,
    cwd: root,
    command: process.execPath,
    args: ['worker/generate-report.mjs', '--sources', '2', '--out', 'out'],
    outputs: ['out/report.json', 'out/chart.png', 'out/report.html'],
    name: 'report',
  });
  const journey = await runResearchJourney({ browser, daemon, rootPath: root, trace: false });
  runs = { worker: worker.runId, journey: journey.runId };
});

async function openOutputs(page: Page) {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(worktreeId);
  await page.getByRole('button', { name: /^Outputs & Audit/ }).click();
  await expect(page.locator('.run-card')).toHaveCount(2);
}

test('runs appear in Outputs & Audit with screenshots, missing captures and outcomes, bound to the right snapshot', async ({
  page,
  request,
}) => {
  const latest = await (
    await request.get(`/api/v1/worktrees/${worktreeId}/snapshot`, { headers: auth })
  ).json();
  const workerRun = await (
    await request.get(`/api/v1/runs/${runs.worker}`, { headers: auth })
  ).json();
  expect(workerRun.run.snapshotId).toBe(latest.snapshot.id);

  await openOutputs(page);
  const journeyCard = page.locator('.run-card', { hasText: 'research journey' });
  await expect(journeyCard).toContainText('process failed');
  await expect(journeyCard).toContainText('1 missing');
  const workerCard = page.locator('.run-card', { hasText: 'generate-report.mjs' });
  // a failed assertion stays failed even though the process exited 0
  await expect(workerCard).toContainText('process succeeded');
  await expect(workerCard).toContainText('task failed');

  await journeyCard.click();
  const detail = page.getByRole('region', { name: 'Run detail' });
  await expect(detail.locator('.frame-card')).toHaveCount(6);
  const missing = detail.locator('.frame-card.is-missing');
  await expect(missing).toHaveCount(1);
  await expect(missing).toContainText('page is closed');
  await expect(detail.locator('.frame-card.kind-failure-state')).toHaveCount(1);
  await expect
    .poll(async () =>
      detail
        .locator('.frame-card img')
        .evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length),
    )
    .toBe(5);
  await expect(detail).toContainText(
    `source snapshot ${latest.snapshot.id.slice(5, 13)} (current)`,
  );

  await workerCard.click();
  await expect(detail.getByRole('tab', { name: 'Code execution' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(detail.getByLabel('Command output')).toContainText('warning: only 2 source(s)');
  await detail.getByRole('tab', { name: /^Artifacts/ }).click();
  const chart = detail.locator('.art-card', { hasText: 'out/chart.png' }).locator('img');
  await expect.poll(() => chart.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(360);
  await detail.getByRole('tab', { name: 'Steps' }).click();
  await expect(detail.locator('.assert')).toContainText('report cites at least 3 sources');
});

test('component → outputs → run → artifact → component → source', async ({ page }) => {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(worktreeId);
  await page.getByRole('button', { name: 'Project structure component', exact: true }).click();
  await page
    .locator('.react-flow__node', {
      has: page.locator('.node-label', { hasText: /^@research\/worker$/ }),
    })
    .dblclick();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure / @research/worker',
  );
  await page
    .locator('.react-flow__node', {
      has: page.locator('.node-label', { hasText: /^generate-report\.mjs$/ }),
    })
    .click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toContainText('worker/generate-report.mjs:1-');
  await inspector
    .getByRole('button', { name: /generate-report\.mjs/ })
    .first()
    .click();

  const detail = page.getByRole('region', { name: 'Run detail' });
  await expect(detail.locator('.rd-title')).toContainText('generate-report.mjs');
  await detail.getByRole('tab', { name: /^Artifacts/ }).click();
  await expect(detail.locator('.art-card', { hasText: 'out/report.json' })).toContainText(
    'produced by generate-report.mjs (command-mapping)',
  );

  await detail
    .getByRole('button', { name: /generate-report\.mjs \(command-mapping, supported\)/ })
    .click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toContainText(
    '@research/worker',
  );
  await expect(inspector.getByRole('region', { name: 'Entity details' })).toContainText(
    'generate-report.mjs',
  );
  await inspector.getByRole('button', { name: 'View source' }).click();
  await expect(
    inspector.getByRole('region', { name: 'Source of worker/generate-report.mjs' }),
  ).toContainText('barChartPng');
});

test('malicious HTML artifacts cannot reach the app, its token or the API', async ({
  page,
  request,
}) => {
  const evil = Buffer.from(`<!doctype html><body><script>
    const r = {};
    const attempt = (k, f) => { try { r[k] = 'ALLOWED:' + String(f()).slice(0, 40); } catch (e) { r[k] = 'blocked:' + e.name; } };
    attempt('origin', () => { if (self.origin !== 'null') throw new Error('not opaque'); return 'null'; });
    attempt('parentDom', () => { parent.document.body.innerHTML = 'PWNED'; return 'wrote'; });
    attempt('topToken', () => top.sessionStorage.getItem('atlas.token'));
    attempt('ownStorage', () => localStorage.setItem('x', '1'));
    attempt('cookie', () => (document.cookie = 'stolen=1'));
    fetch('http://127.0.0.1:${E2E_PORT}/api/v1/status').then(() => { r.fetch = 'ALLOWED'; done(); }, (e) => { r.fetch = 'blocked:' + e.name; done(); });
    function done() { document.body.dataset.result = JSON.stringify(r); }
  </script></body>`);
  const run = await (
    await request.post('/api/v1/runs', {
      headers: auth,
      data: { rootPath: root, adapter: 'test', commandSummary: 'malicious artifact' },
    })
  ).json();
  const res = await request.post(`/api/v1/runs/${run.run.id}/artifacts`, {
    headers: { 'x-atlas-run-token': run.ingestToken },
    data: {
      logicalName: 'innocent-report.png',
      mediaType: 'image/png',
      role: 'render',
      sha256: createHash('sha256').update(evil).digest('hex'),
      byteLength: evil.length,
    },
  });
  const reserved = await res.json();
  await request.put(reserved.uploadPath, {
    headers: { 'x-atlas-run-token': run.ingestToken, 'content-type': 'application/octet-stream' },
    data: evil,
  });
  await request.post(`/api/v1/runs/${run.run.id}/finish`, {
    headers: { 'x-atlas-run-token': run.ingestToken },
    data: { status: 'succeeded' },
  });

  const frameRequests: string[] = [];
  page.on('request', (r) => {
    if (r.frame() !== page.mainFrame()) frameRequests.push(r.url());
  });
  await page.goto(`/#token=${E2E_TOKEN}`);
  const token = await page.evaluate(() => sessionStorage.getItem('atlas.token'));
  await page.getByRole('combobox', { name: 'Project' }).selectOption(worktreeId);
  await page.getByRole('button', { name: /^Outputs & Audit/ }).click();
  await page.locator('.run-card', { hasText: 'malicious artifact' }).click();
  await page
    .getByRole('region', { name: 'Run detail' })
    .getByRole('tab', { name: /^Artifacts/ })
    .click();

  // sniffed as HTML despite the declared image/png, and rendered only in the isolated, sandboxed frame
  const frame = page.frameLocator('iframe[data-isolated="true"]');
  await expect(frame.locator('body')).toHaveAttribute('data-result', /fetch/, { timeout: 10_000 });
  const result = JSON.parse((await frame.locator('body').getAttribute('data-result'))!) as Record<
    string,
    string
  >;
  expect(result.origin).toBe('ALLOWED:null');
  for (const k of ['parentDom', 'topToken', 'ownStorage', 'cookie', 'fetch'])
    expect(result[k], k).toMatch(/^blocked:/);
  await expect(page.locator('body')).not.toContainText('PWNED');
  expect(await page.evaluate(() => sessionStorage.getItem('atlas.token'))).toBe(token);
  expect(frameRequests.filter((u) => u.includes('/api/'))).toEqual([]);
  const iframeSrc = await page.locator('iframe[data-isolated="true"]').getAttribute('src');
  expect(new URL(iframeSrc!).port).not.toBe(String(E2E_PORT));
});
