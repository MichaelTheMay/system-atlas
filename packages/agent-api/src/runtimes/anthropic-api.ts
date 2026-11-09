import Anthropic from '@anthropic-ai/sdk';
import { isBoardJobKind } from '@atlas/schema';
import type {
  DesignRuntime,
  DesignRuntimeContext,
  DesignRuntimeResult,
} from '../design-runtime.ts';
import { parseAnswer } from './claude-code.ts';

/**
 * Anthropic API runtime (D02c): an in-process tool-use loop over the same Atlas tools, with the
 * user's own API key. The key comes only from the caller's resolver (env `ATLAS_ANTHROPIC_API_KEY`,
 * the keychain or the 0600 secrets file): the SDK is always given it explicitly, so it never falls
 * back to ambient credentials. The key is never logged, returned or put into errors.
 */
export const DEFAULT_ANTHROPIC_DESIGN_MODEL = 'claude-sonnet-5-5';

/** The part of the SDK the loop uses (tests inject a fake). */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
}

export interface AnthropicRuntimeOptions {
  /** Resolves the API key at run time (undefined = not configured). */
  apiKey?: () => Promise<string | undefined>;
  /** Injected client (tests); otherwise one is built from the resolved key. */
  client?: MessagesClient;
  model?: string;
  /** Upper bound on model turns per job. */
  maxTurns?: number;
  /** HTTP fetch for the SDK client (tests pass a fake; default global fetch). */
  fetch?: typeof fetch;
  maxRetries?: number;
}

const scrub = (msg: string, key: string | undefined) =>
  (key ? msg.split(key).join('[redacted]') : msg).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]');

export function createAnthropicDesignRuntime(opts: AnthropicRuntimeOptions = {}): DesignRuntime {
  return {
    id: 'anthropic-api',
    async check() {
      if (opts.client) return { available: true, detail: 'API client configured', external: true };
      const key = await opts.apiKey?.().catch(() => undefined);
      return key
        ? { available: true, detail: 'API key configured', external: true }
        : { available: false, detail: 'no API key configured', external: true };
    },
    async run(request, ctx: DesignRuntimeContext): Promise<DesignRuntimeResult> {
      let key: string | undefined;
      let client = opts.client;
      if (!client) {
        key = await opts.apiKey?.();
        if (!key) throw new Error('no Anthropic API key configured');
        // explicit key and no auth token: never ambient ANTHROPIC_* credentials or profiles
        client = new Anthropic({
          apiKey: key,
          authToken: null,
          maxRetries: opts.maxRetries ?? 2,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
      }
      const model = request.model ?? opts.model ?? DEFAULT_ANTHROPIC_DESIGN_MODEL;
      const tools: Anthropic.Tool[] = (await ctx.tools.list()).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));
      const messages: Anthropic.MessageParam[] = [
        {
          role: 'user',
          content:
            request.kind === 'generate'
              ? 'Generate the design now.'
              : isBoardJobKind(request.kind)
                ? 'Do the board task now.'
                : 'Do the task for the selection now.',
        },
      ];
      const usage = { inputTokens: 0, outputTokens: 0 };
      const cap = ctx.budget.maxInputTokens + ctx.budget.maxOutputTokens;
      let finalText = '';
      let reportedModel: string | undefined;
      try {
        for (let turn = 0; turn < (opts.maxTurns ?? 60); turn++) {
          ctx.signal.throwIfAborted();
          const remaining = cap - usage.inputTokens - usage.outputTokens;
          if (remaining <= 0) throw new Error(`token budget of ${cap} reached`);
          const res = await client.messages.create(
            {
              model,
              max_tokens: Math.max(256, Math.min(ctx.budget.maxOutputTokens, 16_000, remaining)),
              system: ctx.prompt,
              tools,
              tool_choice: { type: 'auto' },
              messages,
            },
            { signal: ctx.signal },
          );
          reportedModel = res.model;
          usage.inputTokens += res.usage?.input_tokens ?? 0;
          usage.outputTokens += res.usage?.output_tokens ?? 0;
          ctx.emit({ type: 'usage', jobId: ctx.jobId, ...usage });
          messages.push({ role: 'assistant', content: res.content });
          const calls = res.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          );
          finalText = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          if (res.stop_reason === 'refusal') throw new Error('the model declined the request');
          if (res.stop_reason !== 'tool_use' || !calls.length) break;
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const c of calls) {
            ctx.signal.throwIfAborted();
            const r = await ctx.tools.call(c.name, (c.input ?? {}) as Record<string, unknown>);
            results.push({
              type: 'tool_result',
              tool_use_id: c.id,
              content: r.text.slice(0, 50_000),
              is_error: r.isError,
            });
          }
          messages.push({ role: 'user', content: results });
        }
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        // no `cause`: the provider error may carry the key; only the scrubbed message travels
        // eslint-disable-next-line preserve-caught-error
        throw new Error(scrub(e instanceof Error ? e.message : String(e), key).slice(0, 500));
      }
      return {
        usage,
        model: reportedModel ?? model,
        output:
          request.kind === 'generate'
            ? undefined
            : {
                text: finalText.slice(0, isBoardJobKind(request.kind) ? 20_000 : 4_000),
                data: parseAnswer(finalText),
              },
      };
    },
  };
}
