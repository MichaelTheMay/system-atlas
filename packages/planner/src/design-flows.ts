import type { Nav } from './nav.ts';
import type { GraphEntity, GraphRelation, PlannerGraph } from './types.ts';

/**
 * Request flows derived from code (D04), at entity level. One flow per endpoint: who calls it, then
 * what the module that exposes it can reach through its imports — the tables those modules read
 * and write, the queues they publish to — and on from each queue to its consumers.
 *
 * The analyzers record these facts per module; there is no call graph. A flow is therefore what a
 * request to the endpoint *can* reach, not a trace of what it does: two routes in one file share
 * the same downstream. To keep the obvious false steps out, a GET/HEAD/OPTIONS route is assumed
 * safe and its writes and enqueues are left out. Every flow says so in its description. Flows are
 * view data for boards, never facts.
 */
export type FlowFact =
  | { type: 'calls'; from: string; endpoint: string; to: string }
  | { type: 'uses'; from: string; to: string }
  | { type: 'store'; from: string; store: string; reads: string[]; writes: string[] }
  | { type: 'enqueue'; from: string; queue: string }
  | { type: 'consume'; from: string; queue: string };

export interface FlowHop {
  fromId: string;
  toId: string;
  /** What happens on this hop, in box labels; several hops on one step merge into one sentence. */
  fact: FlowFact;
}
export interface EntityFlow {
  /** Stable local id (`flow-post-orders`), the same on every canvas the flow appears on. */
  id: string;
  name: string;
  description: string;
  hops: FlowHop[];
  /** Hops that are a client calling one of the flow's routes (flows somebody calls rank first). */
  callers: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** A consumer's own flow is followed this many queues deep. */
const MAX_QUEUE_DEPTH = 2;
const MAX_CALLERS = 3;
const MAX_HOPS = 40;

const byCanonical = (a: GraphEntity, b: GraphEntity) =>
  a.canonicalName < b.canonicalName ? -1 : a.canonicalName > b.canonicalName ? 1 : 0;

const words = (all: string[], max = 6) => {
  const xs = all.length > max ? [...all.slice(0, max), `${all.length - max} more`] : all;
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
};

/**
 * The facts of one step as sentences: reads and writes of the same box in the same store become
 * one sentence, and nothing is said twice. E.g. "@shop/orders writes order_items and orders and
 * reads orders in db."
 */
export function flowText(facts: FlowFact[], max = 480): string {
  const out: string[] = [];
  const stores = new Map<
    string,
    { from: string; store: string; reads: Set<string>; writes: Set<string>; at: number }
  >();
  const say = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const f of facts) {
    if (f.type === 'calls') say(`${f.from} calls ${f.endpoint} on ${f.to}.`);
    else if (f.type === 'uses') say(`${f.from} uses ${f.to}.`);
    else if (f.type === 'enqueue') say(`${f.from} enqueues on ${f.queue}.`);
    else if (f.type === 'consume') say(`${f.from} consumes ${f.queue}.`);
    else {
      const k = `${f.from}\u0000${f.store}`;
      let s = stores.get(k);
      if (!s) {
        s = { from: f.from, store: f.store, reads: new Set(), writes: new Set(), at: out.length };
        stores.set(k, s);
        out.push('');
      }
      for (const t of f.reads) s.reads.add(t);
      for (const t of f.writes) s.writes.add(t);
    }
  }
  for (const s of stores.values()) {
    const parts = [
      s.writes.size ? `writes ${words([...s.writes].sort())}` : '',
      s.reads.size ? `reads ${words([...s.reads].sort())}` : '',
    ].filter(Boolean);
    out[s.at] = `${s.from} ${parts.join(' and ')} in ${s.store}.`;
  }
  let text = '';
  for (const s of out) {
    if (text.length + s.length + 1 > max) break;
    text += (text ? ' ' : '') + s;
  }
  return text || (out[0] ?? '').slice(0, max);
}

