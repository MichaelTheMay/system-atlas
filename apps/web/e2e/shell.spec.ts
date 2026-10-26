import { expect, test } from '@playwright/test';
import { E2E_TOKEN } from '../../../playwright.config.ts';

test('connects to the daemon with a fragment token and strips it from the URL', async ({
  page,
}) => {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('live updates on');
  expect(page.url()).not.toContain('token');
  await expect(page.getByRole('heading', { name: 'No snapshot yet' })).toBeVisible();
});

test('switches between the Architecture and Outputs & Audit roots', async ({ page }) => {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByRole('button', { name: /Outputs & Audit/ }).click();
  await expect(page.getByRole('main')).toHaveAccessibleName('Outputs & Audit canvas');
  await expect(page.getByRole('heading', { name: 'No runs recorded yet' })).toBeVisible();
  await page.getByRole('button', { name: /Architecture/ }).click();
  await expect(page.getByRole('heading', { name: 'No snapshot yet' })).toBeVisible();
});

test('without a token the UI says it is not connected and the API refuses', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('contentinfo', { name: 'Status' })).toContainText('Not connected');
  expect((await request.get('/api/v1/status')).status()).toBe(401);
});
