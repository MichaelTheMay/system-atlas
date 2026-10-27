import type { BoardSpec } from './design-board.ts';

/**
 * Starter boards (D03). Shared by the web "New board" dialog, the CLI and the mock design agent
 * (whose "draft from prompt" picks the closest template). Layout-free: the web materializer lays
 * them out. Wave 1a adds more (chat, social feed, payments, upload pipeline, RAG app).
 */
export interface BoardTemplate {
  id: string;
  name: string;
  description: string;
  /** Lower-case words a prompt is matched against. */
  keywords: readonly string[];
  spec: BoardSpec;
}

const user = { author: 'template' as const };
const c = (
  id: string,
  type: BoardSpec['components'][number]['type'],
  label: string,
  props: Record<string, string | number | boolean> = {},
  extra: Partial<BoardSpec['components'][number]> = {},
) => ({ id, type, label, props, entityIds: [], origin: user, status: 'active' as const, ...extra });
const link = (
  id: string,
  from: string,
  to: string,
  o: Partial<BoardSpec['connections'][number]> = {},
) => ({
  id,
  from,
  to,
  mode: 'sync' as const,
  direction: 'request-response' as const,
  origin: user,
  status: 'active' as const,
  ...o,
});

export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
  {
    id: 'url-shortener',
    name: 'URL shortener',
    description:
      'Classic read-heavy service: API behind a load balancer, cache in front of the store, async analytics.',
    keywords: ['url', 'shortener', 'short link', 'tinyurl', 'bitly', 'redirect'],
    spec: {
      title: 'URL shortener',
      summary: 'Create short links and redirect at high read volume with low latency.',
      components: [
        c('user', 'actor', 'Users', { count: '10M MAU' }),
        c('web', 'web-client', 'Web app'),
        c('lb', 'load-balancer', 'Load balancer', { layer: 'L7' }),
        c('api', 'service', 'Shortener API', {
          scaling: 'horizontal',
          instances: 4,
          slo: 'p99 < 100 ms',
        }),
        c('cache', 'cache', 'Redirect cache', { engine: 'redis', ttl: '24h', eviction: 'lru' }),
        c('db', 'sql-db', 'Links DB', { engine: 'postgres', replication: 'primary-replica' }),
        c('idgen', 'service', 'ID generator', { scaling: 'horizontal', instances: 2 }),
        c('stream', 'event-stream', 'Click events', { engine: 'kafka', retention: '7d' }),
        c('analytics', 'worker', 'Analytics worker', { concurrency: 8 }),
        c('warehouse', 'warehouse', 'Analytics warehouse', { engine: 'clickhouse' }),
      ],
      connections: [
        link('c1', 'user', 'web', { protocol: 'HTTP', payload: 'browse' }),
        link('c2', 'web', 'lb', {
          protocol: 'HTTP',
          payload: 'GET /{code}, POST /links',
          volume: '~10k rps',
        }),
        link('c3', 'lb', 'api', { protocol: 'HTTP' }),
        link('c4', 'api', 'cache', { protocol: 'other', payload: 'code → url', volume: '~9k rps' }),
        link('c5', 'api', 'db', { protocol: 'SQL', payload: 'links', volume: '~1k rps' }),
        link('c6', 'api', 'idgen', { protocol: 'gRPC', payload: 'NextId' }),
        link('c7', 'api', 'stream', {
          protocol: 'Kafka',
          mode: 'async',
          direction: 'one-way',
          payload: 'click.recorded',
        }),
        link('c8', 'stream', 'analytics', {
          protocol: 'Kafka',
          mode: 'async',
          direction: 'one-way',
          payload: 'click.recorded',
        }),
        link('c9', 'analytics', 'warehouse', {
          protocol: 'SQL',
          mode: 'async',
          direction: 'one-way',
          payload: 'click rows',
        }),
      ],
      scenarios: [
        {
          id: 's1',
          name: 'Redirect a short link',
          steps: [
            { id: 's1-1', connectionId: 'c2', text: 'Browser requests GET /{code}.' },
            {
              id: 's1-2',
              connectionId: 'c3',
              text: 'Load balancer forwards to a healthy API instance.',
            },
            {
              id: 's1-3',
              connectionId: 'c4',
              text: 'API looks the code up in Redis; a hit answers 90% of traffic.',
            },
            {
              id: 's1-4',
              connectionId: 'c5',
              text: 'On a miss, read the row from Postgres and fill the cache.',
            },
            {
              id: 's1-5',
              connectionId: 'c7',
              text: 'Emit click.recorded asynchronously; respond 302 without waiting.',
            },
          ],
          origin: user,
          status: 'active',
        },
      ],
      doc: {
        items: [
          {
            id: 'd1',
            section: 'requirements',
            text: 'Shorten a URL; redirect a short code; optional custom alias and expiry.',
            pins: ['api'],
            origin: user,
            status: 'active',
          },
          {
            id: 'd2',
            section: 'nfr',
            text: 'Reads dominate (100:1). Redirect p99 < 100 ms. 99.9% availability.',
            pins: ['api', 'cache'],
            origin: user,
            status: 'active',
          },
          {
            id: 'd3',
            section: 'estimates',
            text: '10M MAU, 100M redirects/day ≈ 1.2k rps average, 10k rps peak. 500 bytes/link, 1B links ≈ 500 GB.',
            pins: ['db', 'cache'],
            origin: user,
            status: 'active',
          },
          {
            id: 'd4',
            section: 'api',
            text: 'POST /links {url, alias?, expiresAt?} → {code}; GET /{code} → 302 Location.',
            pins: ['api'],
            origin: user,
            status: 'active',
          },
          {
            id: 'd5',
            section: 'data-model',
            text: 'links(code PK, url, owner_id, created_at, expires_at); clicks stream → warehouse table clicks(code, ts, referrer, geo).',
            pins: ['db', 'warehouse'],
            origin: user,
            status: 'active',
          },
          {
            id: 'd6',
            section: 'decisions',
            text: 'Base62 codes from a range-allocating ID generator instead of hashing: no collisions, predictable length.',
            pins: ['idgen'],
            origin: user,
            status: 'active',
          },
          {
            id: 'd7',
            section: 'risks',
            text: 'Hot links can thrash a single cache shard; the primary DB is a write bottleneck past ~5k writes/s.',
            pins: ['cache', 'db'],
            origin: user,
            status: 'active',
          },
        ],
      },
      frames: [
        { id: 'f-edge', label: 'Edge', componentIds: ['user', 'web', 'lb'] },
        { id: 'f-core', label: 'Core', componentIds: ['api', 'cache', 'db', 'idgen'] },
        {
          id: 'f-analytics',
          label: 'Analytics',
          componentIds: ['stream', 'analytics', 'warehouse'],
        },
      ],
    },
  },
];

export const boardTemplate = (id: string): BoardTemplate | undefined =>
  BOARD_TEMPLATES.find((t) => t.id === id);
