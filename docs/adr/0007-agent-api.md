# ADR-0007: MCP v2 SDK for the agent API

Status: accepted (2026-10-26)

## Decision

Use `@modelcontextprotocol/server` 2.4.0 (the v2 split SDK; `McpServer` + `StdioServerTransport`). `@modelcontextprotocol/sdk` 1.x is now the legacy line. Tools follow plan §12: structured semantic reads with pagination and context budgets, proposals with evidence and snapshot preconditions, and run/event/artifact recording. No arbitrary filesystem, SQL or command execution tools. Implemented in I01: `atlas mcp [path]` serves the tools over stdio, scoped to one project (see docs/agents.md). Proposal and annotation tools follow in M02.
