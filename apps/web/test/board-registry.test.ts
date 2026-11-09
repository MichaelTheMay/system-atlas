import { describe, expect, it } from 'vitest';
import { emptyBoardDocument, type BoardDocument, type Component } from '@atlas/schema';
import {
  badgeLines,
  componentBadges,
  connectionLabelText,
  newTombstones,
  reconcile,
  selectionFor,
  type ReconcileContext,
} from '../src/boards/registry.ts';
import type { AtlasTag, SceneElementLike } from '../src/boards/tags.ts';

/** A drawn component: box + bound label + icon, all tagged, as `renderComponent` makes them. */
function drawn(id: string, label: string, group = `g-${id}`): SceneElementLike[] {
  const tag = (role: AtlasTag['role']) => ({ atlas: { kind: 'component', id, role } });
  return [
    { id: `cmp-${id}`, type: 'rectangle', version: 1, groupIds: [group], customData: tag('box') },
    {
      id: `cmp-${id}-label`,
      type: 'text',
      version: 1,
      groupIds: [group],
      containerId: `cmp-${id}`,
      text: label,
      originalText: label,
      customData: tag('label'),
    },
    { id: `cmp-${id}-icon`, type: 'image', version: 1, groupIds: [group], customData: tag('icon') },
  ];
}
const component = (id: string, label: string, extra: Partial<Component> = {}): Component => ({
  id,
  type: 'service',
  label,
  props: {},
  entityIds: [],
  origin: { author: 'user' },
  status: 'active',
  elementIds: [`cmp-${id}`, `cmp-${id}-label`, `cmp-${id}-icon`],
  ...extra,
});
function board(): BoardDocument {
  const doc = emptyBoardDocument();
  doc.components = { api: component('api', 'API'), db: component('db', 'DB', { type: 'sql-db' }) };
  doc.connections = {
    k1: {
      id: 'k1',
      from: 'api',
      to: 'db',
      mode: 'sync',
      direction: 'request-response',
      origin: { author: 'user' },
      status: 'active',
      elementId: 'con-k1',
    },
  };
  doc.scenarios = [
    {
      id: 's1',
      name: 'Read',
      steps: [{ id: 'st1', connectionId: 'k1', text: 'query' }],
      origin: { author: 'user' },
      status: 'active',
    },
  ];
  doc.doc.items = [
    {
      id: 'd1',
      section: 'risks',
      text: 'DB is a SPOF',
      pins: ['db', 'k1'],
      origin: { author: 'user' },
      status: 'active',
    },
  ];
  return doc;
}
const arrow = (id: string, from: string, to: string, tag?: string): SceneElementLike => ({
  id,
  type: 'arrow',
  version: 1,
  startBinding: { elementId: from },
  endBinding: { elementId: to },
  ...(tag ? { customData: { atlas: { kind: 'connection', id: tag } } } : {}),
});
function ctx(): ReconcileContext {
  let n = 0;
  return {
    tombstones: newTombstones(),
    busyElementIds: new Set(),
    newId: (kind) => `${kind}-${++n}`,
  };
}
const scene = () => [
  ...drawn('api', 'API'),
  ...drawn('db', 'DB'),
  arrow('con-k1', 'cmp-api', 'cmp-db', 'k1'),
];

