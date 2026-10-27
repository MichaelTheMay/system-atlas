import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
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
const flowLabel = (page: Page, label: string) =>
  page.locator('.edge-label.flow-label', { hasText: new RegExp(`^${label}$`) });

/** Register a fresh copy of ts-web-service and scan it; returns ids. */
async function scanFixture(request: APIRequestContext, name: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-design-')), name);
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: root } })
  ).json();
  const wt = reg.worktree.id as string;
  let job = await (await request.post(`/api/v1/worktrees/${wt}/scans`, { headers: auth })).json();
  while (job.state === 'queued' || job.state === 'running') {
    await new Promise((r) => setTimeout(r, 50));
    job = await (await request.get(`/api/v1/jobs/${job.id}`, { headers: auth })).json();
  }
  return { wt, projectId: reg.project.id as string, snapshotId: job.snapshotId as string };
}

async function openDesign(page: Page, wt: string) {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(wt);
  await page.getByRole('button', { name: /^System design/ }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName('System design canvas: System design');
}

test('the System design root draws archetype boxes and flows, and a box opens the code that realizes it', async ({
  page,
  request,
}) => {
  const { wt } = await scanFixture(request, 'design-svc');
  await openDesign(page, wt);

  const archetypes: [string, string][] = [
    ['web', 'client'],
    ['api', 'API service'],
    ['worker', 'worker'],
    ['db', 'datastore'],
    ['report-jobs', 'queue'],
    ['@reports/shared', 'library'],
  ];
  for (const [label, archetype] of archetypes)
    await expect(node(page, label).locator('.node-archetype')).toHaveText(archetype);
  await expect(node(page, 'api').locator('.design-node')).toHaveClass(/arch-api-service/);
  for (const flow of ['HTTP', 'enqueue', 'consume', 'reads/writes', 'uses'])
    await expect(flowLabel(page, flow).first()).toBeVisible();
  // a design root without proposals has no subsystems; the catalog lists only the root
  await expect(
    page.getByRole('button', { name: 'System design design', exact: true }),
  ).toBeVisible();

  await node(page, 'db').click();
  const box = page.getByRole('region', { name: 'Design box' });
  await expect(box).toContainText('datastore');
  await expect(box).toContainText('image postgres');
  await expect(box).toContainText('detected');
  await box.getByRole('button', { name: 'Open db in Architecture' }).click();

  // root switches to Architecture, the realizing canvas opens and the entity stays selected
  await expect(page.getByRole('button', { name: /^Architecture/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('main')).toHaveAccessibleName(/^Architecture canvas: /);
  await expect(node(page, 'db')).toHaveClass(/selected/);
  const details = page.getByRole('region', { name: 'Entity details' });
  await expect(details).toContainText('compose:db');

  // each root keeps its own place: going back to System design shows the whiteboard again
  await page.getByRole('button', { name: /^System design/ }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName('System design canvas: System design');
});

test('an agent-proposed subsystem appears live as proposed, can be promoted and suppressed', async ({
  page,
  request,
}) => {
  const { wt, projectId, snapshotId } = await scanFixture(request, 'design-live');
  await openDesign(page, wt);
  await expect(node(page, 'api')).toBeVisible();

  // package entities behind the api and worker boxes
  const cat = await (
    await request.get(`/api/v1/snapshots/${snapshotId}/canvases`, { headers: auth })
  ).json();
  const rootId = cat.canvases.find((c: { lens: string }) => c.lens === 'design-system').id;
  const proj = await (
    await request.get(`/api/v1/snapshots/${snapshotId}/canvases/${rootId}/projection`, {
      headers: auth,
    })
  ).json();
  const entityOf = (label: string) =>
    proj.nodes.find((n: { label: string }) => n.label === label).entityId as string;
  const proposed = await (
    await request.post('/api/v1/proposals/claims', {
      headers: auth,
      data: {
        snapshotId,
        origin: 'model',
        modelMetadata: {
          provider: 'mcp-client',
          model: 'test-agent',
          promptTemplateVersion: 'agent-authored',
        },
        claims: ['api', 'worker'].map((p) => ({
          subjectId: entityOf(p),
          predicate: 'subsystem',
          value: 'Backend',
          citations: [{ path: `packages/${p}/package.json`, startLine: 1, endLine: 1 }],
        })),
      },
    })
  ).json();
  expect(proposed.accepted).toHaveLength(2);

  // live (SSE): the child canvas and its whiteboard box appear without a reload or rescan
  const views = page.getByRole('list', { name: 'Views' });
  const row = views.getByRole('button', { name: /^Backend/ });
  await expect(row).toHaveAccessibleName('Backend proposed (inferred)');
  await expect(node(page, 'Backend').locator('.node-archetype')).toHaveText('subsystem · 2 boxes');
  await expect(node(page, 'Backend')).toContainText('proposed');
  await expect(node(page, 'api')).toHaveCount(0);

  await row.click();
  await expect(page.getByRole('main')).toHaveAccessibleName('System design canvas: Backend');
  const info = page.getByRole('region', { name: 'Canvas details' });
  await expect(info).toContainText('proposed (inferred)');
  await expect(info).toContainText('Proposed by test-agent');
  // boxes outside the subsystem are faint context ports
  await expect(node(page, 'db').locator('.design-node')).toHaveClass(/k-port/);

  await info.getByRole('button', { name: 'Promote' }).click();
  await expect(row).toHaveAccessibleName('Backend accepted');
  await expect(info).toContainText('Accepted');
  await expect(info.getByRole('button', { name: 'Promote' })).toHaveCount(0);

  await info.getByRole('button', { name: 'Suppress' }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName('System design canvas: System design');
  await expect(views.getByRole('button', { name: /^Backend/ })).toHaveCount(0);
  await expect(node(page, 'Backend')).toHaveCount(0);
  await expect(node(page, 'api')).toBeVisible();
  const overrides = await (
    await request.get(`/api/v1/projects/${projectId}/overrides`, { headers: auth })
  ).json();
  expect(overrides.overrides.map((o: { action: string }) => o.action).sort()).toEqual([
    'promote',
    'suppress',
  ]);

  // suppressed views stay listed under their parent and can be restored
  const canvasInfo = page.getByRole('region', { name: 'Canvas details' });
  await expect(canvasInfo).toContainText('Suppressed here');
  await canvasInfo.getByRole('button', { name: 'Unsuppress' }).click();
  await expect(views.getByRole('button', { name: /^Backend/ })).toHaveAccessibleName(
    'Backend accepted',
  );
});
