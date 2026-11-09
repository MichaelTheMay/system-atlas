/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '@atlas/store';
import type { BusMessage } from '../src/events.ts';
import { buildServer } from '../src/server.ts';

const token = 'b'.repeat(64);
const port = 47996;
const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };

let srv: ReturnType<typeof buildServer> | undefined;
afterEach(async () => {
  await srv?.app.close();
  srv = undefined;
});

async function setup() {
  const db = openDb(':memory:');
  migrate(db);
  srv = buildServer({ token, db, dataDir: '/tmp/x', port: () => port });
  const events: BusMessage[] = [];
  srv.bus.subscribe((m) => events.push(m));
  const req = async (method: string, url: string, payload?: unknown) => {
    const r = await srv!.app.inject({
      method: method as 'GET',
      url,
      headers,
      payload: payload as object,
    });
    return { status: r.statusCode, body: r.json() as any };
  };
  // boards are design-first: an empty folder is enough to own them
  const root = mkdtempSync(join(tmpdir(), 'atlas-boards-'));
  const reg = (await req('POST', '/api/v1/projects', { rootPath: root })).body;
  return { db, req, events, projectId: reg.project.id as string };
}

describe('design boards API (D03)', () => {
  it('creates a blank board, saves a scene with optimistic revisions, lists and deletes it', async () => {
    const { req, events, projectId } = await setup();
    const created = await req('POST', `/api/v1/projects/${projectId}/boards`, { name: 'Checkout' });
    expect(created.status).toBe(201);
    const b = created.body;
    expect(b).toMatchObject({ name: 'Checkout', source: 'blank', revision: 0 });
    expect(b.document.scene.elements).toEqual([]);

    const doc = {
      ...b.document,
      scene: { elements: [{ id: 'e1', type: 'rectangle' }], appState: {}, files: {} },
    };
    const saved = await req('PATCH', `/api/v1/boards/${b.id}`, { document: doc, revision: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(1);
    const stale = await req('PATCH', `/api/v1/boards/${b.id}`, { name: 'Old', revision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.current.revision).toBe(1);

    const list = (await req('GET', `/api/v1/projects/${projectId}/boards`)).body.boards;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: b.id, componentCount: 0 });
    expect(list[0].document).toBeUndefined();

    expect((await req('DELETE', `/api/v1/boards/${b.id}`)).body.deleted).toEqual([b.id]);
    expect((await req('GET', `/api/v1/boards/${b.id}`)).status).toBe(404);
    expect(
      events.filter((e) => e.type === 'design.board.changed').map((e) => e.data.action),
    ).toEqual(['created', 'updated', 'deleted']);
  });

  it('creates a board from a template with its registry filled and an empty scene', async () => {
    const { req, projectId } = await setup();
    const tpls = (await req('GET', '/api/v1/design/board-templates')).body.templates;
    expect(tpls.map((t: any) => t.id)).toContain('url-shortener');
    const r = await req('POST', `/api/v1/projects/${projectId}/boards`, {
      name: 'Shortener',
      source: 'template',
      templateId: 'url-shortener',
    });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.document.components).length).toBeGreaterThan(5);
    expect(r.body.document.components.cache).toMatchObject({
      type: 'cache',
      origin: { author: 'template' },
    });
    expect(r.body.document.scenarios[0].steps.length).toBeGreaterThan(2);
    expect(r.body.document.scene.elements).toEqual([]);
    expect(
      (
        await req('POST', `/api/v1/projects/${projectId}/boards`, {
          name: 'x',
          source: 'template',
          templateId: 'nope',
        })
      ).status,
    ).toBe(400);
  });

  it('nests internals boards at most three levels and deletes them with their parent', async () => {
    const { req, projectId } = await setup();
    const mk = async (name: string, parentBoardId?: string) =>
      req('POST', `/api/v1/projects/${projectId}/boards`, { name, parentBoardId });
    const l1 = (await mk('System')).body;
    const l2 = (await mk('Service internals', l1.id)).body;
    const l3 = (await mk('Module internals', l2.id)).body;
    expect(l3.parentBoardId).toBe(l2.id);
    expect((await mk('Too deep', l3.id)).status).toBe(400);
    const del = (await req('DELETE', `/api/v1/boards/${l1.id}`)).body.deleted;
    expect(del.sort()).toEqual([l1.id, l2.id, l3.id].sort());
    expect((await req('GET', `/api/v1/projects/${projectId}/boards`)).body.boards).toEqual([]);
  });

  it('rejects invalid documents and unknown projects', async () => {
    const { req, projectId } = await setup();
    const b = (await req('POST', `/api/v1/projects/${projectId}/boards`, { name: 'x' })).body;
    const bad = await req('PATCH', `/api/v1/boards/${b.id}`, {
      revision: 0,
      document: { ...b.document, components: { a: { id: 'a', type: 'mainframe', label: 'M' } } },
    });
    expect(bad.status).toBe(400);
    expect((await req('GET', `/api/v1/projects/proj_${'0'.repeat(32)}/boards`)).status).toBe(404);
  });
});
