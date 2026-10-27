import { randomInt } from 'node:crypto';
import {
  BoardOrigin,
  BoardSpec,
  Component,
  Connection,
  DesignBoard,
  DocItem,
  newId,
  Scenario,
  ScenarioStep,
  type BoardDocument,
} from '@atlas/schema';
import type { Db } from '@atlas/store';
import type { z } from 'zod';
import { createBoard, getBoard, type BoardResult } from './boards.ts';

/**
 * Agent proposals on design boards (D03c). An agent never edits a board directly: what it
 * suggests is merged into the registry as `status: 'proposed'` entries under fresh `agent-…` ids,
 * so nothing a person drew (or accepted) is ever replaced. A person then accepts (→ `active`,
 * origin kept) or rejects (→ `rejected`, kept for the record) each entry; every review is audited
 * in the `proposals` table like D02 reviews. Boards are view data: nothing here touches facts.
 */
export type BoardOriginInput = z.infer<typeof BoardOrigin>;

export type ProposalItemKind = 'component' | 'connection' | 'scenario' | 'doc-item' | 'frame';
export interface ProposalAccepted {
  kind: ProposalItemKind;
  /** Id stored on the board. */
  id: string;
  /** Id the agent used in its spec. */
  specId: string;
}
export interface ProposalRejected {
  kind: ProposalItemKind;
  specId: string;
  reasons: string[];
}
export interface ProposalOutcome {
  board: DesignBoard;
  accepted: ProposalAccepted[];
  rejected: ProposalRejected[];
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown) => (typeof x === 'string' ? x : '');

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';

/** Every id already used on the board (components, connections, scenarios, steps, doc items, frames). */
function usedIds(doc: BoardDocument): Set<string> {
  const used = new Set<string>([...Object.keys(doc.components), ...Object.keys(doc.connections)]);
  for (const s of doc.scenarios) {
    used.add(s.id);
    for (const st of s.steps) used.add(st.id);
  }
  for (const i of doc.doc.items) used.add(i.id);
  for (const f of doc.frames) used.add(f.id);
  return used;
}

function freshId(base: string, used: Set<string>): string {
  const b = slug(base);
  const root = b.startsWith('agent-') ? b : `agent-${b}`;
  let id = root;
  for (let n = 2; used.has(id); n++) id = `${root}-${n}`;
  used.add(id);
  return id;
}

