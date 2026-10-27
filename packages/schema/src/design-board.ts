import { z } from 'zod';
import { idSchema, Timestamp } from './ids.ts';

/**
 * Design boards (D03, plan §4 "view data"): a design-first system whiteboard. A board is drawn by a
 * person (or drafted by an agent as a proposal) to say how a system *should* work; it is never
 * derived from code and never read as a fact. The canvas itself is an Excalidraw scene; Atlas keeps
 * its own registry of typed components, connections, scenarios and the design doc next to it, and
 * tags the scene elements that stand for them (`element.customData.atlas`).
 */
export const BOARD_SCHEMA_VERSION = 1 as const;

export const ComponentFamily = z.enum([
  'edge',
  'compute',
  'data',
  'messaging',
  'cross-cutting',
  'external',
  'boundary',
  'people',
  'generic',
]);
export type ComponentFamily = z.infer<typeof ComponentFamily>;

export const ComponentType = z.enum([
  // edge / traffic
  'web-client',
  'mobile-client',
  'cli-client',
  'cdn',
  'dns',
  'load-balancer',
  'api-gateway',
  'reverse-proxy',
  'waf',
  // compute
  'service',
  'function',
  'worker',
  'cron',
  'batch-job',
  // data
  'sql-db',
  'nosql-db',
  'kv-store',
  'cache',
  'search-index',
  'object-storage',
  'warehouse',
  'replica',
  // messaging
  'queue',
  'topic',
  'event-stream',
  'webhook',
  'websocket',
  // cross-cutting
  'auth',
  'rate-limiter',
  'config-secrets',
  'observability',
  'feature-flags',
  // external
  'third-party-api',
  'payments',
  'email-sms',
  'llm-provider',
  // boundaries
  'network-zone',
  'region',
  'trust-boundary',
  'tenant',
  // people / process
  'actor',
  'ops',
  'manual-step',
  // fallback
  'box',
]);
export type ComponentType = z.infer<typeof ComponentType>;

/** One optional property of a component type; values render as badges and feed the design doc. */
export interface PropertyField {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'boolean';
  options?: readonly string[];
  default?: string | number | boolean;
  /** Short unit or hint shown in the form ("rps", "GB"). */
  hint?: string;
}

export interface ComponentTypeInfo {
  type: ComponentType;
  family: ComponentFamily;
  label: string;
  /** Icon name (Lucide for generic kinds, Simple Icons slug for products), resolved by the UI. */
  icon: string;
  /** Boundaries and zones are drawn as containers other components sit in. */
  container?: boolean;
  properties: readonly PropertyField[];
}

const scaling: PropertyField = {
  key: 'scaling',
  label: 'Scaling',
  kind: 'select',
  options: ['single', 'horizontal', 'vertical', 'serverless'],
  default: 'horizontal',
};
const instances: PropertyField = {
  key: 'instances',
  label: 'Instances',
  kind: 'number',
  default: 2,
};
const engine = (options: readonly string[]): PropertyField => ({
  key: 'engine',
  label: 'Engine',
  kind: 'select',
  options,
  default: options[0],
});
const consistency: PropertyField = {
  key: 'consistency',
  label: 'Consistency',
  kind: 'select',
  options: ['strong', 'eventual', 'tunable'],
  default: 'strong',
};
const replication: PropertyField = {
  key: 'replication',
  label: 'Replication',
  kind: 'select',
  options: ['none', 'primary-replica', 'multi-primary', 'sharded'],
  default: 'primary-replica',
};
const sizeGb: PropertyField = { key: 'sizeGb', label: 'Size', kind: 'number', hint: 'GB' };
const ttl: PropertyField = { key: 'ttl', label: 'TTL', kind: 'text', hint: 'e.g. 5m' };
const delivery: PropertyField = {
  key: 'delivery',
  label: 'Delivery',
  kind: 'select',
  options: ['at-least-once', 'at-most-once', 'exactly-once'],
  default: 'at-least-once',
};
const ordering: PropertyField = {
  key: 'ordering',
  label: 'Ordering',
  kind: 'select',
  options: ['none', 'per-key', 'total'],
  default: 'per-key',
};
const retention: PropertyField = {
  key: 'retention',
  label: 'Retention',
  kind: 'text',
  hint: 'e.g. 7d',
};
const slo: PropertyField = { key: 'slo', label: 'SLO', kind: 'text', hint: 'e.g. p99 < 200 ms' };
const stateful: PropertyField = {
  key: 'stateful',
  label: 'Stateful',
  kind: 'boolean',
  default: false,
};
const platform: PropertyField = { key: 'platform', label: 'Platform', kind: 'text' };
const provider: PropertyField = { key: 'provider', label: 'Provider', kind: 'text' };
const schedule: PropertyField = { key: 'schedule', label: 'Schedule', kind: 'text', hint: 'cron' };

