/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '@atlas/store';
import type { BusMessage } from '../src/events.ts';
import { buildServer } from '../src/server.ts';

const token = 'b'.repeat(64);
let srv: ReturnType<typeof buildServer> | undefined;
afterEach(async () => {
  await srv?.app.close();
  srv = undefined;
});

/** A real listening daemon (the job's Atlas tools call it over loopback); boards need no scan. */
async function setup() {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-bagent-')), 'shop');
  mkdirSync(root);
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-bagent-data-'));
  const db = openDb(':memory:');
  migrate(db);
  let port = 0;
  srv = buildServer({
    token,
    db,
    dataDir,
    port: () => port,
    designAgent: { secretTool: false, env: { PATH: '/nonexistent' } },
  });
  await srv.app.listen({ host: '127.0.0.1', port: 0 });
  port = (srv.app.server.address() as { port: number }).port;
  const events: BusMessage[] = [];
  srv.bus.subscribe((m) => events.push(m));
  const s = srv;
  const req = async (method: string, url: string, payload?: unknown) => {
    const r = await s.app.inject({
      method: method as 'GET',
      url,
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` },
      payload: payload as object,
    });
    return { status: r.statusCode, body: r.body ? (r.json() as any) : undefined };
  };
  const reg = (await req('POST', '/api/v1/projects', { rootPath: root })).body;
  const projectId = reg.project.id as string;
  const jobsUrl = `/api/v1/projects/${projectId}/design/jobs`;
  const run = async (body: Record<string, unknown>) => {
    const r = await req('POST', jobsUrl, { runtime: 'mock', ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await s.designJobs.idle(projectId);
    return (await req('GET', `${jobsUrl}/${r.body.id}`)).body;
  };
  const template = async () =>
    (
      await req('POST', `/api/v1/projects/${projectId}/boards`, {
        name: 'Shortener',
        source: 'template',
        templateId: 'url-shortener',
      })
    ).body;
  const board = async (id: string) => (await req('GET', `/api/v1/boards/${id}`)).body;
  return { db, req, events, projectId, jobsUrl, run, template, board, srv: s };
}

const proposed = (doc: any) =>
  [
    ...Object.values(doc.components),
    ...Object.values(doc.connections),
    ...doc.scenarios,
    ...doc.doc.items,
  ].filter((i: any) => i.status === 'proposed') as any[];

describe('design-board agent jobs (D03c)', () => {
  it('drafts a new board from a prompt with the mock: everything proposed, recorded as a run', async () => {
    const t = await setup();
    const job = await t.run({ kind: 'draft-board', prompt: 'Design a URL shortener like bitly' });
    expect(job).toMatchObject({ state: 'succeeded', kind: 'draft-board', model: 'mock-design' });
    expect(job.boardId).toMatch(/^brd_/);
    const b = await t.board(job.boardId);
    expect(b).toMatchObject({ name: 'URL shortener', source: 'prompt' });
    const comps = Object.values(b.document.components) as any[];
    expect(comps.length).toBe(10);
    expect(comps.every((c) => c.status === 'proposed' && c.id.startsWith('agent-'))).toBe(true);
    expect(comps[0].origin).toEqual({ author: 'agent', name: 'mock-design', jobId: job.id });
    expect(job.proposedBoardItems).toBe(proposed(b.document).length);

    // the done event carries the board; the run has no snapshot (boards are design-first)
    const done = t.events.find((e) => e.type === 'design.job' && (e.data as any).type === 'done');
    expect(done?.data).toMatchObject({
      boardId: job.boardId,
      proposedBoardItems: job.proposedBoardItems,
    });
    const run = (await t.req('GET', `/api/v1/runs/${job.runId}`)).body;
    expect(run.run).toMatchObject({ adapter: 'design-agent', status: 'succeeded' });
    expect(run.run.snapshotId).toBeUndefined();
    expect(run.run.environmentSummary.promptTemplateVersion).toBe('board-v1');
    const tools = run.events
      .filter((e: any) => e.type === 'tool.call.completed')
      .map((e: any) => [e.payload.tool, e.payload.accepted]);
    expect(tools).toContainEqual(['atlas_create_board', expect.any(Number)]);

    // no keyword match: a generic three-tier draft named from the prompt
    const generic = await t.run({ kind: 'draft-board', prompt: 'design a recipe planner.' });
    expect((await t.board(generic.boardId)).name).toBe('Recipe planner');
  });

  it('critique proposes pinned risk items; review accepts and rejects them (audited)', async () => {
    const t = await setup();
    const b = await t.template();
    const job = await t.run({ kind: 'critique-board', boardId: b.id });
    expect(job).toMatchObject({ state: 'succeeded', boardId: b.id });
    const doc = (await t.board(b.id)).document;
    const risks = doc.doc.items.filter(
      (i: any) => i.status === 'proposed' && i.section === 'risks',
    );
    expect(risks.length).toBeGreaterThan(0);
    expect(risks.some((r: any) => /^\[Security edge\]/.test(r.text))).toBe(true);
    expect(
      risks.every((r: any) => r.pins.length > 0 && r.pins.every((p: string) => doc.components[p])),
    ).toBe(true);
    expect(job.proposedBoardItems).toBeGreaterThan(0);
    // active template items are untouched
    expect(Object.values(doc.components).every((c: any) => c.status === 'active')).toBe(true);

    const [keep, drop] = [risks[0].id, risks.at(-1).id];
    const r = await t.req('POST', `/api/v1/boards/${b.id}/review`, {
      accept: [keep],
      reject: keep === drop ? [] : [drop],
    });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toEqual([keep]);
    const after = (await t.board(b.id)).document.doc.items;
    expect(after.find((i: any) => i.id === keep)).toMatchObject({
      status: 'active',
      origin: { author: 'agent', jobId: job.id },
    });
    if (keep !== drop) expect(after.find((i: any) => i.id === drop).status).toBe('rejected');
    expect(
      t.events.some(
        (e) => e.type === 'design.board.changed' && (e.data as any).action === 'reviewed',
      ),
    ).toBe(true);
    const audit = t.db
      .prepare("SELECT kind, origin, accepted FROM proposals WHERE kind = 'board-review'")
      .all<{ kind: string; origin: string; accepted: number }>();
    expect(audit).toEqual([{ kind: 'board-review', origin: 'human', accepted: 1 }]);
    // an active item cannot be reviewed again
    const again = await t.req('POST', `/api/v1/boards/${b.id}/review`, { reject: [keep] });
    expect(again.body.ignored).toEqual([{ id: keep, reason: 'item is active, not proposed' }]);
    expect((await t.req('POST', `/api/v1/boards/${b.id}/review`, {})).status).toBe(400);
  });

  it('explains a scenario, fills the doc, proposes a variant board and writes an implementation plan', async () => {
    const t = await setup();
    const b = await t.template();
    const ex = await t.run({ kind: 'explain-scenario', boardId: b.id, scenarioId: 's1' });
    expect(ex.state).toBe('succeeded');
    expect(ex.result).toMatch(/Redirect a short link/);
    expect(ex.result).toMatch(/Web app → Load balancer, over HTTP, synchronously/);

    const fill = await t.run({ kind: 'fill-doc', boardId: b.id });
    const items = (await t.board(b.id)).document.doc.items.filter(
      (i: any) => i.status === 'proposed',
    );
    expect(fill.proposedBoardItems).toBe(items.length);
    expect(items.map((i: any) => i.section)).toEqual(
      expect.arrayContaining(['requirements', 'estimates', 'api', 'data-model']),
    );

    const v = await t.run({ kind: 'variant-board', boardId: b.id });
    expect(v.boardId).not.toBe(b.id);
    const vb = await t.board(v.boardId);
    expect(vb.name).toMatch(/^Shortener — variant: /);
    expect(vb.source).toBe('prompt');
    expect(proposed(vb.document).length).toBeGreaterThan(10);

    const plan = await t.run({ kind: 'implementation-plan', boardId: b.id });
    expect(plan.result).toMatch(/^# Implementation plan: Shortener/);
    expect(plan.result).toMatch(/### T1 — /);
    expect(plan.result).toMatch(/\*\*Acceptance criteria\*\*/);
    expect(plan.result).toMatch(/## Agent brief\n\n```text/);
    expect((await t.board(b.id)).document.doc.plan).toBe(plan.result);
    // the plan comes back from the run record too (e.g. after a restart)
    const run = (await t.req('GET', `/api/v1/runs/${plan.runId}`)).body;
    const enrich = run.events.find((e: any) => e.type === 'model.enrichment');
    expect(enrich.payload.output.text).toBe(plan.result);
  });

  it('gates non-mock runtimes on consent, validates board requests, keeps only the running job id', async () => {
    const t = await setup();
    const b = await t.template();
    const denied = await t.req('POST', t.jobsUrl, {
      kind: 'critique-board',
      runtime: 'claude-code',
      boardId: b.id,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('consent_required');
    const api = await t.req('POST', t.jobsUrl, {
      kind: 'draft-board',
      runtime: 'anthropic-api',
      prompt: 'x',
    });
    expect(api.status).toBe(403);

    expect(
      (await t.req('POST', t.jobsUrl, { kind: 'critique-board', runtime: 'mock' })).body.detail,
    ).toBe('boardId is required');
    expect(
      (await t.req('POST', t.jobsUrl, { kind: 'draft-board', runtime: 'mock' })).body.detail,
    ).toBe('prompt is required');
    expect(
      (
        await t.req('POST', t.jobsUrl, {
          kind: 'critique-board',
          runtime: 'mock',
          boardId: `brd_${'0'.repeat(32)}`,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.req('POST', t.jobsUrl, {
          kind: 'explain-scenario',
          runtime: 'mock',
          boardId: b.id,
          scenarioId: 'nope',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.req('POST', t.jobsUrl, {
          kind: 'draft-board',
          runtime: 'mock',
          prompt: 'x'.repeat(4001),
        })
      ).status,
    ).toBe(400);
    // D02 kinds still need their snapshot
    expect(
      (await t.req('POST', t.jobsUrl, { kind: 'generate', runtime: 'mock' })).body.detail,
    ).toBe('snapshotId is required');

    // a client cannot attribute proposals to a job that is not running
    const r = await t.req('POST', `/api/v1/boards/${b.id}/proposals`, {
      spec: {
        components: [{ id: 'x', type: 'cache', label: 'X' }],
        connections: [{ from: 'x', to: 'ghost' }],
      },
      origin: { name: 'someone', jobId: `djb_${'1'.repeat(32)}` },
    });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toEqual([{ kind: 'component', id: 'agent-x', specId: 'x' }]);
    expect(r.body.rejected[0].reasons).toEqual(['unknown component "ghost" (to)']);
    const c = (await t.board(b.id)).document.components['agent-x'];
    expect(c).toMatchObject({ status: 'proposed', origin: { author: 'agent', name: 'someone' } });
    expect(c.origin.jobId).toBeUndefined();

    const spec = (await t.req('GET', `/api/v1/boards/${b.id}/spec`)).body;
    expect(spec.spec.components.length).toBe(11);
    expect(JSON.stringify(spec)).not.toMatch(/"scene"|elementIds/);
  });
});
