import { cpSync, mkdtempSync } from 'node:fs';
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

test('model claims show as labeled hypotheses with their citations, and a person can reject them', async ({
  page,
  request,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-claims-')), 'claims-svc');
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
  const sid = job.snapshotId as string;
  const { hits } = await (
    await request.get(`/api/v1/snapshots/${sid}/search?q=db&kind=module`, { headers: auth })
  ).json();
  const dbId = hits.find((h: { path?: string }) => h.path === 'packages/api/src/db.ts')
    .id as string;
  const proposed = await (
    await request.post('/api/v1/proposals/claims', {
      headers: auth,
      data: {
        snapshotId: sid,
        origin: 'model',
        modelMetadata: {
          provider: 'mcp-client',
          model: 'test-agent',
          promptTemplateVersion: 'agent-authored',
        },
        claims: [
          {
            subjectId: dbId,
            predicate: 'role',
            value: 'storage',
            citations: [{ path: 'packages/api/src/db.ts', startLine: 1, endLine: 2 }],
          },
          {
            subjectId: dbId,
            predicate: 'summary',
            value: 'Invented.',
            citations: [{ path: 'packages/api/src/nope.ts', startLine: 1, endLine: 1 }],
          },
        ],
      },
    })
  ).json();
  expect(proposed.accepted).toHaveLength(1);
  expect(proposed.rejected).toHaveLength(1);

  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(wt);
  await page.getByRole('button', { name: 'Project structure component', exact: true }).click();
  await node(page, '@reports/api').dblclick();
  await node(page, 'db.ts').click();
  const details = page.getByRole('region', { name: 'Entity details' });
  const claim = details.locator('li.claim', { hasText: 'Role' });
  await expect(claim).toContainText('storage');
  await expect(claim).toContainText('model · test-agent');
  await expect(claim).toContainText('inferred');
  await expect(claim).toContainText('1 citation');
  await expect(details).not.toContainText('Invented.');
  await claim.getByRole('button', { name: /^Reject claim/ }).click();
  await expect(claim).toContainText('rejected');
  await expect(claim.getByRole('button', { name: /^Reject claim/ })).toHaveCount(0);

  const audit = await (
    await request.get(`/api/v1/projects/${reg.project.id}/proposals`, { headers: auth })
  ).json();
  expect(audit.proposals.map((p: { kind: string }) => p.kind)).toEqual(['review', 'claims']);
  expect(audit.proposals[1]).toMatchObject({ accepted: 1, rejected: 1 });
});
