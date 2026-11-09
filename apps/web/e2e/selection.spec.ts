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

test('one selection across views: the selected entity stays selected in every view that shows it', async ({
  page,
  request,
}) => {
  const rootPath = new URL('../../../fixtures/ts-web-service', import.meta.url).pathname.replace(
    /\/$/,
    '',
  );
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath } })
  ).json();
  const wt = reg.worktree.id as string;
  let job = await (await request.post(`/api/v1/worktrees/${wt}/scans`, { headers: auth })).json();
  while (job.state === 'queued' || job.state === 'running') {
    await new Promise((r) => setTimeout(r, 50));
    job = await (await request.get(`/api/v1/jobs/${job.id}`, { headers: auth })).json();
  }
  // a concurrent scan of the same fixture may supersede this one; wait for the published snapshot
  await expect
    .poll(async () =>
      (await request.get(`/api/v1/worktrees/${wt}/snapshot`, { headers: auth })).ok(),
    )
    .toBe(true);
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(wt);
  await page.getByRole('button', { name: 'Project structure component', exact: true }).click();
  await node(page, '@reports/api').dblclick();
  await node(page, 'db.ts').click();
  const details = page.getByRole('region', { name: 'Entity details' });
  await expect(details.locator('.insp-title')).toHaveText('db.ts');

  // the Data lens shows db.ts only inside its package: that package is marked as containing it
  await page.getByRole('button', { name: 'Data data', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText('Data');
  await expect(node(page, '@reports/api').locator('.atlas-node')).toHaveClass(/contains-selection/);
  await expect(page.locator('.atlas-node.contains-selection')).toHaveCount(1);
  await expect(details.locator('.insp-title')).toHaveText('db.ts');

  // back on a canvas that shows db.ts itself, it is the selected node again, and in the list too
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure / @reports/api',
  );
  await expect(node(page, 'db.ts')).toHaveClass(/\bselected\b/);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await page.getByRole('button', { name: 'List' }).click();
  await expect(page.locator('.list-view tr[aria-current="true"] th')).toHaveText('db.ts');
  await page.getByRole('button', { name: 'Canvas' }).click();

  // selecting another entity moves the one selection, across views as well
  await page.getByRole('button', { name: 'Data data', exact: true }).click();
  // wait for the Data canvas itself: the previous canvas also shows a "reports" (as a port)
  await expect(page.getByRole('main')).toHaveAccessibleName('Architecture canvas: Data');
  await node(page, 'reports').click();
  await expect(details.locator('.insp-title')).toHaveText('reports');
  await page.getByRole('button', { name: 'Project structure component', exact: true }).click();
  await expect(page.locator('.react-flow__node.selected .node-label')).toHaveText(['reports']);
});
