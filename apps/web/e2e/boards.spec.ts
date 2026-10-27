import { mkdtempSync } from 'node:fs';
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

/** Boards are design-first: an empty folder is enough to own them. */
async function registerEmpty(request: APIRequestContext, name: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-boards-')), name);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(root);
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: root } })
  ).json();
  return { wt: reg.worktree.id as string, projectId: reg.project.id as string };
}

async function openBoards(page: Page, wt: string) {
  // a same-URL goto would only change the hash and keep the app's state: leave the page first
  await page.goto('about:blank');
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('combobox', { name: 'Project' }).selectOption(wt);
  await page.getByRole('button', { name: /^System design/ }).click();
  await page
    .getByRole('navigation', { name: 'Design views' })
    .getByRole('button', { name: 'Boards' })
    .click();
  await expect(page.getByRole('region', { name: 'Design boards' })).toBeVisible();
}

test('a board from a template opens on the whiteboard with its components drawn, and persists', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await registerEmpty(request, 'boards');
  await openBoards(page, wt);

  await page.getByLabel('Name').fill('Shortener');
  await page.getByLabel('Start from').selectOption('url-shortener');
  await page.getByRole('button', { name: 'Create board' }).click();

  const board = page.getByRole('region', { name: 'Design board: Shortener' });
  await expect(board).toBeVisible();
  await expect(board.locator('.excalidraw')).toBeVisible();
  await expect(board.getByText(/10 component\(s\)/)).toBeVisible();
  // the template's registry was laid out and saved as scene elements (rectangles, labels, arrows)
  await expect
    .poll(async () => {
      const list = await (
        await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
      ).json();
      const id = list.boards[0]?.id as string | undefined;
      if (!id) return 0;
      const b = await (await request.get(`/api/v1/boards/${id}`, { headers: auth })).json();
      return b.document.scene.elements.length as number;
    })
    .toBeGreaterThan(20);
  await expect(board.getByText('Saved', { exact: true })).toBeVisible();

  // the canvas is a real Excalidraw: its toolbar is there and fonts load from the app origin
  await expect(page.getByRole('radio', { name: /Rectangle/ })).toBeVisible();
  // a fresh session (the token is read from the fragment once) still lists and opens the board
  await openBoards(page, wt);
  await page.getByRole('button', { name: /^Shortener/ }).click();
  await expect(page.getByRole('region', { name: 'Design board: Shortener' })).toBeVisible();

  // a blank board and delete
  await page.getByRole('button', { name: '← Boards' }).click();
  await page.getByLabel('Name').fill('Scratch');
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page.getByRole('region', { name: 'Design board: Scratch' })).toBeVisible();
  await page.getByRole('button', { name: '← Boards' }).click();
  await page.getByRole('button', { name: 'Delete Scratch' }).click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByRole('button', { name: /^Scratch/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Shortener/ })).toBeVisible();
});
