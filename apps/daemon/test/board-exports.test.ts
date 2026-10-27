/* eslint-disable @typescript-eslint/no-explicit-any -- API JSON */
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '@atlas/store';
import type { BusMessage } from '../src/events.ts';
import { buildServer } from '../src/server.ts';

const token = 'e'.repeat(64);
const port = 47996;
const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };

const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
});

async function setup(fixture?: string) {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-board-exports-')), 'svc');
  if (fixture)
    cpSync(new URL(`../../../fixtures/${fixture}`, import.meta.url).pathname, root, {
      recursive: true,
    });
  else mkdirSync(root);
  const db = openDb(':memory:');
  migrate(db);
  const srv = buildServer({ token, db, dataDir: '/tmp/x', port: () => port });
  servers.push(srv);
  const events: BusMessage[] = [];
  srv.bus.subscribe((m) => events.push(m));
  const req = async (method: string, url: string, payload?: unknown) => {
    const r = await srv.app.inject({
      method: method as 'GET',
      url,
      headers,
      payload: payload as object,
    });
    return {
      status: r.statusCode,
      type: String(r.headers['content-type'] ?? ''),
      text: r.body,
      body: (r.headers['content-type'] ?? '').toString().includes('json') ? r.json() : undefined,
    } as { status: number; type: string; text: string; body: any };
  };
  const reg = (await req('POST', '/api/v1/projects', { rootPath: root })).body;
  const wt = reg.worktree.id as string;
  const scan = async () => {
    await req('POST', `/api/v1/worktrees/${wt}/scans`);
    await srv.jobs.idle();
    return (await req('GET', `/api/v1/worktrees/${wt}/snapshot`)).body.snapshot.id as string;
  };
  return { req, events, scan, projectId: reg.project.id as string };
}

