import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDb } from '@atlas/store';
import { sha256Hex } from '../src/index.ts';

export const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

export function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/** Content + name + mode snapshot of a directory tree, for "Atlas did not modify it" checks. */
export function treeFingerprint(root: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else parts.push(`${relative(root, p)}:${statSync(p).mode}:${sha256Hex(readFileSync(p))}`);
    }
  };
  walk(root);
  return sha256Hex(parts.join('\n'));
}
