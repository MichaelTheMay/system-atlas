import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_TOKEN, E2E_PORT } from '../../../playwright.config.ts';
import { runResearchJourney } from '../../../scripts/research-journey.ts';

const auth = { authorization: `Bearer ${E2E_TOKEN}` };

// the capture helper records its own Playwright trace; the runner must not already trace the context
test.use({ trace: 'off' });

test('a real browser journey captures three steps, a failure and a missing screenshot', async ({
  browser,
  request,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-journey-')), 'research-demo');
  cpSync(new URL('../../../fixtures/research-demo', import.meta.url).pathname, root, {
    recursive: true,
  });
  const r = await runResearchJourney({
    browser,
    daemon: { baseUrl: `http://127.0.0.1:${E2E_PORT}`, token: E2E_TOKEN },
    rootPath: root,
  });
  expect(r.failedStep).toBe('open report');

  const d = await (await request.get(`/api/v1/runs/${r.runId}`, { headers: auth })).json();
  expect(d.run).toMatchObject({
    adapter: 'playwright',
    status: 'failed',
    snapshotId: expect.stringMatching(/^snap_/),
  });
  expect(d.outcome.assertions.pass).toBe(1);

  const shots = d.artifacts.filter((a: { role: string }) => a.role === 'screenshot');
  const kinds = (state: string) =>
    shots
      .filter((a: { bytesState: string }) => a.bytesState === state)
      .map((a: { metadata: { kind: string } }) => a.metadata.kind);
  expect(kinds('available').filter((k: string) => k === 'post-action')).toHaveLength(3);
  expect(kinds('available')).toContain('failure-state');
  expect(kinds('available')).toContain('final');
  expect(kinds('missing')).toEqual(['sampled']);
  const missing = shots.find((a: { bytesState: string }) => a.bytesState === 'missing');
  expect(missing.metadata.missingReason).toContain('closed');
  for (const s of shots.filter((a: { bytesState: string }) => a.bytesState === 'available')) {
    expect(s.mediaType).toBe('image/png');
    expect(s.metadata).toMatchObject({
      tabId: expect.stringMatching(/^tab-\d+$/),
      viewport: { width: 1280, height: 800 },
    });
  }
  const searchShot = shots.find((a: { logicalName: string }) =>
    a.logicalName.includes('post-action-search'),
  );
  expect(searchShot.metadata.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

  const types = d.events.map((e: { type: string }) => e.type);
  expect(types.filter((t: string) => t === 'step.completed')).toHaveLength(3);
  expect(types.filter((t: string) => t === 'step.failed')).toHaveLength(1);
  expect(types).toEqual(
    expect.arrayContaining([
      'screenshot.captured',
      'capture.gap',
      'network.summary',
      'console.summary',
      'assertion.result',
    ]),
  );
  // order follows the adapter's sequence: the failure screenshot comes after the failing step started
  const seq = (pred: (e: { type: string; payload: Record<string, unknown> }) => boolean) =>
    d.events.findIndex(pred);
  expect(seq((e) => e.type === 'step.started' && e.payload.name === 'open report')).toBeLessThan(
    seq((e) => e.type === 'step.failed'),
  );

  const trace = d.artifacts.find((a: { role: string }) => a.role === 'trace');
  expect(trace).toMatchObject({ bytesState: 'available', mediaType: 'application/zip' });
});
