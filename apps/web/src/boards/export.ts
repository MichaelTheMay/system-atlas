import { boardToMarkdown } from '@atlas/export';
import type { DesignBoard } from '@atlas/schema';
import { exportToBlob, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { clearDecorations } from './scenarios.ts';

/**
 * Board exports (D03 wave 1b), all produced in the browser from the live scene:
 * - PNG / SVG of the canvas (Excalidraw's exporters; the SVG inlines its fonts so text renders
 *   anywhere, fetched from the app origin);
 * - the `.excalidraw` scene, which opens in excalidraw.com or any Excalidraw;
 * - the Markdown design doc (same text as `GET /boards/:id/export/markdown`) as a `.zip` holding
 *   `<name>.md` and the `<name>.png` it embeds, or the `.md` alone. A zip keeps the image a real
 *   sibling file (renders on GitHub and in editors) without the browser's multi-download prompt.
 * Exports show what is on the canvas (a shown scenario included), except the Markdown's picture,
 * which is the plain board.
 */
const BG = '#fffdf7';

export const fileBase = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'board';

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const exportState = { exportBackground: true, viewBackgroundColor: BG, exportWithDarkMode: false };

export const pngOf = (api: ExcalidrawImperativeAPI, plain = false) =>
  exportToBlob({
    elements: (plain ? clearDecorations(api.getSceneElements()) : api.getSceneElements()) as never,
    appState: { ...exportState, exportScale: 2 },
    files: api.getFiles(),
    mimeType: 'image/png',
    exportPadding: 24,
  });

export async function svgOf(api: ExcalidrawImperativeAPI): Promise<string> {
  const svg = await exportToSvg({
    elements: api.getSceneElements(),
    appState: exportState,
    files: api.getFiles(),
    exportPadding: 24,
  });
  return new XMLSerializer().serializeToString(svg);
}

export function excalidrawJsonOf(api: ExcalidrawImperativeAPI): string {
  return serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local');
}

export async function exportBoard(
  kind: 'png' | 'svg' | 'excalidraw' | 'markdown' | 'markdown-zip',
  api: ExcalidrawImperativeAPI,
  board: DesignBoard,
): Promise<void> {
  const base = fileBase(board.name);
  switch (kind) {
    case 'png':
      return download(await pngOf(api), `${base}.png`);
    case 'svg':
      return download(new Blob([await svgOf(api)], { type: 'image/svg+xml' }), `${base}.svg`);
    case 'excalidraw':
      return download(
        new Blob([excalidrawJsonOf(api)], { type: 'application/json' }),
        `${base}.excalidraw`,
      );
    case 'markdown':
      return download(new Blob([boardToMarkdown(board)], { type: 'text/markdown' }), `${base}.md`);
    case 'markdown-zip': {
      const md = boardToMarkdown(board, { imagePath: `${base}.png` });
      const png = new Uint8Array(await (await pngOf(api, true)).arrayBuffer());
      const zip = makeZip([
        { name: `${base}.md`, data: new TextEncoder().encode(md) },
        { name: `${base}.png`, data: png },
      ]);
      return download(new Blob([zip], { type: 'application/zip' }), `${base}-design-doc.zip`);
    }
  }
}

// ---- a minimal store-only (uncompressed) zip writer: two files do not need a dependency ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // utf-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
