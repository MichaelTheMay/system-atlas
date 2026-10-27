/** @atlas/agent-api — MCP server (plan §12, ADR-0007). Model-provider contracts follow in M02. */
export { createAtlasMcpServer, insideRoot, MCP_INSTRUCTIONS, type AtlasMcpOptions } from './mcp.ts';
export * from './provider.ts';
export * from './design-runtime.ts';
export * from './design-tools.ts';
export { buildDesignPrompt, type DesignPromptInput } from './design-prompt.ts';
export * from './runtimes/index.ts';
