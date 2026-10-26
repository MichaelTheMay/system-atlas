# ADR-0001: React Flow renderer over a separate core; four-model split

Status: accepted (2026-10-26)

## Context

Plan §1, §4. The hard problems (analysis, identity, provenance, reconciliation, evidence) sit below the canvas and must be reusable from a browser, VS Code, CI and agents.

## Decision

- Core logic lives in framework-free packages (`schema`, `graph`, `analyzers`, `planner`, `layout`, `evidence`, `adapters`, `agent-api`, `export`). The web app is one consumer.
- Rendering uses `@xyflow/react` 12.12.0 (MIT; v13 is prerelease only). Its sub-flows (`parentId`, `extent: 'parent'`) are used for in-canvas grouping only; recursive canvas navigation is Atlas's own (`CanvasSpec`/`CanvasLink`).
- Four separate models with separate tables and schemas: semantic, view, presentation overlay, execution.
- A local daemon (`fastify` 5.12.7) owns persistence and jobs. It binds 127.0.0.1, validates Host (DNS-rebinding) and Origin (CSRF), requires a bearer token for `/api/*`, and publishes its port/token through a 0600 discovery file. One daemon per user data dir serves all registered projects.
- The UI receives the token once in the URL fragment (never sent to servers or in Referer), keeps it in sessionStorage, and streams SSE over `fetch` so the token is a header, not a query parameter.

## Consequences

Skena or other renderers can be added as adapters without touching the core. The daemon is a single point for writes (single-writer queue, plan §9).
