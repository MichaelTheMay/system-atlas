import {
  BOARD_TEMPLATES,
  componentTypeInfo,
  DOC_SECTION_LABEL,
  type BoardSpec,
  type DesignJobRequest,
} from '@atlas/schema';
import type { DesignRuntimeContext, DesignRuntimeResult } from '../design-runtime.ts';
import type { DesignToolset } from '../design-tools.ts';

/**
 * Deterministic design-board agent (D03c) for CI and demos. It works like a model would, through
 * the same Atlas board tools: read the board as a BoardSpec, then propose with
 * `atlas_propose_board` / `atlas_create_board` (so everything lands as `proposed`), or answer in
 * text. Drafts come from the template catalog by prompt keywords; the critique is a fixed set of
 * system-design rules. Same board and request in, same proposals out. Free.
 */
export const MOCK_BOARD_MODEL = 'mock-design';

type Spec = BoardSpec;
type Comp = Spec['components'][number];
type Conn = Spec['connections'][number];
type DocItemSpec = { id: string; section: string; text: string; pins: string[] };

async function call(tools: DesignToolset, name: string, args: Record<string, unknown>) {
  const r = await tools.call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.text.slice(0, 300)}`);
  return r.data as Record<string, unknown>;
}

async function readBoard(ctx: DesignRuntimeContext, boardId: string) {
  const r = await call(ctx.tools, 'atlas_get_board', { boardId });
  return {
    name: String(r.name ?? 'Board'),
    spec: r.spec as Spec,
    plan: r.plan as string | undefined,
  };
}

// ------------------------------------------------------------------------------- draft

const GENERIC_3_TIER: Spec = {
  title: 'Three-tier web app',
  summary:
    'Clients call a horizontally scaled service behind a load balancer; one SQL database holds the state.',
  components: [
    comp('user', 'actor', 'Users'),
    comp('web', 'web-client', 'Web app'),
    comp('lb', 'load-balancer', 'Load balancer', { layer: 'L7' }),
    comp('api', 'service', 'App service', { scaling: 'horizontal', instances: 2 }),
    comp('db', 'sql-db', 'Database', { engine: 'postgres', replication: 'primary-replica' }),
  ],
  connections: [
    conn('c1', 'user', 'web', { protocol: 'HTTP' }),
    conn('c2', 'web', 'lb', { protocol: 'HTTP', payload: 'API calls' }),
    conn('c3', 'lb', 'api', { protocol: 'HTTP' }),
    conn('c4', 'api', 'db', { protocol: 'SQL', payload: 'reads and writes' }),
  ],
  scenarios: [],
  doc: { items: [] },
  frames: [],
};

function comp(id: string, type: Comp['type'], label: string, props: Comp['props'] = {}): Comp {
  return { id, type, label, props, entityIds: [], origin: { author: 'agent' }, status: 'proposed' };
}
function conn(id: string, from: string, to: string, o: Partial<Conn> = {}): Conn {
  return {
    id,
    from,
    to,
    mode: 'sync',
    direction: 'request-response',
    origin: { author: 'agent' },
    status: 'proposed',
    ...o,
  };
}

/** Template whose keywords best match the prompt (ties: catalog order); undefined = no match. */
export function matchTemplate(prompt: string) {
  const p = prompt.toLowerCase();
  let best: { t: (typeof BOARD_TEMPLATES)[number]; score: number } | undefined;
  for (const t of BOARD_TEMPLATES) {
    const score = t.keywords.filter((k) => p.includes(k)).length;
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t;
}

/** "Design a URL shortener for our app" → "URL shortener for our app" (bounded, capitalized). */
function titleFromPrompt(prompt: string): string {
  const t = prompt
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(please\s+)?(design|draft|build|create|sketch|make)\s+(me\s+)?(an?|the)?\s*/i, '')
    .replace(/[.!?]+$/, '')
    .slice(0, 60)
    .trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'Draft';
}

async function draft(req: DesignJobRequest, ctx: DesignRuntimeContext) {
  const prompt = req.prompt ?? '';
  const tpl = matchTemplate(prompt);
  const spec: Spec = structuredClone(tpl?.spec ?? GENERIC_3_TIER);
  ctx.emit({
    type: 'progress',
    jobId: ctx.jobId,
    level: 0,
    message: tpl
      ? `drafting from the "${tpl.name}" pattern`
      : 'drafting a generic three-tier design',
  });
  if (!req.boardId) {
    const name = tpl?.name ?? titleFromPrompt(prompt);
    const r = await call(ctx.tools, 'atlas_create_board', { name, spec, model: MOCK_BOARD_MODEL });
    return {
      text: `Drafted "${name}" with ${spec.components.length} proposed components${tpl ? ` from the ${tpl.name} pattern` : ''}.`,
      data: { boardId: r.boardId },
    };
  }
  // redraft: propose only what the board does not have yet, wired to what it has
  const cur = await readBoard(ctx, req.boardId);
  const byLabel = new Map(cur.spec.components.map((c) => [c.label.toLowerCase(), c.id]));
  const idMap = new Map<string, string>();
  const components = spec.components.filter((c) => {
    const existing = byLabel.get(c.label.toLowerCase());
    if (existing) idMap.set(c.id, existing);
    return !existing;
  });
  const ref = (id: string) => idMap.get(id) ?? id;
  const have = new Set(cur.spec.connections.map((k) => `${k.from}>${k.to}`));
  const connections = spec.connections
    .map((k) => ({ ...k, from: ref(k.from), to: ref(k.to) }))
    .filter((k) => !have.has(`${k.from}>${k.to}`));
  const r = await call(ctx.tools, 'atlas_propose_board', {
    boardId: req.boardId,
    spec: { components, connections, doc: { items: [] } },
    model: MOCK_BOARD_MODEL,
  });
  return {
    text: `Proposed ${components.length} component(s) and ${connections.length} connection(s) missing from the board.`,
    data: r,
  };
}

// ------------------------------------------------------------------------------- critique

/** "~1.2k rps" → 1200; "10 GB/day" → undefined (not a request rate). */
export function rps(volume: string | undefined): number | undefined {
  const m = /([\d.]+)\s*([km])?\s*(rps|req\/s|qps|requests?\/s)/i.exec(volume ?? '');
  if (!m) return undefined;
  const n = Number(m[1]);
  const k = m[2]?.toLowerCase();
  return n * (k === 'k' ? 1_000 : k === 'm' ? 1_000_000 : 1);
}

const FRONT_DOORS = new Set(['load-balancer', 'api-gateway', 'reverse-proxy']);
const CLIENTS = new Set(['actor', 'web-client', 'mobile-client', 'cli-client']);
const STREAMS = new Set(['queue', 'topic', 'event-stream']);
const DATA = new Set(['sql-db', 'nosql-db']);

export function critiqueRules(spec: Spec): DocItemSpec[] {
  const comps = new Map(spec.components.map((c) => [c.id, c]));
  const into = (id: string) => spec.connections.filter((k) => k.to === id);
  const outOf = (id: string) => spec.connections.filter((k) => k.from === id);
  const label = (id: string) => `${comps.get(id)?.label ?? id} (${id})`;
  const pinned = (id: string) => spec.doc.items.some((i) => i.pins.includes(id));
  const out: DocItemSpec[] = [];
  const add = (section: 'risks' | 'decisions', text: string, pins: string[]) =>
    out.push({ id: `crit-${out.length + 1}`, section, text, pins });

  for (const c of spec.components) {
    const callers = into(c.id)
      .map((k) => comps.get(k.from))
      .filter((x): x is Comp => !!x);
    if (c.type === 'service') {
      const instances = Number(c.props.instances ?? (c.props.scaling === 'single' ? 1 : 2));
      if (instances <= 1 && !callers.some((p) => FRONT_DOORS.has(p.type))) {
        add(
          'risks',
          `[SPOF] ${label(c.id)} runs a single instance with no load balancer in front: one crash or deploy takes it down.`,
          [c.id],
        );
        add(
          'decisions',
          `Run ${label(c.id)} as at least two instances behind a load balancer (health checks, rolling deploys).`,
          [c.id],
        );
      }
    }
    if (DATA.has(c.type) && c.props.replication === 'none')
      add(
        'risks',
        `[SPOF] ${label(c.id)} has no replica: a disk or host failure loses writes and availability.`,
        [c.id],
      );
    if (DATA.has(c.type)) {
      const load = into(c.id).reduce((n, k) => n + (rps(k.volume) ?? 0), 0);
      const cached = callers.some((p) =>
        outOf(p.id).some((k) => comps.get(k.to)?.type === 'cache'),
      );
      if (load >= 1_000 && !cached) {
        add(
          'risks',
          `[Missing cache] ${label(c.id)} takes ~${Math.round(load).toLocaleString('en-US')} rps with no cache in front: reads will dominate its capacity.`,
          [c.id, ...callers.map((p) => p.id)],
        );
        add(
          'decisions',
          `Add a read-through cache (e.g. Redis, short TTL) between ${callers.map((p) => label(p.id)).join(', ')} and ${label(c.id)}.`,
          [c.id],
        );
      }
      const writers = [
        ...new Set(
          callers.filter((p) => componentTypeInfo(p.type).family === 'compute').map((p) => p.id),
        ),
      ];
      if (writers.length >= 2)
        add(
          'risks',
          `[Data consistency] ${label(c.id)} is written by ${writers.map(label).join(' and ')}: define one owner of each table or a transaction/outbox boundary.`,
          [c.id, ...writers],
        );
    }
    if (c.type === 'worker' && !callers.some((p) => STREAMS.has(p.type)))
      add(
        'risks',
        `[Missing queue] ${label(c.id)} is not fed by a queue or stream: there is no backpressure, retry or dead-letter path for its work.`,
        [c.id],
      );
    if (STREAMS.has(c.type) && !c.props.retention && c.type !== 'topic')
      add(
        'risks',
        `[Unbounded growth] ${label(c.id)} has no retention: set a retention period and alert on consumer lag.`,
        [c.id],
      );
  }

  // security edge: traffic from clients reaches the system with no auth anywhere
  const hasAuth = spec.components.some(
    (c) => c.type === 'auth' || (c.type === 'api-gateway' && c.props.auth !== 'none'),
  );
  const entries = [
    ...new Set(
      spec.connections
        .filter(
          (k) =>
            CLIENTS.has(comps.get(k.from)?.type ?? 'box') &&
            !CLIENTS.has(comps.get(k.to)?.type ?? 'box'),
        )
        .map((k) => k.to),
    ),
  ];
  if (!hasAuth && entries.length) {
    add(
      'risks',
      `[Security edge] Client traffic enters at ${entries.map(label).join(', ')} with no auth component or authenticating gateway: who may call what is undefined.`,
      entries,
    );
    add(
      'decisions',
      `Put authentication (OIDC/JWT at an API gateway) and rate limiting in front of ${entries.map(label).join(', ')}.`,
      entries,
    );
  }

  // ownership: services and workers nobody wrote a word about
  const unowned = spec.components.filter(
    (c) => (c.type === 'service' || c.type === 'worker') && !c.responsibility && !pinned(c.id),
  );
  for (const c of unowned.slice(0, 3))
    add(
      'risks',
      `[Unclear ownership] ${label(c.id)} has no responsibility and no doc item: state what it owns and who runs it.`,
      [c.id],
    );

  // skip what the doc already says
  const said = new Set(spec.doc.items.map((i) => i.text));
  return out.filter((i) => !said.has(i.text)).slice(0, 12);
}

async function critique(req: DesignJobRequest, ctx: DesignRuntimeContext) {
  const { spec } = await readBoard(ctx, req.boardId!);
  const items = critiqueRules(spec);
  ctx.emit({
    type: 'progress',
    jobId: ctx.jobId,
    level: 0,
    message: `${items.length} finding(s) from the rule-based critique`,
  });
  if (!items.length) return { text: 'No issues found by the rule-based critique.' };
  const r = await call(ctx.tools, 'atlas_propose_board', {
    boardId: req.boardId,
    spec: { components: [], doc: { items } },
    model: MOCK_BOARD_MODEL,
  });
  const risks = items.filter((i) => i.section === 'risks');
  return {
    text: `${risks.length} risk(s): ${risks.map((i) => i.text.replace(/\].*$/, ']')).join(' ')}`,
    data: r,
  };
}

// ------------------------------------------------------------------------------- fill doc

export function docFromSpec(spec: Spec): DocItemSpec[] {
  const comps = new Map(spec.components.map((c) => [c.id, c]));
  const name = (id: string) => comps.get(id)?.label ?? id;
  const out: DocItemSpec[] = [];
  const add = (section: string, text: string, pins: string[]) =>
    out.push({ id: `doc-${out.length + 1}`, section, text, pins });
  for (const s of spec.scenarios)
    add(
      'requirements',
      `Support "${s.name}"${s.description ? `: ${s.description}` : ''} (${s.steps.length} step(s)).`,
      [
        ...new Set(
          s.steps.flatMap((st) =>
            st.componentId ? [st.componentId] : st.connectionId ? [st.connectionId] : [],
          ),
        ),
      ],
    );
  for (const c of spec.components)
    if (typeof c.props.slo === 'string' && c.props.slo)
      add('nfr', `${c.label}: ${c.props.slo}.`, [c.id]);
  for (const k of spec.connections) {
    if (k.volume)
      add(
        'estimates',
        `${name(k.from)} → ${name(k.to)}: ${k.volume}${rps(k.volume) ? ` ≈ ${Math.round(rps(k.volume)! * 86_400).toLocaleString('en-US')} requests/day` : ''}.`,
        [k.id],
      );
    if (k.payload && (k.protocol === 'HTTP' || k.protocol === 'gRPC' || k.protocol === 'GraphQL'))
      add(
        'api',
        `${name(k.to)} exposes ${k.payload} over ${k.protocol} (called by ${name(k.from)}, ${k.mode}).`,
        [k.to, k.id],
      );
  }
  for (const c of spec.components) {
    const fam = componentTypeInfo(c.type).family;
    if (fam !== 'data') continue;
    const writes = spec.connections.filter((k) => k.to === c.id && k.payload).map((k) => k.payload);
    add(
      'data-model',
      `${c.label} (${String(c.props.engine ?? componentTypeInfo(c.type).label)})${writes.length ? ` holds: ${[...new Set(writes)].join('; ')}` : ': define its entities and keys'}.`,
      [c.id],
    );
  }
  const said = new Set(spec.doc.items.map((i) => `${i.section}:${i.text}`));
  return out.filter((i) => !said.has(`${i.section}:${i.text}`)).slice(0, 40);
}

async function fillDoc(req: DesignJobRequest, ctx: DesignRuntimeContext) {
  const { spec } = await readBoard(ctx, req.boardId!);
  const items = docFromSpec(spec);
  if (!items.length) return { text: 'The design doc already covers what the board shows.' };
  const r = await call(ctx.tools, 'atlas_propose_board', {
    boardId: req.boardId,
    spec: { components: [], doc: { items } },
    model: MOCK_BOARD_MODEL,
  });
  const by = new Map<string, number>();
  for (const i of items) by.set(i.section, (by.get(i.section) ?? 0) + 1);
  return {
    text: `Proposed ${items.length} doc item(s): ${[...by].map(([s, n]) => `${n} ${DOC_SECTION_LABEL[s as keyof typeof DOC_SECTION_LABEL] ?? s}`).join(', ')}.`,
    data: r,
  };
}

// ------------------------------------------------------------------------------- explain

export function explainScenario(spec: Spec, scenarioId?: string): string {
  const s = spec.scenarios.find((x) => x.id === scenarioId) ?? spec.scenarios[0];
  if (!s) return 'The board has no scenario to explain.';
  const comps = new Map(spec.components.map((c) => [c.id, c]));
  const cons = new Map(spec.connections.map((k) => [k.id, k]));
  const name = (id: string) => comps.get(id)?.label ?? id;
  const lines = [`**${s.name}**${s.description ? ` — ${s.description}` : ''}`, ''];
  s.steps.forEach((st, i) => {
    const k = st.connectionId ? cons.get(st.connectionId) : undefined;
    if (k) {
      const how = [
        k.protocol ? `over ${k.protocol}` : undefined,
        k.mode === 'async' ? 'asynchronously (the caller does not wait)' : 'synchronously',
        k.direction === 'one-way'
          ? 'one-way'
          : k.direction === 'bidirectional'
            ? 'both ways'
            : undefined,
        k.payload ? `carrying ${k.payload}` : undefined,
        k.volume ? `at ${k.volume}` : undefined,
      ].filter(Boolean);
      lines.push(`${i + 1}. ${name(k.from)} → ${name(k.to)}, ${how.join(', ')}. ${st.text}`);
    } else if (st.componentId) lines.push(`${i + 1}. At ${name(st.componentId)}: ${st.text}`);
    else lines.push(`${i + 1}. ${st.text}`);
  });
  const asyncHops = s.steps.filter(
    (st) => cons.get(st.connectionId ?? '')?.mode === 'async',
  ).length;
  lines.push(
    '',
    asyncHops
      ? `${asyncHops} hop(s) are asynchronous, so the user-facing latency is the sum of the synchronous hops only; failures there need retries and a dead-letter path.`
      : 'Every hop is synchronous: the slowest hop sets the latency, and any failing hop fails the request.',
  );
  return lines.join('\n');
}

// ------------------------------------------------------------------------------- variant

export function variantOf(spec: Spec): { idea: string; spec: Spec } {
  const next: Spec = structuredClone(spec);
  const comps = new Map(next.components.map((c) => [c.id, c]));
  const fresh = (base: string) => {
    let id = base;
    for (let n = 2; comps.has(id); n++) id = `${base}-${n}`;
    return id;
  };
  // 1. a database read by callers with no cache: add a read-through cache
  const db = next.components.find(
    (c) =>
      DATA.has(c.type) &&
      next.connections
        .filter((k) => k.to === c.id)
        .every(
          (k) =>
            !next.connections.some((o) => o.from === k.from && comps.get(o.to)?.type === 'cache'),
        ),
  );
  const callers = db ? next.connections.filter((k) => k.to === db.id) : [];
  if (db && callers.length) {
    const id = fresh('read-cache');
    next.components.push(
      comp(id, 'cache', `${db.label} cache`, { engine: 'redis', ttl: '5m', eviction: 'lru' }),
    );
    for (const k of callers)
      next.connections.push(
        conn(fresh(`${k.from}-cache`), k.from, id, { protocol: 'other', payload: 'cached reads' }),
      );
    return { idea: `read cache in front of ${db.label}`, spec: next };
  }
  // 2. a service doing slow work inline: put a queue and a worker behind it
  const svc = next.components.find((c) => c.type === 'service');
  if (svc && !next.components.some((c) => STREAMS.has(c.type))) {
    const q = fresh('jobs-queue');
    comps.set(q, comp(q, 'queue', 'Jobs queue'));
    const w = fresh('jobs-worker');
    next.components.push(
      comps.get(q)!,
      comp(w, 'worker', `${svc.label} worker`, { concurrency: 8 }),
    );
    next.connections.push(
      conn(fresh('enqueue'), svc.id, q, {
        protocol: 'AMQP',
        mode: 'async',
        direction: 'one-way',
        payload: 'job',
      }),
      conn(fresh('consume'), q, w, {
        protocol: 'AMQP',
        mode: 'async',
        direction: 'one-way',
        payload: 'job',
      }),
    );
    return { idea: `async jobs for ${svc.label}`, spec: next };
  }
  // 3. otherwise: a read replica for the first data store
  const store = next.components.find((c) => DATA.has(c.type));
  if (store) {
    const id = fresh('replica');
    next.components.push(comp(id, 'replica', `${store.label} replica`, { role: 'read-replica' }));
    next.connections.push(
      conn(fresh('replication'), store.id, id, {
        protocol: 'SQL',
        mode: 'async',
        direction: 'one-way',
        payload: 'WAL',
      }),
    );
    return { idea: `read replica for ${store.label}`, spec: next };
  }
  return {
    idea: 'observability',
    spec: {
      ...next,
      components: [...next.components, comp(fresh('obs'), 'observability', 'Observability')],
    },
  };
}

async function variant(req: DesignJobRequest, ctx: DesignRuntimeContext) {
  const cur = await readBoard(ctx, req.boardId!);
  const v = variantOf(cur.spec);
  const name = `${cur.name} — variant: ${v.idea}`.slice(0, 120);
  const r = await call(ctx.tools, 'atlas_create_board', {
    name,
    spec: { ...v.spec, scenarios: [], doc: { items: [] } },
    model: MOCK_BOARD_MODEL,
  });
  return { text: `Created "${name}" as a proposed variant board.`, data: { boardId: r.boardId } };
}

// ------------------------------------------------------------------------------- plan

const ORDER = ['data', 'messaging', 'cross-cutting', 'external', 'compute', 'edge'];

function criteria(c: Comp, spec: Spec): string[] {
  const out: string[] = [];
  const p = c.props;
  switch (componentTypeInfo(c.type).family) {
    case 'data':
      out.push(`Schema and migrations for ${c.label} are versioned and run in CI.`);
      if (p.replication && p.replication !== 'none')
        out.push(
          `Replication (${String(p.replication)}) is configured and a failover was rehearsed.`,
        );
      if (c.type === 'cache')
        out.push(
          `Cache TTL${p.ttl ? ` of ${String(p.ttl)}` : ''} and eviction${p.eviction ? ` (${String(p.eviction)})` : ''} are set; a cold cache does not overload the store.`,
        );
      out.push('Backups (or rebuild procedure) are documented and restore is tested.');
      break;
    case 'messaging':
      out.push(`Delivery is ${String(p.delivery ?? 'at-least-once')}; consumers are idempotent.`);
      out.push(
        `Retention${p.retention ? ` is ${String(p.retention)}` : ' is set'} and consumer lag is alerted on.`,
      );
      out.push('Poison messages go to a dead-letter queue.');
      break;
    case 'compute':
      out.push(
        `Runs ${p.instances !== undefined ? `${String(p.instances)} instance(s)` : 'with the planned scaling'}${p.scaling ? ` (${String(p.scaling)})` : ''} with health checks and graceful shutdown.`,
      );
      if (p.slo) out.push(`Meets ${String(p.slo)} under the expected load (load test recorded).`);
      if (c.type === 'worker')
        out.push('Retries with backoff; failed jobs are visible and replayable.');
      out.push('Structured logs, metrics and traces are emitted for every request or job.');
      break;
    case 'edge':
      out.push('TLS terminates here; only intended routes are exposed.');
      if (c.type === 'api-gateway')
        out.push(
          `Auth is ${String(p.auth ?? 'jwt')}${p.rateLimit ? `; rate limit ${String(p.rateLimit)}` : ''}.`,
        );
      out.push('Health checks remove failing backends within seconds.');
      break;
    default:
      out.push(`${c.label} is integrated with timeouts, retries and a documented failure mode.`);
  }
  for (const k of spec.connections.filter((x) => x.from === c.id || x.to === c.id))
    if (k.payload && k.to === c.id)
      out.push(
        `Accepts ${k.payload}${k.protocol ? ` over ${k.protocol}` : ''}${k.volume ? ` at ${k.volume}` : ''} with a contract test.`,
      );
  return out;
}

export function implementationPlan(name: string, spec: Spec, model: string): string {
  const comps = new Map(spec.components.map((c) => [c.id, c]));
  const buildable = spec.components
    .filter((c) => ORDER.includes(componentTypeInfo(c.type).family) && !CLIENTS.has(c.type))
    .sort(
      (a, b) =>
        ORDER.indexOf(componentTypeInfo(a.type).family) -
        ORDER.indexOf(componentTypeInfo(b.type).family),
    );
  const clients = spec.components.filter(
    (c) => c.type === 'web-client' || c.type === 'mobile-client' || c.type === 'cli-client',
  );
  const tickets = [...buildable, ...clients];
  const lines = [
    `# Implementation plan: ${name}`,
    '',
    spec.summary ?? '',
    '',
    `_Proposed by ${model} from the design board; review before handing out._`,
    '',
    '## Tickets',
  ];
  tickets.forEach((c, i) => {
    const info = componentTypeInfo(c.type);
    const calls = spec.connections.filter((k) => k.from === c.id);
    const risks = spec.doc.items.filter((d) => d.section === 'risks' && d.pins.includes(c.id));
    const props = Object.entries(c.props).map(([k, v]) => `${k}: ${String(v)}`);
    lines.push(
      '',
      `### T${i + 1} — ${c.label} (${info.label.toLowerCase()})`,
      '',
      c.responsibility ??
        `Build the ${info.label.toLowerCase()} "${c.label}" as drawn on the board.`,
      ...(props.length ? ['', `**Settings:** ${props.join(', ')}`] : []),
      ...(calls.length
        ? [
            '',
            '**Calls:**',
            ...calls.map(
              (k) =>
                `- ${comps.get(k.to)?.label ?? k.to}${k.protocol ? ` over ${k.protocol}` : ''} (${k.mode}${k.payload ? `, ${k.payload}` : ''}${k.volume ? `, ${k.volume}` : ''})`,
            ),
          ]
        : []),
      '',
      '**Acceptance criteria**',
      ...criteria(c, spec).map((a) => `- [ ] ${a}`),
      ...(risks.length ? ['', '**Risks to address:**', ...risks.map((r) => `- ${r.text}`)] : []),
    );
  });
  lines.push(
    '',
    '## Agent brief',
    '',
    '```text',
    `You are implementing "${name}" from its design board, one ticket at a time, in the order below.`,
    ...tickets.map(
      (c, i) =>
        `T${i + 1}. ${c.label} (${componentTypeInfo(c.type).label}): ${c.responsibility ?? 'see the ticket'}`,
    ),
    'For each ticket: write the code and tests, meet every acceptance criterion, and keep the interfaces',
    '(protocol, payload) exactly as listed. Ask before changing the design; do not add components.',
    '```',
  );
  return lines.join('\n');
}

async function plan(req: DesignJobRequest, ctx: DesignRuntimeContext) {
  const { name, spec } = await readBoard(ctx, req.boardId!);
  return { text: implementationPlan(name, spec, MOCK_BOARD_MODEL) };
}

export async function runMockBoardJob(
  req: DesignJobRequest,
  ctx: DesignRuntimeContext,
): Promise<DesignRuntimeResult['output']> {
  switch (req.kind) {
    case 'draft-board':
      return draft(req, ctx);
    case 'critique-board':
      return critique(req, ctx);
    case 'fill-doc':
      return fillDoc(req, ctx);
    case 'explain-scenario': {
      const { spec } = await readBoard(ctx, req.boardId!);
      return { text: explainScenario(spec, req.scenarioId) };
    }
    case 'variant-board':
      return variant(req, ctx);
    case 'implementation-plan':
      return plan(req, ctx);
    default:
      return undefined;
  }
}
