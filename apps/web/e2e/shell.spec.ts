import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

test('connects to the daemon with a fragment token and strips it from the URL', async ({
  page,
}) => {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('live updates on');
  expect(page.url()).not.toContain('token');
});

test('switches between the Architecture and Outputs & Audit roots', async ({ page, request }) => {
  // a project of its own, so runs recorded by other tests cannot appear here
  const rootPath = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-shell-')), 'no-runs');
  cpSync(new URL('../../../fixtures/elixir-unsupported', import.meta.url).pathname, rootPath, {
    recursive: true,
  });
  const reg = await request.post('/api/v1/projects', {
    headers: { authorization: `Bearer ${E2E_TOKEN}` },
    data: { rootPath },
  });
  const worktreeId = (await reg.json()).worktree.id as string;
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(worktreeId);
  await page.getByRole('button', { name: /Outputs & Audit/ }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName('Outputs & Audit canvas');
  await expect(page.getByRole('heading', { name: 'No runs recorded yet' })).toBeVisible();
  await page.getByRole('button', { name: /^Architecture/ }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName(/^Architecture canvas/);
});

test('without a token the UI says it is not connected and the API refuses', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('Not connected');
  expect((await request.get('/api/v1/status')).status()).toBe(401);
});

test('lists a registered project in the project selector', async ({ page, request }) => {
  const rootPath = new URL('../../../fixtures/py-cli-api', import.meta.url).pathname.replace(
    /\/$/,
    '',
  );
  const res = await request.post('/api/v1/projects', {
    headers: { authorization: `Bearer ${E2E_TOKEN}` },
    data: { rootPath },
  });
  expect([200, 201]).toContain(res.status());
  await page.goto(`/#token=${E2E_TOKEN}`);
  const select = page.getByRole('combobox', { name: 'Project' });
  await expect(select).toBeEnabled();
  await expect(select).toContainText('py-cli-api');
});

test('scans the selected project from the UI and shows coverage gaps', async ({
  page,
  request,
}) => {
  const rootPath = new URL(
    '../../../fixtures/elixir-unsupported',
    import.meta.url,
  ).pathname.replace(/\/$/, '');
  const reg = await request.post('/api/v1/projects', {
    headers: { authorization: `Bearer ${E2E_TOKEN}` },
    data: { rootPath },
  });
  const worktreeId = (await reg.json()).worktree.id as string;
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(worktreeId);
  await page.getByRole('button', { name: /Scan project|Rescan/ }).click();
  await page.getByRole('button', { name: 'Coverage & unknowns coverage', exact: true }).click();
  const gap = page.locator('.react-flow__node', { hasText: 'unsupported language' });
  await expect(gap).toBeVisible({ timeout: 15_000 });
  await gap.click();
  const details = page.getByRole('region', { name: 'Node details' });
  await expect(details).toContainText('elixir');
});
