import { execFile } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectStore } from '@atlas/evidence';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '@atlas/daemon';
import { writeDiscovery } from '@atlas/daemon/discovery';
import { claudeCode } from '../src/doctor.ts';

const run = promisify(execFile);
const token = 'g'.repeat(64);
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
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-cli-design-data-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'atlas-cli-design-run-'));
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
  root = join(mkdtempSync(join(tmpdir(), 'atlas-cli-design-proj-')), 'svc');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  env = { ...process.env, ATLAS_RUNTIME_DIR: runtimeDir, ATLAS_DATA_DIR: dataDir };
  delete env.INIT_CWD;
  const scan = await atlas('scan', root);
  expect(scan.code).toBe(0);
}, 120_000);

afterAll(() => srv?.app.close());

describe('atlas design (CLI)', () => {
  it('generate --runtime mock prints the estimate, runs the job and reports proposals', async () => {
    const r = await atlas('design', 'generate', root, '--runtime', 'mock', '--depth', '2');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/runtime: mock/);
    expect(r.stdout).toMatch(/estimated tokens: ~\d+ in/);
    expect(r.stdout).toMatch(/leaves this machine: Nothing leaves this machine/);
    expect(r.stdout).toMatch(/succeeded: [1-9]\d* claim\(s\) proposed/);

    const s = await atlas('design', 'status', root);
    expect(s.code).toBe(0);
    expect(s.stdout).toMatch(/djb_[0-9a-f]+ +generate +mock +succeeded/);
  });

  it('refuses a non-mock runtime without --yes when it cannot ask', async () => {
    const r = await atlas('design', 'generate', root, '--runtime', 'claude-code');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/leaves this machine: Claude Code sends/);
    expect(r.stderr).toMatch(/pass --yes/);
    const s = await atlas('design', 'status', root, '--json');
    const jobs = JSON.parse(s.stdout) as { runtime: string }[];
    expect(jobs.every((j) => j.runtime === 'mock')).toBe(true);
  });
});

describe('atlas doctor: claude-code check', () => {
  it('reports the version of a claude on PATH, or a warning when there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-doctor-claude-'));
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\necho "1.2.3 (Claude Code)"\n');
    chmodSync(join(dir, 'claude'), 0o755);
    expect(await claudeCode('claude', { PATH: dir })).toEqual({
      status: 'ok',
      detail: '1.2.3 (Claude Code) on PATH',
    });
    expect(await claudeCode('claude', { PATH: '/nonexistent' })).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/not on PATH/),
    });
  });
});