const t = (
  type: ComponentType,
  family: ComponentFamily,
  label: string,
  icon: string,
  properties: PropertyField[] = [],
  container = false,
): ComponentTypeInfo => ({
  type,
  family,
  label,
  icon,
  properties,
  ...(container ? { container } : {}),
});

/** The component library: every type with its icon and property form. Order = palette order. */
export const COMPONENT_CATALOG: readonly ComponentTypeInfo[] = [
  t('web-client', 'edge', 'Web client', 'monitor', [platform]),
  t('mobile-client', 'edge', 'Mobile client', 'smartphone', [platform]),
  t('cli-client', 'edge', 'CLI client', 'terminal'),
  t('cdn', 'edge', 'CDN', 'globe', [provider, ttl]),
  t('dns', 'edge', 'DNS', 'signpost', [provider]),
  t('load-balancer', 'edge', 'Load balancer', 'scale', [
    {
      key: 'algorithm',
      label: 'Algorithm',
      kind: 'select',
      options: ['round-robin', 'least-conn', 'ip-hash', 'weighted'],
      default: 'round-robin',
    },
    { key: 'layer', label: 'Layer', kind: 'select', options: ['L4', 'L7'], default: 'L7' },
  ]),
  t('api-gateway', 'edge', 'API gateway', 'door-open', [
    {
      key: 'auth',
      label: 'Auth',
      kind: 'select',
      options: ['none', 'api-key', 'jwt', 'oauth2', 'mtls'],
      default: 'jwt',
    },
    { key: 'rateLimit', label: 'Rate limit', kind: 'text', hint: 'e.g. 100 rps/user' },
  ]),
  t('reverse-proxy', 'edge', 'Reverse proxy', 'arrow-left-right'),
  t('waf', 'edge', 'WAF', 'shield'),
  t('service', 'compute', 'Service', 'box', [scaling, instances, stateful, slo]),
  t('function', 'compute', 'Function', 'zap', [
    { key: 'runtime', label: 'Runtime', kind: 'text' },
    { key: 'timeout', label: 'Timeout', kind: 'text', hint: 'e.g. 30s' },
  ]),
  t('worker', 'compute', 'Worker', 'cog', [
    scaling,
    instances,
    { key: 'concurrency', label: 'Concurrency', kind: 'number', default: 4 },
  ]),
  t('cron', 'compute', 'Scheduled job', 'clock', [schedule]),
  t('batch-job', 'compute', 'Batch job', 'layers', [
    schedule,
    { key: 'window', label: 'Window', kind: 'text' },
  ]),
  t('sql-db', 'data', 'SQL database', 'database', [
    engine(['postgres', 'mysql', 'sqlite', 'sqlserver', 'oracle']),
    replication,
    consistency,
    sizeGb,
  ]),
  t('nosql-db', 'data', 'NoSQL database', 'database-zap', [
    engine(['mongodb', 'dynamodb', 'cassandra', 'cosmosdb', 'firestore']),
    replication,
    consistency,
    sizeGb,
  ]),
  t('kv-store', 'data', 'Key-value store', 'key-round', [
    engine(['redis', 'etcd', 'dynamodb']),
    consistency,
  ]),
  t('cache', 'data', 'Cache', 'gauge', [
    engine(['redis', 'memcached', 'in-process', 'cdn']),
    ttl,
    {
      key: 'eviction',
      label: 'Eviction',
      kind: 'select',
      options: ['lru', 'lfu', 'ttl'],
      default: 'lru',
    },
    sizeGb,
  ]),
  t('search-index', 'data', 'Search index', 'search', [
    engine(['elasticsearch', 'opensearch', 'meilisearch', 'typesense']),
  ]),
  t('object-storage', 'data', 'Object storage', 'archive', [provider, sizeGb]),
  t('warehouse', 'data', 'Data warehouse', 'warehouse', [
    engine(['bigquery', 'snowflake', 'redshift', 'clickhouse']),
  ]),
  t('replica', 'data', 'Replica / shard', 'copy', [
    {
      key: 'role',
      label: 'Role',
      kind: 'select',
      options: ['read-replica', 'shard', 'standby'],
      default: 'read-replica',
    },
  ]),
  t('queue', 'messaging', 'Queue', 'list-ordered', [
    engine(['sqs', 'rabbitmq', 'redis', 'pubsub', 'bullmq']),
    delivery,
    ordering,
    retention,
  ]),
  t('topic', 'messaging', 'Pub/sub topic', 'radio', [
    engine(['sns', 'pubsub', 'nats', 'redis']),
    delivery,
  ]),
  t('event-stream', 'messaging', 'Event stream', 'waves', [
    engine(['kafka', 'kinesis', 'pulsar', 'redpanda']),
    { key: 'partitions', label: 'Partitions', kind: 'number', default: 12 },
    retention,
    ordering,
  ]),
  t('webhook', 'messaging', 'Webhook', 'webhook', [
    { key: 'retries', label: 'Retries', kind: 'number', default: 3 },
  ]),
  t('websocket', 'messaging', 'WebSocket', 'plug', [
    {
      key: 'fanout',
      label: 'Fan-out',
      kind: 'select',
      options: ['direct', 'pubsub'],
      default: 'pubsub',
    },
  ]),
  t('auth', 'cross-cutting', 'Auth / identity', 'lock', [
    provider,
    {
      key: 'protocol',
      label: 'Protocol',
      kind: 'select',
      options: ['oidc', 'saml', 'jwt', 'session'],
      default: 'oidc',
    },
  ]),
  t('rate-limiter', 'cross-cutting', 'Rate limiter', 'timer', [
    {
      key: 'algorithm',
      label: 'Algorithm',
      kind: 'select',
      options: ['token-bucket', 'sliding-window', 'fixed-window'],
      default: 'token-bucket',
    },
  ]),
  t('config-secrets', 'cross-cutting', 'Config / secrets', 'key', [provider]),
  t('observability', 'cross-cutting', 'Observability', 'activity', [
    { key: 'signals', label: 'Signals', kind: 'text', default: 'logs, metrics, traces' },
  ]),
  t('feature-flags', 'cross-cutting', 'Feature flags', 'toggle-right', [provider]),
  t('third-party-api', 'external', 'Third-party API', 'cloud', [provider, slo]),
  t('payments', 'external', 'Payments', 'credit-card', [provider]),
  t('email-sms', 'external', 'Email / SMS', 'mail', [provider]),
  t('llm-provider', 'external', 'LLM provider', 'sparkles', [
    provider,
    { key: 'model', label: 'Model', kind: 'text' },
  ]),
  t(
    'network-zone',
    'boundary',
    'Network zone / VPC',
    'network',
    [{ key: 'cidr', label: 'CIDR', kind: 'text' }],
    true,
  ),
  t(
    'region',
    'boundary',
    'Region / AZ',
    'map',
    [{ key: 'name', label: 'Name', kind: 'text' }],
    true,
  ),
  t('trust-boundary', 'boundary', 'Trust boundary', 'shield-check', [], true),
  t('tenant', 'boundary', 'Tenant', 'building', [], true),
  t('actor', 'people', 'User / actor', 'user', [
    { key: 'count', label: 'Count', kind: 'text', hint: 'e.g. 10M MAU' },
  ]),
  t('ops', 'people', 'Operator', 'wrench'),
  t('manual-step', 'people', 'Manual step', 'hand'),
  t('box', 'generic', 'Box', 'square'),
];
export const componentTypeInfo = (type: ComponentType): ComponentTypeInfo =>
  COMPONENT_CATALOG.find((c) => c.type === type) ??
  COMPONENT_CATALOG[COMPONENT_CATALOG.length - 1]!;

