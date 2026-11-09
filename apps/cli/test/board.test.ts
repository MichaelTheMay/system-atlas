import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectStore } from '@atlas/evidence';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '@atlas/daemon';
import { writeDiscovery } from '@atlas/daemon/discovery';

const run = promisify(execFile);
const token = 'k'.repeat(64);
let port = 0;
let srv: ReturnType<typeof buildServer>;
let root: string;
let env: NodeJS.ProcessEnv;
const main = new URL('../src/main.ts', import.meta.url).pathname;

const atlas = (...args: string[]) =>
  run(process.execPath, [main, ...args], { env, timeout: 60_000 }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );

beforeAll(async () => {
  const db = openDb(':memory:');
  migrate(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-cli-board-data-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'atlas-cli-board-run-'));
  srv = buildServer({
    token,
    db,
    dataDir,
    objects: new ObjectStore(join(dataDir, 'objects')),
    port: () => port,
    // no real claude and no keychain from tests
    designAgent: { secretTool: false, env: { PATH: '/nonexistent' } },
  });
  await srv.app.listen({ host: '127.0.0.1', port: 0 });
  port = (srv.app.server.address() as { port: number }).port;
  await writeDiscovery(join(runtimeDir, 'daemon.json'), {
    pid: process.pid,
    port,
    host: '127.0.0.1',
    token,
    version: 'test',
    startedAt: new Date().toISOString(),
    dataDir,
  });
  // boards are design-first: an empty folder is enough
  root = join(mkdtempSync(join(tmpdir(), 'atlas-cli-board-proj-')), 'shop');
  mkdirSync(root);
  env = { ...process.env, ATLAS_RUNTIME_DIR: runtimeDir, ATLAS_DATA_DIR: dataDir };
  delete env.INIT_CWD;
}, 60_000);

afterAll(() => srv?.app.close());

describe('atlas board (CLI)', () => {
  it('drafts with the mock, lists, shows, exports Markdown, critiques and plans', async () => {
    expect((await atlas('board', 'list', root)).stdout).toMatch(/no boards yet/);

    const d = await atlas(
      'board',
      'draft',
      'design a url shortener',
      '--path',
      root,
      '--runtime',
      'mock',
    );
    expect(d.stderr).toBe('');
    expect(d.code).toBe(0);
    expect(d.stdout).toMatch(/runtime: mock/);
    expect(d.stdout).toMatch(/leaves this machine: Nothing leaves this machine/);
    const m = /succeeded: (\d+) item\(s\) proposed on board (brd_[0-9a-f]+)/.exec(d.stdout);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(10);
    const id = m![2]!;

    const l = await atlas('board', 'list', root);
    expect(l.stdout).toMatch(new RegExp(`${id} +URL shortener +10 component\\(s\\) +prompt`));

    const md = await atlas('board', 'export', id, '--markdown');
    expect(md.code).toBe(0);
    expect(md.stdout).toMatch(/^# URL shortener\n/);
    expect(md.stdout).toMatch(/- \*\*Shortener API\*\* \(Service\).*_\(proposed by mock-design\)_/);
    expect(md.stdout).toMatch(/## Bottlenecks & failure modes/);
    const json = JSON.parse((await atlas('board', 'export', id)).stdout);
    expect(json.id).toBe(id);

    const show = await atlas('board', 'show', id, '--json');
    expect(JSON.parse(show.stdout).spec.components).toHaveLength(10);

    const c = await atlas('board', 'critique', id);
    expect(c.code).toBe(0);
    expect(c.stdout).toMatch(/finding\(s\) proposed:/);
    expect(c.stdout).toMatch(/- \[risks\] \[Security edge\]/);

    const p = await atlas('board', 'plan', id);
    expect(p.code).toBe(0);
    expect(p.stdout).toMatch(/# Implementation plan: URL shortener/);
    expect(p.stdout).toMatch(/## Agent brief/);
  });

  it('refuses non-mock runtimes without --yes and unknown boards', async () => {
    const r = await atlas('board', 'draft', 'x', '--path', root, '--runtime', 'claude-code');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pass --yes/);
    const u = await atlas('board', 'critique', `brd_${'0'.repeat(32)}`);
    expect(u.code).toBe(1);
    expect(u.stderr).toMatch(/unknown board/);
    expect(
      (await atlas('board', 'draft', 'x', '--path', root, '--runtime', 'nope')).stderr,
    ).toMatch(/--runtime must be one of/);
  });
});
