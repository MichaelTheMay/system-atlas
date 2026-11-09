import type { BoardSpec } from './design-board.ts';

/**
 * Starter boards (D03). Shared by the web "New board" dialog, the CLI and the mock design agent
 * (whose "draft from prompt" picks the closest template). Layout-free: the web materializer lays
 * them out.
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

const d = (
  id: string,
  section: BoardSpec['doc']['items'][number]['section'],
  text: string,
  pins: string[] = [],
) => ({ id, section, text, pins, origin: user, status: 'active' as const });

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
  {
    id: 'chat',
    name: 'Chat / messaging app',
    description:
      'Real-time 1:1 and group chat: WebSocket gateways hold connections, a pub/sub bus fans messages out, a wide-column store keeps history, push covers offline users.',
    keywords: ['chat', 'messaging', 'message', 'whatsapp', 'slack', 'realtime', 'websocket', 'im'],
    spec: {
      title: 'Chat / messaging app',
      summary:
        'Deliver messages between online users in < 200 ms, keep history forever, and reach offline users by push.',
      components: [
        c('user', 'actor', 'Users', { count: '50M MAU' }),
        c('mobile', 'mobile-client', 'Mobile app', { platform: 'iOS / Android' }),
        c('web', 'web-client', 'Web app'),
        c('lb', 'load-balancer', 'Load balancer', { layer: 'L4', algorithm: 'least-conn' }),
        c('gw', 'websocket', 'WebSocket gateway', { fanout: 'pubsub' }),
        c('auth', 'auth', 'Auth', { protocol: 'jwt' }),
        c('presence', 'service', 'Presence service', { stateful: true, instances: 6 }),
        c('chat', 'service', 'Chat service', { scaling: 'horizontal', instances: 12 }),
        c('bus', 'topic', 'Fan-out bus', { engine: 'redis', delivery: 'at-most-once' }),
        c('store', 'nosql-db', 'Message store', {
          engine: 'cassandra',
          replication: 'sharded',
          consistency: 'tunable',
        }),
        c('media', 'object-storage', 'Media storage', { provider: 'S3' }),
        c('push', 'worker', 'Push worker', { concurrency: 32 }),
        c('apns', 'email-sms', 'APNs / FCM', { provider: 'Apple / Google' }),
      ],
      connections: [
        link('k1', 'user', 'mobile', { payload: 'chat' }),
        link('k2', 'user', 'web', { payload: 'chat' }),
        link('k3', 'mobile', 'lb', {
          protocol: 'WebSocket',
          direction: 'bidirectional',
          volume: '~5M conns',
        }),
        link('k4', 'web', 'lb', { protocol: 'WebSocket', direction: 'bidirectional' }),
        link('k5', 'lb', 'gw', { protocol: 'WebSocket', direction: 'bidirectional' }),
        link('k6', 'gw', 'auth', { protocol: 'gRPC', payload: 'VerifyToken' }),
        link('k7', 'gw', 'presence', {
          protocol: 'gRPC',
          mode: 'async',
          direction: 'one-way',
          payload: 'heartbeat',
        }),
        link('k8', 'gw', 'chat', { protocol: 'gRPC', payload: 'SendMessage', volume: '~50k rps' }),
        link('k9', 'chat', 'store', { protocol: 'other', payload: 'append message' }),
        link('k10', 'chat', 'bus', {
          protocol: 'other',
          mode: 'async',
          direction: 'one-way',
          payload: 'message.sent',
        }),
        link('k11', 'bus', 'push', {
          protocol: 'other',
          mode: 'async',
          direction: 'one-way',
          payload: 'offline recipients',
        }),
        link('k12', 'push', 'apns', { protocol: 'HTTP', payload: 'notification' }),
        link('k13', 'mobile', 'media', { protocol: 'HTTP', payload: 'presigned upload' }),
      ],
      scenarios: [
        {
          id: 's1',
          name: 'Send a message to an online friend',
          steps: [
            {
              id: 's1-1',
              connectionId: 'k3',
              text: 'The app sends the message over its open socket.',
            },
            {
              id: 's1-2',
              connectionId: 'k8',
              text: 'The gateway forwards it to the chat service with the sender id.',
            },
            {
              id: 's1-3',
              connectionId: 'k9',
              text: 'The chat service assigns a per-conversation sequence number and appends it.',
            },
            {
              id: 's1-4',
              connectionId: 'k10',
              text: 'It publishes message.sent on the conversation channel.',
            },
            {
              id: 's1-5',
              componentId: 'gw',
              text: 'The gateway holding the friend’s socket pushes it down; an ack updates read state.',
            },
          ],
          origin: user,
          status: 'active',
        },
        {
          id: 's2',
          name: 'Reach an offline user',
          steps: [
            { id: 's2-1', connectionId: 'k10', text: 'message.sent is published as usual.' },
            {
              id: 's2-2',
              connectionId: 'k11',
              text: 'Presence says the recipient has no socket: the push worker picks it up.',
            },
            {
              id: 's2-3',
              connectionId: 'k12',
              text: 'A notification goes out through APNs / FCM.',
            },
          ],
          origin: user,
          status: 'active',
        },
      ],
      doc: {
        items: [
          d(
            'd1',
            'requirements',
            '1:1 and group chat (≤ 500 members), history, read receipts, media.',
            ['chat'],
          ),
          d(
            'd2',
            'nfr',
            'Delivery p99 < 200 ms between online users; no message loss once acked.',
            ['gw', 'chat'],
          ),
          d(
            'd3',
            'estimates',
            '50M MAU, 10M concurrent sockets, 40 msgs/user/day ≈ 25k msgs/s average, 100k peak; 1 KB/msg ≈ 2 TB/day.',
            ['store', 'gw'],
          ),
          d(
            'd4',
            'data-model',
            'messages(conversation_id, seq, sender, body, sent_at) partitioned by conversation.',
            ['store'],
          ),
          d(
            'd5',
            'decisions',
            'Per-conversation sequence numbers instead of wall clocks: ordering survives clock skew.',
            ['chat'],
          ),
          d(
            'd6',
            'risks',
            'Huge groups amplify fan-out; a gateway restart drops thousands of sockets at once (reconnect storms).',
            ['bus', 'gw'],
          ),
        ],
      },
      frames: [
        { id: 'f-clients', label: 'Clients', componentIds: ['user', 'mobile', 'web'] },
        {
          id: 'f-realtime',
          label: 'Realtime edge',
          componentIds: ['lb', 'gw', 'auth', 'presence'],
        },
        { id: 'f-core', label: 'Messaging core', componentIds: ['chat', 'bus', 'store', 'media'] },
        { id: 'f-offline', label: 'Offline delivery', componentIds: ['push', 'apns'] },
      ],
    },
  },
  {
    id: 'social-feed',
    name: 'Social feed',
    description:
      'Post, follow and read a home timeline: writes fan out to follower feeds through an event stream, reads come from a precomputed feed cache.',
    keywords: ['social', 'feed', 'timeline', 'twitter', 'instagram', 'news feed', 'follow', 'post'],
    spec: {
      title: 'Social feed',
      summary: 'Publish posts and serve each user a ranked home timeline in < 300 ms.',
      components: [
        c('user', 'actor', 'Users', { count: '200M DAU' }),
        c('app', 'mobile-client', 'Mobile app'),
        c('cdn', 'cdn', 'CDN', { provider: 'CloudFront', ttl: '1d' }),
        c('gw', 'api-gateway', 'API gateway', { auth: 'oauth2', rateLimit: '50 rps/user' }),
        c('posts', 'service', 'Post service', { instances: 8 }),
        c('feed', 'service', 'Feed service', { instances: 24, slo: 'p99 < 300 ms' }),
        c('graph', 'sql-db', 'Social graph', { engine: 'mysql', replication: 'sharded' }),
        c('postdb', 'nosql-db', 'Posts DB', { engine: 'cassandra', consistency: 'eventual' }),
        c('stream', 'event-stream', 'Post events', { engine: 'kafka', partitions: 64 }),
        c('fanout', 'worker', 'Fan-out worker', { instances: 16, concurrency: 64 }),
        c('timeline', 'cache', 'Timeline cache', { engine: 'redis', ttl: '7d', sizeGb: 2000 }),
        c('media', 'object-storage', 'Media storage', { provider: 'S3' }),
        c('rank', 'service', 'Ranking service', { instances: 6 }),
      ],
      connections: [
        link('k1', 'user', 'app'),
        link('k2', 'app', 'cdn', { protocol: 'HTTP', payload: 'images, video' }),
        link('k3', 'cdn', 'media', { protocol: 'HTTP', payload: 'cache miss' }),
        link('k4', 'app', 'gw', { protocol: 'HTTP', payload: 'REST', volume: '~300k rps' }),
        link('k5', 'gw', 'posts', { protocol: 'gRPC', payload: 'CreatePost' }),
        link('k6', 'gw', 'feed', { protocol: 'gRPC', payload: 'GetTimeline', volume: '~250k rps' }),
        link('k7', 'posts', 'postdb', { protocol: 'other', payload: 'insert post' }),
        link('k8', 'posts', 'stream', {
          protocol: 'Kafka',
          mode: 'async',
          direction: 'one-way',
          payload: 'post.created',
        }),
        link('k9', 'stream', 'fanout', {
          protocol: 'Kafka',
          mode: 'async',
          direction: 'one-way',
          payload: 'post.created',
        }),
        link('k10', 'fanout', 'graph', { protocol: 'SQL', payload: 'followers of author' }),
        link('k11', 'fanout', 'timeline', {
          protocol: 'other',
          mode: 'async',
          direction: 'one-way',
          payload: 'push post id',
        }),
        link('k12', 'feed', 'timeline', { protocol: 'other', payload: 'read ids' }),
        link('k13', 'feed', 'postdb', { protocol: 'other', payload: 'hydrate posts' }),
        link('k14', 'feed', 'rank', { protocol: 'gRPC', payload: 'Score' }),
      ],
      scenarios: [
        {
          id: 's1',
          name: 'Publish a post',
          steps: [
            { id: 's1-1', connectionId: 'k5', text: 'The app posts through the gateway.' },
            { id: 's1-2', connectionId: 'k7', text: 'The post is stored once.' },
            {
              id: 's1-3',
              connectionId: 'k8',
              text: 'post.created goes onto the stream; the user gets 201.',
            },
            {
              id: 's1-4',
              connectionId: 'k10',
              text: 'The fan-out worker pages through the followers.',
            },
            {
              id: 's1-5',
              connectionId: 'k11',
              text: 'It prepends the post id to each follower timeline (celebrities are skipped: pulled at read time).',
            },
          ],
          origin: user,
          status: 'active',
        },
        {
          id: 's2',
          name: 'Read the home timeline',
          steps: [
            { id: 's2-1', connectionId: 'k6', text: 'The app asks for the timeline.' },
            { id: 's2-2', connectionId: 'k12', text: 'Feed service reads the precomputed ids.' },
            { id: 's2-3', connectionId: 'k13', text: 'It hydrates posts in one batched read.' },
            {
              id: 's2-4',
              connectionId: 'k14',
              text: 'Ranking orders the page; media loads from the CDN.',
            },
          ],
          origin: user,
          status: 'active',
        },
      ],
      doc: {
        items: [
          d(
            'd1',
            'requirements',
            'Post text and media, follow users, read a ranked home timeline.',
            ['posts', 'feed'],
          ),
          d('d2', 'nfr', 'Timeline p99 < 300 ms; a new post shows to followers within 5 s.', [
            'feed',
            'fanout',
          ]),
          d(
            'd3',
            'estimates',
            '200M DAU × 20 timeline reads ≈ 46k rps avg; 2 posts/user/day ≈ 4.6k writes/s; avg 200 followers → ~1M timeline inserts/s.',
            ['timeline', 'fanout'],
          ),
          d('d4', 'api', 'POST /posts; GET /timeline?cursor=; POST /follow/{id}.', ['gw']),
          d(
            'd5',
            'decisions',
            'Hybrid fan-out: push on write for normal users, pull on read for accounts with > 100k followers.',
            ['fanout', 'feed'],
          ),
          d(
            'd6',
            'risks',
            'Celebrity posts create write storms; cache loss means a slow cold rebuild.',
            ['timeline'],
          ),
        ],
      },
      frames: [
        { id: 'f-edge', label: 'Clients & edge', componentIds: ['user', 'app', 'cdn', 'gw'] },
        {
          id: 'f-write',
          label: 'Write path',
          componentIds: ['posts', 'stream', 'fanout', 'graph'],
        },
        { id: 'f-read', label: 'Read path', componentIds: ['feed', 'timeline', 'rank'] },
        { id: 'f-storage', label: 'Storage', componentIds: ['postdb', 'media'] },
      ],
    },
  },
  {
    id: 'payments',
    name: 'Payments / checkout',
    description:
      'Checkout with idempotent payment intents: card data stays inside a PCI trust boundary, a provider charges the card, a ledger records every movement.',
    keywords: ['payment', 'payments', 'checkout', 'stripe', 'billing', 'order', 'cart', 'pci'],
    spec: {
      title: 'Payments / checkout',
      summary: 'Take an order and charge exactly once, keeping card data inside the PCI zone.',
      components: [
        c('user', 'actor', 'Shoppers'),
        c('web', 'web-client', 'Storefront'),
        c('gw', 'api-gateway', 'API gateway', { auth: 'jwt' }),
        c('checkout', 'service', 'Checkout service', { instances: 4 }),
        c('orders', 'sql-db', 'Orders DB', { engine: 'postgres', consistency: 'strong' }),
        c('idem', 'kv-store', 'Idempotency keys', { engine: 'redis' }),
        c('pci', 'trust-boundary', 'PCI zone'),
        c(
          'payment',
          'service',
          'Payment service',
          { instances: 3, slo: 'p99 < 800 ms' },
          { parentId: 'pci' },
        ),
        c('vault', 'config-secrets', 'Card vault', { provider: 'tokenizer' }, { parentId: 'pci' }),
        c('ledger', 'sql-db', 'Ledger', { engine: 'postgres', replication: 'primary-replica' }),
        c('psp', 'payments', 'Payment provider', { provider: 'Stripe' }),
        c('hooks', 'webhook', 'PSP webhooks', { retries: 5 }),
        c('events', 'queue', 'Payment events', { engine: 'sqs', delivery: 'at-least-once' }),
        c('email', 'email-sms', 'Receipts', { provider: 'SES' }),
      ],
      connections: [
        link('k1', 'user', 'web'),
        link('k2', 'web', 'gw', { protocol: 'HTTP', payload: 'POST /checkout' }),
        link('k3', 'gw', 'checkout', { protocol: 'HTTP' }),
        link('k4', 'checkout', 'idem', { protocol: 'other', payload: 'SETNX key' }),
        link('k5', 'checkout', 'orders', { protocol: 'SQL', payload: 'order row' }),
        link('k6', 'checkout', 'payment', { protocol: 'gRPC', payload: 'CreateCharge' }),
        link('k7', 'payment', 'vault', { protocol: 'gRPC', payload: 'detokenize' }),
        link('k8', 'payment', 'psp', { protocol: 'HTTP', payload: 'charge', volume: '~200 rps' }),
        link('k9', 'payment', 'ledger', { protocol: 'SQL', payload: 'double entry' }),
        link('k10', 'psp', 'hooks', {
          protocol: 'HTTP',
          mode: 'async',
          direction: 'one-way',
          payload: 'charge.succeeded',
        }),
        link('k11', 'hooks', 'events', {
          protocol: 'AMQP',
          mode: 'async',
          direction: 'one-way',
          payload: 'payment.settled',
        }),
        link('k12', 'events', 'email', {
          protocol: 'SMTP',
          mode: 'async',
          direction: 'one-way',
          payload: 'receipt',
        }),
      ],
      scenarios: [
        {
          id: 's1',
          name: 'Pay for an order',
          steps: [
            {
              id: 's1-1',
              connectionId: 'k2',
              text: 'The storefront submits the cart with an idempotency key.',
            },
            {
              id: 's1-2',
              connectionId: 'k4',
              text: 'Checkout claims the key; a retry gets the first result.',
            },
            { id: 's1-3', connectionId: 'k5', text: 'The order is written as pending.' },
            {
              id: 's1-4',
              connectionId: 'k6',
              text: 'Checkout asks the payment service to charge the token.',
            },
            {
              id: 's1-5',
              connectionId: 'k8',
              text: 'The provider authorizes and captures the card.',
            },
            {
              id: 's1-6',
              connectionId: 'k9',
              text: 'Debit and credit entries are recorded in the ledger.',
            },
            {
              id: 's1-7',
              connectionId: 'k10',
              text: 'The settlement webhook confirms asynchronously.',
            },
          ],
          origin: user,
          status: 'active',
        },
      ],
      doc: {
        items: [
          d(
            'd1',
            'requirements',
            'Checkout a cart, charge a saved or new card, refunds, receipts.',
            ['checkout', 'payment'],
          ),
          d(
            'd2',
            'nfr',
            'Never double-charge; card data only inside the PCI zone; 99.95% checkout availability.',
            ['idem', 'pci'],
          ),
          d('d3', 'estimates', 'Peak 200 checkouts/s on sale days; ledger grows ~50M rows/month.', [
            'ledger',
          ]),
          d(
            'd4',
            'api',
            'POST /checkout {cartId, paymentMethodToken} with Idempotency-Key header → {orderId, status}.',
            ['gw', 'checkout'],
          ),
          d(
            'd5',
            'data-model',
            'ledger_entries(id, txn_id, account, amount_minor, currency, direction) — sums to zero per txn.',
            ['ledger'],
          ),
          d(
            'd6',
            'decisions',
            'Tokenize at the edge so only the payment service and vault are in PCI scope.',
            ['vault', 'pci'],
          ),
          d(
            'd7',
            'risks',
            'Provider timeouts leave charges unknown: reconcile from webhooks, never retry blindly.',
            ['psp', 'hooks'],
          ),
        ],
      },
      frames: [
        {
          id: 'f-checkout',
          label: 'Checkout',
          componentIds: ['user', 'web', 'gw', 'checkout', 'orders', 'idem'],
        },
        { id: 'f-pay', label: 'Payments', componentIds: ['pci', 'ledger', 'psp'] },
        { id: 'f-async', label: 'Settlement', componentIds: ['hooks', 'events', 'email'] },
      ],
    },
  },
  {
    id: 'upload-pipeline',
    name: 'File upload & processing pipeline',
    description:
      'Clients upload straight to object storage with presigned URLs; a queue drives scanning and transcoding workers in a private network; results are served through a CDN.',
    keywords: [
      'upload',
      'file',
      'video',
      'image',
      'transcode',
      'pipeline',
      'processing',
      'media',
      'youtube',
    ],
    spec: {
      title: 'File upload & processing pipeline',
      summary:
        'Accept large uploads reliably, process them asynchronously and serve the results fast.',
      components: [
        c('user', 'actor', 'Creators'),
        c('web', 'web-client', 'Upload UI'),
        c('gw', 'api-gateway', 'API gateway', { auth: 'jwt' }),
        c('api', 'service', 'Upload API', { instances: 3 }),
        c('meta', 'sql-db', 'File metadata', { engine: 'postgres' }),
        c('raw', 'object-storage', 'Raw uploads', { provider: 'S3' }),
        c('queue', 'queue', 'Processing queue', {
          engine: 'sqs',
          delivery: 'at-least-once',
          retention: '4d',
        }),
        c('vpc', 'network-zone', 'Processing VPC', { cidr: '10.20.0.0/16' }),
        c('scan', 'worker', 'Virus scanner', { instances: 4 }, { parentId: 'vpc' }),
        c(
          'transcode',
          'worker',
          'Transcoder',
          { scaling: 'horizontal', concurrency: 2 },
          { parentId: 'vpc' },
        ),
        c('out', 'object-storage', 'Processed files', { provider: 'S3' }),
        c('cdn', 'cdn', 'CDN', { ttl: '30d' }),
        c('notify', 'webhook', 'Status webhook', { retries: 5 }),
        c('cleanup', 'cron', 'Cleanup job', { schedule: '0 3 * * *' }),
      ],
      connections: [
        link('k1', 'user', 'web'),
        link('k2', 'web', 'gw', { protocol: 'HTTP', payload: 'POST /uploads' }),
        link('k3', 'gw', 'api', { protocol: 'HTTP' }),
        link('k4', 'api', 'meta', { protocol: 'SQL', payload: 'upload row' }),
        link('k5', 'web', 'raw', { protocol: 'HTTP', payload: 'presigned PUT', volume: '~2 GB/s' }),
        link('k6', 'raw', 'queue', {
          protocol: 'other',
          mode: 'async',
          direction: 'one-way',
          payload: 'object.created',
        }),
        link('k7', 'queue', 'scan', {
          protocol: 'AMQP',
          mode: 'async',
          direction: 'one-way',
          payload: 'job',
        }),
        link('k8', 'scan', 'transcode', {
          protocol: 'AMQP',
          mode: 'async',
          direction: 'one-way',
          payload: 'clean file',
        }),
        link('k9', 'transcode', 'out', { protocol: 'HTTP', payload: 'renditions' }),
        link('k10', 'transcode', 'meta', { protocol: 'SQL', payload: 'status = ready' }),
        link('k11', 'cdn', 'out', { protocol: 'HTTP', payload: 'cache miss' }),
        link('k12', 'transcode', 'notify', {
          protocol: 'HTTP',
          mode: 'async',
          direction: 'one-way',
          payload: 'file.ready',
        }),
        link('k13', 'cleanup', 'raw', { protocol: 'HTTP', payload: 'delete stale' }),
      ],
      scenarios: [
        {
          id: 's1',
          name: 'Upload a video',
          steps: [
            {
              id: 's1-1',
              connectionId: 'k2',
              text: 'The UI asks for an upload; the API records it and returns a presigned URL.',
            },
            {
              id: 's1-2',
              connectionId: 'k5',
              text: 'The browser PUTs the file straight to storage (multipart, resumable).',
            },
            {
              id: 's1-3',
              connectionId: 'k6',
              text: 'Storage emits object.created onto the queue.',
            },
            {
              id: 's1-4',
              connectionId: 'k7',
              text: 'A scanner takes the job; infected files are quarantined.',
            },
            { id: 's1-5', connectionId: 'k9', text: 'The transcoder writes renditions.' },
            {
              id: 's1-6',
              connectionId: 'k12',
              text: 'file.ready is delivered to the customer’s webhook.',
            },
          ],
          origin: user,
          status: 'active',
        },
      ],
      doc: {
        items: [
          d(
            'd1',
            'requirements',
            'Upload files up to 20 GB, resumable; scan; transcode to 3 renditions; notify when ready.',
            ['api', 'transcode'],
          ),
          d(
            'd2',
            'nfr',
            'Upload bandwidth never touches app servers; ready within 2× video length.',
            ['raw', 'transcode'],
          ),
          d(
            'd3',
            'estimates',
            '100k uploads/day × 500 MB ≈ 50 TB/day raw; transcoding ~2 CPU-min per minute of video.',
            ['raw', 'transcode'],
          ),
          d(
            'd4',
            'decisions',
            'Presigned direct-to-storage uploads instead of proxying through the API.',
            ['raw', 'api'],
          ),
          d(
            'd5',
            'risks',
            'Poison files can loop forever: dead-letter after 3 attempts and alert.',
            ['queue'],
          ),
        ],
      },
      frames: [
        {
          id: 'f-ingest',
          label: 'Ingest',
          componentIds: ['user', 'web', 'gw', 'api', 'meta', 'raw'],
        },
        {
          id: 'f-process',
          label: 'Processing',
          componentIds: ['queue', 'vpc', 'notify', 'cleanup'],
        },
        { id: 'f-serve', label: 'Serving', componentIds: ['out', 'cdn'] },
      ],
    },
  },
  {
    id: 'rag-app',
    name: 'RAG / LLM app',
    description:
      'Question answering over your documents: an ingestion pipeline chunks and embeds sources into a vector index; the chat API retrieves context and calls an LLM, with traces for evaluation.',
    keywords: [
      'rag',
      'llm',
      'ai',
      'chatbot',
      'retrieval',
      'embedding',
      'vector',
      'gpt',
      'claude',
      'assistant',
    ],
    spec: {
      title: 'RAG / LLM app',
      summary: 'Answer questions grounded in company documents, with citations, in a few seconds.',
      components: [
        c('user', 'actor', 'Employees'),
        c('web', 'web-client', 'Chat UI'),
        c('gw', 'api-gateway', 'API gateway', { auth: 'oauth2', rateLimit: '20 req/min/user' }),
        c('vpc', 'network-zone', 'App VPC'),
        c(
          'chat',
          'service',
          'Chat API',
          { instances: 4, slo: 'first token < 2 s' },
          { parentId: 'vpc' },
        ),
        c('retriever', 'service', 'Retriever', { instances: 3 }, { parentId: 'vpc' }),
        c('vectors', 'search-index', 'Vector index', { engine: 'opensearch' }, { parentId: 'vpc' }),
        c('cache', 'cache', 'Answer cache', { engine: 'redis', ttl: '1h' }, { parentId: 'vpc' }),
        c('ingest', 'worker', 'Ingestion worker', { concurrency: 8 }, { parentId: 'vpc' }),
        c('docs', 'object-storage', 'Source documents', { provider: 'S3' }),
        c('llm', 'llm-provider', 'LLM', { provider: 'Anthropic', model: 'claude' }),
        c('embed', 'llm-provider', 'Embeddings API', { provider: 'Voyage' }),
        c('obs', 'observability', 'Traces & evals', { signals: 'traces, evals' }),
      ],
      connections: [
        link('k1', 'user', 'web'),
        link('k2', 'web', 'gw', {
          protocol: 'HTTP',
          payload: 'POST /ask (SSE)',
          direction: 'request-response',
        }),
        link('k3', 'gw', 'chat', { protocol: 'HTTP' }),
        link('k4', 'chat', 'cache', { protocol: 'other', payload: 'question hash' }),
        link('k5', 'chat', 'retriever', { protocol: 'gRPC', payload: 'Retrieve(q, k=8)' }),
        link('k6', 'retriever', 'embed', { protocol: 'HTTP', payload: 'embed query' }),
        link('k7', 'retriever', 'vectors', { protocol: 'HTTP', payload: 'kNN search' }),
        link('k8', 'chat', 'llm', {
          protocol: 'HTTP',
          payload: 'prompt + context',
          volume: '~30 rps',
        }),
        link('k9', 'chat', 'obs', {
          protocol: 'HTTP',
          mode: 'async',
          direction: 'one-way',
          payload: 'trace',
        }),
        link('k10', 'docs', 'ingest', {
          protocol: 'other',
          mode: 'async',
          direction: 'one-way',
          payload: 'new / changed doc',
        }),
        link('k11', 'ingest', 'embed', { protocol: 'HTTP', payload: 'embed chunks' }),
        link('k12', 'ingest', 'vectors', { protocol: 'HTTP', payload: 'upsert chunks' }),
      ],
      scenarios: [
        {
          id: 's1',
          name: 'Answer a question',
          steps: [
            {
              id: 's1-1',
              connectionId: 'k2',
              text: 'The user asks; the UI opens a streaming request.',
            },
            {
              id: 's1-2',
              connectionId: 'k4',
              text: 'A recent identical question is answered from cache.',
            },
            { id: 's1-3', connectionId: 'k6', text: 'The retriever embeds the question.' },
            {
              id: 's1-4',
              connectionId: 'k7',
              text: 'It fetches the 8 nearest chunks, filtered by the user’s permissions.',
            },
            {
              id: 's1-5',
              connectionId: 'k8',
              text: 'The chat API prompts the LLM with the chunks and streams the answer with citations.',
            },
            {
              id: 's1-6',
              connectionId: 'k9',
              text: 'The trace (question, chunks, answer) is recorded for evals.',
            },
          ],
          origin: user,
          status: 'active',
        },
        {
          id: 's2',
          name: 'Ingest a document',
          steps: [
            {
              id: 's2-1',
              connectionId: 'k10',
              text: 'A new or changed document triggers ingestion.',
            },
            {
              id: 's2-2',
              connectionId: 'k11',
              text: 'It is split into ~500-token chunks and embedded.',
            },
            {
              id: 's2-3',
              connectionId: 'k12',
              text: 'Chunks are upserted with their ACLs and source links.',
            },
          ],
          origin: user,
          status: 'active',
        },
      ],
      doc: {
        items: [
          d(
            'd1',
            'requirements',
            'Ask questions in natural language; answers cite sources; respect document permissions.',
            ['chat', 'retriever'],
          ),
          d(
            'd2',
            'nfr',
            'First token < 2 s; no document leaves the VPC except chunks sent to the model provider.',
            ['chat', 'vpc'],
          ),
          d(
            'd3',
            'estimates',
            '5k employees × 10 questions/day ≈ 0.6 rps avg, 30 rps peak; 2M chunks × 1 KB vectors ≈ 8 GB.',
            ['vectors', 'llm'],
          ),
          d(
            'd4',
            'decisions',
            'Permission filtering in the retriever, not the prompt: the model never sees forbidden text.',
            ['retriever'],
          ),
          d(
            'd5',
            'risks',
            'Stale or missing chunks give confident wrong answers: evals on traces catch regressions.',
            ['obs', 'ingest'],
          ),
        ],
      },
      frames: [
        { id: 'f-app', label: 'Application', componentIds: ['user', 'web', 'gw', 'vpc'] },
        { id: 'f-providers', label: 'Model providers', componentIds: ['llm', 'embed'] },
        { id: 'f-data', label: 'Sources & ops', componentIds: ['docs', 'obs'] },
      ],
    },
  },
];

export const boardTemplate = (id: string): BoardTemplate | undefined =>
  BOARD_TEMPLATES.find((t) => t.id === id);
