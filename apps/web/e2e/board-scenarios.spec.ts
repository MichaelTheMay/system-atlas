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
  customData?: { atlas?: { kind: string; id: string; role?: string } };
}
/** The container rectangle of each drawn component (1a tags every part; `role: 'box'` is the box). */
const isBox = (e: SceneEl) =>
  e.customData?.atlas?.kind === 'component' && e.customData.atlas.role === 'box';

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
  const { boardId } = await newTemplateBoard(page, request, 'Flows');
  // scenarios and the design doc are tabs of the board inspector (App's right column)
  const panels = page.getByRole('complementary', { name: 'Inspector' });
  await expect(panels.getByRole('tab', { name: 'Properties' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await panels.getByRole('tab', { name: 'Scenarios' }).click();
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
  const { boardId } = await newTemplateBoard(page, request, 'Docs');
  const panels = page.getByRole('complementary', { name: 'Inspector' });
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
        document: { scene: { elements: SceneEl[] }; components: Record<string, unknown> };
      };
      const comps = b.document.scene.elements.filter(isBox);
      return {
        source: b.source,
        drawn: comps.length > 0 && comps.length === Object.keys(b.document.components).length,
        faded: comps.every((e) => e.opacity === 60),
      };
    })
    .toEqual({ source: 'code', drawn: true, faded: true });
  await expect(board.getByText(/[1-9]\d* component\(s\)/)).toBeVisible();

  // presenting it has one slide: the "As built" frame
  await board.getByRole('button', { name: 'Present' }).click();
  await expect(
    page
      .getByRole('toolbar', { name: 'Presentation' })
      .getByText(/Slide 1 \/ 1 · As built \(from code, \d{4}-\d{2}-\d{2}\)/),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // "Import as built" adds the same design next to an already-drawn board, faded, in its own frame
  await page.getByRole('button', { name: '← Boards' }).click();
  await page.getByLabel('Name').fill('Planned');
  await page.getByLabel('Start from').selectOption('url-shortener');
  await page.getByRole('button', { name: 'Create board' }).click();
  const planned = page.getByRole('region', { name: 'Design board: Planned' });
  await expect(planned.getByText('Saved', { exact: true })).toBeVisible();
  await planned.getByRole('button', { name: 'Import as built' }).click();
  await expect
    .poll(async () => {
      const list = await (
        await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
      ).json();
      const id = list.boards.find((x: { name: string }) => x.name === 'Planned').id as string;
      const b = (await stored(request, id)) as unknown as {
        document: {
          scene: { elements: SceneEl[] };
          components: Record<string, { origin: { author: string } }>;
          frames: { label: string }[];
        };
      };
      const code = new Set(
        Object.entries(b.document.components)
          .filter(([, c]) => c.origin.author === 'code')
          .map(([cid]) => cid),
      );
      const boxes = b.document.scene.elements.filter(isBox);
      const codeBoxes = boxes.filter((e) => code.has(e.customData!.atlas!.id));
      return {
        template: boxes.length - codeBoxes.length,
        imported: codeBoxes.length > 0 && codeBoxes.length === code.size,
        faded: codeBoxes.every((e) => e.opacity === 60),
        frame: b.document.frames.some((f) => f.label.startsWith('As built (from code')),
      };
    })
    .toEqual({ template: 10, imported: true, faded: true, frame: true });

  // a project without a snapshot does not offer it
  const empty = await registerEmpty(request, 'nocode');
  await openBoards(page, empty.wt);
  await expect(page.getByLabel('Start from').locator('option[value="code"]')).toHaveCount(0);
});

