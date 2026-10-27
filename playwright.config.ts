import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The e2e daemon uses a throwaway data dir and a fixed test token; it never touches real Atlas state.
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));
// ATLAS_E2E_PORT lets parallel worktrees run e2e side by side.
export const E2E_PORT = Number(process.env.ATLAS_E2E_PORT ?? 4399);
export const E2E_TOKEN = 'e2e0'.repeat(16);

export default defineConfig({
  testDir: 'apps/web/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node apps/daemon/src/main.ts',
    url: `http://127.0.0.1:${E2E_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      ATLAS_PORT: String(E2E_PORT),
      ATLAS_TOKEN: E2E_TOKEN,
      ATLAS_DATA_DIR: dataDir,
      ATLAS_RUNTIME_DIR: join(dataDir, 'run'),
    },
  },
});
