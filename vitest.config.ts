import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/web/e2e/**'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
