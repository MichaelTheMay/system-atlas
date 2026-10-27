import type { DesignJobEvent, DesignJobRequest, DesignRuntimeId } from '@atlas/schema';
import type { DesignToolset } from './design-tools.ts';

/**
 * Design agent runtime contract (D02c). A runtime drives a model through Atlas's own MCP tools
 * (`atlas_propose_view`, `atlas_propose_claims`, read-only graph tools), so everything it produces
 * goes through the same citation validator and lands as `proposed`. Runtimes never write facts.
 *
 * - `claude-code`: the documented headless CLI (`claude -p … --output-format stream-json
 *   --mcp-config <atlas mcp> --allowedTools "mcp__atlas__*"`) in a temp cwd, using the user's own
 *   Claude Code login. Atlas never reads Claude tokens or session files.
 * - `anthropic-api`: `@anthropic-ai/sdk` tool-use loop in process; the key comes from the OS
 *   keychain or a 0600 file and is never returned to the UI or logged.
 * - `mock`: deterministic, free; CI and demos.
 *
 * Only an explicit user action starts a job; the first real use requires recorded consent.
 */
export interface DesignRuntimeAvailability {
  available: boolean;
  /** Why not, or what was found (e.g. "claude 2.1.310 on PATH"). Never contains secrets. */
  detail: string;
  /** True when a run sends repository excerpts off the machine and may cost money. */
  external: boolean;
}

export interface DesignRuntimeContext {
  jobId: string;
  projectId: string;
  rootPath: string;
  /**
   * In-process Atlas tools (the design-agent subset of the MCP server, bound to this project).
   * Runtimes that drive a model in process (mock, anthropic-api) work only through these.
   */
  tools: DesignToolset;
  /**
   * How to start `atlas mcp <root>` as a stdio server, for runtimes that run an external agent
   * (claude-code). Carries no tokens: `atlas mcp` finds the daemon through its discovery record.
   */
  atlasMcp?: { command: string; args: string[]; env?: Record<string, string> };
  /** Redacted, bounded system brief for the agent (prompt template versioned by the runner). */
  prompt: string;
  promptTemplateVersion: string;
  budget: { maxInputTokens: number; maxOutputTokens: number };
  emit: (event: DesignJobEvent) => void;
  signal: AbortSignal;
}

export interface DesignRuntimeResult {
  /** What the runtime reported; absent fields stay unknown (never estimated here). */
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  model?: string;
  /** Copilot answer (name, explanation, suggestions); generate jobs leave it empty. */
  output?: { text?: string; data?: unknown };
}

export interface DesignRuntime {
  readonly id: DesignRuntimeId;
  check(): Promise<DesignRuntimeAvailability>;
  run(request: DesignJobRequest, ctx: DesignRuntimeContext): Promise<DesignRuntimeResult>;
}

/** Version of the design-agent prompt and tool contract the runner sends. */
export const DESIGN_PROMPT_TEMPLATE_VERSION = 'design-v1';
