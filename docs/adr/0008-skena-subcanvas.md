# ADR-0008: Skena and Subcanvas are references, not dependencies

Status: accepted (2026-10-26)

## Findings (documentation-level, 2026-10-26)

- Skena (github.com/dmarienko/skena): MIT, last commit 2026-09-30. A VS Code extension rendering JSON Canvas 1.0 with extra node types and a bundled MCP server. No public API beyond `.canvas` files and its MCP tools.
- Subcanvas (github.com/subcanvas/subcanvas): AGPL-3.0, last commit 2026-10-18. A hosted product on Supabase with optional Stripe billing.

## Decision

- No code is copied from either project. Subcanvas's AGPL license is incompatible with an MIT tool that copies its code.
- Subcanvas informs recursive-navigation UX only.
- Interop with Skena happens at the JSON Canvas 1.0 file level (I04 export), with richer metadata in a versioned sidecar. Re-inspect Skena's API before I04.
