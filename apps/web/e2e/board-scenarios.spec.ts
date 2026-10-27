import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

/** D03 wave 1b: scenarios, sequence view, player, design doc, export, present, from-code import. */
const auth = { authorization: `Bearer ${E2E_TOKEN}` };
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

interface SceneEl {
  id: string;
  type: string;
  opacity: number;
  customData?: { atlas?: { kind: string; id: string } };
}

async function registerEmpty(request: APIRequestContext, name: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-board-sc-')), name);
  mkdirSync(root);
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: root } })
  ).json();
  return { wt: reg.worktree.id as string, projectId: reg.project.id as string };
}

async function scanFixture(request: APIRequestContext, name: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-board-sc-')), name);
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

async function openBoards(page: Page, wt: string) {
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

async function newTemplateBoard(page: Page, request: APIRequestContext, name: string) {
  const { wt, projectId } = await registerEmpty(request, name.toLowerCase());
  await openBoards(page, wt);
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Start from').selectOption('url-shortener');
  await page.getByRole('button', { name: 'Create board' }).click();
  const board = page.getByRole('region', { name: `Design board: ${name}` });
  await expect(board.locator('.excalidraw')).toBeVisible();
  const list = await (
    await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
  ).json();
  return { board, boardId: list.boards[0].id as string, projectId };
}

const stored = async (request: APIRequestContext, boardId: string) =>
  (await (await request.get(`/api/v1/boards/${boardId}`, { headers: auth })).json()) as {
    document: {
      scene: { elements: SceneEl[] };
      doc: { items: { text: string; pins: string[]; section: string }[] };
    };
  };

test('scenarios: show numbers on the canvas, sequence view and step-through player', async ({
  page,
  request,
}) => {
  const { board, boardId } = await newTemplateBoard(page, request, 'Flows');
  const panels = board.getByRole('complementary', { name: 'Board panels' });
  await expect(panels.getByRole('tab', { name: 'Scenarios' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(panels.getByRole('button', { name: /^Redirect a short link/ })).toBeVisible();
  await expect(panels.getByText('5 step(s)')).toBeVisible();
  // steps are bound to connections, shown as "A → B · payload"
  await expect(panels.getByLabel('Step 1 target')).toHaveValue('k:c2');
  await expect(panels.getByLabel('Step 1 target').locator('option:checked')).toHaveText(
    'Web app → Load balancer · GET /{code}, POST /links',
  );

  await panels.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(panels.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
  // the numbers are scene elements tagged scenario-step, saved with the board; off-path is dimmed
  await expect
    .poll(async () => {
      const els = (await stored(request, boardId)).document.scene.elements;
      return els.filter((e) => e.customData?.atlas?.kind === 'scenario-step').length;
    })
    .toBe(10);
  const els = (await stored(request, boardId)).document.scene.elements;
  const idgen = els.find(
    (e) => e.customData?.atlas?.kind === 'component' && e.customData.atlas.id === 'idgen',
  );
  expect(idgen?.opacity).toBeLessThan(50);

  // sequence view: Mermaid rendered in the panel
  await panels.getByRole('button', { name: 'Sequence view' }).click();
  const seq = panels.getByRole('figure', { name: 'Sequence diagram: Redirect a short link' });
  await expect(seq.locator('svg')).toBeVisible();
  for (const p of ['Web app', 'Load balancer', 'Shortener API', 'Redirect cache', 'Links DB'])
    await expect(seq.locator('svg').getByText(p, { exact: true }).first()).toBeAttached();

  // player: Next advances the step text
  await panels.getByRole('button', { name: 'Player' }).click();
  const player = panels.getByLabel('Scenario player');
  await expect(player.getByText('5 step(s). Press Next or Play.')).toBeVisible();
  await player.getByRole('button', { name: 'Next ›' }).click();
  await expect(player.getByText('Step 1 / 5: Browser requests GET /{code}.')).toBeVisible();
  await player.getByRole('button', { name: 'Next ›' }).click();
  await expect(
    player.getByText('Step 2 / 5: Load balancer forwards to a healthy API instance.'),
  ).toBeVisible();
  await player.getByRole('button', { name: '‹ Prev' }).click();
  await expect(player.getByText(/^Step 1 \/ 5/)).toBeVisible();

  // hide removes the numbers and restores the dimmed boxes
  await panels.getByRole('button', { name: 'Steps' }).click();
  await panels.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect
    .poll(async () => {
      const all = (await stored(request, boardId)).document.scene.elements;
      return {
        steps: all.filter((e) => e.customData?.atlas?.kind === 'scenario-step').length,
        dimmed: all.filter((e) => e.opacity < 50).length,
      };
    })
    .toEqual({ steps: 0, dimmed: 0 });
});

test('design doc: sections, pins that select, and a new pinned item persists', async ({
  page,
  request,
}) => {
  const { board, boardId } = await newTemplateBoard(page, request, 'Docs');
  const panels = board.getByRole('complementary', { name: 'Board panels' });
  await panels.getByRole('tab', { name: 'Design doc' }).click();
  await expect(panels.getByLabel('Summary')).toHaveValue(/Create short links/);
  const risks = panels.getByRole('region', { name: 'Bottlenecks & failure modes' });
  await expect(risks.getByText(/Hot links can thrash/)).toBeVisible();
  await expect(panels.getByRole('region', { name: 'Capacity estimates' })).toContainText('10M MAU');

  // clicking a pin selects that component on the canvas, which becomes the pin target
  await risks.getByRole('button', { name: 'Links DB', exact: true }).click();
  await expect(panels.getByText('Pin to selection: Links DB')).toBeVisible();
  await panels.getByLabel('Section').selectOption('risks');
  await panels.getByLabel('New item').fill('Primary failover takes ~30 s; writes fail meanwhile.');
  await panels.getByRole('button', { name: 'Add item' }).click();
  await expect(
    risks.getByText('Primary failover takes ~30 s; writes fail meanwhile.'),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await stored(request, boardId)).document.doc.items.find((i) =>
        i.text.startsWith('Primary failover'),
      ),
    )
    .toMatchObject({ section: 'risks', pins: ['db'] });

  // the daemon's Markdown export carries it too
  const md = await (
    await request.get(`/api/v1/boards/${boardId}/export/markdown`, { headers: auth })
  ).text();
  expect(md).toContain('- Primary failover takes ~30 s; writes fail meanwhile. _(Links DB)_');
});

test('export SVG with text, and present mode with frames as slides', async ({ page, request }) => {
  const { board } = await newTemplateBoard(page, request, 'Slides');
  await expect(board.getByText('Saved', { exact: true })).toBeVisible();

  await board.getByRole('button', { name: 'Export ▾' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    board.getByRole('menuitem', { name: 'SVG image' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('slides.svg');
  const svg = readFileSync((await download.path())!, 'utf8');
  expect(svg).toMatch(/^<svg/);
  expect(svg).toContain('Shortener API');
  // fonts are inlined so the text renders outside Atlas
  expect(svg).toContain('@font-face');

  // Markdown design doc + PNG as one zip (stored entries: names and bytes readable as is)
  await board.getByRole('button', { name: 'Export ▾' }).click();
  const [zipDl] = await Promise.all([
    page.waitForEvent('download'),
    board.getByRole('menuitem', { name: 'Markdown design doc + PNG (.zip)' }).click(),
  ]);
  expect(zipDl.suggestedFilename()).toBe('slides-design-doc.zip');
  const zip = readFileSync((await zipDl.path())!);
  expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
  const zipText = zip.toString('latin1');
  expect(zipText).toContain('slides.md');
  expect(zipText).toContain('# Slides\n');
  expect(zipText).toContain('![Slides](slides.png)');
  expect(zipText).toContain('\x89PNG');

  await board.getByRole('button', { name: 'Present' }).click();
  const bar = page.getByRole('toolbar', { name: 'Presentation' });
  await expect(bar).toBeVisible();
  // read-only: Excalidraw's editing toolbar is gone in view mode
  await expect(page.getByRole('radio', { name: /Rectangle/ })).toHaveCount(0);
  await expect(bar.getByText('Slide 1 / 3 · Edge')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByText('Slide 2 / 3 · Core')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByText('Slide 3 / 3 · Analytics')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(bar.getByText('Slide 2 / 3 · Core')).toBeVisible();
  // scenario reveal advances with the player
  await bar.getByLabel('Reveal scenario').selectOption({ label: 'Redirect a short link' });
  await bar.getByRole('button', { name: 'Next ›' }).click();
  await expect(bar.getByText(/^Step 1 \/ 5/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Rectangle/ })).toBeVisible();
});

test('from code: a scanned project imports its derived design as a faded "as built" board', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await scanFixture(request, 'fromcode');
  await openBoards(page, wt);
  await page.getByLabel('Start from').selectOption('code');
  await page.getByRole('button', { name: 'Create board' }).click();
  const board = page.getByRole('region', { name: 'Design board: As built (from code)' });
  await expect(board.locator('.excalidraw')).toBeVisible();
  await expect
    .poll(async () => {
      const list = await (
        await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
      ).json();
      const b = (await stored(request, list.boards[0].id as string)) as unknown as {
        source: string;
        document: { scene: { elements: SceneEl[] } };
      };
      const comps = b.document.scene.elements.filter(
        (e) => e.customData?.atlas?.kind === 'component',
      );
      return { source: b.source, count: comps.length, faded: comps.every((e) => e.opacity === 60) };
    })
    .toMatchObject({ source: 'code', faded: true, count: expect.any(Number) });
  await expect(board.getByText(/[1-9]\d* component\(s\)/)).toBeVisible();

  // presenting it has one slide: the "As built" frame
  await board.getByRole('button', { name: 'Present' }).click();
  await expect(
    page
      .getByRole('toolbar', { name: 'Presentation' })
      .getByText(/Slide 1 \/ 1 · As built \(from code, \d{4}-\d{2}-\d{2}\)/),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // a project without a snapshot does not offer it
  const empty = await registerEmpty(request, 'nocode');
  await openBoards(page, empty.wt);
  await expect(page.getByLabel('Start from').locator('option[value="code"]')).toHaveCount(0);
});
