import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { DesignJobEvent } from '@atlas/schema';
import { createAtlasMcpServer, type AtlasMcpOptions } from './mcp.ts';

/**
 * The design agent's tool surface (D02c): the read tools plus the two proposal tools of the Atlas
 * MCP server. No refresh (a scan would make every later proposal a stale precondition), no notes,
 * no run recording (the job runner records the run itself), no filesystem, shell or web.
 */
export const DESIGN_AGENT_TOOLS = [
  'atlas_project_status',
  'atlas_list_views',
  'atlas_get_view',
  'atlas_search',
  'atlas_get_entity',
  'atlas_get_evidence',
  'atlas_propose_view',
  'atlas_propose_claims',
] as const;

/** Claude Code names MCP tools `mcp__<server>__<tool>`; the server is registered as `atlas`. */
export const CLAUDE_CODE_ALLOWED_TOOLS = DESIGN_AGENT_TOOLS.map((t) => `mcp__atlas__${t}`);

export interface DesignTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments, as the MCP server advertises it. */
  inputSchema: Record<string, unknown>;
}

export interface DesignToolResult {
  isError: boolean;
  /** Raw text the tool returned (JSON for successes). Untrusted repository-derived content. */
  text: string;
  /** Parsed JSON when the text is JSON. */
  data?: unknown;
}

export interface DesignToolset {
  list(): Promise<DesignTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<DesignToolResult>;
  close(): Promise<void>;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Connect to an in-process Atlas MCP server (same tool implementations and validator as
 * `atlas mcp`) over a linked in-memory transport, restricted to {@link DESIGN_AGENT_TOOLS}.
 */
export async function connectAtlasTools(
  opts: AtlasMcpOptions & { clientName?: string },
): Promise<DesignToolset> {
  const server = createAtlasMcpServer(opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: opts.clientName ?? 'atlas-design-agent', version: '1.0.0' });
  await client.connect(clientSide);
  const allowed = new Set<string>(DESIGN_AGENT_TOOLS);
  return {
    async list() {
      const { tools } = await client.listTools();
      return tools
        .filter((t) => allowed.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema as Record<string, unknown>,
        }));
    },
    async call(name, args) {
      if (!allowed.has(name))
        return { isError: true, text: `tool ${name} is not available to the design agent` };
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };
      const text = (r.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      return { isError: !!r.isError, text, data: r.isError ? undefined : parse(text) };
    },
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

/** Accepted/rejected counts of a proposal tool result (0/0 for reads and errors). */
export function proposalCounts(
  tool: string,
  data: unknown,
): { accepted: number; rejected: number } {
  const d = data as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') return { accepted: 0, rejected: 0 };
  const len = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  if (tool === 'atlas_propose_claims')
    return { accepted: len(d.accepted), rejected: len(d.rejected) };
  if (tool === 'atlas_propose_view' && Array.isArray(d.subsystems)) {
    const n = { accepted: 0, rejected: 0 };
    for (const s of d.subsystems as Record<string, unknown>[]) {
      n.accepted += len(s.accepted);
      n.rejected += len(s.rejected);
    }
    return n;
  }
  return { accepted: 0, rejected: 0 };
}

/** Wrap a toolset so every call is reported as a `tool-call` job event. */
export function instrumentTools(
  tools: DesignToolset,
  jobId: string,
  emit: (e: DesignJobEvent) => void,
): DesignToolset {
  return {
    list: () => tools.list(),
    close: () => tools.close(),
    async call(name, args) {
      const r = await tools.call(name, args);
      emit({ type: 'tool-call', jobId, tool: name, ...proposalCounts(name, r.data) });
      return r;
    },
  };
}
