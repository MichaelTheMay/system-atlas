/* eslint-disable @typescript-eslint/no-explicit-any -- exported JSON */
/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { runProcess } from '@atlas/adapters';
import { ObjectStore } from '@atlas/evidence';
import { validateJsonCanvas } from '@atlas/export';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '@atlas/daemon';
import { buildPreviewServer } from '@atlas/daemon/preview';
import { exportToDir } from '../src/export.ts';

const token = 'x'.repeat(64);
let port = 0;
let previewPort = 0;
let srv: ReturnType<typeof buildServer>;
let preview: ReturnType<typeof buildPreviewServer>;
let root: string;
let runId: string;
const daemon = () => ({ baseUrl: `http://127.0.0.1:${port}`, token });

beforeAll(async () => {
  const db = openDb(':memory:');
  migrate(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-export-'));
  const objects = new ObjectStore(join(dataDir, 'objects'));
  preview = buildPreviewServer({
    db,
    objects,
    port: () => previewPort,
    appOrigins: () => [`http://127.0.0.1:${port}`],
  });
  srv = buildServer({
    token,
    db,
    dataDir,
    objects,
    port: () => port,
    previewOrigin: () => `http://127.0.0.1:${previewPort}`,
    signPreview: (id, kind) => preview.sign(id, kind),
  });
  await preview.app.listen({ host: '127.0.0.1', port: 0 });
  previewPort = (preview.app.server.address() as { port: number }).port;
  await srv.app.listen({ host: '127.0.0.1', port: 0 });
  port = (srv.app.server.address() as { port: number }).port;
  root = join(mkdtempSync(join(tmpdir(), 'atlas-export-proj-')), 'research-demo');
  cpSync(new URL('../../../fixtures/research-demo', import.meta.url).pathname, root, {
    recursive: true,
  });
  const r = await runProcess({
    daemon: daemon(),
    rootPath: root,
    cwd: root,
    command: process.execPath,
    args: ['worker/generate-report.mjs', '--sources', '2', '--out', 'out'],
    outputs: ['out/report.json', 'out/chart.png', 'out/report.html'],
    name: 'report',
  });
  runId = r.runId;
}, 60_000);
afterAll(async () => {
  await srv.app.close();
  await preview.app.close();
});

/** Serve the export plus the JSON Canvas viewer, the way a static host would. */
function serve(dir: string): Promise<{ server: Server; url: string }> {
  const viewer = new URL('../../../node_modules/json-canvas-viewer/dist/chimp.js', import.meta.url)
    .pathname;
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (path === '/') {
      const file = new URL(req.url ?? '/', 'http://x').searchParams.get('file') ?? '';
      res.setHeader('content-type', 'text/html');
      return res.end(`<!doctype html><div id="c" style="width:1400px;height:900px"></div>
<script type="module">
  import { parser, fetchCanvas, JSONCanvasViewer } from '/viewer.js';
  new JSONCanvasViewer({ container: document.getElementById('c'), parser, canvas: await fetchCanvas(${JSON.stringify('/' + 'FILE')}.replace('FILE', ${JSON.stringify(file)})) });
  window.__rendered = true;
</script>`);
    }
    const file = path === '/viewer.js' ? viewer : normalize(join(dir, path));
    if (!file.startsWith(dir) && file !== viewer) return res.writeHead(403).end();
    if (!existsSync(file)) return res.writeHead(404).end();
    const types: Record<string, string> = {
      '.js': 'text/javascript',
      '.png': 'image/png',
      '.canvas': 'application/json',
      '.json': 'application/json',
    };
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }),
    ),
  );
}

const SHOTS =
  '/tmp/claude-1000/-home-michaelmay-Dev-atlast/092bbf5b-5d73-4a00-86aa-d4e1d23d0344/scratchpad';

/** Open one exported canvas in json-canvas-viewer (the selected renderer) and report what it shows. */
async function render(dir: string, file: string, shot?: string) {
  const { server, url } = await serve(dir);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1420, height: 920 } });
    const errors: string[] = [];
    const missing: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => r.status() >= 400 && missing.push(r.url()));
    await page.goto(`${url}/?file=${encodeURIComponent(file)}`);
    await page.waitForFunction(() => (window as any).__rendered === true, null, {
      timeout: 10_000,
    });
    await page.waitForTimeout(800);
    if (shot && existsSync(SHOTS)) await page.screenshot({ path: join(SHOTS, shot) });
    const text = await page.locator('#c').innerText();
    const images = await page.$$eval('#c img', (imgs) =>
      imgs.map((i) => [(i as HTMLImageElement).src, (i as HTMLImageElement).naturalWidth] as const),
    );
    return { errors, missing, text, images };
  } finally {
    await browser.close();
    server.close();
  }
}

