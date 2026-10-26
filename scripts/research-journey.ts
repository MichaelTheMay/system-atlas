/**
 * The plan §18 browser journey over fixtures/research-demo/web, captured with the Atlas Playwright
 * helper. Used by `pnpm demo` and the Phase 2 end-to-end tests. Everything is local: a tiny static
 * server for the fixture page, fake data, no network.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Browser } from '@playwright/test';
import { BrowserCapture, startRun } from '@atlas/adapters';

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

export function serveStatic(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const rel =
      normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^([/\\])+/, '') ||
      'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir + sep) || req.method !== 'GET') {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res
        .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
        .end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, server }),
    ),
  );
}

export interface JourneyResult {
  runId: string;
  failedStep?: string;
}

export async function runResearchJourney(o: {
  browser: Browser;
  daemon: { baseUrl: string; token: string };
  rootPath: string;
  topic?: string;
  trace?: boolean;
}): Promise<JourneyResult> {
  const site = await serveStatic(join(o.rootPath, 'web'));
  const { client, runId } = await startRun({
    daemon: o.daemon,
    rootPath: o.rootPath,
    adapter: 'playwright',
    commandSummary: `research journey: search "${o.topic ?? 'solar storage'}"`,
    environmentSummary: {
      browser: o.browser.browserType().name(),
      browserVersion: o.browser.version(),
      viewport: '1280x800',
    },
    instrumentationCapabilities: [
      'screenshots',
      'steps',
      'console-summary',
      'network-summary',
      o.trace ? 'trace' : 'no-trace',
    ],
    producerId: 'research-journey',
  });
  const context = await o.browser.newContext({ viewport: { width: 1280, height: 800 } });
  const capture = await BrowserCapture.attach(client, context, {
    trace: o.trace ?? true,
    waitPolicy: 'load',
  });
  const page = await context.newPage();
  let failedStep: string | undefined;
  try {
    await capture.step(page, 'open search page', () => page.goto(site.url));
    await capture.step(page, 'enter topic', () => page.fill('#topic', o.topic ?? 'solar storage'));
    await capture.step(page, 'search', async () => {
      await page.click('button[type=submit]');
      await page.waitForSelector('#results li', { timeout: 5000 });
    });
    const results = await page.locator('#results li').count();
    await capture.assert(`search shows at least 3 results (got ${results})`, results >= 3);
    try {
      // the fixture page has no report link: this step fails on purpose and leaves a failure screenshot
      await capture.step(page, 'open report', () =>
        page.click('text=View report', { timeout: 1500 }),
      );
    } catch {
      failedStep = 'open report';
    }
    // a tab that is gone before it could be captured: its screenshot is recorded as missing
    const popup = await context.newPage();
    await popup.goto(site.url);
    await popup.close();
    await capture.screenshot(popup, 'sampled', { name: 'closed tab' });
  } finally {
    await capture.finish();
    await context.close();
    site.server.close();
  }
  await client.finish(failedStep ? 'failed' : 'succeeded');
  return { runId, failedStep };
}
