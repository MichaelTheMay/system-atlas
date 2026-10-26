import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { redactExcerpt, redactUrl } from '@atlas/schema';
import type { IngestClient } from './client.ts';

/**
 * Browser evidence for explicitly instrumented Playwright contexts (plan §10). Screenshots are real
 * captured bytes with provenance; a screenshot proves a captured visual state, not that a workflow
 * succeeded. Ordering comes from the adapter's sequence numbers, not cross-machine timestamps.
 */
export type ShotKind =
  'initial' | 'pre-action' | 'post-action' | 'failure-state' | 'sampled' | 'final' | 'bookmark';

export interface CaptureOptions {
  /** Record a Playwright trace for the context and attach it (Trace Viewer). */
  trace?: boolean;
  /** Screenshot before each step as well as after (default: after only). */
  beforeEachStep?: boolean;
  /** Upper bound on screenshots per run; beyond it a capture gap is recorded. */
  maxScreenshots?: number;
  /** What a "post-action" capture waits for; recorded with every screenshot. */
  waitPolicy?: 'none' | 'domcontentloaded' | 'load' | 'networkidle';
  /** CSS selectors masked in every screenshot before it is stored. */
  mask?: string[];
  fullPage?: boolean;
}

interface TabStats {
  id: string;
  requests: number;
  failed: { url: string; error: string }[];
  httpErrors: { url: string; status: number }[];
  console: { type: string; text: string }[];
}

export class BrowserCapture {
  private readonly client: IngestClient;
  private readonly context: BrowserContext;
  private readonly opts: Required<Omit<CaptureOptions, 'mask'>> & { mask: string[] };
  private readonly tabs = new Map<Page, TabStats>();
  private shots = 0;
  private limitReported = false;
  private traceDir?: string;

  private constructor(client: IngestClient, context: BrowserContext, opts: CaptureOptions) {
    this.client = client;
    this.context = context;
    this.opts = {
      trace: false,
      beforeEachStep: false,
      maxScreenshots: 50,
      waitPolicy: 'load',
      fullPage: false,
      mask: [],
      ...opts,
    };
  }

  static async attach(
    client: IngestClient,
    context: BrowserContext,
    opts: CaptureOptions = {},
  ): Promise<BrowserCapture> {
    const c = new BrowserCapture(client, context, opts);
    if (c.opts.trace) {
      try {
        await context.tracing.start({ screenshots: true, snapshots: true });
        c.traceDir = mkdtempSync(join(tmpdir(), 'atlas-trace-'));
      } catch (e) {
        // the caller (e.g. the Playwright test runner) already traces this context; it owns the trace
        client.emit({
          type: 'capture.gap',
          payload: {
            kind: 'trace-not-captured',
            detail: `tracing is controlled by the caller: ${String((e as Error).message).split('\n')[0]}`,
          },
        });
      }
    }
    for (const p of context.pages()) c.track(p);
    context.on('page', (p) => c.track(p));
    return c;
  }

  /** Stable tab identity for a page (tab-1, tab-2, … in order of appearance). */
  tabId(page: Page): string {
    return this.track(page).id;
  }

  private track(page: Page): TabStats {
    let s = this.tabs.get(page);
    if (s) return s;
    s = { id: `tab-${this.tabs.size + 1}`, requests: 0, failed: [], httpErrors: [], console: [] };
    this.tabs.set(page, s);
    const stats = s;
    page.on('request', () => stats.requests++);
    page.on(
      'requestfailed',
      (r) =>
        stats.failed.length < 50 &&
        stats.failed.push({ url: redactUrl(r.url()), error: r.failure()?.errorText ?? 'failed' }),
    );
    page.on(
      'response',
      (r) =>
        r.status() >= 400 &&
        stats.httpErrors.length < 50 &&
        stats.httpErrors.push({ url: redactUrl(r.url()), status: r.status() }),
    );
    page.on('console', (m) => {
      if ((m.type() === 'error' || m.type() === 'warning') && stats.console.length < 50)
        stats.console.push({ type: m.type(), text: redactExcerpt(m.text().slice(0, 500)).text });
    });
    return s;
  }

