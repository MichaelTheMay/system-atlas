/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON */
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockProvider } from '@atlas/agent-api';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '../src/server.ts';

const token = 'e'.repeat(64);
const port = 47998;
const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
const SECRET = 'sk-live-0123456789abcdefghijklmnopqrst';
let srv: ReturnType<typeof buildServer> | undefined;
afterEach(async () => {
  await srv?.app.close();
  srv = undefined;
});

async function setup(
  providers: Record<string, ReturnType<typeof createMockProvider>>,
  opts: { watch?: { debounceMs: number } } = {},
) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-enrich-')), 'svc');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  writeFileSync(
    join(root, 'packages/api/src/secrets.ts'),
    `export const API_KEY = "${SECRET}";\nexport const region = 'eu';\n`,
  );
  const db = openDb(':memory:');
  migrate(db);
  srv = buildServer({
    token,
    db,
    dataDir: '/tmp/x',
    port: () => port,
    providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, () => p])),
    watch: opts.watch,
  });
  const app = srv.app;
  const j = async (method: string, url: string, payload?: unknown) =>
    (
      await app.inject({ method: method as 'GET', url, headers, payload: payload as object })
    ).json() as any;
  const reg = await j('POST', '/api/v1/projects', { rootPath: root });
  const wt = reg.worktree.id as string;
  await j('POST', `/api/v1/worktrees/${wt}/scans`);
  await srv.jobs.idle();
  const snap = await j('GET', `/api/v1/worktrees/${wt}/snapshot`);
  const find = async (q: string, path: string) =>
    (await j('GET', `/api/v1/snapshots/${snap.snapshot.id}/search?q=${q}&kind=module`)).hits.find(
      (h: any) => h.path === path,
    ).id as string;
  return {
    root,
    wt,
    projectId: reg.project.id as string,
    j,
    find,
    enrich: (ids: string[]) => j('POST', `/api/v1/worktrees/${wt}/enrich`, { entityIds: ids }),
  };
}

describe('model enrichment', () => {
  it('is off by default and never calls a provider', async () => {
    const mock = createMockProvider();
    const t = await setup({ mock });
    const id = await t.find('db', 'packages/api/src/db.ts');
    expect((await t.enrich([id])).results[0]).toMatchObject({ status: 'disabled' });
    expect(mock.calls()).toBe(0);
    expect(await t.j('PUT', '/api/v1/settings/enrichment', { provider: 'openai' })).toMatchObject({
      error: expect.any(String),
    });
  });

  it('validates provider output like any proposal, caches identical requests and redacts before sending', async () => {
    const honest = createMockProvider();
    const adversarial = createMockProvider({ mode: 'adversarial' });
    const t = await setup({ mock: honest, 'mock-adversarial': adversarial });
    const db = await t.find('db', 'packages/api/src/db.ts');
    await t.j('PUT', '/api/v1/settings/enrichment', { provider: 'mock' });
    const first = (await t.enrich([db])).results[0];
    expect(first).toMatchObject({ status: 'completed', accepted: 2, rejected: [] });
    const entity = await t.j(
      'GET',
      `/api/v1/snapshots/${(await t.j('GET', `/api/v1/worktrees/${t.wt}/snapshot`)).snapshot.id}/entities/${db}`,
    );
    expect(entity.claims.map((c: any) => [c.predicate, c.origin, c.status, c.model])).toEqual(
      expect.arrayContaining([
        ['role', 'model', 'inferred', 'mock-honest'],
        ['summary', 'model', 'inferred', 'mock-honest'],
      ]),
    );
    // an identical request is served from the cache: no provider call, nothing duplicated
    expect((await t.enrich([db])).results[0]).toMatchObject({ status: 'cached', accepted: 0 });
    expect(honest.calls()).toBe(1);

    // invented citations from a provider are rejected with reasons
    await t.j('PUT', '/api/v1/settings/enrichment', { provider: 'mock-adversarial' });
    const server = await t.find('server', 'packages/api/src/server.ts');
    const adv = (await t.enrich([server])).results[0];
    expect(adv.status).toBe('completed');
    expect(adv.accepted).toBe(2);
    expect(adv.rejected.map((r: any) => r.reasons.join(' '))).toEqual([
      expect.stringMatching(/does not exist in this project/),
      expect.stringMatching(/not part of this snapshot/),
    ]);

    // secrets in excerpts never reach a provider
    await t.j('PUT', '/api/v1/settings/enrichment', { provider: 'mock' });
    const secrets = await t.find('secrets', 'packages/api/src/secrets.ts');
    await t.enrich([secrets]);
    const sent = JSON.stringify(honest.seen.at(-1));
    expect(sent).toContain('secrets.ts');
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain('[REDACTED]');

    const usage = (await t.j('GET', `/api/v1/projects/${t.projectId}/enrichment`)).usage;
    expect(usage).toMatchObject({ requests: 3, cached: 1, skippedBudget: 0 });
    expect(usage.estimated).toBeGreaterThan(0);
    expect(usage.reported).toBeGreaterThan(0);
  });

  it('stops at the daily budget before sending, and a newer request cancels an older one', async () => {
    const slow = createMockProvider({ delayMs: 400 });
    const t = await setup({ mock: slow });
    const db = await t.find('db', 'packages/api/src/db.ts');
    await t.j('PUT', '/api/v1/settings/enrichment', { provider: 'mock', maxTokensPerDay: 300 });
    expect((await t.enrich([db])).results[0]).toMatchObject({ status: 'skipped-budget' });
    expect(slow.calls()).toBe(0);

    await t.j('PUT', '/api/v1/settings/enrichment', { maxTokensPerDay: 1_000_000 });
    const older = t.enrich([db]);
    await new Promise((r) => setTimeout(r, 50));
    const newer = await t.enrich([db]);
    expect((await older).results[0]).toMatchObject({ status: 'cancelled' });
    expect(newer.results[0]).toMatchObject({ status: 'completed', accepted: 2 });
    expect((await t.j('GET', `/api/v1/projects/${t.projectId}/enrichment`)).usage).toMatchObject({
      skippedBudget: 1,
      cancelled: 1,
      requests: 1,
    });
  });

  it('never calls a model because files changed (watcher churn)', async () => {
    const mock = createMockProvider();
    const t = await setup({ mock }, { watch: { debounceMs: 80 } });
    await t.j('PUT', '/api/v1/settings/enrichment', { provider: 'mock' });
    await t.j('PUT', `/api/v1/worktrees/${t.wt}/watch`, { enabled: true });
    for (let i = 0; i < 5; i++)
      writeFileSync(join(t.root, 'packages/api/src/db.ts'), `export const v${i} = ${i};\n`);
    await new Promise((r) => setTimeout(r, 400));
    await srv!.jobs.idle();
    expect(mock.calls()).toBe(0);
  });
});