describe('atlas export', () => {
  it('exports every view as linked, valid JSON Canvas that a JSON Canvas renderer opens', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'atlas-out-')), 'export');
    const r = await exportToDir({ daemon: daemon(), rootPath: root, output: out });
    expect(r.problems).toEqual([]);
    const canvases = r.files.filter((f) => f.endsWith('.canvas'));
    expect(canvases.length).toBeGreaterThan(4);
    const links: string[] = [];
    for (const f of canvases) {
      const doc = JSON.parse(readFileSync(join(out, f), 'utf8'));
      expect(validateJsonCanvas(doc), f).toEqual([]);
      for (const n of doc.nodes)
        for (const m of String(n.text ?? '').matchAll(/\]\(([^)]+\.canvas)\)/g)) links.push(m[1]!);
    }
    // drill-down links are relative to the export root and point at files that exist
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(existsSync(join(out, decodeURI(l))), l).toBe(true);
    const sidecar = JSON.parse(readFileSync(join(out, 'atlas-export.json'), 'utf8'));
    expect(sidecar).toMatchObject({
      format: 'atlas-export-sidecar',
      version: 1,
      snapshotId: expect.stringMatching(/^snap_/),
    });
    const structure = sidecar.views.find(
      (v: any) => v.lens === 'component' && v.title === 'Project structure',
    );
    expect(structure.nodes.some((n: any) => n.entityId?.startsWith('ent_'))).toBe(true);
    expect(sidecar.disclosures.length).toBeGreaterThanOrEqual(4);

    const shown = await render(out, structure.file, 'export-view.png');
    expect(shown.errors).toEqual([]);
    expect(shown.missing).toEqual([]);
    expect(shown.text).toContain('@research/worker');
    expect(shown.text).toContain('open view');

    // a non-empty directory is never written into
    await expect(exportToDir({ daemon: daemon(), rootPath: root, output: out })).rejects.toThrow(
      /not empty/,
    );
  });

  it('exports a run with its artifacts beside it (verified bytes, no active content, logs only on request)', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'atlas-out-')), 'run');
    const r = await exportToDir({ daemon: daemon(), rootPath: root, output: out, runs: [runId] });
    expect(r.problems).toEqual([]);
    const runFile = r.files.find((f) => f.endsWith('run.canvas'))!;
    const doc = JSON.parse(readFileSync(join(out, runFile), 'utf8'));
    expect(validateJsonCanvas(doc)).toEqual([]);
    const chart = doc.nodes.find((n: any) => n.type === 'file' && n.file.endsWith('chart.png'));
    expect(existsSync(join(out, chart.file))).toBe(true);
    const detail = await (
      await fetch(`${daemon().baseUrl}/api/v1/runs/${runId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    const recorded = detail.artifacts.find((a: any) => a.logicalName === 'out/chart.png');
    expect(
      createHash('sha256')
        .update(readFileSync(join(out, chart.file)))
        .digest('hex'),
    ).toBe(recorded.sha256);
    const exported = r.files.map((f) => f.split('/').pop());
    expect(exported).not.toContain('report.html');
    expect(exported).not.toContain('stdout.log');
    expect(r.disclosures.join(' ')).toMatch(/left out/);

    const shown = await render(out, runFile, 'export-run.png');
    expect(shown.errors).toEqual([]);
    expect(shown.missing).toEqual([]);
    expect(shown.text).toContain('task failed');
    expect(shown.images.filter(([, w]) => w > 0)).toHaveLength(1);

    const withLogs = join(mkdtempSync(join(tmpdir(), 'atlas-out-')), 'logs');
    const r2 = await exportToDir({
      daemon: daemon(),
      rootPath: root,
      output: withLogs,
      runs: [runId],
      includeLogs: true,
    });
    expect(r2.files.map((f) => f.split('/').pop())).toEqual(
      expect.arrayContaining(['stdout.log', 'stderr.log']),
    );
  });

  it('exports views as simplified Mermaid with a disclosure', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'atlas-out-')), 'mmd');
    const r = await exportToDir({
      daemon: daemon(),
      rootPath: root,
      output: out,
      format: 'mermaid',
      views: ['Project structure'],
    });
    expect(r.files).toEqual(['views/project-structure.mmd', 'atlas-export.json']);
    const text = readFileSync(join(out, 'views/project-structure.mmd'), 'utf8');
    expect(text.split('\n')[1]).toBe('flowchart LR');
    expect(text).toContain('@research/worker');
    expect(r.disclosures.join(' ')).toMatch(/Mermaid export is a simplified/);
    expect(readdirSync(out)).toEqual(expect.arrayContaining(['views', 'atlas-export.json']));
    writeFileSync(join(out, 'keep.txt'), 'x');
  });
});
