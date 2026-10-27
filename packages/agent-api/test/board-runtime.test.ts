/* eslint-disable @typescript-eslint/no-explicit-any -- tool payloads */
import { describe, expect, it } from 'vitest';
import { BOARD_TEMPLATES, BoardSpec, type DesignJobRequest } from '@atlas/schema';
import {
  BOARD_PROMPT_TEMPLATE_VERSION,
  buildDesignPrompt,
  createMockDesignRuntime,
  critiqueRules,
  explainScenario,
  implementationPlan,
  matchTemplate,
  variantOf,
  type DesignRuntimeContext,
  type DesignToolset,
} from '../src/index.ts';

const JOB = `djb_${'b'.repeat(32)}`;
const BRD = `brd_${'e'.repeat(32)}`;
const shortener = BOARD_TEMPLATES.find((t) => t.id === 'url-shortener')!.spec;

const req = (over: Partial<DesignJobRequest>): DesignJobRequest => ({
  kind: 'critique-board',
  runtime: 'mock',
  depth: 3,
  maxSubsystemsPerLevel: 8,
  targetIds: [],
  replaceProposals: false,
  boardId: BRD,
  ...over,
});

const spec = (s: Partial<BoardSpec>) =>
  BoardSpec.parse({ components: [], connections: [], scenarios: [], doc: { items: [] }, ...s });
const c = (id: string, type: string, props: Record<string, unknown> = {}, extra = {}) => ({
  id,
  type,
  label: id.toUpperCase(),
  props,
  ...extra,
});
const k = (id: string, from: string, to: string, extra = {}) => ({ id, from, to, ...extra });

function boardTools(board: BoardSpec, name = 'Shop') {
  const calls: { name: string; args: any }[] = [];
  const tools: DesignToolset = {
    async list() {
      return [];
    },
    async close() {},
    async call(n, args: any) {
      calls.push({ name: n, args: structuredClone(args) });
      let data: any;
      if (n === 'atlas_get_board') data = { boardId: args.boardId, name, spec: board };
      else if (n === 'atlas_propose_board' || n === 'atlas_create_board')
        data = { boardId: BRD, accepted: [], rejected: [] };
      return { isError: false, text: JSON.stringify(data), data };
    },
  };
  return { tools, calls };
}
const ctx = (tools: DesignToolset): DesignRuntimeContext => ({
  jobId: JOB,
  projectId: `proj_${'c'.repeat(32)}`,
  rootPath: '/nonexistent',
  tools,
  prompt: 'p',
  promptTemplateVersion: BOARD_PROMPT_TEMPLATE_VERSION,
  budget: { maxInputTokens: 1, maxOutputTokens: 1 },
  emit: () => undefined,
  signal: new AbortController().signal,
});

