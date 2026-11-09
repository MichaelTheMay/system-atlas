import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isBoardJobKind, type DesignJobRequest } from '@atlas/schema';
import type {
  DesignRuntime,
  DesignRuntimeAvailability,
  DesignRuntimeContext,
  DesignRuntimeResult,
} from '../design-runtime.ts';
import { CLAUDE_CODE_ALLOWED_TOOLS, proposalCounts } from '../design-tools.ts';

/**
 * Claude Code runtime (D02c): the user's own Claude account through the documented headless CLI.
 * Atlas spawns `claude -p` with an argv array (no shell) in an empty temp directory, gives it only
 * the Atlas MCP server (`atlas mcp <root>`, which finds the daemon through its discovery record, so
 * no token is written anywhere), removes every built-in tool, and allows only the design-agent
 * Atlas tools. It parses the stream-json output for tool calls, usage and the final result. Atlas
 * never reads Claude Code's own files, tokens or sessions.
 */
export interface ClaudeCodeRuntimeOptions {
  /** Executable name or path (default `claude`, resolved on the PATH of `env`). */
  bin?: string;
  /** Environment for the child (default: this process's, without Atlas secrets). */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock limit for one job (default 30 min). */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL on cancel (default 3 s). */
  killGraceMs?: number;
}

/** Flags taken from `claude --help` (2.1.x); see docs and the D02c PR for the reasoning. */
export function claudeCodeArgs(o: {
  prompt: string;
  mcpConfigPath: string;
  model?: string;
}): string[] {
  return [
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(o.model ? ['--model', o.model] : []),
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
    '--tools',
    '',
    '--disallowedTools',
    'Bash,Edit,Write,WebFetch,WebSearch',
    '--allowedTools',
    CLAUDE_CODE_ALLOWED_TOOLS.join(','),
    // variadic: last, so it cannot swallow other arguments
    '--mcp-config',
    o.mcpConfigPath,
  ];
}

const SECRET_ENV = /^(ATLAS_TOKEN|ATLAS_ANTHROPIC_API_KEY)$/;

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
}

/** JSON object from a model's final answer (bare, or inside a ```json fence); undefined otherwise. */
export function parseAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  try {
    return JSON.parse(fenced.trim());
  } catch {
    return undefined;
  }
}

interface StreamState {
  model?: string;
  toolNames: Map<string, string>;
  result?: { isError: boolean; subtype?: string; text: string };
  usage: DesignRuntimeResult['usage'];
  malformed: number;
  mcpFailed?: string;
}

type Json = Record<string, unknown>;
const obj = (x: unknown): Json | undefined =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : undefined;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);
const shortTool = (name: string) => name.replace(/^mcp__atlas__/, '');

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c) => (obj(c)?.type === 'text' ? String(obj(c)!.text ?? '') : ''))
      .join('\n');
  return '';
}

/** Interpret one stream-json line (untrusted). Returns events to emit. */
export function handleStreamLine(
  line: string,
  s: StreamState,
  jobId: string,
): Parameters<DesignRuntimeContext['emit']>[0][] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let m: Json | undefined;
  try {
    m = obj(JSON.parse(trimmed));
  } catch {
    m = undefined;
  }
  if (!m) {
    s.malformed++;
    return [];
  }
  const out: Parameters<DesignRuntimeContext['emit']>[0][] = [];
  if (m.type === 'system' && m.subtype === 'init') {
    if (typeof m.model === 'string') s.model = m.model.slice(0, 100);
    const servers = Array.isArray(m.mcp_servers) ? m.mcp_servers : [];
    const atlas = servers.map(obj).find((x) => x?.name === 'atlas');
    // only an explicit failure is fatal: a server may still be starting when init is reported
    if (!atlas) s.mcpFailed = 'atlas MCP server missing';
    else if (atlas.status === 'failed' || atlas.status === 'needs-auth')
      s.mcpFailed = `atlas MCP server ${String(atlas.status)}`;
  } else if (m.type === 'assistant' || m.type === 'user') {
    const content = obj(m.message)?.content;
    for (const c of Array.isArray(content) ? content.map(obj) : []) {
      if (!c) continue;
      if (c.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string')
        s.toolNames.set(c.id, c.name);
      if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
        const tool = shortTool(s.toolNames.get(c.tool_use_id) ?? 'unknown').slice(0, 100);
        let data: unknown;
        try {
          data = c.is_error ? undefined : JSON.parse(resultText(c.content));
        } catch {
          data = undefined;
        }
        out.push({ type: 'tool-call', jobId, tool, ...proposalCounts(tool, data) });
      }
    }
  } else if (m.type === 'result') {
    s.result = {
      isError: m.is_error === true || (typeof m.subtype === 'string' && m.subtype !== 'success'),
      subtype: typeof m.subtype === 'string' ? m.subtype : undefined,
      text: typeof m.result === 'string' ? m.result : '',
    };
    const u = obj(m.usage);
    s.usage = {
      inputTokens: num(u?.input_tokens),
      outputTokens: num(u?.output_tokens),
      costUsd: num(m.total_cost_usd),
    };
    out.push({
      type: 'usage',
      jobId,
      inputTokens: s.usage.inputTokens,
      outputTokens: s.usage.outputTokens,
    });
  }
  return out;
}

