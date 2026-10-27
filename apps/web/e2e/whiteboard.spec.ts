import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

/** Whiteboard controls on the System design canvases (D02a). */

const auth = { authorization: `Bearer ${E2E_TOKEN}` };
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const node = (page: Page, label: string) =>
  page.locator('.react-flow__node', {
    has: page.locator('.node-label', { hasText: new RegExp(`^${esc(label)}$`) }),
  });

async function scanFixture(request: APIRequestContext, name: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-wb-')), name);
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
  return { wt, projectId: reg.project.id as string };
}

async function openDesignEditing(page: Page, wt: string) {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(wt);
  await page.getByRole('button', { name: /^System design/ }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName('System design canvas: System design');
  await expect(node(page, 'api')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Done editing' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

/** Drag a connection from the right handle of one box to the left handle of another. */
async function connect(page: Page, from: Locator, to: Locator) {
  const a = (await from.locator('.react-flow__handle.source').boundingBox())!;
  const b = (await to.locator('.react-flow__handle.target').boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('draw a planned box, connect it, rename with undo/redo; drift is marked', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await scanFixture(request, 'wb-draw');
  await openDesignEditing(page, wt);

  // click-to-add from the palette: an unbound box, dashed and labelled as planned
  await page.getByRole('button', { name: 'Add API service' }).click();
  const box = node(page, 'New API service');
  await expect(box).toBeVisible();
  await expect(box).toContainText('planned — not in code');
  await expect(box.locator('.design-node')).toHaveClass(/unbound/);

  // drag a flow from the new box to api; its label is edited in place
  await connect(page, box, node(page, 'api'));
  const labelInput = page.getByRole('textbox', { name: 'Flow label' });
  await expect(labelInput).toBeFocused();
  await labelInput.fill('REST');
  await labelInput.press('Enter');
  const drawn = page.locator('.edge-label.wb-flow', { hasText: 'REST' });
  await expect(drawn).toContainText('drawn, not found in code');
  // once a flow is drawn, code flows left off the board are faint ghosts that can be adopted
  const ghost = page.locator('.edge-label.wb-flow.undrawn', { hasText: /^HTTP/ });
  await expect(ghost).toBeVisible();
  await ghost.hover();
  await ghost.getByRole('button', { name: 'Adopt HTTP flow' }).click();
  await expect(page.locator('.edge-label.wb-flow.undrawn', { hasText: /^HTTP/ })).toHaveCount(0);

  // inline rename: double-click the label
  await box.locator('.node-label').dblclick();
  const rename = page.getByRole('textbox', { name: 'Rename New API service' });
  await rename.fill('Billing API');
  await rename.press('Enter');
  await expect(node(page, 'Billing API')).toBeVisible();

  // undo / redo over the person's own operations
  await page.keyboard.press('Control+z');
  await expect(node(page, 'New API service')).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(node(page, 'Billing API')).toBeVisible();
  // the toolbar buttons do the same: undo the rename, then the adopted flow
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(node(page, 'New API service')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.edge-label.wb-flow.undrawn', { hasText: /^HTTP/ })).toBeVisible();
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(node(page, 'Billing API')).toBeVisible();

  // archetype change in the Inspector
  await node(page, 'Billing API').click();
  await page.getByRole('combobox', { name: 'Archetype' }).selectOption('worker');
  await expect(node(page, 'Billing API').locator('.node-archetype')).toHaveText('worker');

  const els = await (
    await request.get(`/api/v1/projects/${projectId}/design/elements`, { headers: auth })
  ).json();
  const kinds = els.elements.map((e: { body: { kind: string } }) => e.body.kind).sort();
  expect(kinds).toEqual(['box', 'flow', 'flow']);
  expect(els.elements.every((e: { author: string }) => e.author === 'user')).toBe(true);
});

test('group detected boxes into a subsystem, and hide a detected box with undo', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await scanFixture(request, 'wb-group');
  await openDesignEditing(page, wt);

  // multi-select two detected boxes and name the subsystem inline
  await node(page, 'worker').click();
  await node(page, 'report-jobs').click({ modifiers: ['Control'] });
  const bar = page.locator('.wb-selbar');
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Group into subsystem…' }).click();
  await bar.getByRole('textbox', { name: 'Subsystem name' }).fill('Jobs');
  await bar.getByRole('button', { name: 'Group', exact: true }).click();

  // a human subsystem claim per box: an accepted subsystem canvas appears
  const views = page.getByRole('list', { name: 'Views' });
  await expect(views.getByRole('button', { name: /^Jobs/ })).toHaveAccessibleName('Jobs accepted');
  await expect(node(page, 'Jobs').locator('.node-archetype')).toHaveText('subsystem · 2 boxes');
  await expect(node(page, 'worker')).toHaveCount(0);
  await node(page, 'Jobs').dblclick();
  await expect(page.getByRole('main')).toHaveAccessibleName('System design canvas: Jobs');
  await page.keyboard.press('Escape'); // the canvas details show when nothing is selected
  // the header counts the members, not the context ports around them
  await expect(page.getByRole('region', { name: 'Canvas details' })).toContainText(
    'subsystem · 2 box(es)',
  );
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName('System design canvas: System design');

  // Delete on a detected box hides it (a suppress override); Undo brings it back
  await node(page, 'db').click();
  await page.keyboard.press('Delete');
  await expect(node(page, 'db')).toHaveCount(0);
  const status = page.locator('.wb-status');
  await expect(status).toContainText('Hid db from the design views');
  await status.getByRole('button', { name: 'Undo' }).click();
  await expect(node(page, 'db')).toBeVisible();
  const overrides = await (
    await request.get(`/api/v1/projects/${projectId}/overrides`, { headers: auth })
  ).json();
  expect(
    overrides.overrides.filter((o: { action: string }) => o.action === 'suppress'),
  ).toHaveLength(0);

  // Escape clears the selection
  await node(page, 'api').click();
  await page.keyboard.press('Escape');
  await expect(node(page, 'api').locator('.design-node')).not.toHaveClass(/selected/);
});

test('sticky notes and drawn subsystems: add, edit text, dissolve and undo', async ({
  page,
  request,
}) => {
  const { wt } = await scanFixture(request, 'wb-sticky');
  await openDesignEditing(page, wt);

  await page.getByRole('button', { name: 'Add sticky note' }).click();
  const sticky = page.locator('.react-flow__node .wb-sticky');
  await expect(sticky).toHaveText('Note');
  await sticky.dblclick();
  const text = page.getByRole('textbox', { name: 'Note text' });
  await text.fill('Split billing out of api');
  await text.press('Control+Enter');
  await expect(sticky).toHaveText('Split billing out of api');

  await page.getByRole('button', { name: 'Add subsystem' }).click();
  await expect(node(page, 'New subsystem')).toBeVisible();
  await page.getByRole('button', { name: 'Add datastore' }).click();
  await node(page, 'New datastore').click();
  await page
    .getByRole('combobox', { name: 'In subsystem' })
    .selectOption({ label: 'New subsystem' });
  await expect(node(page, 'New datastore')).toHaveCount(0);
  await expect(node(page, 'New subsystem')).toContainText('subsystem · 1 box');

  // dissolve: the box moves back up; undo restores the subsystem around it
  await node(page, 'New subsystem').click();
  await page.getByRole('button', { name: 'Dissolve subsystem' }).click();
  await expect(node(page, 'New subsystem')).toHaveCount(0);
  await expect(node(page, 'New datastore')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(node(page, 'New subsystem')).toBeVisible();
  await expect(node(page, 'New datastore')).toHaveCount(0);
});
