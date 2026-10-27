import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

/** D03c: the design-board agent on the mock runtime (free, local, deterministic). */
const auth = { authorization: `Bearer ${E2E_TOKEN}` };
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

async function registerEmpty(request: APIRequestContext, name: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-bagent-')), name);
  mkdirSync(root);
  const reg = await (
    await request.post('/api/v1/projects', { headers: auth, data: { rootPath: root } })
  ).json();
  return { wt: reg.worktree.id as string, projectId: reg.project.id as string };
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

type El = {
  id: string;
  strokeStyle?: string;
  isDeleted?: boolean;
  customData?: { atlas?: { kind?: string; id?: string; role?: string } };
};
async function boardOf(request: APIRequestContext, projectId: string) {
  const list = await (
    await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
  ).json();
  const id = list.boards[0]?.id as string | undefined;
  if (!id) return undefined;
  return (await (await request.get(`/api/v1/boards/${id}`, { headers: auth })).json()) as {
    id: string;
    document: {
      scene: { elements: El[] };
      components: Record<string, { status: string }>;
      doc: {
        items: { id: string; status: string; section: string; text: string }[];
        plan?: string;
      };
    };
  };
}
/** Stroke styles of the component boxes on the saved scene. */
const componentStrokes = (b: Awaited<ReturnType<typeof boardOf>>) =>
  (b?.document.scene.elements ?? [])
    .filter(
      (e) =>
        !e.isDeleted &&
        e.customData?.atlas?.kind === 'component' &&
        e.customData.atlas.role === 'box',
    )
    .map((e) => e.strokeStyle);

test('start from a prompt: the mock drafts a proposed board, Accept all makes it solid; critique, reject, plan', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await registerEmpty(request, 'shortener');
  await openBoards(page, wt);

  await page.getByRole('button', { name: 'Start from a prompt…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start from a prompt' });
  await dialog.getByLabel('Design prompt').fill('design a url shortener');
  await expect(dialog.getByLabel('Runtime')).toHaveValue('mock');
  await dialog.getByRole('button', { name: 'Draft board' }).click();

  // the drafted board opens with every item proposed (dashed, faded, tagged with the agent)
  const board = page.getByRole('region', { name: 'Design board: URL shortener' });
  await expect(board).toBeVisible();
  const proposals = page.getByRole('region', { name: 'Agent proposals' });
  await expect(proposals).toBeVisible();
  await expect(
    proposals.getByRole('region', { name: 'Proposed components' }).getByRole('listitem'),
  ).toHaveCount(10);
  await expect(proposals.getByText('agent: mock-design').first()).toBeVisible();
  await expect
    .poll(async () => componentStrokes(await boardOf(request, projectId)))
    .toEqual(Array(10).fill('dashed'));
  await expect(board.locator('.excalidraw')).toBeVisible();

  await proposals.getByRole('button', { name: 'Accept all' }).click();
  await expect(page.getByRole('region', { name: 'Agent proposals' })).toHaveCount(0);
  await expect
    .poll(async () => componentStrokes(await boardOf(request, projectId)))
    .toEqual(Array(10).fill('solid'));
  const accepted = await boardOf(request, projectId);
  expect(Object.values(accepted!.document.components).every((c) => c.status === 'active')).toBe(
    true,
  );

  // critique: proposed risk items pinned to components; reject one
  await board.getByRole('button', { name: 'Agent ▾' }).click();
  await page.getByRole('menuitem', { name: 'Critique this design' }).click();
  const result = page.getByRole('region', { name: 'Agent result' });
  await expect(result.getByText(/item\(s\) proposed/)).toBeVisible();
  const doc = proposals.getByRole('region', { name: 'Proposed design doc' });
  await expect(doc.getByText(/^\[Security edge\]/)).toBeVisible();
  const items = doc.getByRole('listitem');
  const before = await items.count();
  expect(before).toBeGreaterThan(1);
  const rejectedText = (await items.first().locator('.ba-item-title').textContent())!;
  await items
    .first()
    .getByRole('button', { name: /^Reject / })
    .click();
  await expect(items).toHaveCount(before - 1);
  await expect
    .poll(
      async () =>
        (await boardOf(request, projectId))!.document.doc.items.find((i) => i.text === rejectedText)
          ?.status,
    )
    .toBe('rejected');

  // implementation plan: tickets per component with acceptance criteria and an agent brief
  await board.getByRole('button', { name: 'Agent ▾' }).click();
  await page.getByRole('menuitem', { name: 'Implementation plan…' }).click();
  const plan = page.getByRole('region', { name: 'Implementation plan' });
  await expect(
    plan.getByRole('heading', { name: 'Implementation plan: URL shortener' }),
  ).toBeVisible();
  await expect(plan.getByRole('heading', { name: /^T1 — / })).toBeVisible();
  await expect(plan.getByText('Acceptance criteria').first()).toBeVisible();
  await expect(plan.getByRole('heading', { name: 'Agent brief' })).toBeVisible();
  await expect(plan.getByRole('button', { name: 'Copy as agent brief' })).toBeVisible();
  await expect
    .poll(async () => (await boardOf(request, projectId))!.document.doc.plan ?? '')
    .toMatch(/^# Implementation plan: URL shortener/);
});

test('explain a scenario and propose a variant board from the Agent menu', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await registerEmpty(request, 'variant');
  const created = await (
    await request.post(`/api/v1/projects/${projectId}/boards`, {
      headers: auth,
      data: { name: 'Links', source: 'template', templateId: 'url-shortener' },
    })
  ).json();
  await openBoards(page, wt);
  await page.getByRole('button', { name: /^Links/ }).click();
  const board = page.getByRole('region', { name: 'Design board: Links' });
  await expect(board.locator('.excalidraw')).toBeVisible();

  await board.getByRole('button', { name: 'Agent ▾' }).click();
  await page.getByRole('menuitem', { name: 'Explain scenario…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Explain scenario' });
  await expect(dlg.getByLabel('Scenario')).toHaveValue('s1');
  await dlg.getByRole('button', { name: 'Explain' }).click();
  const result = page.getByRole('region', { name: 'Agent result' });
  await expect(result.getByText(/Web app → Load balancer, over HTTP, synchronously/)).toBeVisible();
  await result.getByRole('button', { name: 'Close agent result' }).click();

  await board.getByRole('button', { name: 'Agent ▾' }).click();
  await page.getByRole('menuitem', { name: 'Propose a variant' }).click();
  await result.getByRole('button', { name: 'Open variant' }).click();
  const variant = page.getByRole('region', { name: /^Design board: Links — variant: / });
  await expect(variant).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agent proposals' })).toBeVisible();
  // the original is untouched
  const orig = await (await request.get(`/api/v1/boards/${created.id}`, { headers: auth })).json();
  expect(
    Object.values(orig.document.components as Record<string, { status: string }>).every(
      (c) => c.status === 'active',
    ),
  ).toBe(true);
});

