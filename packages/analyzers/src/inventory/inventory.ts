import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  existsSync,
  type Stats,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { SupportLevel } from '@atlas/schema';
import { runGit } from '../git-exec.ts';
import {
  DEFAULT_EXCLUDES,
  detectLanguage,
  detectRole,
  hasBinaryExtension,
  isSecretPath,
  type FileRole,
} from './classify.ts';

export interface InventoryFile {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  /** git blob id of the working-tree bytes, for dirty detection against HEAD. */
  gitBlob: string;
  language: string;
  role: FileRole;
  /** Upgraded by analyzers that handle the file. */
  support: SupportLevel;
}

export type SkipReason =
  'secret' | 'binary' | 'size' | 'symlink-escape' | 'symlink' | 'nested-repository' | 'unreadable';

export interface SkippedEntry {
  path: string;
  reason: SkipReason;
  size?: number;
}

export interface Inventory {
  root: string;
  files: InventoryFile[];
  skipped: SkippedEntry[];
  git?: { tracked: boolean; head?: string; dirty: boolean };
  durationMs: number;
}

export interface InventoryOptions {
  maxFileBytes?: number;
  signal?: AbortSignal;
  concurrency?: number;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

function atlasIgnore(root: string): Ignore {
  const ig = ignore().add(DEFAULT_EXCLUDES);
  const f = join(root, '.atlasignore');
  if (existsSync(f)) ig.add(readFileSync(f, 'utf8'));
  return ig;
}

interface Candidate {
  path: string;
  /** git reported a submodule or nested repository directory. */
  nestedRepo?: boolean;
}

/** Tracked + untracked-not-ignored files via git, honoring every gitignore source git does. */
async function listWithGit(root: string): Promise<Candidate[] | undefined> {
  const excludeArgs = DEFAULT_EXCLUDES.flatMap((p) => ['-x', p]);
  const [tracked, untracked] = await Promise.all([
    runGit(root, ['ls-files', '-z', '--stage', '--cached']),
    runGit(root, ['ls-files', '-z', '--others', '--exclude-standard', ...excludeArgs]),
  ]);
  if (!tracked || !untracked) return undefined;
  const out: Candidate[] = [];
  for (const rec of tracked.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const mode = rec.slice(0, 6);
    const path = rec.slice(tab + 1);
    out.push(mode === '160000' ? { path, nestedRepo: true } : { path });
  }
  for (const path of untracked.toString('utf8').split('\0')) {
    if (!path) continue;
    // git lists untracked nested repositories as a directory entry with a trailing slash
    out.push(path.endsWith('/') ? { path: path.slice(0, -1), nestedRepo: true } : { path });
  }
  return out;
}

/** Filesystem walk for non-git roots, honoring nested .gitignore files. Never follows directory symlinks. */
function listWithWalk(root: string, signal?: AbortSignal): Candidate[] {
  const out: Candidate[] = [];
  const walk = (rel: string, rules: { base: string; ig: Ignore }[]) => {
    signal?.throwIfAborted();
    const abs = rel ? join(root, rel) : root;
    const gi = join(abs, '.gitignore');
    const here = existsSync(gi)
      ? [...rules, { base: rel, ig: ignore().add(readFileSync(gi, 'utf8')) }]
      : rules;
    const ignored = (p: string, dir: boolean) =>
      here.some(({ base, ig }) => {
        const r = base ? p.slice(base.length + 1) : p;
        return r !== '' && ig.ignores(dir ? `${r}/` : r);
      });
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        if (ignored(p, true)) continue;
        if (existsSync(join(root, p, '.git'))) {
          out.push({ path: p, nestedRepo: true });
          continue;
        }
        walk(p, here);
      } else if (!ignored(p, false)) {
        out.push({ path: p });
      }
    }
  };
  walk('', []);
  return out;
}

function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>, signal?: AbortSignal) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        signal?.throwIfAborted();
        await fn(items[i++]!);
      }
    }),
  );
}

/**
 * Inventory a registered root (plan §7 step 1). Reads file bytes only to hash them; never executes
 * anything. The registered root is the boundary: symlinks resolving outside it are not followed.
 */