describe('design board exports and from-code import (D03 wave 1b)', () => {
  it('exports a template board as a Markdown design doc', async () => {
    const { req, projectId } = await setup();
    const b = (
      await req('POST', `/api/v1/projects/${projectId}/boards`, {
        name: 'Shortener',
        source: 'template',
        templateId: 'url-shortener',
      })
    ).body;
    const md = await req('GET', `/api/v1/boards/${b.id}/export/markdown`);
    expect(md.status).toBe(200);
    expect(md.type).toContain('text/markdown');
    const t = md.text;
    expect(t.startsWith('# Shortener\n')).toBe(true);
    expect(t).toContain('Create short links and redirect');
    expect(t).toContain('## Components');
    expect(t).toMatch(/\| Shortener API \| Service \| Scaling: horizontal, Instances: 4/);
    expect(t).toContain('## Connections');
    expect(t).toMatch(/\| Shortener API \| Links DB \| SQL \| sync \|/);
    expect(t).toContain('### Redirect a short link');
    expect(t).toContain('1. Browser requests GET /{code}. — _Web app → Load balancer');
    expect(t).toContain('```mermaid\nsequenceDiagram');
    expect(t).toContain('  p1->>p2: GET /{code}, POST /links (HTTP)');
    expect(t).toContain('  p3->>p4: code → url (other)');
    expect(t).toContain('  p3-)p6: click.recorded (Kafka)');

    // mermaid-breaking characters in payloads are escaped once (one pass, no "#35#59;")
    const doc = structuredClone(b.document);
    doc.connections.c2.payload = 'C# issue #42; v2: "x" <y>';
    const saved = await req('PATCH', `/api/v1/boards/${b.id}`, { document: doc, revision: 0 });
    expect(saved.status).toBe(200);
    const t2 = (await req('GET', `/api/v1/boards/${b.id}/export/markdown`)).text;
    expect(t2).toContain('  p1->>p2: C#35; issue #35;42#59; v2#58; #quot;x#quot; #lt;y#gt; (HTTP)');
    // the Markdown table escapes pipes only; the raw text stays readable there
    expect(t2).toContain('| C# issue #42; v2: "x" <y> |');
    expect(t).toContain('## Capacity estimates');
    expect(t).toContain('## Bottlenecks & failure modes');
    expect(t).toMatch(/- Hot links can thrash .* _\(Redirect cache, Links DB\)_/);

    expect((await req('GET', `/api/v1/boards/brd_${'0'.repeat(32)}/export/markdown`)).status).toBe(
      404,
    );
    expect((await req('GET', '/api/v1/boards/nope/export/markdown')).status).toBe(404);
  });

  it('refuses a from-code import before any scan', async () => {
    const { req, projectId } = await setup();
    expect((await req('GET', `/api/v1/projects/${projectId}/boards/from-code`)).body).toEqual({
      available: false,
    });
    const r = await req('POST', `/api/v1/projects/${projectId}/boards/from-code`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('no_snapshot');
    expect(
      (await req('POST', `/api/v1/projects/${projectId}/boards/from-code`, { snapshotId: 'x' }))
        .status,
    ).toBe(400);
  });

  it('imports the derived design lens of a scanned project as a faded "as built" board', async () => {
    const { req, events, scan, projectId } = await setup('ts-web-service');
    const snapshotId = await scan();
    expect((await req('GET', `/api/v1/projects/${projectId}/boards/from-code`)).body).toEqual({
      available: true,
      snapshotId,
    });
    const r = await req('POST', `/api/v1/projects/${projectId}/boards/from-code`, {});
    expect(r.status).toBe(201);
    const b = r.body;
    expect(b).toMatchObject({ source: 'code', name: 'As built (from code)', revision: 0 });
    const comps = Object.values(b.document.components) as any[];
    expect(comps.length).toBeGreaterThan(1);
    for (const c of comps) {
      expect(c.origin.author).toBe('code');
      expect(c.elementIds).toEqual([]);
    }
    // archetypes map to component types; code entities are kept as hints
    expect(comps.some((c) => c.type === 'service' || c.type === 'web-client')).toBe(true);
    expect(comps.some((c) => c.entityIds.length > 0 && c.entityIds[0].startsWith('ent_'))).toBe(
      true,
    );
    const conns = Object.values(b.document.connections) as any[];
    expect(conns.length).toBeGreaterThan(0);
    // flow labels become protocols (and payloads when they say more than the protocol)
    const label = (id: string) => b.document.components[id].label;
    expect(conns.find((k) => label(k.from) === 'web' && label(k.to) === 'api')).toMatchObject({
      protocol: 'HTTP',
      mode: 'sync',
    });
    expect(
      conns.find((k) => label(k.from) === 'web' && label(k.to) === 'api').payload,
    ).toBeUndefined();
    expect(conns.find((k) => label(k.from) === 'api' && label(k.to) === 'db')).toMatchObject({
      protocol: 'SQL',
      payload: 'reads/writes',
    });
    expect(conns.find((k) => k.payload === 'enqueue')).toMatchObject({
      mode: 'async',
      direction: 'one-way',
    });
    expect(comps.find((c) => c.label === 'db')?.type).toBe('sql-db');
    expect(comps.find((c) => c.label === 'worker')?.type).toBe('worker');
    for (const k of conns) {
      expect(b.document.components[k.from]).toBeDefined();
      expect(b.document.components[k.to]).toBeDefined();
      expect(k.origin.author).toBe('code');
    }
    expect(b.document.frames).toHaveLength(1);
    expect(b.document.frames[0].label).toMatch(/^As built \(from code, \d{4}-\d{2}-\d{2}\)$/);
    expect(b.document.frames[0].componentIds).toHaveLength(comps.length);
    expect(b.document.scene.elements).toEqual([]);
    expect(events.some((e) => e.type === 'design.board.changed')).toBe(true);

    // an explicit snapshot of another project is refused
    const other = await setup();
    const bad = await other.req('POST', `/api/v1/projects/${other.projectId}/boards/from-code`, {
      snapshotId,
    });
    expect(bad.status).toBe(400);
  });
});
