import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '@atlas/store';
import {
  inspectGit,
  listProjects,
  manifestDigest,
  redactRemoteUrl,
  registerRoot,
  sha256Hex,
} from '../src/index.ts';

const g = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=atlas-test',
      '-c',
      'user.email=atlas-test@example.invalid',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd,
      stdio: 'pipe',
    },
  ).toString();

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-repo-'));
  const repo = join(dir, 'app');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# app\n');
  writeFileSync(join(repo, 'sub', 'x.ts'), 'export const x = 1;\n');
  g(repo, 'init', '-q');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/** Content + name + mode snapshot of a directory tree, for "registration did not modify it" checks. */
function treeFingerprint(root: string): string {
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

describe('registerRoot', () => {
  it('treats two git worktrees as separate contexts of one project with their own branches', async () => {
    const repo = tempRepo();
    const feature = join(repo, '..', 'app-feature');
    g(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
    const db = freshDb();
    const a = await registerRoot(db, repo);
    const b = await registerRoot(db, feature);
    expect(b.project.id).toBe(a.project.id);
    expect(b.created).toEqual({ project: false, worktree: true });
    expect(b.worktree.id).not.toBe(a.worktree.id);
    expect(a.worktree.git?.branch).toBe('main');
    expect(b.worktree.git?.branch).toBe('feature');
  });

  it('makes separate clones and different sub-paths separate projects', async () => {
    const repo = tempRepo();
    const clone = join(repo, '..', 'clone');
    execFileSync('git', ['clone', '-q', repo, clone]);
    const db = freshDb();
    const a = await registerRoot(db, repo);
    const c = await registerRoot(db, clone);
    const s = await registerRoot(db, join(repo, 'sub'));
    expect(c.project.id).not.toBe(a.project.id);
    expect(s.project.id).not.toBe(a.project.id);
    expect(s.worktree.rootPath.endsWith('/sub')).toBe(true);
    expect(s.worktree.git?.subPath).toBe('sub');
    expect(s.worktree.git?.topLevel).toBe(a.worktree.rootPath);
  });

  it('is idempotent and refreshes the branch on re-registration', async () => {
    const repo = tempRepo();
    const db = freshDb();
    const first = await registerRoot(db, repo);
    g(repo, 'checkout', '-q', '-b', 'topic');
    const again = await registerRoot(db, repo);
    expect(again.created).toEqual({ project: false, worktree: false });
    expect(again.worktree.id).toBe(first.worktree.id);
    expect(again.worktree.git?.branch).toBe('topic');
    expect(listProjects(db)).toHaveLength(1);
  });

  it('registers non-git directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-plain-'));
    const r = await registerRoot(freshDb(), dir);
    expect(r.worktree.git).toBeUndefined();
    expect(r.project.remoteUrl).toBeUndefined();
  });

  it('does not modify the registered tree (repository fixture)', async () => {
    const fixture = fileURLToPath(new URL('../../../fixtures/ts-web-service', import.meta.url));
    const before = treeFingerprint(fixture);
    const r = await registerRoot(freshDb(), fixture);
    expect(treeFingerprint(fixture)).toBe(before);
    expect(r.worktree.rootPath).toBe(fixture);
    // the fixture lives inside the Atlas repo: git metadata is recorded but the root stays the fixture
    if (r.worktree.git) expect(r.worktree.git.subPath).toBe('fixtures/ts-web-service');
  });
});

describe('git inspection safety', () => {
  it('does not execute core.fsmonitor from repository config', async () => {
    const repo = tempRepo();
    const marker = join(repo, '..', 'pwned');
    const script = join(repo, '..', 'monitor.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    g(repo, 'config', 'core.fsmonitor', script);
    const info = await inspectGit(repo);
    expect(info?.branch).toBe('main');
    expect(existsSync(marker)).toBe(false);
  });

  it('redacts credentials from remote URLs', () => {
    expect(redactRemoteUrl('https://user:ghp_secret@github.com/a/b.git?token=x')).toBe(
      'https://github.com/a/b.git',
    );
    expect(redactRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(redactRemoteUrl('ssh://git@host/a/b.git')).toBe('ssh://git@host/a/b.git');
  });
});

describe('manifestDigest', () => {
  it('is order-independent and content-sensitive', () => {
    const a = [
      { path: 'a.ts', sha256: '1'.repeat(64) },
      { path: 'b.ts', sha256: '2'.repeat(64) },
    ];
    expect(manifestDigest(a)).toBe(manifestDigest([...a].reverse()));
    expect(manifestDigest(a)).not.toBe(
      manifestDigest([a[0]!, { path: 'b.ts', sha256: '3'.repeat(64) }]),
    );
  });
});
