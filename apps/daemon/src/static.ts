import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Resolve a URL path inside `root`, refusing traversal. Falls back to index.html for SPA routes. */
export async function resolveStatic(
  root: string,
  urlPath: string,
): Promise<{ file: string; type: string } | undefined> {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0] ?? '/')).replace(
    /^([/\\])+/,
    '',
  );
  const candidate = join(root, clean);
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
  for (const file of [candidate, join(root, 'index.html')]) {
    try {
      if ((await stat(file)).isFile())
        return { file, type: TYPES[extname(file)] ?? 'application/octet-stream' };
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export async function readStatic(file: string): Promise<Buffer> {
  return readFile(file);
}