/** Short opaque ids inside a board (components, connections, scenarios, doc items). */
export const localId = z.string().min(1).max(64);

/** Who put something on the board. Agent output stays `proposed` until a person accepts it. */
export const BoardOrigin = z.object({
  author: z.enum(['user', 'agent', 'template', 'code']),
  /** Model as reported by the runtime, for "agent: <model>" labels. */
  name: z.string().max(100).optional(),
  jobId: idSchema('designJob').optional(),
});
export const BoardItemStatus = z.enum(['active', 'proposed', 'rejected']);

export const PropertyValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const Component = z.object({
  id: localId,
  type: ComponentType,
  label: z.string().trim().min(1).max(120),
  props: z.record(z.string().max(40), PropertyValue).default({}),
  responsibility: z.string().max(500).optional(),
  /** Container component (boundary/zone) this one sits in. */
  parentId: localId.optional(),
  /** Linked sub-board showing this component's internals (depth ≤ 3). */
  internalsBoardId: idSchema('board').optional(),
  /** Code entities this component is meant to become / was imported from (optional, never a fact). */
  entityIds: z.array(idSchema('entity')).max(200).default([]),
  origin: BoardOrigin.default({ author: 'user' }),
  status: BoardItemStatus.default('active'),
  /** Scene element ids of the group drawn for it (container rect first). */
  elementIds: z.array(z.string().max(64)).max(20).default([]),
});
export type Component = z.infer<typeof Component>;