const issues = (e: z.ZodError) =>
  e.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'item'}: ${i.message}`);

/**
 * Merge an agent's (partial) BoardSpec into a board as proposals. Components, connections,
 * scenarios and doc items get new `agent-…` ids and `status: 'proposed'`; references inside the
 * spec are remapped, references to existing (non-rejected) board items are kept, and anything that
 * points at an unknown id is rejected with a reason. Existing entries are never modified.
 */
export function applyBoardProposal(
  db: Db,
  boardId: string,
  spec: unknown,
  origin: BoardOriginInput,
  opts: { frames?: boolean; summary?: boolean } = {},
): BoardResult<ProposalOutcome> {
  if (!isRec(spec)) return { ok: false, status: 400, error: 'spec must be an object' };
  const o = BoardOrigin.safeParse(origin);
  if (!o.success) return { ok: false, status: 400, error: 'invalid origin' };
  return db.transaction((): BoardResult<ProposalOutcome> => {
    const cur = getBoard(db, boardId);
    if (!cur) return { ok: false, status: 404, error: 'unknown_board' };
    const doc: BoardDocument = structuredClone(cur.document);
    const used = usedIds(doc);
    const accepted: ProposalAccepted[] = [];
    const rejected: ProposalRejected[] = [];
    const prov = { origin: o.data, status: 'proposed' as const };
    const live = (id: string) => {
      const c = doc.components[id];
      return c && c.status !== 'rejected' ? id : undefined;
    };

    // components first, so connections, steps and pins can point at them
    const compMap = new Map<string, string>();
    const specComps = arr(spec.components).filter(isRec);
    const pendingParents: [string, string][] = [];
    for (const raw of specComps) {
      const specId = str(raw.id) || str(raw.label) || 'component';
      const id = freshId(specId, used);
      const { parentId, ...rest } = raw;
      const parsed = Component.safeParse({
        ...rest,
        ...prov,
        id,
        elementIds: [],
        entityIds: [],
        internalsBoardId: undefined,
      });
      if (!parsed.success) {
        used.delete(id);
        rejected.push({ kind: 'component', specId, reasons: issues(parsed.error) });
        continue;
      }
      compMap.set(specId, id);
      doc.components[id] = parsed.data;
      if (typeof parentId === 'string') pendingParents.push([id, parentId]);
      accepted.push({ kind: 'component', id, specId });
    }
    const compRef = (ref: unknown) => {
      const r = str(ref);
      return compMap.get(r) ?? live(r);
    };
    for (const [id, parent] of pendingParents) {
      const p = compRef(parent);
      if (p && p !== id) doc.components[id] = { ...doc.components[id]!, parentId: p };
    }

    const conMap = new Map<string, string>();
    for (const raw of arr(spec.connections).filter(isRec)) {
      const specId = str(raw.id) || `${str(raw.from)}-${str(raw.to)}`;
      const from = compRef(raw.from);
      const to = compRef(raw.to);
      const reasons = [
        ...(from ? [] : [`unknown component "${str(raw.from)}" (from)`]),
        ...(to ? [] : [`unknown component "${str(raw.to)}" (to)`]),
      ];
      if (reasons.length) {
        rejected.push({ kind: 'connection', specId, reasons });
        continue;
      }
      const id = freshId(specId, used);
      const parsed = Connection.safeParse({ ...raw, ...prov, id, from, to, elementId: undefined });
      if (!parsed.success) {
        used.delete(id);
        rejected.push({ kind: 'connection', specId, reasons: issues(parsed.error) });
        continue;
      }
      conMap.set(specId, id);
      doc.connections[id] = parsed.data;
      accepted.push({ kind: 'connection', id, specId });
    }
    const conRef = (ref: unknown) => {
      const r = str(ref);
      const c = doc.connections[r];
      return conMap.get(r) ?? (c && c.status !== 'rejected' ? r : undefined);
    };

    for (const raw of arr(spec.scenarios).filter(isRec)) {
      const specId = str(raw.id) || str(raw.name) || 'scenario';
      const reasons: string[] = [];
      const steps = arr(raw.steps)
        .filter(isRec)
        .map((st, i) => {
          const connectionId = st.connectionId === undefined ? undefined : conRef(st.connectionId);
          const componentId = st.componentId === undefined ? undefined : compRef(st.componentId);
          if (st.connectionId !== undefined && !connectionId)
            reasons.push(`step ${i + 1}: unknown connection "${str(st.connectionId)}"`);
          if (st.componentId !== undefined && !componentId)
            reasons.push(`step ${i + 1}: unknown component "${str(st.componentId)}"`);
          return { text: st.text, connectionId, componentId };
        });
      if (reasons.length) {
        rejected.push({ kind: 'scenario', specId, reasons: reasons.slice(0, 5) });
        continue;
      }
      const id = freshId(specId, used);
      const parsed = Scenario.safeParse({
        name: raw.name,
        description: raw.description,
        ...prov,
        id,
        steps: steps.map((st) => ({ ...st, id: freshId(`${id}-step`, used) })),
      });
      if (!parsed.success || !parsed.data.steps.every((s) => ScenarioStep.safeParse(s).success)) {
        used.delete(id);
        rejected.push({
          kind: 'scenario',
          specId,
          reasons: parsed.success ? ['invalid step'] : issues(parsed.error),
        });
        continue;
      }
      doc.scenarios.push(parsed.data);
      accepted.push({ kind: 'scenario', id, specId });
    }

    const docSpec = isRec(spec.doc) ? spec.doc : {};
    for (const raw of arr(docSpec.items).filter(isRec)) {
      const specId = str(raw.id) || `${str(raw.section)}-item`;
      const pins: string[] = [];
      const reasons: string[] = [];
      for (const p of arr(raw.pins)) {
        const r = compRef(p) ?? conRef(p);
        if (r) pins.push(r);
        else reasons.push(`unknown pin "${str(p)}"`);
      }
      if (reasons.length) {
        rejected.push({ kind: 'doc-item', specId, reasons: reasons.slice(0, 5) });
        continue;
      }
      const id = freshId(specId, used);
      const parsed = DocItem.safeParse({ section: raw.section, text: raw.text, ...prov, id, pins });
      if (!parsed.success) {
        used.delete(id);
        rejected.push({ kind: 'doc-item', specId, reasons: issues(parsed.error) });
        continue;
      }
      doc.doc.items.push(parsed.data);
      accepted.push({ kind: 'doc-item', id, specId });
    }
    if (opts.summary && typeof docSpec.summary === 'string' && !doc.doc.summary)
      doc.doc.summary = docSpec.summary.slice(0, 4000);
    if (opts.summary && typeof spec.summary === 'string' && !doc.doc.summary)
      doc.doc.summary = spec.summary.slice(0, 4000);

    if (opts.frames)
      for (const raw of arr(spec.frames).filter(isRec)) {
        const specId = str(raw.id) || str(raw.label) || 'frame';
        const label = str(raw.label).trim().slice(0, 120);
        const componentIds = arr(raw.componentIds)
          .map(compRef)
          .filter((x): x is string => !!x);
        if (!label || !componentIds.length) {
          rejected.push({ kind: 'frame', specId, reasons: ['frame needs a label and components'] });
          continue;
        }
        const id = freshId(specId, used);
        doc.frames.push({ id, label, componentIds });
        accepted.push({ kind: 'frame', id, specId });
      }

    if (!accepted.length)
      return { ok: true, board: cur, accepted, rejected } as BoardResult<ProposalOutcome>;
    const next = DesignBoard.safeParse({
      ...cur,
      document: doc,
      revision: cur.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    if (!next.success)
      return { ok: false, status: 400, error: issues(next.error).join('; ') || 'board too large' };
    write(db, next.data);
    return { ok: true, board: next.data, accepted, rejected };
  });
}

function write(db: Db, b: DesignBoard) {
  db.prepare(
    'UPDATE design_boards SET name = ?, document = ?, revision = ?, updated_at = ? WHERE id = ?',
  ).run(b.name, JSON.stringify(b.document), b.revision, b.updatedAt, b.id);
}

/**
 * A new board drafted by an agent (`draft-board`, `variant-board`): an empty board with
 * `source: 'prompt'` and the whole spec merged as proposals (frames and summary included).
 */
export function createProposedBoard(
  db: Db,
  projectId: string,
  input: { name: string; spec: unknown; parentBoardId?: string },
  origin: BoardOriginInput,
): BoardResult<ProposalOutcome> {
  const created = createBoard(db, projectId, {
    name: input.name,
    source: 'prompt',
    ...(input.parentBoardId ? { parentBoardId: input.parentBoardId } : {}),
  });
  if (!created.ok) return created;
  const r = applyBoardProposal(db, created.board.id, input.spec, origin, {
    frames: true,
    summary: true,
  });
  if (!r.ok) db.prepare('DELETE FROM design_boards WHERE id = ?').run(created.board.id);
  return r;
}

// ------------------------------------------------------------------------------------- review

export interface ReviewOutcome {
  board: DesignBoard;
  accepted: string[];
  rejected: string[];
  /** Ids that were not proposed items of this board (active, already rejected, unknown). */
  ignored: { id: string; reason: string }[];
}

type AnyItem = { status: string; origin: BoardOriginInput };
function findItem(
  doc: BoardDocument,
  id: string,
): { kind: ProposalItemKind; item: AnyItem } | undefined {
  if (doc.components[id]) return { kind: 'component', item: doc.components[id] };
  if (doc.connections[id]) return { kind: 'connection', item: doc.connections[id] };
  const s = doc.scenarios.find((x) => x.id === id);
  if (s) return { kind: 'scenario', item: s };
  const d = doc.doc.items.find((x) => x.id === id);
  if (d) return { kind: 'doc-item', item: d };
  return undefined;
}

/**
 * Accept or reject proposed board items. Accept → `active` (origin kept, so the canvas can still
 * say "agent: <model>"); reject → `rejected` (kept for the audit trail, removed from the canvas).
 * Only `proposed` items change: active work is never touched. Accepting a connection or scenario
 * accepts the proposed components it needs; rejecting a component rejects its proposed
 * connections. The scene is restyled to match (solid when accepted, removed when rejected).
 */
export function reviewBoardItems(
  db: Db,
  boardId: string,
  input: { accept?: unknown; reject?: unknown },
): BoardResult<ReviewOutcome> {
  const ids = (x: unknown) =>
    [...new Set(arr(x).filter((v): v is string => typeof v === 'string' && v.length <= 64))].slice(
      0,
      2000,
    );
  const accept = ids(input.accept);
  const reject = ids(input.reject);
  if (!accept.length && !reject.length)
    return { ok: false, status: 400, error: 'nothing to review: pass accept and/or reject ids' };
  const both = accept.filter((a) => reject.includes(a));
  if (both.length)
    return { ok: false, status: 400, error: `both accepted and rejected: ${both.join(', ')}` };
  return db.transaction((): BoardResult<ReviewOutcome> => {
    const cur = getBoard(db, boardId);
    if (!cur) return { ok: false, status: 404, error: 'unknown_board' };
    const doc: BoardDocument = structuredClone(cur.document);
    const out = {
      accepted: [] as string[],
      rejected: [] as string[],
      ignored: [] as ReviewOutcome['ignored'],
    };
    const flip = (id: string, to: 'active' | 'rejected', explicit: boolean) => {
      const f = findItem(doc, id);
      if (!f) {
        if (explicit) out.ignored.push({ id, reason: 'unknown item' });
        return false;
      }
      if (f.item.status !== 'proposed') {
        if (explicit) out.ignored.push({ id, reason: `item is ${f.item.status}, not proposed` });
        return false;
      }
      f.item.status = to;
      (to === 'active' ? out.accepted : out.rejected).push(id);
      return true;
    };
    for (const id of accept) {
      if (!flip(id, 'active', true)) continue;
      const k = doc.connections[id];
      if (k) for (const end of [k.from, k.to]) flip(end, 'active', false);
      const s = doc.scenarios.find((x) => x.id === id);
      if (s)
        for (const st of s.steps) {
          if (st.componentId) flip(st.componentId, 'active', false);
          const sk = st.connectionId ? doc.connections[st.connectionId] : undefined;
          if (sk) {
            flip(sk.id, 'active', false);
            flip(sk.from, 'active', false);
            flip(sk.to, 'active', false);
          }
        }
    }
    for (const id of reject) {
      if (!flip(id, 'rejected', true)) continue;
      if (doc.components[id])
        for (const k of Object.values(doc.connections))
          if (k.from === id || k.to === id) flip(k.id, 'rejected', false);
    }
    if (!out.accepted.length && !out.rejected.length)
      return { ok: true, board: cur, ...out } as BoardResult<ReviewOutcome>;
    doc.scene = { ...doc.scene, elements: restyleScene(doc, out.accepted, out.rejected) };
    const next: DesignBoard = {
      ...cur,
      document: doc,
      revision: cur.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    write(db, next);
    audit(db, cur.projectId, {
      boardId,
      accepted: out.accepted.map((id) => describe(doc, id)),
      rejected: out.rejected.map((id) => describe(doc, id)),
    });
    return { ok: true, board: next, ...out };
  });
}

function describe(doc: BoardDocument, id: string) {
  const f = findItem(doc, id)!;
  return {
    id,
    kind: f.kind,
    author: f.item.origin.author,
    ...(f.item.origin.name ? { model: f.item.origin.name } : {}),
    ...(f.item.origin.jobId ? { jobId: f.item.origin.jobId } : {}),
  };
}

/** Same audit table as claim and D02 design reviews; boards are independent of snapshots. */
function audit(
  db: Db,
  projectId: string,
  body: { boardId: string; accepted: unknown[]; rejected: unknown[] },
) {
  const snap = db
    .prepare(
      "SELECT id FROM snapshots WHERE project_id = ? AND state IN ('ready','partial') ORDER BY published_at DESC LIMIT 1",
    )
    .get<{ id: string }>(projectId);
  db.prepare(
    'INSERT INTO proposals (id, project_id, snapshot_id, origin, kind, accepted, rejected, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    newId('proposal'),
    projectId,
    snap?.id ?? '',
    'human',
    'board-review',
    body.accepted.length,
    body.rejected.length,
    JSON.stringify({ action: 'board-review', ...body }),
    new Date().toISOString(),
  );
}

type El = Record<string, unknown> & { id: string };
const tagOf = (el: Rec) =>
  (isRec(el.customData) && isRec(el.customData.atlas) ? el.customData.atlas : undefined) as
    { kind?: string; id?: string; proposed?: boolean } | undefined;

/**
 * Restyle scene elements of reviewed items: accepted ones become solid and opaque (async
 * connections stay dashed), rejected ones leave the canvas with their bound labels and arrows.
 * Elements are opaque Excalidraw records: only `strokeStyle`, `opacity`, `boundElements`,
 * `version`/`versionNonce` and the `customData.atlas.proposed` flag are touched.
 */
export function restyleScene(doc: BoardDocument, accepted: string[], rejected: string[]): El[] {
  const els = doc.scene.elements.filter((e): e is El => typeof e.id === 'string');
  const ownerOf = (el: El): string | undefined => {
    const tag = tagOf(el);
    if (tag?.id && (tag.kind === 'component' || tag.kind === 'connection')) return tag.id;
    return undefined;
  };
  const elementsOf = (itemId: string): Set<string> => {
    const set = new Set<string>();
    const c = doc.components[itemId];
    for (const e of c?.elementIds ?? []) set.add(e);
    const k = doc.connections[itemId];
    if (k?.elementId) set.add(k.elementId);
    for (const el of els) if (ownerOf(el) === itemId) set.add(el.id);
    // labels bound to a container (rectangle text, arrow label)
    for (const el of els)
      if (typeof el.containerId === 'string' && set.has(el.containerId)) set.add(el.id);
    return set;
  };
  const bump = (el: El): El => ({
    ...el,
    version: (typeof el.version === 'number' ? el.version : 1) + 1,
    versionNonce: randomInt(1, 2 ** 31 - 1),
  });
  const remove = new Set<string>();
  for (const id of rejected) for (const e of elementsOf(id)) remove.add(e);
  // the "agent: <model>" tag the web draws next to a proposal goes once it is reviewed
  const reviewed = new Set([...accepted, ...rejected]);
  for (const el of els) {
    const tag = tagOf(el);
    if (tag?.kind === 'proposal-tag' && tag.id && reviewed.has(tag.id)) remove.add(el.id);
  }
  // arrows bound to a removed box go too (their connections were rejected with it)
  for (const el of els) {
    const ends = [el.startBinding, el.endBinding].filter(isRec).map((b) => str(b.elementId));
    if (el.type === 'arrow' && ends.some((e) => remove.has(e))) {
      remove.add(el.id);
      for (const t of els) if (t.containerId === el.id) remove.add(t.id);
    }
  }
  const solid = new Map<string, string>();
  for (const id of accepted) {
    const k = doc.connections[id];
    const style = k ? (k.mode === 'async' ? 'dashed' : 'solid') : 'solid';
    for (const e of elementsOf(id)) solid.set(e, style);
  }
  return els
    .filter((el) => !remove.has(el.id))
    .map((el) => {
      let next = el;
      if (solid.has(el.id)) {
        const tag = tagOf(el);
        const customData =
          tag && isRec(el.customData)
            ? { ...el.customData, atlas: { ...tag, proposed: undefined } }
            : el.customData;
        next = bump({
          ...el,
          ...(el.type !== 'text' ? { strokeStyle: solid.get(el.id) } : {}),
          opacity: 100,
          ...(customData !== undefined ? { customData } : {}),
        });
      }
      if (
        Array.isArray(el.boundElements) &&
        el.boundElements.some((b) => isRec(b) && remove.has(str(b.id)))
      )
        next = bump({
          ...next,
          boundElements: el.boundElements.filter((b) => !(isRec(b) && remove.has(str(b.id)))),
        });
      return next;
    });
}

// ------------------------------------------------------------------------------------- reads

/**
 * The registry as a layout-free BoardSpec, for agents (`atlas_get_board`): no scene, no element
 * ids, rejected items left out. Statuses and origins stay so an agent can tell proposals apart.
 */
export function boardSpecOf(document: BoardDocument, title?: string): BoardSpec {
  const keep = <T extends { status: string }>(x: T) => x.status !== 'rejected';
  return BoardSpec.parse({
    ...(title ? { title } : {}),
    ...(document.doc.summary ? { summary: document.doc.summary } : {}),
    components: Object.values(document.components)
      .filter(keep)
      .map(({ elementIds: _e, ...c }) => c),
    connections: Object.values(document.connections)
      .filter(keep)
      .map(({ elementId: _e, ...k }) => k),
    scenarios: document.scenarios.filter(keep).map((s) => ({
      ...s,
      steps: s.steps.map(({ elementId: _e, ...st }) => st),
    })),
    doc: { summary: document.doc.summary, items: document.doc.items.filter(keep) },
    frames: document.frames.map(({ elementId: _e, ...f }) => f),
  });
}

/** Store an implementation plan (Markdown) on the board's design doc; replaces an earlier plan. */
export function setBoardPlan(
  db: Db,
  boardId: string,
  markdown: string,
): BoardResult<{ board: DesignBoard }> {
  return db.transaction((): BoardResult<{ board: DesignBoard }> => {
    const cur = getBoard(db, boardId);
    if (!cur) return { ok: false, status: 404, error: 'unknown_board' };
    const next: DesignBoard = {
      ...cur,
      document: { ...cur.document, doc: { ...cur.document.doc, plan: markdown.slice(0, 100_000) } },
      revision: cur.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    write(db, next);
    return { ok: true, board: next };
  });
}

/** Boards of a project carrying items a design job proposed, with how many are still proposed. */
export function boardItemsOfJob(
  db: Db,
  projectId: string,
  jobId: string,
): { boardId: string; proposed: number; total: number }[] {
  const rows = db
    .prepare(
      'SELECT id FROM design_boards WHERE project_id = ? AND instr(document, ?) > 0 ORDER BY created_at, id',
    )
    .all<{ id: string }>(projectId, jobId);
  const out: { boardId: string; proposed: number; total: number }[] = [];
  for (const r of rows) {
    const b = getBoard(db, r.id);
    if (!b) continue;
    const d = b.document;
    const items: AnyItem[] = [
      ...Object.values(d.components),
      ...Object.values(d.connections),
      ...d.scenarios,
      ...d.doc.items,
    ];
    const mine = items.filter((i) => i.origin.jobId === jobId);
    if (mine.length)
      out.push({
        boardId: b.id,
        proposed: mine.filter((i) => i.status === 'proposed').length,
        total: mine.length,
      });
  }
  return out;
}