describe('board registry ↔ scene reconciliation (D03 wave 1a)', () => {
  it('is a no-op when registry and scene agree', () => {
    const r = reconcile(board(), scene(), ctx());
    expect(r.changed).toBe(false);
    expect(r.deleteElementIds).toEqual([]);
    expect(r.retag).toEqual([]);
  });

  it('deleting a component box removes it, its leftover parts, its connections and every reference', () => {
    const els = scene().map((e) => (e.id === 'cmp-db' ? { ...e, isDeleted: true } : e));
    const c = ctx();
    const r = reconcile(board(), els, c);
    expect(r.changed).toBe(true);
    expect(Object.keys(r.doc.components)).toEqual(['api']);
    expect(r.doc.connections).toEqual({});
    expect(r.deleteElementIds.sort()).toEqual(['cmp-db-icon', 'cmp-db-label', 'con-k1'].sort());
    expect(r.doc.scenarios[0]!.steps).toEqual([]);
    expect(r.doc.doc.items[0]!.pins).toEqual([]);
    // tombstoned for undo
    expect(c.tombstones.components.get('db')?.label).toBe('DB');
    expect(c.tombstones.connections.get('k1')?.from).toBe('api');
  });

  it('undo of a delete brings the component and its connection back from the tombstones', () => {
    const c = ctx();
    const gone = reconcile(
      board(),
      scene().map((e) =>
        e.id.startsWith('cmp-db') || e.id === 'con-k1' ? { ...e, isDeleted: true } : e,
      ),
      c,
    );
    const back = reconcile(gone.doc, scene(), c);
    expect(back.doc.components.db?.type).toBe('sql-db');
    expect(back.doc.connections.k1?.elementId).toBe('con-k1');
    expect(back.refreshComponentIds).toContain('db');
    expect(c.tombstones.components.size).toBe(0);
  });

  it('a label edit on the canvas renames the component (first line, wrap-free text)', () => {
    const els = scene().map((e) =>
      e.id === 'cmp-api-label'
        ? { ...e, text: 'Orders\nAPI', originalText: 'Orders API\nsecond line' }
        : e,
    );
    expect(reconcile(board(), els, ctx()).doc.components.api?.label).toBe('Orders API');
    // not while it is being typed
    const busy = { ...ctx(), busyElementIds: new Set(['cmp-api-label']) };
    expect(reconcile(board(), els, busy).changed).toBe(false);
  });

  it('an arrow drawn between two components becomes a tagged connection with its text as label', () => {
    const els = [
      ...scene(),
      arrow('a2', 'cmp-db', 'cmp-api-icon'),
      { id: 't2', type: 'text', version: 1, containerId: 'a2', originalText: 'replication lag' },
      arrow('a3', 'cmp-db', 'somewhere'), // dangling: ignored
    ];
    const r = reconcile(board(), els, ctx());
    const k = Object.values(r.doc.connections).find((x) => x.elementId === 'a2')!;
    expect(k).toMatchObject({ from: 'db', to: 'api', mode: 'sync', label: 'replication lag' });
    expect(r.retag).toEqual([{ elementId: 'a2', tag: { kind: 'connection', id: k.id } }]);
    expect(Object.values(r.doc.connections).some((x) => x.elementId === 'a3')).toBe(false);
    // still being drawn: not yet
    const busy = { ...ctx(), busyElementIds: new Set(['a2']) };
    expect(Object.keys(reconcile(board(), els, busy).doc.connections)).toEqual(['k1']);
  });

  it('deleting an arrow removes its connection; re-pointing it updates from/to', () => {
    const gone = reconcile(
      board(),
      scene().map((e) => (e.id === 'con-k1' ? { ...e, isDeleted: true } : e)),
      ctx(),
    );
    expect(gone.doc.connections).toEqual({});
    expect(gone.doc.components.db).toBeDefined();
    const repointed = reconcile(
      board(),
      scene().map((e) => (e.id === 'con-k1' ? arrow('con-k1', 'cmp-db', 'cmp-api', 'k1') : e)),
      ctx(),
    );
    expect(repointed.doc.connections.k1).toMatchObject({ from: 'db', to: 'api' });
  });

  it('a pasted copy of a component becomes a new component with its parts re-tagged', () => {
    const copy = drawn('api', 'API', 'g-copy').map((e) => ({ ...e, id: `copy-${e.id}` }));
    for (const e of copy) if (e.containerId) e.containerId = 'copy-cmp-api';
    const r = reconcile(board(), [...scene(), ...copy], ctx());
    const clone = Object.values(r.doc.components).find((c) => c.id !== 'api' && c.label === 'API')!;
    expect(clone.elementIds[0]).toBe('copy-cmp-api');
    expect(r.retag.map((t) => t.elementId).sort()).toEqual(copy.map((e) => e.id).sort());
    expect(r.doc.components.api?.elementIds[0]).toBe('cmp-api');
  });

  it('frames: drawn frames are adopted, deleted ones dropped, membership follows the scene', () => {
    const doc = board();
    doc.frames = [{ id: 'f1', label: 'Core', componentIds: [], elementId: 'frm-f1' }];
    const els = [
      ...scene().map((e) => (e.id === 'cmp-api' ? { ...e, frameId: 'frm-f1' } : e)),
      { id: 'frm-f1', type: 'frame', version: 1, name: 'Core services' },
      { id: 'new-frame', type: 'frame', version: 1, name: null },
    ];
    const r = reconcile(doc, els as SceneElementLike[], ctx());
    expect(r.doc.frames[0]).toMatchObject({
      id: 'f1',
      label: 'Core services',
      componentIds: ['api'],
    });
    expect(r.doc.frames[1]).toMatchObject({ label: 'Frame', elementId: 'new-frame' });
    const dropped = reconcile(r.doc, scene(), ctx());
    expect(dropped.doc.frames).toEqual([]);
  });

  it('maps the Excalidraw selection to one component or one connection', () => {
    const els = scene();
    expect(selectionFor(els, { 'cmp-api': true, 'cmp-api-label': true }).componentId).toBe('api');
    expect(selectionFor(els, { 'con-k1': true }).connectionId).toBe('k1');
    const both = selectionFor(els, { 'cmp-api': true, 'cmp-db': true });
    expect(both.componentId).toBeUndefined();
    expect(both.elementIds).toEqual(['cmp-api', 'cmp-db']);
  });
});

describe('badges and labels', () => {
  it('shows set properties in catalog order, readable', () => {
    expect(
      componentBadges({
        type: 'sql-db',
        props: { replication: 'primary-replica', engine: 'postgres', sizeGb: 500, extra: 'x' },
      }),
    ).toEqual(['postgres', 'primary-replica', '500 GB', 'extra: x']);
    expect(componentBadges({ type: 'service', props: { stateful: true, instances: 4 } })).toEqual([
      'instances 4',
      'stateful',
    ]);
    expect(badgeLines(['horizontal', 'instances 4', 'p99 < 100 ms'])).toEqual([
      'horizontal · instances 4',
      'p99 < 100 ms',
    ]);
  });

  it('labels a connection payload · protocol · volume, on two lines when long', () => {
    expect(connectionLabelText({ payload: 'NextId', protocol: 'gRPC' })).toBe('NextId · gRPC');
    expect(
      connectionLabelText({
        payload: 'GET /{code}, POST /links',
        protocol: 'HTTP',
        volume: '~10k rps',
      }),
    ).toBe('GET /{code}, POST /links\nHTTP · ~10k rps');
    expect(connectionLabelText({ label: 'replicates', payload: 'wal' })).toBe('replicates');
    expect(connectionLabelText({})).toBe('');
  });
});
