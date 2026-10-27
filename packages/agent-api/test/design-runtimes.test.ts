/* eslint-disable @typescript-eslint/no-explicit-any -- tool payloads */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignJobEvent, DesignJobRequest } from '@atlas/schema';
import {
  buildDesignPrompt,
  claudeCodeArgs,
  createAnthropicDesignRuntime,
  createClaudeCodeRuntime,
  createMockDesignRuntime,
  DESIGN_PROMPT_TEMPLATE_VERSION,
  type DesignRuntimeContext,
  type DesignToolset,
  type MessagesClient,
} from '../src/index.ts';

const SNAP = `snap_${'a'.repeat(32)}`;
const JOB = `djb_${'b'.repeat(32)}`;
const ent = (n: number) => `ent_${n.toString(16).padStart(32, '0')}`;
const evd = (n: number) => `evd_${n.toString(16).padStart(32, '0')}`;

const request = (over: Partial<DesignJobRequest> = {}): DesignJobRequest => ({
  kind: 'generate',
  runtime: 'mock',
  snapshotId: SNAP,
  depth: 3,
  maxSubsystemsPerLevel: 8,
  targetIds: [],
  replaceProposals: false,
  ...over,
});

/** In-memory stand-in for the Atlas tools: a design root with 9 services in 3 folders and a db. */
function fakeTools() {
  const boxes = [
    ...Array.from({ length: 9 }, (_, i) => ({
      id: ent(i + 1),
      label: `svc${i + 1}`,
      archetype: 'api-service',
      path: `services/${['billing', 'auth', 'search'][i % 3]}/svc${i + 1}/package.json`,
    })),
    { id: ent(20), label: 'db', archetype: 'datastore', path: 'docker-compose.yml' },
    { id: ent(21), label: 'no-evidence', archetype: 'client', path: '' },
  ];
  const calls: { name: string; args: any }[] = [];
  const tools: DesignToolset = {
    async list() {
      return [];
    },
    async close() {},
    async call(name, args: any) {
      calls.push({ name, args: structuredClone(args) });
      let data: any;
      if (name === 'atlas_list_views')
        data = { views: [{ viewId: `cvs_${'1'.repeat(32)}`, lens: 'design-system' }] };
      else if (name === 'atlas_get_view')
        data = {
          nodes: boxes.map((b) => ({
            kind: 'entity',
            entityId: b.id,
            label: b.label,
            archetype: b.archetype,
          })),
        };
      else if (name === 'atlas_get_evidence') {
        const b = boxes.find((x) => x.id === args.entityId)!;
        data = {
          entity: {
            evidence: b.path ? [{ id: evd(parseInt(b.id.slice(4), 16)), path: b.path }] : [],
          },
        };
      } else if (name === 'atlas_get_entity') {
        const b = boxes.find((x) => x.id === args.entityId)!;
        data = {
          entity: { displayName: b.label },
          evidence: [{ id: evd(parseInt(b.id.slice(4), 16)), path: b.path }],
          relations: [{ kind: 'calls', other: { id: ent(20) } }],
        };
      } else if (name === 'atlas_propose_view')
        data = {
          subsystems: args.subsystems.map((s: any) => ({
            name: s.name,
            accepted: s.members.map((m: any) => m.entityId),
            rejected: [],
          })),
        };
      else if (name === 'atlas_propose_claims')
        data = { accepted: args.claims.map((_: any, index: number) => ({ index })), rejected: [] };
      return { isError: false, text: JSON.stringify(data), data };
    },
  };
  return { tools, calls };
}

function ctx(tools: DesignToolset, over: Partial<DesignRuntimeContext> = {}) {
  const events: DesignJobEvent[] = [];
  const c: DesignRuntimeContext = {
    jobId: JOB,
    projectId: `proj_${'c'.repeat(32)}`,
    rootPath: '/nonexistent',
    tools,
    prompt: 'design prompt',
    promptTemplateVersion: DESIGN_PROMPT_TEMPLATE_VERSION,
    budget: { maxInputTokens: 50_000, maxOutputTokens: 4_000 },
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    ...over,
  };
  return { c, events };
}