async function scanNested(request: APIRequestContext) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-board-nested-')), 'shop');
  cpSync(new URL('../../../fixtures/monorepo-nested', import.meta.url).pathname, root, {
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

test('from code, recursively (D04): subsystems open as internals boards two levels down', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await scanNested(request);
  await openBoards(page, wt);
  await page.getByLabel('Name').fill('Shop as built');
  await page.getByLabel('Start from').selectOption('code');
  await page.getByRole('button', { name: 'Create board' }).click();
  const root = page.getByRole('region', { name: 'Design board: Shop as built' });
  await expect(root.locator('.excalidraw')).toBeVisible();

  // one board per design subsystem, all linked under the root
  const { boards } = (await (
    await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
  ).json()) as { boards: { id: string; name: string; parentBoardId?: string }[] };
  expect(boards).toHaveLength(8);
  const rootId = boards.find((b) => !b.parentBoardId)!.id;
  expect(
    boards
      .filter((b) => b.parentBoardId === rootId)
      .map((b) => b.name)
      .sort(),
  ).toEqual([
    'Build & test tooling — internals',
    'Fixtures & examples — internals',
    'apps — internals',
    'packages — internals',
  ]);

  // the summary lists what opens; the canvas marks those boxes
  const summary = page.getByRole('region', { name: 'Board summary' });
  await expect(summary.getByRole('button', { name: 'packages', exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const b = await (await request.get(`/api/v1/boards/${rootId}`, { headers: auth })).json();
      return (b.document.scene.elements as { text?: string }[]).filter((e) =>
        e.text?.includes('opens internals'),
      ).length;
    })
    .toBe(4);

  // root -> packages -> commerce
  await summary.getByRole('button', { name: 'packages', exact: true }).click();
  const packages = page.getByRole('region', { name: 'Design board: packages — internals' });
  await expect(packages.locator('.excalidraw')).toBeVisible();
  const path = page.getByRole('navigation', { name: 'Board path' });
  await expect(path.getByRole('button')).toHaveText(['Shop as built']);
  await page
    .getByRole('region', { name: 'Board summary' })
    .getByRole('button', { name: 'commerce', exact: true })
    .click();
  const commerce = page.getByRole('region', { name: 'Design board: commerce — internals' });
  await expect(commerce.locator('.excalidraw')).toBeVisible();
  await expect(path.getByRole('button')).toHaveText(['Shop as built', 'packages — internals']);

  // the lowest board is drawn on first open: five boxes of its own and seven outside stubs, faded
  const commerceId = boards.find((b) => b.name === 'commerce — internals')!.id;
  await expect
    .poll(async () => {
      const b = await (await request.get(`/api/v1/boards/${commerceId}`, { headers: auth })).json();
      return (b.document.scene.elements as SceneEl[]).filter(isBox).length;
    })
    .toBe(12);
  await expect(
    page.getByRole('region', { name: 'Board summary' }).getByRole('heading', { name: 'Internals' }),
  ).toHaveCount(0);

  // back up by the path, then to the list: only the root is listed
  await path.getByRole('button', { name: 'Shop as built' }).click();
  await expect(root.locator('.excalidraw')).toBeVisible();
  await expect(path).toHaveCount(0);
  await page.getByRole('button', { name: '← Boards' }).click();
  const list = page.getByRole('region', { name: 'Design boards' });
  await expect(list.locator('.board-card')).toHaveCount(1);
  await expect(list.locator('.board-card')).toContainText('7 internals board(s)');
});

test('flow gaps (D04): a step the flow has not reached is flagged and repaired in one click', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await registerEmpty(request, 'chat');
  await openBoards(page, wt);
  await page.getByLabel('Name').fill('Chat');
  await page.getByLabel('Start from').selectOption('chat');
  await page.getByRole('button', { name: 'Create board' }).click();
  const board = page.getByRole('region', { name: 'Design board: Chat' });
  await expect(board.locator('.excalidraw')).toBeVisible();
  const { boards } = (await (
    await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
  ).json()) as { boards: { id: string }[] };
  const steps = async () => {
    const b = await (
      await request.get(`/api/v1/boards/${boards[0]!.id}`, { headers: auth })
    ).json();
    return (b.document.scenarios[0].steps as { connectionId?: string }[]).map(
      (s) => s.connectionId ?? '-',
    );
  };

  await page.getByRole('tab', { name: 'Scenarios' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Scenarios' });
  // "Send a message to an online friend" goes mobile -> load balancer, then gateway -> chat
  // service: nothing takes it from the load balancer to the gateway
  const first = panel.locator('.scenario').first();
  await expect(first.locator('.scenario-head .chip-gap')).toHaveText('1 gap(s)');
  await expect(first.locator('.step-gap')).toHaveCount(1);
  await expect(first.locator('.step').nth(1).locator('.step-gap')).toContainText(
    'The flow has not reached this step.',
  );
  expect(await steps()).toEqual(['k3', 'k8', 'k9', 'k10', '-']);

  await first.getByRole('button', { name: 'Insert missing hops before step 2' }).click();
  await expect(first.locator('.step')).toHaveCount(6);
  await expect(first.locator('.chip-gap')).toHaveCount(0);
  // the inserted step is the load balancer -> gateway hop, and it is saved
  await expect(first.getByLabel('Step 2 target')).toHaveValue('k:k5');
  await expect.poll(steps).toEqual(['k3', 'k5', 'k8', 'k9', 'k10', '-']);

  // the sequence view warns about a gap too: the second scenario is whole, so no warning there
  await first.getByRole('button', { name: 'Sequence view' }).click();
  await expect(first.getByRole('figure').locator('svg')).toBeVisible();
  await expect(first.locator('.scenario-gap-note')).toHaveCount(0);
});

test('flows from code (D04): follow a derived flow into an internals board and back', async ({
  page,
  request,
}) => {
  const { wt } = await scanNested(request);
  await openBoards(page, wt);
  await page.getByLabel('Name').fill('Shop flows');
  await page.getByLabel('Start from').selectOption('code');
  await page.getByRole('button', { name: 'Create board' }).click();
  const root = page.getByRole('region', { name: 'Design board: Shop flows' });
  await expect(root.locator('.excalidraw')).toBeVisible();

  await page.getByRole('tab', { name: 'Scenarios' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Scenarios' });
  // three flows derived from the routes of apps/api, each marked as built, none with a gap
  await expect(panel.locator('.scenario-name')).toHaveText([
    /^POST \/orders\s*5 step\(s\)$/,
    /^GET \/orders\/:id\s*3 step\(s\)$/,
    /^GET \/products\s*3 step\(s\)$/,
  ]);
  await expect(panel.locator('.scenario-head .chip', { hasText: 'as built' })).toHaveCount(3);
  await expect(panel.locator('.chip-gap')).toHaveCount(0);
  const flow = panel.locator('.scenario').first();
  await expect(flow.locator('.scenario-desc')).toContainText(
    'a step may be reachable without being taken',
  );
  await expect(flow.getByLabel('Step 3 text')).toHaveValue(
    '@shop/orders writes order_items and orders and reads orders in db.',
  );
  // steps 1 (inside apps) and 2 (into packages) open the same flow one level down
  await expect(flow.locator('.step-drill')).toHaveCount(2);

  // the sequence view draws the internals flows inside shaded blocks
  await flow.getByRole('button', { name: 'Sequence view' }).click();
  const figure = flow.getByRole('figure');
  await expect(figure.locator('svg')).toContainText('Inside apps (apps — internals)');
  await expect(figure.locator('svg')).toContainText('@shop/storefront');
  await expect(figure.locator('svg')).toContainText('Inside commerce (commerce — internals)');

  // player: step 1 happens inside apps; go down, play there, come back to step 2
  await flow.getByRole('button', { name: 'Player' }).click();
  await flow.getByRole('button', { name: 'Next ›' }).click();
  await expect(flow.locator('.player-text')).toContainText('Step 1 / 5');
  await flow.getByRole('button', { name: '↓ Into this step' }).click();

  const apps = page.getByRole('region', { name: 'Design board: apps — internals' });
  await expect(apps.locator('.excalidraw')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Board path' }).getByRole('button')).toHaveText(
    ['Shop flows'],
  );
  // the Scenarios tab opens by itself, on the same flow, in the player, at its first step
  await expect(page.getByRole('tab', { name: 'Scenarios' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const below = page.getByRole('tabpanel', { name: 'Scenarios' }).locator('.scenario').first();
  await expect(below.locator('.player-text')).toContainText(
    'Step 1 / 6: @shop/storefront calls POST /orders on @shop/api.',
  );
  await below.getByRole('button', { name: 'Next ›' }).click();
  await expect(below.locator('.player-text')).toContainText('Step 2 / 6');

  await below.getByRole('button', { name: '↑ Back to the flow above' }).click();
  await expect(root.locator('.excalidraw')).toBeVisible();
  const again = page.getByRole('tabpanel', { name: 'Scenarios' }).locator('.scenario').first();
  // back on the root at the step after the one that led down
  await expect(again.locator('.player-text')).toContainText(
    'Step 2 / 5: @shop/api uses @shop/orders.',
  );
  // nothing to go back up to from the root
  await expect(again.getByRole('button', { name: '↑ Back to the flow above' })).toHaveCount(0);
});

test('a board drawn on its first open has its text measured with the canvas fonts', async ({
  page,
  request,
}) => {
  // A new page has no canvas fonts loaded, so the board is drawn with fallback metrics first.
  const { wt, projectId } = await scanNested(request);
  await openBoards(page, wt);
  await page.getByLabel('Name').fill('Fonts');
  await page.getByLabel('Start from').selectOption('code');
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(
    page.getByRole('region', { name: 'Design board: Fonts' }).locator('.excalidraw'),
  ).toBeVisible();
  const { boards } = (await (
    await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
  ).json()) as { boards: { id: string; parentBoardId?: string }[] };
  const rootId = boards.find((b) => !b.parentBoardId)!.id;
  /** Stored width of each long label against its width in the loaded hand-drawn font. */
  const widths = async () => {
    const b = await (await request.get(`/api/v1/boards/${rootId}`, { headers: auth })).json();
    const labels = (
      b.document.scene.elements as {
        type: string;
        text?: string;
        width: number;
        fontSize: number;
        fontFamily: number;
      }[]
    ).filter((e) => e.type === 'text' && e.fontFamily === 5 && (e.text?.length ?? 0) >= 18);
    return page.evaluate(async (els) => {
      await document.fonts.load('20px Excalifont', 'Build');
      const ctx = document.createElement('canvas').getContext('2d')!;
      return els.map((e) => {
        ctx.font = `${e.fontSize}px Excalifont`;
        const real = Math.max(...e.text!.split('\n').map((l) => ctx.measureText(l).width));
        return { text: e.text, off: Math.round(Math.abs(real - e.width)) };
      });
    }, labels);
  };
  // "Build & test tooling", "Fixtures & examples", "Third-party libraries": saved within 2px of
  // their real width (they were up to 20px short, and clipped, when measured too early)
  await expect
    .poll(async () => {
      const w = await widths();
      return w.length >= 3 && w.every((x) => x.off <= 2) ? 'ok' : JSON.stringify(w);
    })
    .toBe('ok');
});
