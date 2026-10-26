import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export interface ManifestEntry {
  path: string;
  sha256: string;
}

/**
 * Digest of a tree manifest: identifies exactly which file contents were analyzed (plan §6).
 * Order-independent; two trees with the same paths and contents always share a digest.
 */
export function manifestDigest(entries: readonly ManifestEntry[]): string {
  const h = createHash('sha256');
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(e.path);
    h.update('\u0000');
    h.update(e.sha256);
    h.update('\n');
  }
  return h.digest('hex');
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolvePromise(h.digest('hex')));
  });
}