export function createClaudeCodeRuntime(opts: ClaudeCodeRuntimeOptions = {}): DesignRuntime {
  const bin = opts.bin ?? 'claude';
  const env = () => childEnv(opts.env ?? process.env);
  return {
    id: 'claude-code',
    check(): Promise<DesignRuntimeAvailability> {
      return new Promise((resolve) => {
        execFile(bin, ['--version'], { timeout: 5_000, env: env() }, (err, stdout) => {
          if (err) {
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
            return resolve({
              available: false,
              detail: missing ? `${bin} not found on PATH` : `${bin} --version failed`,
              external: true,
            });
          }
          const v = String(stdout).split('\n')[0]!.trim().slice(0, 100);
          resolve({ available: true, detail: `${v} on PATH`, external: true });
        });
      });
    },
    async run(request: DesignJobRequest, ctx: DesignRuntimeContext): Promise<DesignRuntimeResult> {
      if (!ctx.atlasMcp) throw new Error('atlas mcp command not configured');
      ctx.signal.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), 'atlas-design-'));
      try {
        const mcpConfigPath = join(dir, 'atlas-mcp.json');
        await writeFile(
          mcpConfigPath,
          JSON.stringify({
            mcpServers: {
              atlas: {
                type: 'stdio',
                command: ctx.atlasMcp.command,
                args: ctx.atlasMcp.args,
                env: ctx.atlasMcp.env ?? {},
              },
            },
          }),
          { mode: 0o600 },
        );
        const child = spawn(
          bin,
          claudeCodeArgs({ prompt: ctx.prompt, mcpConfigPath, model: request.model }),
          { cwd: dir, env: env(), stdio: ['ignore', 'pipe', 'pipe'], shell: false },
        );
        const state: StreamState = { toolNames: new Map(), usage: {}, malformed: 0 };
        let stderrBytes = 0;
        child.stderr.on('data', (b: Buffer) => (stderrBytes += b.length)); // never logged
        let killedFor: string | undefined;
        const kill = (why: string) => {
          if (killedFor || child.exitCode !== null) return;
          killedFor = why;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, opts.killGraceMs ?? 3_000).unref();
        };
        const onAbort = () => kill('canceled');
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => kill('timed out'), opts.timeoutMs ?? 30 * 60_000);
        timer.unref();
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
          },
        );
        try {
          for await (const line of createInterface({ input: child.stdout })) {
            for (const e of handleStreamLine(line, state, ctx.jobId)) ctx.emit(e);
            if (state.mcpFailed) kill(state.mcpFailed);
          }
          const { code } = await exited;
          ctx.signal.throwIfAborted();
          if (killedFor) throw new Error(`claude ${killedFor}`);
          if (!state.result)
            throw new Error(
              `claude exited with code ${code} without a result${state.malformed ? ` (${state.malformed} unreadable line(s))` : ''}${stderrBytes ? '; see its stderr' : ''}`,
            );
          if (state.result.isError)
            throw new Error(
              `claude reported ${state.result.subtype ?? 'an error'}: ${state.result.text.slice(0, 300)}`,
            );
          const text = state.result.text.slice(0, 20_000);
          return {
            usage: state.usage,
            model: state.model,
            output:
              request.kind === 'generate'
                ? undefined
                : {
                    // board plans and explanations are longer answers than copilot JSON
                    text: text.slice(0, isBoardJobKind(request.kind) ? 20_000 : 4_000),
                    data: parseAnswer(text),
                  },
          };
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          if (child.exitCode === null && child.signalCode === null) kill('stopped');
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
