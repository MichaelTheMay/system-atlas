import { describe, expect, it } from 'vitest';
import {
  BOARD_TEMPLATES,
  BoardSpec,
  COMPONENT_CATALOG,
  componentTypeInfo,
  ComponentType,
  DesignBoard,
  emptyBoardDocument,
  newId,
} from '../src/index.ts';

describe('design boards contract (D03)', () => {
  it('every catalog type is unique and covered by the enum', () => {
    const types = COMPONENT_CATALOG.map((c) => c.type);
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual([...ComponentType.options].sort());
    for (const c of COMPONENT_CATALOG)
      for (const p of c.properties)
        if (p.kind === 'select') expect(p.options?.length, `${c.type}.${p.key}`).toBeGreaterThan(1);
  });

  it('templates are valid specs whose connections and pins reference their components', () => {
    for (const tpl of BOARD_TEMPLATES) {
      const spec = BoardSpec.parse(tpl.spec);
      const ids = new Set(spec.components.map((c) => c.id));
      for (const k of spec.connections) {
        expect(ids.has(k.from), `${tpl.id} ${k.id} from`).toBe(true);
        expect(ids.has(k.to), `${tpl.id} ${k.id} to`).toBe(true);
      }
      const conns = new Set(spec.connections.map((k) => k.id));
      for (const s of spec.scenarios)
        for (const st of s.steps)
          expect(
            (st.connectionId && conns.has(st.connectionId)) ||
              (st.componentId && ids.has(st.componentId)),
            `${tpl.id} ${s.id}/${st.id}`,
          ).toBe(true);
      for (const item of spec.doc.items)
        for (const pin of item.pins) expect(ids.has(pin) || conns.has(pin)).toBe(true);
      // containment: a parent is a boundary (container) type of the same spec, never itself
      const byId = new Map(spec.components.map((c) => [c.id, c]));
      for (const c of spec.components)
        if (c.parentId) {
          expect(c.parentId, `${tpl.id} ${c.id} parent`).not.toBe(c.id);
          expect(
            componentTypeInfo(byId.get(c.parentId)?.type ?? 'box').container,
            `${tpl.id} ${c.id} parent ${c.parentId} is a container`,
          ).toBe(true);
        }
      for (const f of spec.frames)
        for (const id of f.componentIds) expect(ids.has(id), `${tpl.id} ${f.id}/${id}`).toBe(true);
      expect(new Set(spec.components.map((c) => c.id)).size).toBe(spec.components.length);
    }
  });

  it('ships the starter templates, each a complete design (components, flows, scenario, doc, frames)', () => {
    expect(BOARD_TEMPLATES.map((t) => t.id)).toEqual([
      'url-shortener',
      'chat',
      'social-feed',
      'payments',
      'upload-pipeline',
      'rag-app',
    ]);
    for (const tpl of BOARD_TEMPLATES) {
      const spec = BoardSpec.parse(tpl.spec);
      expect(spec.components.length, tpl.id).toBeGreaterThanOrEqual(8);
      expect(spec.components.length, tpl.id).toBeLessThanOrEqual(14);
      expect(spec.connections.length, tpl.id).toBeGreaterThan(0);
      expect(
        spec.scenarios.some((s) => s.steps.length > 0),
        tpl.id,
      ).toBe(true);
      expect(new Set(spec.doc.items.map((i) => i.section)).size, tpl.id).toBeGreaterThanOrEqual(4);
      expect(spec.frames.length, tpl.id).toBeGreaterThan(0);
      expect(tpl.description.length, tpl.id).toBeGreaterThan(20);
    }
    // at least one template exercises boundaries with children
    expect(BOARD_TEMPLATES.some((t) => t.spec.components.some((c) => c.parentId))).toBe(true);
  });

  it('a blank board document round-trips and rejects unknown component types', () => {
    const now = '2026-10-27T00:00:00.000Z';
    const board = DesignBoard.parse({
      id: newId('board'),
      projectId: newId('project'),
      name: 'Checkout',
      document: emptyBoardDocument(),
      source: 'blank',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    expect(board.document.components).toEqual({});
    const bad = DesignBoard.safeParse({
      ...board,
      document: {
        ...board.document,
        components: { x: { id: 'x', type: 'mainframe', label: 'Mainframe' } },
      },
    });
    expect(bad.success).toBe(false);
  });
});