export const Protocol = z.enum([
  'HTTP',
  'gRPC',
  'GraphQL',
  'WebSocket',
  'SQL',
  'AMQP',
  'Kafka',
  'SMTP',
  'TCP',
  'UDP',
  'file',
  'other',
]);
export const Connection = z.object({
  id: localId,
  from: localId,
  to: localId,
  protocol: Protocol.optional(),
  mode: z.enum(['sync', 'async']).default('sync'),
  direction: z.enum(['one-way', 'bidirectional', 'request-response']).default('request-response'),
  /** Name of what travels ("CreateOrder", "order.created event"). */
  payload: z.string().max(120).optional(),
  /** Rough volume ("~1k rps", "10 GB/day"). */
  volume: z.string().max(60).optional(),
  label: z.string().max(120).optional(),
  origin: BoardOrigin.default({ author: 'user' }),
  status: BoardItemStatus.default('active'),
  /** Scene arrow element id. */
  elementId: z.string().max(64).optional(),
});
export type Connection = z.infer<typeof Connection>;

export const ScenarioStep = z.object({
  id: localId,
  /** The hop this step takes (a connection) or the component where work happens. */
  connectionId: localId.optional(),
  componentId: localId.optional(),
  text: z.string().max(500),
  /** Scene element id of the circled step number. */
  elementId: z.string().max(64).optional(),
});
export const Scenario = z.object({
  id: localId,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  steps: z.array(ScenarioStep).max(100).default([]),
  origin: BoardOrigin.default({ author: 'user' }),
  status: BoardItemStatus.default('active'),
});
export type Scenario = z.infer<typeof Scenario>;

export const DocSection = z.enum([
  'requirements',
  'nfr',
  'estimates',
  'api',
  'data-model',
  'decisions',
  'risks',
]);
export type DocSection = z.infer<typeof DocSection>;
export const DOC_SECTION_LABEL: Record<DocSection, string> = {
  requirements: 'Functional requirements',
  nfr: 'Non-functional requirements',
  estimates: 'Capacity estimates',
  api: 'API',
  'data-model': 'Data model',
  decisions: 'Decisions & trade-offs',
  risks: 'Bottlenecks & failure modes',
};
export const DocItem = z.object({
  id: localId,
  section: DocSection,
  text: z.string().max(4000),
  /** Components (and connections) this item concerns. */
  pins: z.array(localId).max(50).default([]),
  origin: BoardOrigin.default({ author: 'user' }),
  status: BoardItemStatus.default('active'),
});
export type DocItem = z.infer<typeof DocItem>;
export const DesignDoc = z.object({
  summary: z.string().max(4000).optional(),
  /**
   * Implementation plan (Markdown: tickets per component with acceptance criteria and an agent
   * brief), written by the `implementation-plan` design job (D03c). Agent output, labeled as such.
   */
  plan: z.string().max(100_000).optional(),
  items: z.array(DocItem).max(500).default([]),
});
export type DesignDoc = z.infer<typeof DesignDoc>;