test('redraft on a drawn board: proposals are drawn with arrows bound to existing boxes', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await registerEmpty(request, 'redraft');
  const doc = {
    schemaVersion: 1,
    scene: { elements: [], appState: {}, files: {} },
    components: {
      mine: { id: 'mine', type: 'service', label: 'Shortener API', props: {}, elementIds: [] },
    },
    connections: {},
    scenarios: [],
    doc: { items: [] },
    frames: [],
  };
  await request.post(`/api/v1/projects/${projectId}/boards`, {
    headers: auth,
    data: { name: 'Mine', source: 'blank', document: doc },
  });
  await openBoards(page, wt);
  await page.getByRole('button', { name: /^Mine/ }).click();
  const board = page.getByRole('region', { name: 'Design board: Mine' });
  await expect(board.locator('.excalidraw')).toBeVisible();
  await board.getByRole('button', { name: 'Agent ▾' }).click();
  await page.getByRole('menuitem', { name: 'Redraft from a prompt…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Redraft from a prompt' });
  await dialog.getByLabel('Design prompt').fill('a url shortener');
  await dialog.getByRole('button', { name: 'Draft board' }).click();
  await expect(page.getByRole('region', { name: 'Agent proposals' })).toBeVisible();

  type Saved = {
    document: {
      components: Record<string, { status: string; elementIds: string[] }>;
      connections: Record<string, { from: string; to: string; elementId?: string }>;
      scene: {
        elements: { id: string; isDeleted?: boolean; endBinding?: { elementId: string } }[];
      };
    };
  };
  // the load balancer → existing API arrow is drawn and bound to the box that was already there
  await expect
    .poll(async () => {
      const list = await (
        await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
      ).json();
      const b = (await (
        await request.get(`/api/v1/boards/${list.boards[0].id}`, { headers: auth })
      ).json()) as Saved;
      const k = Object.values(b.document.connections).find((c) => c.to === 'mine');
      const arrow = b.document.scene.elements.find((e) => e.id === k?.elementId && !e.isDeleted);
      return arrow?.endBinding?.elementId === b.document.components.mine!.elementIds[0];
    })
    .toBe(true);
});
