import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

const auth = { authorization: `Bearer ${E2E_TOKEN}` };
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

const node = (page: Page, label: string) =>
  page.locator('.react-flow__node', {
    has: page.locator('.node-label', {
      hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    }),
  });

test('watching keeps the open canvas live: a new file appears without a manual rescan', async ({
  page,
  request,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-watch-')), 'live-service');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: root } })
  ).json();
  const worktreeId = reg.worktree.id as string;

  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(worktreeId);
  const watch = page.getByRole('button', { name: 'Watch' });
  await watch.click();
  const live = page.getByRole('button', { name: 'Live' });
  await expect(live).toHaveAttribute('aria-pressed', 'true');
  // enabling the watch scans whatever has not been scanned yet
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText('System context', {
    timeout: 15_000,
  });

  await page.getByRole('button', { name: 'Project structure component', exact: true }).click();
  await node(page, '@reports/api').dblclick();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure / @reports/api',
  );
  await expect(node(page, 'db.ts')).toBeVisible();
  await expect(node(page, 'live-probe.ts')).toHaveCount(0);
  const positions = () =>
    page
      .locator('.react-flow__node')
      .evaluateAll((els) =>
        Object.fromEntries(
          els.map((e) => [
            e.querySelector('.node-label')?.textContent ?? e.id,
            (e as HTMLElement).style.transform,
          ]),
        ),
      );
  const before = await positions();
  // let the remembered layout positions save before the map changes
  await page.waitForTimeout(600);

  writeFileSync(
    join(root, 'packages/api/src/live-probe.ts'),
    "import { getReport } from './db';\nexport const probe = getReport;\n",
  );
  await expect(node(page, 'live-probe.ts')).toBeVisible({ timeout: 15_000 });
  // the map stays where it was: every existing node keeps its exact position, the new one takes free space
  const after = await positions();
  for (const [label, transform] of Object.entries(before))
    expect(after[label], label).toBe(transform);
  const fresh = (await node(page, 'live-probe.ts').boundingBox())!;
  for (const other of await page.locator('.react-flow__node').all()) {
    if ((await other.locator('.node-label').textContent()) === 'live-probe.ts') continue;
    const b = (await other.boundingBox())!;
    const overlaps =
      fresh.x < b.x + b.width &&
      b.x < fresh.x + fresh.width &&
      fresh.y < b.y + b.height &&
      b.y < fresh.y + fresh.height;
    expect(overlaps).toBe(false);
  }
  // still on the same canvas: the update did not navigate away
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure / @reports/api',
  );

  await live.click();
  await expect(page.getByRole('button', { name: 'Watch' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const status = await (
    await request.get(`/api/v1/worktrees/${worktreeId}/watch`, { headers: auth })
  ).json();
  expect(status.watching).toBe(false);
});
