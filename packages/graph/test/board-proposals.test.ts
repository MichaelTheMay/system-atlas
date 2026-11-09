import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOARD_TEMPLATES } from '@atlas/schema';
import {
  applyBoardProposal,
  boardItemsOfJob,
  boardSpecOf,
  createBoard,
  createProposedBoard,
  getBoard,
  listProposals,
  registerRoot,
  reviewBoardItems,
  setBoardPlan,
} from '../src/index.ts';
import { freshDb } from './helpers.ts';

const agent = { author: 'agent' as const, name: 'mock-design', jobId: `djb_${'a'.repeat(32)}` };

async function setup() {
  const db = freshDb();
  const root = mkdtempSync(join(tmpdir(), 'atlas-brdp-'));
  const { project } = await registerRoot(db, root);
  const r = createBoard(db, project.id, {
    name: 'Shop',
    source: 'template',
    templateId: 'url-shortener',
  });
  if (!r.ok) throw new Error(r.error);
  return { db, projectId: project.id, board: r.board };
}

describe('board proposals (D03c)', () => {
  it('merges a spec as proposed agent-… items, remapping refs and keeping active items untouched', async () => {
    const { db, board } = await setup();
    const before = structuredClone(board.document.components);
    const r = applyBoardProposal(
      db,
      board.id,
      {
        components: [
          { id: 'api', type: 'service', label: 'Second API' }, // same id as an active one
          { id: 'q', type: 'queue', label: 'Jobs' },
        ],
        connections: [
          { id: 'k1', from: 'api', to: 'q', protocol: 'AMQP', mode: 'async' }, // spec ids win
          { id: 'k2', from: 'db', to: 'q' }, // existing component
        ],
        doc: { items: [{ id: 'r1', section: 'risks', text: 'Queue may grow', pins: ['q', 'db'] }] },
      },
      agent,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rejected).toEqual([]);
    const ids = r.accepted.map((a) => a.id);
    expect(ids).toEqual(['agent-api', 'agent-q', 'agent-k1', 'agent-k2', 'agent-r1']);
    const doc = r.board.document;
    // the active "api" is exactly as it was
    expect(doc.components.api).toEqual(before.api);
    expect(doc.components['agent-api']).toMatchObject({ status: 'proposed', origin: agent });
    expect(doc.connections['agent-k1']).toMatchObject({ from: 'agent-api', to: 'agent-q' });
    expect(doc.connections['agent-k2']).toMatchObject({ from: 'db', to: 'agent-q' });
    expect(doc.doc.items.at(-1)).toMatchObject({ pins: ['agent-q', 'db'], status: 'proposed' });
    expect(r.board.revision).toBe(board.revision + 1);

    // a second proposal never collides with the first
    const again = applyBoardProposal(
      db,
      board.id,
      { components: [{ id: 'q', type: 'queue', label: 'Q2' }] },
      agent,
    );
    expect(again.ok && again.accepted[0]!.id).toBe('agent-q-2');
  });

  it('rejects dangling connections, steps and pins with reasons', async () => {
    const { db, board } = await setup();
    const r = applyBoardProposal(
      db,
      board.id,
      {
        components: [{ id: 'x', type: 'not-a-type', label: 'Bad' }],
        connections: [
          { id: 'k', from: 'api', to: 'ghost' },
          { id: 'k2', from: 'x', to: 'api' },
        ],
        scenarios: [{ id: 's', name: 'Flow', steps: [{ connectionId: 'nope', text: 'hop' }] }],
        doc: { items: [{ id: 'd', section: 'risks', text: 't', pins: ['ghost'] }] },
      },
      agent,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => [x.kind, x.specId])).toEqual([
      ['component', 'x'],
      ['connection', 'k'],
      ['connection', 'k2'],
      ['scenario', 's'],
      ['doc-item', 'd'],
    ]);
    expect(r.rejected[1]!.reasons).toEqual(['unknown component "ghost" (to)']);
    // nothing applied: same revision
    expect(getBoard(db, board.id)!.revision).toBe(board.revision);
  });

  it('review flips statuses, cascades, never changes active items, restyles the scene and audits', async () => {
    const { db, board, projectId } = await setup();
    const r = applyBoardProposal(
      db,
      board.id,
      {
        components: [
          { id: 'q', type: 'queue', label: 'Jobs' },
          { id: 'w', type: 'worker', label: 'Worker' },
        ],
        connections: [
          { id: 'k1', from: 'api', to: 'q', mode: 'async' },
          { id: 'k2', from: 'q', to: 'w' },
        ],
        doc: { items: [{ id: 'r', section: 'risks', text: 'risk', pins: ['api'] }] },
      },
      agent,
    );
    if (!r.ok) throw new Error(r.error);
    // pretend the web drew the proposals (dashed, faded)
    const doc = r.board.document;
    const el = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      type: 'rectangle',
      version: 1,
      strokeStyle: 'dashed',
      opacity: 60,
      ...extra,
    });
    doc.scene.elements = [
      el('e-q', { customData: { atlas: { kind: 'component', id: 'agent-q', proposed: true } } }),
      el('t-q', { type: 'text', containerId: 'e-q' }),
      el('tag-q', { type: 'text', customData: { atlas: { kind: 'proposal-tag', id: 'agent-q' } } }),
      el('e-w', {
        customData: { atlas: { kind: 'component', id: 'agent-w' } },
        boundElements: [{ id: 'a-k2', type: 'arrow' }],
      }),
      el('a-k1', { type: 'arrow', customData: { atlas: { kind: 'connection', id: 'agent-k1' } } }),
      el('a-k2', {
        type: 'arrow',
        customData: { atlas: { kind: 'connection', id: 'agent-k2' } },
        endBinding: { elementId: 'e-w' },
      }),
    ];
    db.prepare('UPDATE design_boards SET document = ? WHERE id = ?').run(
      JSON.stringify(doc),
      board.id,
    );

    const bad = reviewBoardItems(db, board.id, { accept: ['api'], reject: ['nope'] });
    expect(bad.ok && bad.ignored).toEqual([
      { id: 'api', reason: 'item is active, not proposed' },
      { id: 'nope', reason: 'unknown item' },
    ]);

    const rev = reviewBoardItems(db, board.id, {
      accept: ['agent-k1'],
      reject: ['agent-w', 'agent-r'],
    });
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;
    // accepting a connection accepts its proposed endpoint; rejecting a component takes its connections
    expect(rev.accepted.sort()).toEqual(['agent-k1', 'agent-q']);
    expect(rev.rejected.sort()).toEqual(['agent-k2', 'agent-r', 'agent-w']);
    const d = rev.board.document;
    expect(d.components['agent-q']).toMatchObject({ status: 'active', origin: agent });
    expect(d.components['agent-w']!.status).toBe('rejected');
    expect(d.components.api!.status).toBe('active');
    const els = Object.fromEntries(d.scene.elements.map((e) => [e.id as string, e]));
    expect(Object.keys(els).sort()).toEqual(['a-k1', 'e-q', 't-q']);
    expect(els['e-q']).toMatchObject({ strokeStyle: 'solid', opacity: 100, version: 2 });
    expect(els['t-q']).toMatchObject({ opacity: 100 });
    expect(els['a-k1']).toMatchObject({ strokeStyle: 'dashed', opacity: 100 }); // async stays dashed

    // reviewing again changes nothing
    const again = reviewBoardItems(db, board.id, { accept: ['agent-q'] });
    expect(again.ok && again.accepted).toEqual([]);

    const audit = listProposals(db, projectId).filter((p) => p.kind === 'board-review');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ origin: 'human', accepted: 2, rejected: 3 });
    expect((audit[0]!.detail as { rejected: { model?: string }[] }).rejected[0]!.model).toBe(
      'mock-design',
    );
  });

  it('drafts a whole new proposed board, reads back as a scene-free spec, finds job items and stores a plan', async () => {
    const { db, projectId } = await setup();
    const spec = BOARD_TEMPLATES[0]!.spec;
    const r = createProposedBoard(db, projectId, { name: 'Draft', spec }, agent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.board.source).toBe('prompt');
    expect(r.rejected).toEqual([]);
    const comps = Object.values(r.board.document.components);
    expect(comps).toHaveLength(spec.components.length);
    expect(comps.every((c) => c.status === 'proposed' && c.id.startsWith('agent-'))).toBe(true);
    expect(r.board.document.frames).toHaveLength(spec.frames.length);
    expect(r.board.document.doc.summary).toBe(spec.summary);

    const view = boardSpecOf(r.board.document, r.board.name);
    expect(view.title).toBe('Draft');
    expect(JSON.stringify(view)).not.toMatch(/elementId|"scene"/);
    expect(view.connections).toHaveLength(spec.connections.length);

    expect(boardItemsOfJob(db, projectId, agent.jobId)).toEqual([
      expect.objectContaining({ boardId: r.board.id, proposed: expect.any(Number) }),
    ]);
    const p = setBoardPlan(db, r.board.id, '# Plan');
    expect(p.ok && p.board.document.doc.plan).toBe('# Plan');
  });
});
