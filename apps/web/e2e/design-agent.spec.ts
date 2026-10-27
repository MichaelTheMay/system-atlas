import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

/**
 * D02b: copilot panel, Generate design dialog, review sheet and design-agent settings. Every job
 * here runs on the deterministic `mock` runtime. No real model is ever called: the consent gate
 * is exercised only up to the refusal (403) and the consent screen, never recording consent for
 * a runtime that would call out, so the shared e2e daemon's settings stay at mock.
 */

const auth = { authorization: `Bearer ${E2E_TOKEN}` };
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 2000)));
});
test.afterEach(async ({ request }) => {
  expect(pageErrors).toEqual([]);
  // the design-agent settings are daemon-wide: leave them at mock for the other specs
  const s = await (await request.get('/api/v1/settings/design-agent', { headers: auth })).json();
  expect(s.consented['claude-code']).toBe(false);
  expect(s.consented['anthropic-api']).toBe(false);
  if (s.runtime !== 'mock')
    await request.put('/api/v1/settings/design-agent', {
      headers: auth,
      data: { runtime: 'mock' },
    });
});

const node = (page: Page, label: string) =>
  page.locator('.react-flow__node', {
    has: page.locator('.node-label', {
      hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    }),
  });

async function scanFixture(request: APIRequestContext, name: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-e2e-dagent-')), name);
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
  await expect(node(page, 'api')).toBeVisible();
}

