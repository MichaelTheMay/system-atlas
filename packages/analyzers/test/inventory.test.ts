import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInventory, detectLanguage, detectRole, isSecretPath } from '../src/index.ts';

const g = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd,
      stdio: 'pipe',
    },
  );

function write(root: string, files: Record<string, string | Buffer>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

function repo(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-inv-')), 'r');
  mkdirSync(root);
  write(root, {
    '.gitignore': 'generated/\n*.log\n',
    'src/app.ts': 'export const a = 1;\n',
    'src/app.test.ts': 'test\n',
    'api/main.py': 'print(1)\n',
    'README.md': '# r\n',
    'package.json': '{"name":"r"}\n',
    Dockerfile: 'FROM node:24\n',
    'migrations/001.sql': 'create table t (x int);\n',
    'lib/core.ex': 'defmodule Core do end\n',
    '.env': 'SECRET=hunter2\n',
    'certs/server.pem': '-----BEGIN PRIVATE KEY-----\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
    'data/blob.txt': Buffer.from('abc\0def'),
    'big.json': 'x'.repeat(2048),
    'generated/out.ts': 'ignored',
    'debug.log': 'ignored',
  });
  g(root, 'init', '-q');
  g(root, 'add', '.');
  g(root, 'commit', '-q', '-m', 'init');
  return root;
}

const paths = (inv: Awaited<ReturnType<typeof buildInventory>>) => inv.files.map((f) => f.path);
const skippedAs = (inv: Awaited<ReturnType<typeof buildInventory>>, reason: string) =>
  inv.skipped.filter((s) => s.reason === reason).map((s) => s.path);

describe('buildInventory (git)', () => {
  it('honors gitignore, skips secrets/binaries/oversize, classifies files and is clean at HEAD', async () => {
    const root = repo();
    const inv = await buildInventory(root, { maxFileBytes: 1024 });
    expect(paths(inv)).toEqual([
      '.gitignore',
      'Dockerfile',
      'README.md',
      'api/main.py',
      'lib/core.ex',
      'migrations/001.sql',
      'package.json',
      'src/app.test.ts',
      'src/app.ts',
    ]);
    expect(skippedAs(inv, 'secret')).toEqual(['.env', 'certs/server.pem']);
    expect(skippedAs(inv, 'binary')).toEqual(['data/blob.txt', 'logo.png']);
    expect(skippedAs(inv, 'size')).toEqual(['big.json']);
    const byPath = Object.fromEntries(inv.files.map((f) => [f.path, f]));
    expect(byPath['src/app.ts']).toMatchObject({
      language: 'typescript',
      role: 'source',
      support: 'inventory-only',
    });
    expect(byPath['src/app.test.ts']!.role).toBe('test');
    expect(byPath['Dockerfile']).toMatchObject({ language: 'dockerfile', role: 'deploy' });
    expect(byPath['migrations/001.sql']!.role).toBe('migration');
    expect(byPath['package.json']!.role).toBe('manifest');
    expect(byPath['src/app.ts']!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.git).toMatchObject({ tracked: true, dirty: false });
    expect(inv.git?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('never enumerates untracked dependency folders and applies .atlasignore', async () => {
    const root = repo();
    write(root, { 'node_modules/left-pad/index.js': 'x', '.atlasignore': 'lib/\n' });
    const inv = await buildInventory(root);
    expect(paths(inv).some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths(inv)).not.toContain('lib/core.ex');
  });

  it('detects dirty trees: modified, deleted and untracked files', async () => {
    const root = repo();
    write(root, { 'src/app.ts': 'export const a = 2;\n' });
    expect((await buildInventory(root)).git?.dirty).toBe(true);
    g(root, 'checkout', '--', 'src/app.ts');
    expect((await buildInventory(root)).git?.dirty).toBe(false);
    rmSync(join(root, 'api/main.py'));
    expect((await buildInventory(root)).git?.dirty).toBe(true);
    g(root, 'checkout', '--', 'api/main.py');
    write(root, { 'src/new.ts': 'export {}\n' });
    expect((await buildInventory(root)).git?.dirty).toBe(true);
  });

  it('records symlinks, escapes and nested repositories as skipped entries without reading them', async () => {
    const root = repo();
    const outside = mkdtempSync(join(tmpdir(), 'atlas-outside-'));
    writeFileSync(join(outside, 'secret.ts'), 'export const s = 1;');
    symlinkSync(outside, join(root, 'escape-dir'));
    symlinkSync(join(outside, 'secret.ts'), join(root, 'escape.ts'));
    symlinkSync(join(root, 'src/app.ts'), join(root, 'alias.ts'));
    // tracked embedded repository (gitlink) and untracked nested repository
    const embedded = join(root, 'embedded');
    mkdirSync(embedded);
    write(embedded, { 'x.ts': 'x' });
    g(embedded, 'init', '-q');
    g(embedded, 'add', '.');
    g(embedded, 'commit', '-q', '-m', 'e');
    g(root, 'add', 'embedded');
    const nested = join(root, 'nested');
    mkdirSync(nested);
    write(nested, { 'y.ts': 'y' });
    g(nested, 'init', '-q');
    const inv = await buildInventory(root);
    expect(skippedAs(inv, 'symlink-escape').sort()).toEqual(['escape-dir', 'escape.ts']);
    expect(skippedAs(inv, 'symlink')).toEqual(['alias.ts']);
    expect(skippedAs(inv, 'nested-repository').sort()).toEqual(['embedded', 'nested']);
    expect(
      paths(inv).some(
        (p) => p.startsWith('escape') || p.startsWith('embedded/') || p.startsWith('nested/'),
      ),
    ).toBe(false);
  });
});

describe('buildInventory (no git)', () => {
  it('walks with nested .gitignore files and default excludes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-walk-'));
    write(root, {
      'a.py': 'x',
      'pkg/.gitignore': 'tmp/\n',
      'pkg/tmp/t.py': 'ignored',
      'pkg/b.py': 'x',
      'node_modules/m/i.js': 'ignored',
      'other/.git/HEAD': 'nested',
      'other/c.py': 'inside nested repo',
    });
    const inv = await buildInventory(root);
    expect(paths(inv)).toEqual(['a.py', 'pkg/.gitignore', 'pkg/b.py']);
    expect(skippedAs(inv, 'nested-repository')).toEqual(['other']);
    expect(inv.git).toBeUndefined();
  });
});

describe('classification', () => {
  it.each([
    ['.env.production', true],
    ['.env.example', false],
    ['deploy/key.pem', true],
    ['config/credentials.json', true],
    ['src/credentials.ts', false],
    ['terraform.tfstate', true],
  ])('isSecretPath(%s) = %s', (p, want) => expect(isSecretPath(p)).toBe(want));

  it('detects languages and roles', () => {
    expect(detectLanguage('Dockerfile.prod')).toBe('dockerfile');
    expect(detectLanguage('x/y.mts')).toBe('typescript');
    expect(detectRole('.github/workflows/ci.yml', 'yaml')).toBe('ci');
    expect(detectRole('docker-compose.yml', 'yaml')).toBe('deploy');
    expect(detectRole('api/openapi.yaml', 'yaml')).toBe('schema');
    expect(detectRole('tests/test_api.py', 'python')).toBe('test');
    expect(detectRole('pnpm-lock.yaml', 'yaml')).toBe('lockfile');
  });
});
