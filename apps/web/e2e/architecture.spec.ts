import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

const auth = { authorization: `Bearer ${E2E_TOKEN}` };

// Any uncaught error in the page fails the test with its message (a crash otherwise shows as a blank page).
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});
const fixture = new URL('../../../fixtures/ts-web-service', import.meta.url).pathname.replace(
  /\/$/,
  '',
);

async function scanFixture(request: APIRequestContext): Promise<string> {
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: fixture } })
  ).json();
  const worktreeId = reg.worktree.id as string;
  let job = await (
    await request.post(`/api/v1/worktrees/${worktreeId}/scans`, { headers: auth })
  ).json();
  for (let i = 0; i < 100 && (job.state === 'queued' || job.state === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = await (await request.get(`/api/v1/jobs/${job.id}`, { headers: auth })).json();
  }
  expect(job.state).toBe('succeeded');
  return worktreeId;
}

async function openProject(page: Page, worktreeId: string) {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(worktreeId);
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText('System context');
}

const node = (page: Page, label: string) =>
  page.locator('.react-flow__node', {
    has: page.locator('.node-label', {
      hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    }),
  });

test('open project → nested component → evidence → source', async ({ page, request }) => {
  const wt = await scanFixture(request);
  await openProject(page, wt);
  await expect(node(page, 'ts-web-service')).toBeVisible();
  await expect(node(page, 'Third-party libraries')).toBeVisible();

  await node(page, 'ts-web-service').dblclick();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure',
  );
  await node(page, '@reports/api').dblclick();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure / @reports/api',
  );

  await node(page, 'db.ts').click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('region', { name: 'Entity details' })).toContainText(
    'packages/api/src/db.ts:1-15',
  );
  await expect(inspector).toContainText('current');
  await expect(inspector).toContainText('writes reports');
  await inspector.getByRole('button', { name: 'View source' }).click();
  const code = inspector.getByRole('region', { name: 'Source of packages/api/src/db.ts' });
  await expect(code).toContainText('insertReport');
  await expect(code.locator('.line.hl')).toHaveCount(15);

  // back/forward keep navigation
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure',
  );
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure / @reports/api',
  );
});

test('an edge explains itself with relations and evidence', async ({ page, request }) => {
  const wt = await scanFixture(request);
  await openProject(page, wt);
  await page.getByRole('button', { name: 'Workflows & queues workflow', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Workflows & queues',
  );
  await page.locator('.react-flow__edge').first().click({ force: true });
  const edge = page.getByRole('region', { name: 'Edge details' });
  await expect(edge).toContainText('Why this edge?');
  await expect(edge).toContainText(/publishes|subscribes/);
  await expect(edge).toContainText(/new (Queue|Worker)/);
});

test('a manual pin survives reload and rescan', async ({ page, request }) => {
  const wt = await scanFixture(request);
  await openProject(page, wt);
  await page.getByRole('button', { name: 'Project structure component', exact: true }).click();
  const web = node(page, '@reports/web');
  await expect(web).toBeVisible();
  const box = (await web.boundingBox())!;
  // wait for the save that actually carries the pin (viewport-only saves don't count)
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes('/overlay') &&
      r.request().method() === 'PUT' &&
      r.ok() &&
      /"pinnedIds":\["ent_/.test(r.request().postData() ?? ''),
  );
  await page.mouse.move(box.x + 40, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 65, { steps: 8 });
  await page.mouse.up();
  await saved;
  // flow-space position from the node transform; stored pins are rounded to whole pixels
  const transform = async () =>
    (await web.getAttribute('style'))!
      .match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)!
      .slice(1)
      .map(Number);
  const near = (a: number[], b: number[]) =>
    expect(Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!))).toBeLessThanOrEqual(1);
  const pinned = await transform();
  await expect(web.locator('.node-flag')).toHaveCount(1);

  await page.reload();
  await page.getByRole('combobox', { name: 'Project' }).selectOption(wt);
  await page.getByRole('button', { name: 'Project structure component', exact: true }).click();
  await expect(web).toBeVisible();
  near(await transform(), pinned);
  // the reopened view fits the canvas (a pin-only save must not restore a default viewport)
  const pane = (await page.locator('.react-flow').boundingBox())!;
  const after = (await web.boundingBox())!;
  expect(after.x).toBeGreaterThanOrEqual(pane.x);
  expect(after.y).toBeGreaterThanOrEqual(pane.y);
  expect(after.x + after.width).toBeLessThanOrEqual(pane.x + pane.width);
  expect(after.y + after.height).toBeLessThanOrEqual(pane.y + pane.height);

  await scanFixture(request);
  await page.waitForTimeout(500);
  await expect(web).toBeVisible();
  near(await transform(), pinned);
});

test('list view is a readable alternative to the canvas', async ({ page, request }) => {
  const wt = await scanFixture(request);
  await openProject(page, wt);
  await page.getByRole('button', { name: 'List' }).click();
  const nodes = page.getByRole('table', { name: /Nodes in System context/ });
  await expect(nodes).toContainText('ts-web-service');
  await nodes
    .getByRole('row', { name: /ts-web-service/ })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure',
  );
  await expect(page.getByRole('table', { name: 'Relations' })).toContainText('depends-on');
});

test('the Python fixture renders its own views: merged root, API, and module detail', async ({
  page,
  request,
}) => {
  const root = new URL('../../../fixtures/py-cli-api', import.meta.url).pathname.replace(/\/$/, '');
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: root } })
  ).json();
  let job = await (
    await request.post(`/api/v1/worktrees/${reg.worktree.id}/scans`, { headers: auth })
  ).json();
  for (let i = 0; i < 100 && (job.state === 'queued' || job.state === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = await (await request.get(`/api/v1/jobs/${job.id}`, { headers: auth })).json();
  }
  await openProject(page, reg.worktree.id);
  await expect(node(page, 'py-cli-api')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deployables deploy', exact: true })).toHaveCount(
    0,
  );
  await node(page, 'py-cli-api').dblclick();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure',
  );
  // the root package (notekeeper) is merged into the system, so modules are the first level
  await expect(node(page, 'api')).toBeVisible();
  await expect(node(page, 'cli')).toBeVisible();
  await node(page, 'api').dblclick();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText(
    'Project structure / api (module)',
  );
  await expect(node(page, 'GET /notes/{note_id}')).toBeVisible();
  await page.getByRole('button', { name: 'API api', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveText('API');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(node(page, 'POST /notes')).toBeVisible();
  await page.screenshot({ path: 'test-results/python-api.png' });
});