test('Generate design: confirm with estimate, run on mock, review, accept one and reject another', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await scanFixture(request, 'dagent-gen');
  await openDesign(page, wt);

  await page.getByRole('button', { name: 'Generate design…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate design' });
  await expect(dialog.getByRole('combobox', { name: 'Runtime' })).toHaveValue('mock');
  const estimate = dialog.getByRole('region', { name: 'Estimate' });
  await expect(estimate).toContainText('Nothing leaves this machine');
  await expect(estimate).toContainText(/Estimated tokens: ~[\d,]+ in/);
  await expect(estimate).toContainText(/Daily budget: [\d,]+ of [\d,]+ tokens left today/);
  await dialog.getByRole('combobox', { name: 'Depth' }).selectOption('2');

  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  const review = dialog.getByRole('region', { name: 'Review proposals' });
  await expect(review).toContainText(/proposed subsystems? to review/);
  const services = review.getByRole('listitem', { name: 'Services' });
  const clients = review.getByRole('listitem', { name: 'Clients' });
  await expect(services).toContainText('proposed');
  await expect(services).toContainText('agent: mock-design');
  await expect(clients).toBeVisible();
  await expect(review.getByRole('button', { name: 'Open run in Outputs & Audit' })).toBeVisible();

  // the canvas shows the proposals live, labeled as proposed
  const views = page.getByRole('list', { name: 'Views' });
  await expect(views.getByRole('button', { name: /^Services/ })).toHaveAccessibleName(
    'Services proposed (inferred)',
  );

  await services.getByRole('button', { name: 'Accept' }).click();
  await expect(services).toContainText('accepted');
  await expect(services.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(views.getByRole('button', { name: /^Services/ })).toHaveAccessibleName(
    'Services accepted',
  );

  await clients.getByRole('button', { name: 'Reject' }).click();
  await expect(clients).toHaveCount(0);
  await expect(views.getByRole('button', { name: /^Clients/ })).toHaveCount(0);

  // the job is a design-agent run in Outputs & Audit
  const runs = await (
    await request.get(`/api/v1/projects/${projectId}/runs`, { headers: auth })
  ).json();
  const list = (runs.runs ?? runs) as { run?: { adapter: string }; adapter?: string }[];
  expect(list.some((r) => (r.run?.adapter ?? r.adapter) === 'design-agent')).toBe(true);
  await review.getByRole('button', { name: 'Open run in Outputs & Audit' }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName('Outputs & Audit canvas');
});

test('the copilot applies a deterministic grouping and answers Ask actions with labeled, cited results', async ({
  page,
  request,
}) => {
  const { wt, projectId } = await scanFixture(request, 'dagent-copilot');
  await openDesign(page, wt);
  await page.getByRole('button', { name: 'Copilot' }).click();
  const copilot = page.getByRole('complementary', { name: 'Design copilot' });
  const suggestions = copilot.getByRole('region', { name: 'Suggestions' });

  // dismiss persists per project
  const messaging = suggestions.getByRole('listitem', { name: /are not in any subsystem/ }).first();
  const dismissedTitle = await messaging.getAttribute('aria-label');
  await messaging.getByRole('button', { name: 'Dismiss' }).click();
  await expect(suggestions.getByRole('listitem', { name: dismissedTitle! })).toHaveCount(0);
  const stored = await page.evaluate(
    (k) => localStorage.getItem(k),
    `atlas.copilot.dismissed.${projectId}`,
  );
  expect(stored).toContain('layer:');

  // coupling: api and worker share many flows; Apply groups them (human claims, accepted)
  const couple = suggestions.getByRole('listitem', {
    name: /^Group (worker and api|api and worker)$/,
  });
  await expect(couple).toContainText('share');
  await couple.getByRole('button', { name: 'Group' }).click();
  const views = page.getByRole('list', { name: 'Views' });
  await expect(views.getByRole('button', { name: /&/ })).toHaveAccessibleName(
    /^(worker & api|api & worker) accepted$/,
  );
  await expect(node(page, 'api')).toHaveCount(0);

  // Ask: Explain this flow (web → api over HTTP) on the mock runtime, with citations
  const ask = copilot.getByRole('region', { name: 'Ask the agent' });
  await expect(ask).toContainText('Runs on Mock (local, free)');
  await page.getByRole('group', { name: /^HTTP/ }).first().click({ force: true });
  await ask.getByRole('button', { name: 'Explain this flow' }).click();
  const result = ask.getByRole('region', { name: 'Agent result' });
  await expect(result).toContainText('Flow explanation');
  await expect(result).toContainText('agent: mock-design');
  await expect(result.getByLabel('Citations')).toContainText(/package\.json/);
  await result.getByRole('button', { name: 'Reject' }).click();
  await expect(result).toContainText('Rejected.');
  await result.getByRole('button', { name: 'Clear' }).click();
  await expect(result).toHaveCount(0);

  // Ask: Name this subsystem for picked boxes; Accept groups them under the agent's name
  await ask
    .getByRole('group', { name: 'Boxes to ask about' })
    .getByRole('button', { name: 'web' })
    .click();
  await ask.getByRole('button', { name: 'Name this subsystem' }).click();
  await expect(result).toContainText('Subsystem name');
  await expect(result).toContainText('agent: mock-design');
  await expect(result.getByLabel('Citations')).toContainText('package.json');
  await result.getByRole('button', { name: 'Accept' }).click();
  await expect(result).toContainText('Accepted.');
  await expect(node(page, 'web')).toHaveCount(0);
});

test('Settings lists the runtimes and a non-mock runtime is refused without consent', async ({
  page,
  request,
}) => {
  const { wt, projectId, snapshotId } = await scanFixture(request, 'dagent-consent');
  await openDesign(page, wt);

  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const agent = settings.getByRole('region', { name: 'Design agent' });
  for (const r of ['Claude Code (your Claude account)', 'Anthropic API key', 'Mock (local, free)'])
    await expect(
      agent.getByRole('radio', { name: new RegExp(`^${r.replace(/[()]/g, '\\$&')}`) }),
    ).toBeVisible();
  await expect(agent.getByRole('radio', { name: /^Mock/ })).toBeChecked();
  await expect(agent).toContainText(/available: deterministic mock/);
  await expect(agent).toContainText('default when available');
  await expect(agent.getByRole('status', { name: 'API key status' })).toHaveText('no key stored');

  // choosing a runtime that sends data off the machine shows the consent screen first
  await agent.getByRole('radio', { name: /^Anthropic API key/ }).click();
  const consent = agent.getByRole('region', { name: 'Consent' });
  await expect(consent).toContainText('What is sent.');
  await expect(consent).toContainText('to the Anthropic API with your key');
  await expect(consent).toContainText('file, shell or web access');
  await consent.getByRole('button', { name: 'Cancel' }).click();
  await expect(consent).toHaveCount(0);
  await expect(agent.getByRole('radio', { name: /^Mock/ })).toBeChecked();
  await page.keyboard.press('Escape');

  // the Generate dialog will not run it either: consent screen, Generate disabled
  await page.getByRole('button', { name: 'Generate design…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate design' });
  await dialog.getByRole('combobox', { name: 'Runtime' }).selectOption('anthropic-api');
  await expect(dialog.getByRole('region', { name: 'Consent' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  // and the daemon refuses it before creating any run (no call is made)
  const before = await (
    await request.get(`/api/v1/projects/${projectId}/runs`, { headers: auth })
  ).text();
  for (const runtime of ['anthropic-api', 'claude-code']) {
    const r = await request.post(`/api/v1/projects/${projectId}/design/jobs`, {
      headers: auth,
      data: { kind: 'generate', runtime, snapshotId },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toBe('consent_required');
  }
  const after = await (
    await request.get(`/api/v1/projects/${projectId}/runs`, { headers: auth })
  ).text();
  expect(after).toBe(before);
});