  /**
   * Capture a screenshot with provenance. If it cannot be captured (page closed, crashed, timed out)
   * the screenshot is recorded as missing with the reason, and a capture gap is emitted.
   */
  async screenshot(
    page: Page,
    kind: ShotKind,
    opts: { name?: string; stepEventId?: string } = {},
  ): Promise<string | undefined> {
    const tabId = this.tabId(page);
    const logicalName = `${String(this.shots + 1).padStart(3, '0')}-${tabId}-${kind}${opts.name ? `-${opts.name.replace(/[^\w.-]+/g, '_').slice(0, 60)}` : ''}.png`;
    if (this.shots >= this.opts.maxScreenshots) {
      if (!this.limitReported) {
        this.limitReported = true;
        this.client.emit({
          type: 'capture.gap',
          payload: {
            kind: 'screenshot-limit',
            detail: `screenshot limit of ${this.opts.maxScreenshots} reached; later states were not captured`,
          },
        });
      }
      return undefined;
    }
    this.shots++;
    let url = 'about:blank';
    try {
      if (page.isClosed()) throw new Error('page is closed');
      url = redactUrl(page.url());
      const title = redactExcerpt((await page.title()).slice(0, 200)).text;
      const viewport = page.viewportSize();
      const bytes = await page.screenshot({
        fullPage: this.opts.fullPage,
        timeout: 10_000,
        mask: this.opts.mask.map((s) => page.locator(s)),
      });
      const eventId = await this.client.event({
        type: 'screenshot.captured',
        parentEventId: opts.stepEventId,
        payload: {
          tabId,
          kind,
          url,
          title,
          viewport,
          name: opts.name ?? null,
          waitPolicy: kind === 'post-action' ? this.opts.waitPolicy : 'none',
          masked: this.opts.mask.length > 0,
        },
      });
      const a = await this.client.uploadBytes(bytes, {
        logicalName,
        mediaType: 'image/png',
        role: 'screenshot',
        eventId,
        metadata: { tabId, kind, url, title, viewport, stepEventId: opts.stepEventId ?? null },
      });
      return a.id;
    } catch (e) {
      const reason = String((e as Error).message ?? e)
        .split('\n')[0]!
        .slice(0, 300);
      await this.client.event({
        type: 'capture.gap',
        parentEventId: opts.stepEventId,
        payload: { kind: 'screenshot-missing', tabId, shot: kind, url, detail: reason },
      });
      await this.client.declareMissing(
        {
          logicalName,
          role: 'screenshot',
          mediaType: 'image/png',
          metadata: { tabId, kind, url, stepEventId: opts.stepEventId ?? null },
        },
        reason,
      );
      return undefined;
    }
  }

  /** Initial state of a page (call after the first navigation). */
  initial(page: Page) {
    return this.screenshot(page, 'initial');
  }

  bookmark(page: Page, name: string) {
    return this.screenshot(page, 'bookmark', { name });
  }

  /**
   * A named step: step.started → fn → post-action screenshot → step.completed; on error a
   * failure-state screenshot and step.failed are recorded and the error is rethrown.
   */
  async step<T>(
    page: Page,
    name: string,
    fn: () => Promise<T>,
    opts: { entityRefs?: string[] } = {},
  ): Promise<T> {
    const tabId = this.tabId(page);
    const stepEventId = await this.client.event({
      type: 'step.started',
      payload: { name, tabId, url: redactUrl(page.url()) },
      entityRefs: opts.entityRefs,
    });
    if (this.opts.beforeEachStep) await this.screenshot(page, 'pre-action', { name, stepEventId });
    const t0 = performance.now();
    try {
      const out = await fn();
      if (this.opts.waitPolicy !== 'none' && !page.isClosed())
        await page
          .waitForLoadState(this.opts.waitPolicy, { timeout: 10_000 })
          .catch(() => undefined);
      await this.screenshot(page, 'post-action', { name, stepEventId });
      await this.client.event({
        type: 'step.completed',
        parentEventId: stepEventId,
        payload: { name, tabId, durationMs: Math.round(performance.now() - t0) },
      });
      return out;
    } catch (e) {
      await this.screenshot(page, 'failure-state', { name, stepEventId });
      await this.client.event({
        type: 'step.failed',
        parentEventId: stepEventId,
        payload: {
          name,
          tabId,
          durationMs: Math.round(performance.now() - t0),
          error: redactExcerpt(
            String((e as Error).message ?? e)
              .split('\n')
              .slice(0, 3)
              .join('\n')
              .slice(0, 1000),
          ).text,
        },
      });
      throw e;
    }
  }

  async assert(description: string, ok: boolean, subjectArtifactId?: string) {
    await this.client.event({
      type: 'assertion.result',
      payload: { description, outcome: ok ? 'pass' : 'fail', source: 'adapter', subjectArtifactId },
    });
  }

  /** Final screenshots of open tabs, console/network summaries and the trace. */
  async finish(): Promise<void> {
    for (const [page, s] of this.tabs) {
      if (!page.isClosed()) await this.screenshot(page, 'final');
      this.client.emit({
        type: 'network.summary',
        payload: { tabId: s.id, requests: s.requests, failed: s.failed, httpErrors: s.httpErrors },
      });
      this.client.emit({
        type: 'console.summary',
        payload: {
          tabId: s.id,
          entries: s.console,
          errors: s.console.filter((c) => c.type === 'error').length,
        },
      });
    }
    await this.client.flush();
    if (this.traceDir) {
      const path = join(this.traceDir, 'trace.zip');
      try {
        await this.context.tracing.stop({ path });
        const eventId = await this.client.event({
          type: 'file.produced',
          payload: {
            path: 'trace.zip',
            kind: 'playwright-trace',
            viewer: 'npx playwright show-trace trace.zip',
          },
        });
        await this.client.uploadFile(path, {
          logicalName: 'trace.zip',
          mediaType: 'application/zip',
          role: 'trace',
          eventId,
          metadata: { viewer: 'playwright show-trace' },
        });
      } catch (e) {
        this.client.emit({
          type: 'capture.gap',
          payload: { kind: 'trace-missing', detail: String((e as Error).message).slice(0, 300) },
        });
      } finally {
        rmSync(this.traceDir, { recursive: true, force: true });
      }
    }
    await this.client.flush();
  }
}
