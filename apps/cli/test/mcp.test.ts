/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are JSON read the way an agent would */
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ObjectStore } from '@atlas/evidence';
import { migrate, openDb } from '@atlas/store';
import { buildServer } from '@atlas/daemon';
import { localDaemon, recorderFor, startRun } from '@atlas/adapters';
import { writeDiscovery } from '@atlas/daemon/discovery';

const token = 'm'.repeat(64);
let port = 0;
let srv: ReturnType<typeof buildServer>;
let client: Client;
let root: string;
let runtimeDir: string;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = r.content[0]!.text;
  if (r.isError) return { error: text };
  return JSON.parse(text) as Record<string, any>;
};

beforeAll(async () => {
  const db = openDb(':memory:');
  migrate(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-mcp-data-'));
  runtimeDir = mkdtempSync(join(tmpdir(), 'atlas-mcp-run-'));
  srv = buildServer({
    token,
    db,
    dataDir,
    objects: new ObjectStore(join(dataDir, 'objects')),
    port: () => port,
  });
  await srv.app.listen({ host: '127.0.0.1', port: 0 });
  port = (srv.app.server.address() as { port: number }).port;
  // the spawned `atlas mcp` finds this in-process daemon through the discovery record
  await writeDiscovery(join(runtimeDir, 'daemon.json'), {
    pid: process.pid,
    port,
    host: '127.0.0.1',
    token,
    version: 'test',
    startedAt: new Date().toISOString(),
    dataDir,
  });
  root = join(mkdtempSync(join(tmpdir(), 'atlas-mcp-proj-')), 'svc');
  cpSync(new URL('../../../fixtures/ts-web-service', import.meta.url).pathname, root, {
    recursive: true,
  });
  writeFileSync(join(root, 'secret-outside.txt'), 'inside');
  symlinkSync('/etc/hostname', join(root, 'escape-link'));
  client = new Client({ name: 'atlas-test-agent', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL('../src/main.ts', import.meta.url).pathname, 'mcp', root],
      env: {
        ...(process.env as Record<string, string>),
        ATLAS_RUNTIME_DIR: runtimeDir,
        ATLAS_DATA_DIR: dataDir,
      },
      stderr: 'pipe',
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  await srv?.app.close();
});

describe('atlas mcp (stdio, as an external agent)', () => {
  it('exposes semantic tools only', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'atlas_annotate',
      'atlas_finish_run',
      'atlas_get_artifact_metadata',
      'atlas_get_entity',
      'atlas_get_evidence',
      'atlas_get_run',
      'atlas_get_view',
      'atlas_list_artifacts',
      'atlas_list_runs',
      'atlas_list_views',
      'atlas_project_status',
      'atlas_propose_claims',
      'atlas_propose_view',
      'atlas_record_artifact',
      'atlas_record_event',
      'atlas_refresh',
      'atlas_search',
      'atlas_start_run',
    ]);
    expect(tools.find((t) => t.name === 'atlas_search')?.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain('untrusted');
  });

  it('reads the map: status, refresh, views, search, entity, evidence', async () => {
    expect((await call('atlas_project_status')).snapshot).toBeNull();
    expect(await call('atlas_refresh', { dryRun: true })).toMatchObject({
      dryRun: true,
      changedSinceSnapshot: true,
    });
    const refreshed = await call('atlas_refresh');
    expect(refreshed.snapshotId).toMatch(/^snap_/);
    expect((await call('atlas_refresh')).noop).toBe(true);
    const status = await call('atlas_project_status');
    expect(status.snapshot.id).toBe(refreshed.snapshotId);
    expect(status.counts.entitiesByKind.module).toBeGreaterThan(5);

    const views = await call('atlas_list_views', { lens: 'component' });
    expect(views.views.length).toBeGreaterThan(0);
    const view = await call('atlas_get_view', { viewId: views.views[0].viewId });
    expect(view.nodes.length).toBeGreaterThan(2);
    expect(view.edges[0]).toHaveProperty('kinds');
    expect((await call('atlas_list_views', { limit: 2 })).nextCursor).toBe('2');
    expect(views.views[0]).toMatchObject({ workspace: 'architecture' });
    expect(
      (await call('atlas_list_views', { workspace: 'outputs' })).views.every(
        (v: any) => v.workspace === 'outputs',
      ),
    ).toBe(true);
    expect((await call('atlas_list_views', { workspace: 'nope' })).error).toBeTruthy();

    const { hits } = await call('atlas_search', { query: 'db', kind: 'module' });
    const db = hits.find((h: any) => h.path === 'packages/api/src/db.ts');
    expect(db).toBeTruthy();
    const entity = await call('atlas_get_entity', { entityId: db.id });
    expect(entity.entity.displayName).toBe('db.ts');
    expect(entity.relations.length).toBeGreaterThan(0);
    const ev = await call('atlas_get_evidence', {
      entityId: db.id,
      relationIds: entity.relations.slice(0, 2).map((r: any) => r.id),
    });
    expect(ev.entity.evidence[0]).toMatchObject({
      path: 'packages/api/src/db.ts',
      freshness: 'current',
    });
    expect(ev.relations).toHaveLength(2);
    expect((await call('atlas_get_entity', { entityId: 'ent_' + '0'.repeat(32) })).error).toMatch(
      /unknown_entity/,
    );
    expect((await call('atlas_get_view', { viewId: '../../etc' })).error).toBeTruthy();
  });

  it('records an agent run: events, explicit entity links, artifacts, outcome; refuses escapes', async () => {
    const { hits } = await call('atlas_search', { query: 'db', kind: 'module' });
    const dbId = hits.find((h: any) => h.path === 'packages/api/src/db.ts').id;
    const { runId, snapshotBound } = await call('atlas_start_run', {
      name: 'investigate report storage',
      producer: 'test-agent',
    });
    expect(snapshotBound).toBe(true);
    const step = await call('atlas_record_event', {
      runId,
      type: 'step.started',
      payload: { name: 'read db module' },
      entityIds: [dbId],
    });
    expect(step.eventId).toMatch(/^evt_/);
    await call('atlas_record_event', {
      runId,
      type: 'tool.call.completed',
      payload: { tool: 'grep', resultCount: 3 },
      parentEventId: step.eventId,
    });
    expect(
      (
        await call('atlas_record_event', {
          runId,
          type: 'assertion.result',
          payload: { name: 'x', passed: false },
        })
      ).error,
    ).toMatch(/outcome/);
    await call('atlas_record_event', {
      runId,
      type: 'assertion.result',
      payload: { outcome: 'fail', description: 'reports are persisted' },
    });
    expect((await call('atlas_record_event', { runId, type: 'not.a.type' })).error).toBeTruthy();

    const file = await call('atlas_record_artifact', { runId, path: 'packages/api/src/db.ts' });
    expect(file.bytesState).toBe('available');
    const note = await call('atlas_record_artifact', {
      runId,
      text: '# findings\nno retry on insert',
      logicalName: 'findings.md',
      mediaType: 'text/markdown',
    });
    expect(note.bytesState).toBe('available');
    expect(
      (await call('atlas_record_artifact', { runId, path: '../../../etc/hostname' })).error,
    ).toMatch(/escapes the project root|no such file/);
    expect((await call('atlas_record_artifact', { runId, path: 'escape-link' })).error).toMatch(
      /escapes the project root/,
    );
    expect((await call('atlas_record_artifact', { runId, path: '/etc/hostname' })).error).toMatch(
      /relative/,
    );

    const done = await call('atlas_finish_run', { runId, status: 'succeeded' });
    // the rejected assertion stays visible in the audit trail as an ingestion error
    expect(done.ingestionErrors).toEqual([expect.stringMatching(/assertion\.result/)]);
    expect((await call('atlas_record_event', { runId, type: 'step.started' })).error).toMatch(
      /only runs started in this session/,
    );

    const run = await call('atlas_get_run', { runId });
    expect(run.outcome).toMatchObject({ process: 'succeeded', task: 'failed' });
    expect(run.eventsTotal).toBeGreaterThanOrEqual(3);
    expect(run.links.map((l: any) => l.entity?.displayName)).toContain('db.ts');
    expect(run.artifacts.map((a: any) => a.logicalName).sort()).toEqual([
      'findings.md',
      'packages/api/src/db.ts',
    ]);
    const meta = await call('atlas_get_artifact_metadata', { artifactId: run.artifacts[0].id });
    expect(meta).toHaveProperty('sha256');
    expect(JSON.stringify(meta)).not.toContain('no retry on insert'); // metadata only, never bytes
    expect((await call('atlas_list_runs')).runs.map((r: any) => r.id)).toContain(runId);
    // another session's run cannot be written
    expect(
      (await call('atlas_finish_run', { runId: 'run_' + '1'.repeat(32), status: 'failed' })).error,
    ).toMatch(/only runs started/);
  });

  it('generic event SDK: any program finds the daemon, starts a run and records steps', async () => {
    const daemon = localDaemon({ ...process.env, ATLAS_RUNTIME_DIR: runtimeDir });
    const { client, runId } = await startRun({ daemon, rootPath: root, adapter: 'custom-agent' });
    const atlas = recorderFor(client);
    const value = await atlas.step('plan', async () => 42);
    expect(value).toBe(42);
    await atlas.assert('plan produced a value', value === 42);
    await client.finish('succeeded');
    const run = await call('atlas_get_run', { runId });
    expect(run.outcome).toMatchObject({ process: 'succeeded', task: 'passed' });
    expect(run.events.map((e: any) => e.type)).toEqual([
      'step.started',
      'step.completed',
      'assertion.result',
    ]);
    expect(() =>
      localDaemon({ ATLAS_RUNTIME_DIR: join(runtimeDir, 'nope'), ATLAS_DATA_DIR: '/tmp/x' }),
    ).toThrow(/no running Atlas daemon/);
  });

  it('proposes cited claims (invented evidence rejected) and annotates as an agent', async () => {
    const status = await call('atlas_project_status');
    const { hits } = await call('atlas_search', { query: 'db', kind: 'module' });
    const dbId = hits.find((h: any) => h.path === 'packages/api/src/db.ts').id;
    const r = await call('atlas_propose_claims', {
      snapshotId: status.snapshot.id,
      claims: [
        {
          subjectId: dbId,
          predicate: 'role',
          value: 'storage',
          citations: [{ path: 'packages/api/src/db.ts', startLine: 1, endLine: 3 }],
          rationale: 'issues SQL',
        },
        {
          subjectId: dbId,
          predicate: 'summary',
          value: 'Talks to Redis.',
          citations: [{ path: 'packages/api/src/redis.ts', startLine: 1, endLine: 2 }],
        },
      ],
    });
    expect(r.accepted).toEqual([expect.objectContaining({ index: 0, status: 'inferred' })]);
    expect(r.rejected[0]).toMatchObject({
      index: 1,
      reasons: [expect.stringMatching(/not part of this snapshot/)],
    });
    const entity = await call('atlas_get_entity', { entityId: dbId });
    expect(entity.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: 'role',
          origin: 'model',
          status: 'inferred',
          value: 'storage',
        }),
      ]),
    );
    expect(
      (
        await call('atlas_propose_claims', {
          snapshotId: 'snap_' + '0'.repeat(32),
          claims: [
            {
              subjectId: dbId,
              predicate: 'role',
              value: 'api',
              citations: [{ path: 'packages/api/src/db.ts', startLine: 1, endLine: 1 }],
            },
          ],
        })
      ).error,
    ).toMatch(/unknown_snapshot/);

    // subsystems: each member becomes a cited subsystem (+ responsibility) claim, labeled inferred
    const serverId = (await call('atlas_search', { query: 'server', kind: 'module' })).hits.find(
      (h: any) => h.path === 'packages/api/src/server.ts',
    ).id;
    const v = await call('atlas_propose_view', {
      snapshotId: status.snapshot.id,
      subsystems: [
        {
          name: 'Backend/Persistence',
          responsibility: 'Stores reports.',
          members: [
            {
              entityId: dbId,
              citations: [{ path: 'packages/api/src/db.ts', startLine: 1, endLine: 2 }],
            },
            { entityId: serverId, citations: [{ evidenceId: 'evd_' + '0'.repeat(32) }] },
          ],
        },
      ],
    });
    expect(v.subsystems).toEqual([
      {
        name: 'Backend/Persistence',
        accepted: [dbId],
        rejected: [
          {
            entityId: serverId,
            predicate: 'subsystem',
            reasons: [expect.stringMatching(/does not exist in this project/)],
          },
          {
            entityId: serverId,
            predicate: 'responsibility',
            reasons: [expect.stringMatching(/does not exist in this project/)],
          },
        ],
        proposalIds: [expect.stringMatching(/^prp_/)],
      },
    ]);
    expect((await call('atlas_get_entity', { entityId: dbId })).claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: 'subsystem',
          value: 'Backend/Persistence',
          origin: 'model',
          status: 'inferred',
        }),
        expect.objectContaining({ predicate: 'responsibility', value: 'Stores reports.' }),
      ]),
    );
    // more than 25 claims are split into several validated proposals
    const big = await call('atlas_propose_view', {
      snapshotId: status.snapshot.id,
      subsystems: [
        {
          name: 'Edge',
          responsibility: 'Serves HTTP.',
          members: Array.from({ length: 13 }, () => ({
            entityId: serverId,
            citations: [{ path: 'packages/api/src/server.ts', startLine: 1, endLine: 1 }],
          })),
        },
      ],
    });
    expect(big.subsystems[0].accepted).toHaveLength(13);
    expect(big.subsystems[0].rejected).toEqual([]);
    expect(big.subsystems[0].proposalIds).toHaveLength(2);
    expect(
      (
        await call('atlas_propose_view', {
          snapshotId: status.snapshot.id,
          subsystems: [
            {
              name: 'a/b/c/d',
              members: [{ entityId: dbId, citations: [{ evidenceId: 'evd_' + '0'.repeat(32) }] }],
            },
          ],
        })
      ).error,
    ).toBeTruthy();

    const note = await call('atlas_annotate', { entityId: dbId, text: 'Inserts have no retry.' });
    expect(note.annotationId).toMatch(/^ann_/);
    const overlay: any = await (
      await fetch(`http://127.0.0.1:${port}/api/v1/views/${note.viewId}/overlay`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(overlay.annotations).toEqual([
      expect.objectContaining({
        targetId: dbId,
        text: 'Inserts have no retry.',
        author: 'agent',
        authorName: 'atlas-test-agent',
      }),
    ]);
  });
});
