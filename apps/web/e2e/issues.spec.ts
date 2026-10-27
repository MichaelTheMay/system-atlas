import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
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

async function scan(request: APIRequestContext, worktreeId: string) {
  let job = await (
    await request.post(`/api/v1/worktrees/${worktreeId}/scans`, { headers: auth })
  ).json();
  for (let i = 0; i < 200 && (job.state === 'queued' || job.state === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    job = await (await request.get(`/api/v1/jobs/${job.id}`, { headers: auth })).json();
  }
  expect(job.state).toBe('succeeded');
  return job.snapshotId as string;
}

test('rename issues are reviewed in the UI; a linked rename carries the pin to the moved file', async ({
  page,
  request,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-issues-')), 'renames');
  cpSync(new URL('../../../fixtures/py-cli-api', import.meta.url).pathname, root, {
    recursive: true,
  });
  const pkg = join(root, 'src/notekeeper');
  writeFileSync(join(pkg, 'a.py'), 'def helper():\n    return 1\n');
  writeFileSync(join(pkg, 'b.py'), 'def helper():\n    return 1\n');
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: root } })
  ).json();
  const worktreeId = reg.worktree.id as string;
  const projectId = reg.project.id as string;
  await scan(request, worktreeId);

  // identical files moved together are ambiguous; a moved-and-edited file is only a possible rename
  mkdirSync(join(pkg, 'sub'));
  renameSync(join(pkg, 'a.py'), join(pkg, 'sub/a2.py'));
  renameSync(join(pkg, 'b.py'), join(pkg, 'sub/b2.py'));
  mkdirSync(join(pkg, 'io'));
  writeFileSync(
    join(pkg, 'io/export.py'),
    readFileSync(join(pkg, 'export.py'), 'utf8') + '\n# edited\n',
  );
  rmSync(join(pkg, 'export.py'));
  const snapshotId = await scan(request, worktreeId);

  const { issues } = await (
    await request.get(`/api/v1/projects/${projectId}/issues`, { headers: auth })
  ).json();
  const ambiguous = issues.find((i: { kind: string }) => i.kind === 'ambiguous-rename');
  const at = (paths: string[], ids: string[], end: string) =>
    ids[paths.findIndex((p) => p.endsWith(end))]!;
  const aOld = at(ambiguous.detail.from, ambiguous.detail.fromIds, '/a.py');
  const aNew = at(ambiguous.detail.to, ambiguous.detail.toIds, '/a2.py');
  // the old file was pinned on some canvas before it moved
  const viewId = `cvs_${'7'.repeat(32)}`;
  await request.put(`/api/v1/views/${viewId}/overlay`, {
    headers: auth,
    data: {
      schemaVersion: 1,
      viewId,
      profileId: 'local',
      entityPositions: { [aOld]: { x: 40, y: 50 } },
      nodePositions: {},
      pinnedIds: [aOld],
      annotations: [],
      displayOverrides: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      revision: 0,
    },
  });

  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(worktreeId);
  await page.getByRole('button', { name: '2 rename issues to review' }).click();
  const panel = page.getByRole('dialog', { name: 'Rename issues' });
  const amb = panel.getByRole('listitem', { name: /^Ambiguous rename/ });
  const row = (old: string) => amb.locator('.issue-row', { hasText: old });
  // several candidates: nothing is preselected, so Link waits for a choice
  await expect(row('src/notekeeper/a.py').getByRole('button', { name: 'Link' })).toBeDisabled();
  await row('src/notekeeper/a.py')
    .getByRole('combobox', { name: 'New location of src/notekeeper/a.py' })
    .selectOption({ label: 'src/notekeeper/sub/a2.py' });
  await row('src/notekeeper/a.py').getByRole('button', { name: 'Link' }).click();
  await expect(amb).toContainText('linked');
  // only the remaining candidate is offered for b.py, and it is preselected
  const bSelect = row('src/notekeeper/b.py').getByRole('combobox', {
    name: 'New location of src/notekeeper/b.py',
  });
  await expect(bSelect.locator('option')).toHaveText(['src/notekeeper/sub/b2.py']);
  await row('src/notekeeper/b.py').getByRole('button', { name: 'Link' }).click();
  await expect(panel.getByRole('listitem', { name: /^Ambiguous rename/ })).toHaveCount(0);
  await panel
    .getByRole('listitem', { name: /^Possible rename/ })
    .getByRole('button', { name: 'Dismiss' })
    .click();
  await expect(panel).toContainText('No open rename issues.');
  await expect(page.getByRole('button', { name: /rename issues? to review/ })).toHaveCount(0);

  // the pin follows the linked rename when the current snapshot is viewed
  const overlay = await (
    await request.get(
      `/api/v1/views/${viewId}/overlay?project=${projectId}&snapshot=${snapshotId}`,
      { headers: auth },
    )
  ).json();
  expect(overlay.pinnedIds).toEqual([aNew]);
  expect(overlay.entityPositions).toEqual({ [aNew]: { x: 40, y: 50 } });
});