describe('mock design runtime', () => {
  it('groups top-down through the proposal tool, citing the evidence it read, deterministically', async () => {
    const runOnce = async () => {
      const f = fakeTools();
      const r = await createMockDesignRuntime().run(request(), ctx(f.tools).c);
      return { r, proposals: f.calls.filter((c) => c.name === 'atlas_propose_view') };
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(b.proposals).toEqual(a.proposals);
    expect(a.r).toMatchObject({ model: 'mock-design', usage: { costUsd: 0 } });
    const subs = a.proposals.flatMap((p) => p.args.subsystems);
    // Services had 9 members (> 6): decomposed one level by folder; Data stays a leaf
    expect(subs.map((s: any) => s.name).sort()).toEqual([
      'Data',
      'Services/Auth',
      'Services/Billing',
      'Services/Search',
    ]);
    expect(a.proposals.every((p) => p.args.snapshotId === SNAP && p.args.model === 'mock-design'));
    const members = subs.flatMap((s: any) => s.members);
    expect(members).toHaveLength(10); // the box without evidence is never proposed
    for (const m of members)
      expect(m.citations).toEqual([{ evidenceId: evd(parseInt(m.entityId.slice(4), 16)) }]);
  });

  it('respects depth and the per-level cap', async () => {
    const names = async (over: Partial<DesignJobRequest>) => {
      const f = fakeTools();
      await createMockDesignRuntime().run(request(over), ctx(f.tools).c);
      return f.calls
        .filter((c) => c.name === 'atlas_propose_view')
        .flatMap((c) => c.args.subsystems.map((s: any) => s.name));
    };
    // depth 1: no decomposition even with 9 members
    expect(await names({ depth: 1 })).toEqual(['Data', 'Services']);
    // cap 2: the overflow folders merge into "Other"
    expect(await names({ depth: 2, maxSubsystemsPerLevel: 2 })).toEqual([
      'Data',
      'Services/Auth',
      'Services/Other',
    ]);
  });

  it('answers copilot actions deterministically', async () => {
    const f = fakeTools();
    const name = await createMockDesignRuntime().run(
      request({ kind: 'name-subsystem', targetIds: [ent(2), ent(5)] }),
      ctx(f.tools).c,
    );
    expect(name.output?.data).toEqual({
      name: 'Auth',
      responsibility: 'Groups svc2, svc5.',
      evidenceIds: [evd(2), evd(5)],
    });
    const flow = await createMockDesignRuntime().run(
      request({ kind: 'explain-flow', targetIds: [ent(1), ent(20)] }),
      ctx(f.tools).c,
    );
    expect((flow.output?.data as any).explanation).toBe(
      'svc1 calls db (see services/billing/svc1/package.json).',
    );
    await createMockDesignRuntime().run(
      request({ kind: 'suggest-responsibilities', targetIds: [ent(1)] }),
      ctx(f.tools).c,
    );
    expect(f.calls.at(-1)).toMatchObject({
      name: 'atlas_propose_claims',
      args: { claims: [{ subjectId: ent(1), predicate: 'responsibility' }] },
    });
  });
});

describe('design prompt', () => {
  it('is versioned, carries the snapshot and the recursion rules, and names only Atlas tools', () => {
    const p = buildDesignPrompt({ request: request({ depth: 2 }), snapshotId: SNAP });
    expect(p).toContain(DESIGN_PROMPT_TEMPLATE_VERSION);
    expect(p).toContain(SNAP);
    expect(p).toMatch(/more than 6 members/);
    expect(p).toMatch(/down to 2 level/);
    expect(p).toMatch(/must cite evidence/);
  });
});

// ------------------------------------------------------------------ claude-code (fake binary)

/** A fake `claude` on a private PATH: canned stream-json, never the real CLI. */
function fakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-fake-claude-'));
  const log = join(dir, 'log.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (Fake Claude)'); process.exit(0); }
const cfg = argv[argv.indexOf('--mcp-config') + 1];
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, pid: process.pid, cwd: process.cwd(),
  config: JSON.parse(fs.readFileSync(cfg, 'utf8')), env: Object.keys(process.env) }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const mode = process.env.FAKE_MODE;
