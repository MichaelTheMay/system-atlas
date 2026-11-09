import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

/**
 * D03 wave 1a: the component layer of design boards. Excalidraw draws on a canvas, so everything
 * about the scene is asserted through the saved board (API), polled until the debounced save lands.
 */
const auth = { authorization: `Bearer ${E2E_TOKEN}` };
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

type El = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  points?: [number, number][];
  containerId?: string | null;
  customData?: { atlas?: { kind: string; id: string; role?: string } };
};
type Board = {
  id: string;
  document: {
    scene: { elements: El[] };
    components: Record<string, { id: string; type: string; label: string; props: object }>;
    connections: Record<string, { id: string; from: string; to: string; elementId?: string }>;
  };
};

async function registerEmpty(request: APIRequestContext, name: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-board-cmp-')), name);
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

const getBoard = async (request: APIRequestContext, projectId: string): Promise<Board> => {
  const list = await (
    await request.get(`/api/v1/projects/${projectId}/boards`, { headers: auth })
  ).json();
  return (await request.get(`/api/v1/boards/${list.boards[0].id}`, { headers: auth })).json();
};
const tagOf = (e: El) => e.customData?.atlas;
const boxes = (b: Board) =>
  b.document.scene.elements.filter(
    (e) => tagOf(e)?.kind === 'component' && tagOf(e)?.role === 'box',
  );

test('component layer: ELK layout, palette, properties, connections, rename and delete', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await registerEmpty(request, 'components');
  await openBoards(page, wt);

  // the new-board form describes the template it starts from
  await page.getByLabel('Start from').selectOption('payments');
  await expect(page.getByText(/card data stays inside a PCI trust boundary/)).toBeVisible();
  await page.getByLabel('Name').fill('Checkout');
  await page.getByRole('button', { name: 'Create board' }).click();
  const board = page.getByRole('region', { name: 'Design board: Checkout' });
  await expect(board).toBeVisible();

  // 1. materialized with ELK: every component drawn, no two component boxes overlap, the PCI
  // zone (a boundary) encloses its children, and no arrow runs through a box it does not join
  await expect
    .poll(async () => boxes(await getBoard(request, projectId)).length, { timeout: 15_000 })
    .toBe(14);
  const laid = await getBoard(request, projectId);
  const containers = new Set(['pci']);
  const solid = boxes(laid).filter((e) => !containers.has(tagOf(e)!.id));
  for (const a of solid)
    for (const b of solid) {
      if (a === b) continue;
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, `${tagOf(a)!.id} overlaps ${tagOf(b)!.id}`).toBe(false);
    }
  const zone = boxes(laid).find((e) => tagOf(e)!.id === 'pci')!;
  for (const child of ['payment', 'vault']) {
    const c = boxes(laid).find((e) => tagOf(e)!.id === child)!;
    expect(c.x > zone.x && c.y > zone.y, `${child} inside the PCI zone`).toBe(true);
    expect(c.x + c.width < zone.x + zone.width && c.y + c.height < zone.y + zone.height).toBe(true);
  }
  const frames = laid.document.scene.elements.filter((e) => e.type === 'frame');
  expect(frames.map((f) => (f as { name?: string }).name).sort()).toEqual(
    ['Checkout', 'Payments', 'Settlement'].sort(),
  );
  const arrows = laid.document.scene.elements.filter((e) => tagOf(e)?.kind === 'connection');
  expect(arrows).toHaveLength(12);
  for (const arrow of arrows) {
    const k = laid.document.connections[tagOf(arrow)!.id]!;
    const pts = arrow.points!.map(([x, y]) => ({ x: arrow.x + x, y: arrow.y + y }));
    for (const box of solid) {
      const id = tagOf(box)!.id;
      if (id === k.from || id === k.to) continue;
      // shrink by 2px: touching a border is fine, running through the inside is not
      const r = { x: box.x + 2, y: box.y + 2, w: box.width - 4, h: box.height - 4 };
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i]!;
        const q = pts[i + 1]!;
        const through =
          Math.max(p.x, q.x) > r.x &&
          Math.min(p.x, q.x) < r.x + r.w &&
          Math.max(p.y, q.y) > r.y &&
          Math.min(p.y, q.y) < r.y + r.h;
        expect(through, `arrow ${k.id} runs through ${id}`).toBe(false);
      }
    }
  }
  // icons are carried as files of the scene, never fetched
  expect(laid.document.scene.elements.some((e) => e.type === 'image')).toBe(true);

  // 2. palette click-adds a component at a free spot; it is selected and the inspector shows it
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await page
    .getByRole('navigation', { name: 'Component palette' })
    .getByPlaceholder('Search components')
    .fill('serv');
  await page.getByRole('button', { name: 'Add Service' }).click();
  await expect(inspector.getByRole('region', { name: 'Component' })).toBeVisible();
  await expect(inspector.getByRole('textbox', { name: 'Label' })).toHaveValue('Service');
  await expect(inspector.getByRole('spinbutton', { name: 'Instances' })).toBeVisible();
  let newId = '';
  await expect
    .poll(async () => {
      const b = await getBoard(request, projectId);
      newId = Object.values(b.document.components).find((c) => c.label === 'Service')?.id ?? '';
      return newId && boxes(b).some((e) => tagOf(e)!.id === newId);
    })
    .toBe(true);
  {
    const b = await getBoard(request, projectId);
    const mine = boxes(b).find((e) => tagOf(e)!.id === newId)!;
    for (const other of boxes(b).filter((e) => e !== mine && !containers.has(tagOf(e)!.id)))
      expect(
        mine.x < other.x + other.width &&
          other.x < mine.x + mine.width &&
          mine.y < other.y + other.height &&
          other.y < mine.y + mine.height,
        `new component overlaps ${tagOf(other)!.id}`,
      ).toBe(false);
  }

  // 3. a property shows up as a badge on the canvas
  await inspector.getByRole('spinbutton', { name: 'Instances' }).fill('3');
  await inspector.getByRole('spinbutton', { name: 'Instances' }).press('Enter');
  await expect
    .poll(async () => {
      const b = await getBoard(request, projectId);
      const badge = b.document.scene.elements.find(
        (e) => tagOf(e)?.id === newId && tagOf(e)?.role === 'badges',
      );
      return badge?.text ?? '';
    })
    .toContain('instances 3');

  // 4. "Connect to…" draws a tagged arrow bound to both boxes and registers the connection
  await inspector.getByRole('combobox', { name: 'Connect to' }).selectOption({ label: 'Ledger' });
  await inspector.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(inspector.getByRole('region', { name: 'Connection' })).toBeVisible();
  let connectionId = '';
  await expect
    .poll(async () => {
      const b = await getBoard(request, projectId);
      const k = Object.values(b.document.connections).find(
        (x) => x.from === newId && x.to === 'ledger',
      );
      connectionId = k?.id ?? '';
      const arrow = b.document.scene.elements.find((e) => e.id === k?.elementId);
      return !!arrow && arrow.type === 'arrow' && tagOf(arrow)?.id === connectionId;
    })
    .toBe(true);
  // its payload becomes the arrow label
  await inspector.getByRole('textbox', { name: 'Payload' }).fill('invoices');
  await inspector.getByRole('textbox', { name: 'Payload' }).press('Enter');
  await expect
    .poll(async () => {
      const b = await getBoard(request, projectId);
      const arrowId = b.document.connections[connectionId]?.elementId;
      return b.document.scene.elements.find((e) => e.containerId === arrowId)?.text ?? '';
    })
    .toBe('invoices');

  // 5. rename through the inspector: the label text on the canvas follows
  await inspector.getByRole('button', { name: 'Service', exact: true }).click();
  await expect(inspector.getByRole('textbox', { name: 'Label' })).toHaveValue('Service');
  await inspector.getByRole('textbox', { name: 'Label' }).fill('Billing API');
  await inspector.getByRole('textbox', { name: 'Label' }).press('Enter');
  await expect
    .poll(async () => {
      const b = await getBoard(request, projectId);
      const label = b.document.scene.elements.find(
        (e) => tagOf(e)?.id === newId && tagOf(e)?.role === 'label',
      );
      return [b.document.components[newId]?.label, label?.text];
    })
    .toEqual(['Billing API', 'Billing API']);

  // 6. deleting the component removes its parts and its connection, in registry and scene
  await inspector.getByRole('button', { name: 'Delete component' }).click();
  await inspector.getByRole('button', { name: 'Confirm delete' }).click();
  await expect
    .poll(async () => {
      const b = await getBoard(request, projectId);
      return {
        component: !!b.document.components[newId],
        connection: !!b.document.connections[connectionId],
        elements: b.document.scene.elements.filter(
          (e) => tagOf(e)?.id === newId || tagOf(e)?.id === connectionId,
        ).length,
      };
    })
    .toEqual({ component: false, connection: false, elements: 0 });
  await expect(inspector.getByRole('region', { name: 'Board summary' })).toBeVisible();
  await expect(board.getByText('14 component(s)')).toBeVisible();
});