export function deriveFlows(
  g: PlannerGraph,
  nav: Nav,
  /** Key and label of the whiteboard box an entity belongs to. */
  boxOf: (entityId: string) => { key: string; label: string } | undefined,
): EntityFlow[] {
  const ent = (id: string) => nav.byId.get(id);
  /** The module an entity's code lives in (itself for a module). */
  const home = (id: string): string => {
    for (const a of [id, ...nav.ancestors(id)]) if (ent(a)?.kind === 'module') return a;
    return id;
  };
  const label = (id: string) => boxOf(id)?.label ?? ent(id)?.displayName ?? id;
  const sameBox = (a: string, b: string) => {
    const x = boxOf(a)?.key;
    return x !== undefined && x === boxOf(b)?.key;
  };

  const out = new Map<string, GraphRelation[]>();
  const into = new Map<string, GraphRelation[]>();
  const add = (m: Map<string, GraphRelation[]>, k: string, r: GraphRelation) =>
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  for (const r of g.relations) {
    add(out, home(r.fromId), r);
    add(into, r.toId, r);
  }
  const sorted = (ids: Iterable<string>) =>
    [...new Set(ids)]
      .map(ent)
      .filter((e): e is GraphEntity => !!e)
      .sort(byCanonical)
      .map((e) => e.id);
  const of = (moduleId: string, kind: string, targetKinds: string[]) =>
    (out.get(moduleId) ?? []).filter(
      (r) => r.kind === kind && targetKinds.includes(ent(r.toId)?.kind ?? ''),
    );
  /** Internal modules a module imports, in a stable order. */
  const imports = (moduleId: string) =>
    sorted(
      (out.get(moduleId) ?? [])
        .filter(
          (r) => r.kind === 'imports' && ent(r.toId)?.kind === 'module' && !nav.isExternal(r.toId),
        )
        .map((r) => r.toId),
    );

  const used = new Set<string>();
  const flowId = (name: string) => {
    const base =
      `flow-${name}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 56) || 'flow';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const found: {
    name: string;
    method: string;
    safe: boolean;
    calls: FlowHop[];
    rest: FlowHop[];
  }[] = [];
  const endpoints = g.entities
    .filter((e) => e.kind === 'endpoint' && !nav.isExternal(e.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || byCanonical(a, b));
  for (const e of endpoints) {
    const exposer = (into.get(e.id) ?? []).find((r) => r.kind === 'exposes')?.fromId;
    const start = home(exposer ?? e.id);
    if (ent(start)?.kind !== 'module') continue;
    const method = String(e.attributes.method ?? '').toUpperCase();
    const safe = SAFE_METHODS.has(method);
    const hops: FlowHop[] = [];
    const pairs = new Set<string>();
    const hop = (fromId: string, toId: string, fact: FlowFact) => {
      const k = `${fromId}>${toId}`;
      if (pairs.has(k) || hops.length >= MAX_HOPS) return;
      pairs.add(k);
      hops.push({ fromId, toId, fact });
    };

    const callers = sorted(
      (into.get(e.id) ?? []).filter((r) => r.kind === 'calls').map((r) => home(r.fromId)),
    ).slice(0, MAX_CALLERS);
    for (const c of callers)
      hop(c, e.id, { type: 'calls', from: label(c), endpoint: e.displayName, to: label(e.id) });

    const visited = new Set<string>();
    /** Everything `from` reaches through imports: its effects, then its queues' consumers. */
    const follow = (from: string, readOnly: boolean, depth: number): void => {
      if (visited.has(from)) return;
      const parent = new Map<string, string | undefined>([[from, undefined]]);
      const order: string[] = [];
      for (const queue = [from]; queue.length;) {
        const at = queue.shift()!;
        order.push(at);
        for (const next of imports(at))
          if (!parent.has(next)) {
            parent.set(next, at);
            queue.push(next);
          }
      }
      for (const m of order) visited.add(m);
      const published: string[] = [];
      for (const m of order) {
        const effects: FlowHop[] = [];
        // tables, one step per store box
        const stores = new Map<string, { to: string; reads: string[]; writes: string[] }>();
        for (const kind of ['writes', 'reads'] as const) {
          if (kind === 'writes' && readOnly) continue;
          for (const r of of(m, kind, ['table'])) {
            const key = boxOf(r.toId)?.key ?? r.toId;
            const s =
              stores.get(key) ?? stores.set(key, { to: r.toId, reads: [], writes: [] }).get(key)!;
            const name = ent(r.toId)!.displayName;
            if (!s[kind].includes(name)) s[kind].push(name);
          }
        }
        for (const [, s] of [...stores].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
          effects.push({
            fromId: m,
            toId: s.to,
            fact: {
              type: 'store',
              from: label(m),
              store: label(s.to),
              reads: s.reads,
              writes: s.writes,
            },
          });
        if (!readOnly)
          for (const q of sorted(of(m, 'publishes', ['queue', 'topic']).map((r) => r.toId))) {
            effects.push({
              fromId: m,
              toId: q,
              fact: { type: 'enqueue', from: label(m), queue: label(q) },
            });
            published.push(q);
          }
        for (const t of sorted(of(m, 'calls', ['endpoint']).map((r) => r.toId)))
          if (t !== e.id && !sameBox(m, t))
            effects.push({
              fromId: m,
              toId: t,
              fact: { type: 'calls', from: label(m), endpoint: ent(t)!.displayName, to: label(t) },
            });
        if (!effects.length) continue;
        // the imports that lead here, box to box (imports inside one box say nothing)
        const chain: string[] = [];
        for (let at: string | undefined = m; at; at = parent.get(at)) chain.unshift(at);
        for (let i = 1; i < chain.length; i++)
          if (!sameBox(chain[i - 1]!, chain[i]!))
            hop(chain[i - 1]!, chain[i]!, {
              type: 'uses',
              from: label(chain[i - 1]!),
              to: label(chain[i]!),
            });
        for (const x of effects) hop(x.fromId, x.toId, x.fact);
      }
      if (depth >= MAX_QUEUE_DEPTH) return;
      for (const q of sorted(published)) {
        const consumers = sorted(
          (into.get(q) ?? []).filter((r) => r.kind === 'subscribes').map((r) => home(r.fromId)),
        );
        for (const c of consumers) {
          hop(c, q, { type: 'consume', from: label(c), queue: label(q) });
          follow(c, false, depth + 1);
        }
      }
    };
    follow(start, safe, 0);
    if (hops.length < 2) continue;
    found.push({
      name: e.displayName,
      method,
      safe,
      calls: hops.filter((h) => h.toId === e.id),
      rest: hops.filter((h) => h.toId !== e.id),
    });
  }

  // Routes that reach exactly the same things (typically routes of one file) are one flow: told
  // once, named after its routes.
  const groups = new Map<string, typeof found>();
  for (const f of found) {
    const sig = `${f.safe}|${f.rest.map((h) => `${h.fromId}>${h.toId}:${h.fact.type}`).join(',')}`;
    (groups.get(sig) ?? groups.set(sig, []).get(sig)!).push(f);
  }
  const flows: EntityFlow[] = [];
  for (const fs of groups.values()) {
    const first = fs[0]!;
    let name = first.name;
    let shown = 1;
    while (shown < fs.length && `${name}, ${fs[shown]!.name}`.length <= 90)
      name += `, ${fs[shown++]!.name}`;
    if (shown < fs.length) name += `, +${fs.length - shown} more`;
    const what = fs.length > 1 ? `any of ${fs.length} routes (${name})` : first.name;
    flows.push({
      id: flowId(first.name),
      name,
      description:
        `Derived from code: what a request to ${what} can reach. It follows the module that exposes the route through its imports to the tables and queues those modules touch, then on to each queue's consumers. ` +
        'The facts are per module, so a step may be reachable without being taken on this request.' +
        (first.safe
          ? ` Writes and enqueues are left out because ${first.method} is assumed to be safe.`
          : ''),
      hops: [...fs.flatMap((f) => f.calls), ...first.rest],
      callers: fs.reduce((n, f) => n + f.calls.length, 0),
    });
  }
  return flows;
}
