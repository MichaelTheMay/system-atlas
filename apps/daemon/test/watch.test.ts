import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '../src/server.ts';

const token = 'w'.repeat(64);
const port = 47999;
const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let srv: ReturnType<typeof buildServer> | undefined;
afterEach(async () => {
  await srv?.app.close();
  srv = undefined;
});

async function setup(watch: { debounceMs: number; maxWaitMs?: number }) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-watch-')), 'proj');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  const db = openDb(':memory:');
  migrate(db);
  srv = buildServer({ token, db, dataDir: '/tmp/x', port: () => port, watch });
  const { app, jobs } = srv;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers,
    payload: { rootPath: root },
  });
  const wt = reg.json().worktree.id as string;
  const published: { snapshotId: string; noop: boolean }[] = [];
  const changed: { changes: number; sample: string[] }[] = [];
  srv.bus.subscribe((m) => {
    if (m.type === 'snapshot.published' && m.data.worktreeId === wt)
      published.push({ snapshotId: String(m.data.snapshotId), noop: !!m.data.noop });
    if (m.type === 'watch.changed') changed.push(m.data as never);
  });
  const enable = await app.inject({
    method: 'PUT',
    url: `/api/v1/worktrees/${wt}/watch`,
    headers,
    payload: { enabled: true },
  });
  expect(enable.json().watching).toBe(true);
  await jobs.idle(); // the initial catch-up scan
  const settle = async () => {
    await sleep(watch.debounceMs * 2 + 50);
    await jobs.idle();
  };
  return {
    root,
    wt,
    app,
    db,
    published,
    changed,
    settle,
    real: () => published.filter((p) => !p.noop),
  };
}

describe('watcher', () => {
  it('coalesces a burst of edits into one scan and one published snapshot', async () => {
    const t = await setup({ debounceMs: 150 });
    const before = t.real().length;
    const files = [
      'packages/api/src/db.ts',
      'packages/web/src/main.tsx',
      'packages/worker/src/generate.ts',
    ];
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(t.root, files[i % 3]!), `// burst ${i}\nexport const v${i} = ${i};\n`);
      await sleep(5);
    }
    await t.settle();
    expect(t.changed).toHaveLength(1);
    expect(t.changed[0]!.sample).toEqual(expect.arrayContaining(files));
    expect(t.real().length - before).toBe(1);
    const status = (await t.app.inject({ url: `/api/v1/worktrees/${t.wt}/watch`, headers })).json();
    expect(status.status).toMatchObject({ flushes: 1, pendingChanges: 0, debounceMs: 150 });
  });

  it('caps the delay under continuous edits (max wait) and picks up files in new directories', async () => {
    const t = await setup({ debounceMs: 200, maxWaitMs: 300 });
    for (let i = 0; i < 16; i++) {
      writeFileSync(join(t.root, 'packages/api/src/db.ts'), `export const n = ${i};\n`);
      await sleep(50);
    }
    // edits never paused for 200 ms, yet scans happened while they continued
    expect(t.changed.length).toBeGreaterThanOrEqual(2);
    mkdirSync(join(t.root, 'packages/api/src/feature'));
    await sleep(20);
    writeFileSync(
      join(t.root, 'packages/api/src/feature/new-module.ts'),
      'export const fresh = 1;\n',
    );
    await t.settle();
    const snap = (
      await t.app.inject({ url: `/api/v1/worktrees/${t.wt}/snapshot`, headers })
    ).json();
    const files = t.db
      .prepare('SELECT path FROM snapshot_files WHERE snapshot_id = ?')
      .all<{ path: string }>(snap.snapshot.id)
      .map((r) => r.path);
    expect(files).toContain('packages/api/src/feature/new-module.ts');
  });

  it('ignores excluded folders and stops when disabled', async () => {
    const t = await setup({ debounceMs: 100 });
    mkdirSync(join(t.root, 'node_modules/left-pad'), { recursive: true });
    writeFileSync(join(t.root, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
    await t.settle();
    expect(t.changed).toEqual([]);
    await t.app.inject({
      method: 'PUT',
      url: `/api/v1/worktrees/${t.wt}/watch`,
      headers,
      payload: { enabled: false },
    });
    writeFileSync(join(t.root, 'packages/api/src/db.ts'), 'export const after = 1;\n');
    await t.settle();
    expect(t.changed).toEqual([]);
    expect((await t.app.inject({ url: '/api/v1/status', headers })).json().watching).toEqual([]);
  });
});