describe('mock design-board agent (D03c)', () => {
  it('drafts from the best-matching template, or a generic three-tier design', async () => {
    expect(matchTemplate('design a url shortener')?.id).toBe('url-shortener');
    expect(matchTemplate('a todo list')).toBeUndefined();
    const f = boardTools(spec({}));
    const rt = createMockDesignRuntime();
    await rt.run(
      req({ kind: 'draft-board', boardId: undefined, prompt: 'Design a TinyURL clone' }),
      ctx(f.tools),
    );
    expect(f.calls[0]).toMatchObject({
      name: 'atlas_create_board',
      args: { name: 'URL shortener', model: 'mock-design' },
    });
    expect(f.calls[0]!.args.spec.components).toHaveLength(shortener.components.length);
    const g = boardTools(spec({}));
    await rt.run(
      req({ kind: 'draft-board', boardId: undefined, prompt: 'build me a garden journal app!' }),
      ctx(g.tools),
    );
    expect(g.calls[0]!.args.name).toBe('Garden journal app');
    expect(g.calls[0]!.args.spec.components.map((x: any) => x.type)).toEqual([
      'actor',
      'web-client',
      'load-balancer',
      'service',
      'sql-db',
    ]);
  });

  it('redraft proposes only what is missing, wired to existing components', async () => {
    const f = boardTools(
      spec({ components: [c('mine', 'service', {}, { label: 'Shortener API' })] as never }),
    );
    await createMockDesignRuntime().run(
      req({ kind: 'draft-board', prompt: 'url shortener' }),
      ctx(f.tools),
    );
    const sent = f.calls.find((x) => x.name === 'atlas_propose_board')!.args.spec;
    expect(sent.components.map((x: any) => x.label)).not.toContain('Shortener API');
    expect(sent.connections.find((x: any) => x.id === 'c3')).toMatchObject({
      from: 'lb',
      to: 'mine',
    });
  });

  it('critique rules: SPOF, missing cache, security edge, missing queue, unbounded growth, consistency, ownership', () => {
    const items = critiqueRules(
      spec({
        components: [
          c('u', 'web-client'),
          c('api', 'service', { instances: 1 }),
          c('svc2', 'service', {}, { responsibility: 'billing' }),
          c('db', 'sql-db', { replication: 'none' }),
          c('w', 'worker'),
          c('s', 'event-stream'),
        ] as never,
        connections: [
          k('k1', 'u', 'api'),
          k('k2', 'api', 'db', { volume: '~1.5k rps' }),
          k('k3', 'svc2', 'db'),
          k('k4', 'api', 's'),
        ] as never,
      }),
    );
    const cats = items.map((i) => /^\[([^\]]+)\]/.exec(i.text)?.[1] ?? i.section);
    expect(cats).toEqual(
      expect.arrayContaining([
        'SPOF',
        'Missing cache',
        'Data consistency',
        'Missing queue',
        'Unbounded growth',
        'Security edge',
        'Unclear ownership',
        'decisions',
      ]),
    );
    // every finding cites component ids
    expect(items.every((i) => i.pins.length > 0)).toBe(true);
    expect(items.find((i) => i.text.startsWith('[SPOF] API'))!.pins).toEqual(['api']);
    // a cached, load-balanced, authenticated design is clean on those counts
    const clean = critiqueRules(
      spec({
        components: [
          c('u', 'web-client'),
          c('gw', 'api-gateway', { auth: 'jwt' }),
          c('api', 'service', { instances: 3 }, { responsibility: 'x' }),
          c('cache', 'cache'),
          c('db', 'sql-db'),
        ] as never,
        connections: [
          k('k1', 'u', 'gw'),
          k('k2', 'gw', 'api'),
          k('k3', 'api', 'cache'),
          k('k4', 'api', 'db', { volume: '5k rps' }),
        ] as never,
      }),
    );
    expect(clean).toEqual([]);
  });

  it('critique proposes doc items in risks/decisions through atlas_propose_board', async () => {
    const f = boardTools(BoardSpec.parse(shortener));
    const r = await createMockDesignRuntime().run(req({ kind: 'critique-board' }), ctx(f.tools));
    const sent = f.calls.find((x) => x.name === 'atlas_propose_board')!.args;
    expect(sent.boardId).toBe(BRD);
    expect(sent.spec.doc.items.every((i: any) => ['risks', 'decisions'].includes(i.section))).toBe(
      true,
    );
    expect(r.output?.text).toMatch(/risk\(s\)/);
  });

  it('explains a scenario hop by hop, proposes a variant and writes a ticketed plan', () => {
    const s = BoardSpec.parse(shortener);
    const text = explainScenario(s, 's1');
    expect(text.split('\n').filter((l) => /^\d\. /.test(l))).toHaveLength(5);
    expect(text).toMatch(/Shortener API → Click events, over Kafka, asynchronously/);

    const v = variantOf(s);
    expect(v.idea).toMatch(/read cache in front of|async jobs|read replica/);
    expect(v.spec.components.length).toBe(s.components.length + 1);
    // deterministic
    expect(variantOf(s)).toEqual(v);

    const plan = implementationPlan('Shortener', s, 'mock-design');
    expect(plan).toMatch(/^# Implementation plan: Shortener/);
    expect(plan.match(/^### T\d+ — /gm)!.length).toBeGreaterThanOrEqual(8);
    expect(plan).toMatch(/- \[ \] /);
    expect(plan).not.toMatch(/### T\d+ — Users/); // actors are not tickets
    expect(plan).toMatch(/## Agent brief\n\n```text\n[\s\S]+\n```$/);
  });

  it('board prompts are versioned, name the board and only the Atlas tools', () => {
    const p = buildDesignPrompt({ request: req({ kind: 'critique-board' }) });
    expect(p).toContain(BOARD_PROMPT_TEMPLATE_VERSION);
    expect(p).toContain(BRD);
    expect(p).toMatch(
      /SPOF, Missing cache\/queue, Unbounded growth, Unclear ownership, Security edge, Data consistency/,
    );
    expect(p).toMatch(/cites the component ids/);
    const d = buildDesignPrompt({
      request: req({ kind: 'draft-board', boardId: undefined, prompt: 'chat app' }),
    });
    expect(d).toMatch(/atlas_create_board/);
    expect(d).toContain('"""chat app"""');
    expect(buildDesignPrompt({ request: req({ kind: 'implementation-plan' }) })).toMatch(
      /## Agent brief/,
    );
    expect(
      buildDesignPrompt({ request: req({ kind: 'explain-scenario', scenarioId: 's1' }) }),
    ).toMatch(/scenario s1/);
  });
});