export async function buildInventory(
  rootPath: string,
  opts: InventoryOptions = {},
): Promise<Inventory> {
  const started = performance.now();
  const root = realpathSync(rootPath);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const gitList = await listWithGit(root);
  const candidates = gitList ?? listWithWalk(root, opts.signal);
  const ig = atlasIgnore(root);

  const files: InventoryFile[] = [];
  const skipped: SkippedEntry[] = [];
  const toHash: { path: string; st: Stats }[] = [];

  for (const c of candidates) {
    if (ig.ignores(c.path)) continue;
    if (c.nestedRepo) {
      skipped.push({ path: c.path, reason: 'nested-repository' });
      continue;
    }
    if (isSecretPath(c.path)) {
      skipped.push({ path: c.path, reason: 'secret' });
      continue;
    }
    let st: Stats;
    try {
      st = lstatSync(join(root, c.path));
    } catch {
      continue; // listed by git index but deleted from the working tree
    }
    if (st.isSymbolicLink()) {
      let target: string | undefined;
      try {
        target = realpathSync(join(root, c.path));
      } catch {
        target = undefined;
      }
      const inside = target !== undefined && (target === root || target.startsWith(root + sep));
      skipped.push({ path: c.path, reason: inside ? 'symlink' : 'symlink-escape' });
      continue;
    }
    if (st.isDirectory()) {
      skipped.push({ path: c.path, reason: 'nested-repository' });
      continue;
    }
    if (!st.isFile()) continue;
    if (hasBinaryExtension(c.path)) {
      skipped.push({ path: c.path, reason: 'binary', size: st.size });
      continue;
    }
    if (st.size > maxBytes) {
      skipped.push({ path: c.path, reason: 'size', size: st.size });
      continue;
    }
    toHash.push({ path: c.path, st });
  }

  await pool(
    toHash,
    opts.concurrency ?? 32,
    async ({ path, st }) => {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(root, path));
      } catch {
        skipped.push({ path, reason: 'unreadable' });
        return;
      }
      if (bytes.subarray(0, 8000).includes(0)) {
        skipped.push({ path, reason: 'binary', size: bytes.length });
        return;
      }
      const language = detectLanguage(path);
      files.push({
        path,
        size: bytes.length,
        mtimeMs: st.mtimeMs,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        gitBlob: gitBlobId(bytes),
        language,
        role: detectRole(path, language),
        support: 'inventory-only',
      });
    },
    opts.signal,
  );

  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  skipped.sort((a, b) => (a.path < b.path ? -1 : 1));

  let git: Inventory['git'];
  if (gitList) {
    const head =
      (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.toString().trim() ||
      undefined;
    git = { tracked: true, head, dirty: await isDirtyVsHead(root, files, skipped, head, ig) };
  }
  return { root, files, skipped, git, durationMs: performance.now() - started };
}

/**
 * True when the analyzed tree differs from HEAD for the paths Atlas includes. Compares git blob ids
 * of working-tree bytes with `git ls-tree HEAD`. Line-ending or clean/smudge filters can make this
 * report dirty when `git status` says clean; that is the safe direction (never label edits as HEAD).
 */
async function isDirtyVsHead(
  root: string,
  files: InventoryFile[],
  skipped: SkippedEntry[],
  head: string | undefined,
  ig: Ignore,
): Promise<boolean> {
  if (!head) return true;
  const out = await runGit(root, ['ls-tree', '-r', '-z', 'HEAD', '--', '.']);
  if (!out) return true;
  const headBlobs = new Map<string, string>();
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, blob] = rec.slice(0, tab).split(' ');
    if (type === 'blob' && mode !== '120000') headBlobs.set(rec.slice(tab + 1), blob!);
  }
  for (const f of files) if (headBlobs.get(f.path) !== f.gitBlob) return true;
  const present = new Set([...files.map((f) => f.path), ...skipped.map((s) => s.path)]);
  for (const p of headBlobs.keys()) {
    if (present.has(p) || ig.ignores(p) || isSecretPath(p) || hasBinaryExtension(p)) continue;
    // a HEAD file that is no longer present on disk was deleted
    if (!existsSync(join(root, p))) return true;
    try {
      if (statSync(join(root, p)).size > DEFAULT_MAX_FILE_BYTES) continue;
    } catch {
      return true;
    }
  }
  return false;
}