out({ type: 'system', subtype: 'init', model: 'claude-fake-1', mcp_servers: [{ name: 'atlas', status: mode === 'mcp-fail' ? 'failed' : mode === 'pending' ? 'pending' : 'connected' }] });
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
if (mode === 'mcp-fail') { setInterval(() => {}, 1000); return; }
if (mode === 'crash') { process.stdout.write('{not json\\n'); process.exit(3); }
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'tu1', name: 'mcp__atlas__atlas_list_views', input: {} }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '{"views":[]}' }] }] } });
process.stdout.write('this line is not json\\n');
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__atlas__atlas_propose_view', input: {} }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: JSON.stringify({ subsystems: [{ name: 'A', accepted: ['e1', 'e2'], rejected: [{ entityId: 'e3' }] }] }) }] } });
if (mode === 'board') {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tb', name: 'mcp__atlas__atlas_propose_board', input: {} }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tb', content: JSON.stringify({ accepted: [{ id: 'agent-a' }, { id: 'agent-b' }], rejected: [{ specId: 'k' }] }) }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: '# Implementation plan\\n' + 'x'.repeat(6000), usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
}
out({ type: 'result', subtype: mode === 'error' ? 'error_max_turns' : 'success', is_error: mode === 'error', result: mode === 'answer' ? '\`\`\`json\\n{"name":"Billing"}\\n\`\`\`' : 'done', usage: { input_tokens: 1234, output_tokens: 56 }, total_cost_usd: 0.01 });
`,
  );
  chmodSync(bin, 0o755);
  const env = (mode: string) => ({
    PATH: `${dir}:${dirname(process.execPath)}`,
    FAKE_LOG: log,
    FAKE_MODE: mode,
    ATLAS_TOKEN: 'must-not-leak',
  });
  const readLog = () => JSON.parse(readFileSync(log, 'utf8'));
  return { env, readLog, log };
}

const atlasMcp = { command: '/usr/bin/node', args: ['/x/apps/cli/src/main.ts', 'mcp', '/repo'] };
const unusedTools = fakeTools().tools;

describe('claude-code runtime (fake claude on PATH)', () => {
  it('builds the documented headless argv with only Atlas tools', () => {
    const a = claudeCodeArgs({ prompt: 'P', mcpConfigPath: '/t/c.json', model: 'm' });
    expect(a.slice(0, 2)).toEqual(['-p', 'P']); // prompt before any variadic flag
    expect(a).toEqual(
      expect.arrayContaining([
        '--output-format',
        'stream-json',
        '--verbose',
        '--strict-mcp-config',
      ]),
    );
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe('Bash,Edit,Write,WebFetch,WebSearch');
    const allowed = a[a.indexOf('--allowedTools') + 1]!.split(',');
    expect(allowed.every((t) => t.startsWith('mcp__atlas__atlas_'))).toBe(true);
    expect(allowed).not.toContain('mcp__atlas__atlas_refresh');
    expect(a.slice(-2)).toEqual(['--mcp-config', '/t/c.json']);
  });

  it('check() reports the version from --version only', async () => {
    const f = fakeClaude();
    expect(await createClaudeCodeRuntime({ env: f.env('ok') }).check()).toEqual({
      available: true,
      detail: '9.9.9 (Fake Claude) on PATH',
      external: true,
    });
    expect(existsSync(f.log)).toBe(false);
    expect(await createClaudeCodeRuntime({ env: { PATH: '/nonexistent' } }).check()).toMatchObject({
      available: false,
      detail: 'claude not found on PATH',
    });
  });

  it('runs claude in a temp cwd, parses tool calls and usage, skips malformed lines', async () => {
    const f = fakeClaude();
    const { c, events } = ctx(unusedTools, { atlasMcp });
    const r = await createClaudeCodeRuntime({ env: f.env('ok') }).run(request(), c);
    expect(r).toEqual({
      usage: { inputTokens: 1234, outputTokens: 56, costUsd: 0.01 },
      model: 'claude-fake-1',
      output: undefined,
    });
    expect(events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', jobId: JOB, tool: 'atlas_list_views', accepted: 0, rejected: 0 },
      { type: 'tool-call', jobId: JOB, tool: 'atlas_propose_view', accepted: 2, rejected: 1 },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'usage',
      jobId: JOB,
      inputTokens: 1234,
      outputTokens: 56,
    });
    const log = f.readLog();
    expect(log.argv.slice(0, 2)).toEqual(['-p', 'design prompt']);
    expect(log.cwd).toMatch(/atlas-design-/);
    expect(existsSync(log.cwd)).toBe(false); // temp dir removed
    expect(log.config).toEqual({
      mcpServers: {
        atlas: { type: 'stdio', command: atlasMcp.command, args: atlasMcp.args, env: {} },
      },
    });
    expect(log.env).not.toContain('ATLAS_TOKEN');
  });

  it('does not fail while the Atlas MCP server is still starting at init', async () => {
    const f = fakeClaude();
    const r = await createClaudeCodeRuntime({ env: f.env('pending') }).run(
      request(),
      ctx(unusedTools, { atlasMcp }).c,
    );
    expect(r.model).toBe('claude-fake-1');
  });

  it('parses a JSON answer for copilot actions', async () => {
    const f = fakeClaude();
    const r = await createClaudeCodeRuntime({ env: f.env('answer') }).run(
      request({ kind: 'name-subsystem', targetIds: [ent(1)] }),
      ctx(unusedTools, { atlasMcp }).c,
    );
    expect(r.output?.data).toEqual({ name: 'Billing' });
  });

  it('fails on an error result, a crash or a failed Atlas MCP server', async () => {
    const f = fakeClaude();
    const rt = (mode: string) => createClaudeCodeRuntime({ env: f.env(mode), killGraceMs: 200 });
    await expect(rt('error').run(request(), ctx(unusedTools, { atlasMcp }).c)).rejects.toThrow(
      /claude reported error_max_turns/,
    );
    await expect(rt('crash').run(request(), ctx(unusedTools, { atlasMcp }).c)).rejects.toThrow(
      /exited with code 3 without a result \(1 unreadable line/,
    );
    await expect(rt('mcp-fail').run(request(), ctx(unusedTools, { atlasMcp }).c)).rejects.toThrow(
      /atlas MCP server failed/,
    );
  });

  it('cancels: kills the child and rejects', async () => {
    const f = fakeClaude();
    const ctrl = new AbortController();
    const run = createClaudeCodeRuntime({ env: f.env('hang'), killGraceMs: 200 }).run(
      request(),
      ctx(unusedTools, { atlasMcp, signal: ctrl.signal }).c,
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(f.log) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const { pid } = f.readLog();
    ctrl.abort(new Error('canceled by the user'));
    await expect(run).rejects.toThrow(/canceled by the user/);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

// ------------------------------------------------------------------ anthropic-api (fake client)

describe('anthropic-api runtime (injected client, no network)', () => {
  it('runs one tool_use round over the Atlas tools and sums usage', async () => {
    const f = fakeTools();
    f.tools.list = async () => [
      { name: 'atlas_list_views', description: 'views', inputSchema: { type: 'object' } },
    ];
    const seen: any[] = [];
    const client: MessagesClient = {
      messages: {
        async create(params, opts) {
          seen.push({ params: structuredClone(params), signal: opts?.signal });
          return (
            seen.length === 1
              ? {
                  model: 'claude-sonnet-5-5',
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu', name: 'atlas_list_views', input: {} }],
                  usage: { input_tokens: 100, output_tokens: 10 },
                }
              : {
                  model: 'claude-sonnet-5-5',
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: '{"name":"Core"}' }],
                  usage: { input_tokens: 150, output_tokens: 5 },
                }
          ) as any;
        },
      },
    };
    const { c, events } = ctx(f.tools);
    const r = await createAnthropicDesignRuntime({ client }).run(
      request({ kind: 'name-subsystem', runtime: 'anthropic-api', targetIds: [ent(1)] }),
      c,
    );
    expect(r).toEqual({
      usage: { inputTokens: 250, outputTokens: 15 },
      model: 'claude-sonnet-5-5',
      output: { text: '{"name":"Core"}', data: { name: 'Core' } },
    });
    expect(seen[0].params).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: 'design prompt',
      tool_choice: { type: 'auto' },
      tools: [{ name: 'atlas_list_views', description: 'views', input_schema: { type: 'object' } }],
    });
    expect(seen[0].params).not.toHaveProperty('temperature');
    expect(seen[0].params).not.toHaveProperty('thinking');
    expect(seen[0].signal).toBe(c.signal);
    expect(seen[1].params.messages.at(-1).content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu',
        content:
          '{"views":[{"viewId":"cvs_11111111111111111111111111111111","lens":"design-system"}]}',
        is_error: false,
      },
    ]);
    expect(f.calls.map((x) => x.name)).toEqual(['atlas_list_views']);
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('builds the real SDK client with only the Atlas key (mocked fetch, ambient credentials ignored)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-api-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-auth-token');
    vi.stubEnv('ANTHROPIC_PROFILE', 'does-not-exist');
    const key = 'sk-ant-atlas-test-' + 'k'.repeat(24);
    const requests: { url: string; headers: Headers; body: any }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const r = await createAnthropicDesignRuntime({
      apiKey: async () => key,
      fetch: fakeFetch,
      maxRetries: 0,
    }).run(request({ runtime: 'anthropic-api' }), ctx(fakeTools().tools).c);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toMatch(/\/v1\/messages$/);
    // SDK 1.3.0 sends the key as a bearer credential; it must be exactly the Atlas key
    const h = requests[0]!.headers;
    const sent = h.get('x-api-key') ?? h.get('authorization')?.replace(/^Bearer /, '');
    expect(sent).toBe(key);
    expect([...h.values()].join(' ')).not.toMatch(/ambient/);
    expect(requests[0]!.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: 'design prompt',
    });
  });

  it('refuses to run without a resolved key (never ambient credentials)', async () => {
    const rt = createAnthropicDesignRuntime({ apiKey: async () => undefined });
    expect(await rt.check()).toMatchObject({ available: false, detail: 'no API key configured' });
    await expect(
      rt.run(request({ runtime: 'anthropic-api' }), ctx(fakeTools().tools).c),
    ).rejects.toThrow('no Anthropic API key configured');
  });

  it('scrubs the key from provider errors', async () => {
    const key = 'sk-ant-secret-' + 'z'.repeat(30);
    const client: MessagesClient = {
      messages: {
        async create() {
          throw new Error(`401 invalid x-api-key ${key}`);
        },
      },
    };
    const err = await createAnthropicDesignRuntime({ client })
      .run(request({ runtime: 'anthropic-api' }), ctx(fakeTools().tools).c)
      .catch((e: Error) => e);
    expect(String(err)).not.toContain(key);
    expect(String(err)).toContain('[redacted]');
  });
});

describe('claude-code runtime on design-board jobs (fake claude)', () => {
  it('allows the board tools, counts board proposals and keeps long plan answers', async () => {
    const allowed = claudeCodeArgs({ prompt: 'P', mcpConfigPath: '/t/c.json' });
    expect(allowed[allowed.indexOf('--allowedTools') + 1]!.split(',')).toEqual(
      expect.arrayContaining([
        'mcp__atlas__atlas_get_board',
        'mcp__atlas__atlas_propose_board',
        'mcp__atlas__atlas_create_board',
        'mcp__atlas__atlas_list_boards',
      ]),
    );
    const f = fakeClaude();
    const { c, events } = ctx(unusedTools, { atlasMcp });
    const r = await createClaudeCodeRuntime({ env: f.env('board') }).run(
      request({
        kind: 'implementation-plan',
        boardId: `brd_${'d'.repeat(32)}`,
        snapshotId: undefined,
      }),
      c,
    );
    expect(r.output?.text).toMatch(/^# Implementation plan/);
    expect(r.output!.text!.length).toBeGreaterThan(4_000);
    expect(events.filter((e) => e.type === 'tool-call').at(-1)).toEqual({
      type: 'tool-call',
      jobId: JOB,
      tool: 'atlas_propose_board',
      accepted: 2,
      rejected: 1,
    });
  });
});

describe('anthropic-api runtime on design-board jobs (injected client)', () => {
  it('asks for the board task and keeps a long explanation', async () => {
    const f = fakeTools();
    const seen: any[] = [];
    const client: MessagesClient = {
      messages: {
        async create(params) {
          seen.push(structuredClone(params));
          return {
            model: 'claude-sonnet-5-5',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: `1. Web → LB over HTTP. ${'y'.repeat(5000)}` }],
            usage: { input_tokens: 10, output_tokens: 10 },
          } as any;
        },
      },
    };
    const r = await createAnthropicDesignRuntime({ client }).run(
      request({
        kind: 'explain-scenario',
        runtime: 'anthropic-api',
        boardId: `brd_${'d'.repeat(32)}`,
        snapshotId: undefined,
      }),
      ctx(f.tools).c,
    );
    expect(seen[0].messages[0].content).toBe('Do the board task now.');
    expect(r.output?.text?.length).toBeGreaterThan(4_000);
  });
});