/** A frame grouping components visually (drawn as an Excalidraw frame; also a presentation slide). */
export const BoardFrame = z.object({
  id: localId,
  label: z.string().trim().min(1).max(120),
  componentIds: z.array(localId).max(200).default([]),
  elementId: z.string().max(64).optional(),
});

/**
 * Layout-free description of a board: what templates, agent drafts and code imports produce and
 * what agents read. The web materializer lays it out and draws it; positions are never part of it.
 */
export const BoardSpec = z.object({
  title: z.string().max(120).optional(),
  summary: z.string().max(4000).optional(),
  components: z.array(Component.omit({ elementIds: true })).max(300),
  connections: z
    .array(Connection.omit({ elementId: true }))
    .max(600)
    .default([]),
  scenarios: z
    .array(Scenario.extend({ steps: z.array(ScenarioStep.omit({ elementId: true })).max(100) }))
    .max(50)
    .default([]),
  doc: DesignDoc.default({ items: [] }),
  frames: z
    .array(BoardFrame.omit({ elementId: true }))
    .max(50)
    .default([]),
});
export type BoardSpec = z.infer<typeof BoardSpec>;

/** Excalidraw scene as stored: elements are kept opaque (validated by Excalidraw itself on load). */
export const BoardScene = z.object({
  elements: z.array(z.record(z.string(), z.unknown())).max(20_000),
  appState: z.record(z.string(), z.unknown()).default({}),
  files: z.record(z.string(), z.unknown()).default({}),
});

export const BoardDocument = z.object({
  schemaVersion: z.literal(BOARD_SCHEMA_VERSION),
  scene: BoardScene,
  components: z.record(localId, Component).default({}),
  connections: z.record(localId, Connection).default({}),
  scenarios: z.array(Scenario).max(50).default([]),
  doc: DesignDoc.default({ items: [] }),
  frames: z.array(BoardFrame).max(50).default([]),
});
export type BoardDocument = z.infer<typeof BoardDocument>;

export const emptyBoardDocument = (): BoardDocument => ({
  schemaVersion: BOARD_SCHEMA_VERSION,
  scene: { elements: [], appState: {}, files: {} },
  components: {},
  connections: {},
  scenarios: [],
  doc: { items: [] },
  frames: [],
});

export const BoardSource = z.enum(['blank', 'template', 'prompt', 'markdown', 'code']);

export const DesignBoard = z.object({
  id: idSchema('board'),
  projectId: idSchema('project'),
  name: z.string().trim().min(1).max(120),
  document: BoardDocument,
  source: BoardSource,
  templateId: z.string().max(60).optional(),
  /** Board whose component this one shows the internals of. */
  parentBoardId: idSchema('board').optional(),
  revision: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type DesignBoard = z.infer<typeof DesignBoard>;

/** List row: everything but the document. */
export const DesignBoardSummary = DesignBoard.omit({ document: true }).extend({
  componentCount: z.number().int().nonnegative(),
});
export type DesignBoardSummary = z.infer<typeof DesignBoardSummary>;

export const DesignBoardCreate = z.object({
  name: z.string().trim().min(1).max(120),
  source: BoardSource.default('blank'),
  templateId: z.string().max(60).optional(),
  parentBoardId: idSchema('board').optional(),
  document: BoardDocument.optional(),
});
export const DesignBoardPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  document: BoardDocument.optional(),
  /** Optimistic concurrency, as for overlays: the revision the client edited. */
  revision: z.number().int().nonnegative(),
});
