# Implementation status

Last updated: 2026-10-26. Spec: `docs/plan/System_Atlas_Claude_Code_Plan.md`.

Status values: `not started` · `in progress` · `done` (with PR and evidence) · `blocked` (with reason).

## Next ticket

**A01 — Bootstrap workspace, contracts and ADRs** on branch `feat/A01-bootstrap-workspace`.

## Tickets (plan §17)

| ID | Ticket | Depends on | Status | PR / evidence |
|---|---|---|---|---|
| A00 | Repository bootstrap, GitHub remote, branch rules | — | done | bootstrap commit on `main` |
| A01 | Bootstrap workspace, contracts and ADRs | — | not started | |
| A02 | Project/worktree identity and SQLite migrations | A01 | not started | |
| A03 | Inventory and coverage report | A02 | not started | |
| A04 | TS/JS and Python analyzers | A03 | not started | |
| A05 | Semantic identity and snapshot reconciler | A04 | not started | |
| A06 | View planner and canvas navigation | A05 | not started | |
| A07 | React Flow, layout worker, overlays and inspector | A06 | not started | |
| E01 | Run/event/artifact store and ingestion | A02 | not started | |
| E02 | Process wrapper and output registration | E01 | not started | |
| E03 | Playwright capture helper | E01 | not started | |
| E04 | Output canvases and isolated preview renderer | E02,E03,A07 | not started | |
| M01 | Watcher and incremental invalidation | A05,A07 | not started | |
| M02 | Model proposal validation, cache and budget | M01 | not started | |
| I01 | MCP and generic event SDK | E01,A06 | not started | |
| I02 | VS Code integration | I01 | not started | |
| I03 | OTLP subset and bundle importer | E04 | not started | |
| I04 | Skena/JSON Canvas bridge | I01,A07 | not started | |
| H01 | Retention, recovery, export and performance | E04,M01 | not started | |

## Phase acceptance checklists (plan §15)

### Phase 0 — scaffold
- [ ] Clean checkout installs, typechecks and starts via documented commands
- [ ] A fixture can be registered without modifying it (content hash before/after)
- [ ] All persistence paths and contracts are explicit in docs

### Phase 1 — architecture vertical slice
- [ ] TS web/service fixture and Python CLI/API fixture generate different relevant views
- [ ] Every supported edge opens evidence
- [ ] Unsupported features appear as gaps
- [ ] Second identical scan causes no semantic/view churn
- [ ] Single-file change updates affected state
- [ ] Manual pin survives refresh
- [ ] Branch/worktree contexts stay separate

### Phase 2 — real outputs vertical slice
- [ ] Real fixture browser journey captures screenshots of three steps and a failure
- [ ] Real CLI run records stdout/stderr and produces a JSON file and an image
- [ ] Both appear in Outputs & Audit and link to the correct snapshot
- [ ] Failed assertion remains failed despite exit code 0
- [ ] Missing screenshot appears as missing
- [ ] Malicious HTML cannot read app storage or execute with app privileges

Phases 3–5: see plan §15; checklists added when Phase 2 completes.

## Environment record (2026-10-26)

Ubuntu 24.04 x86_64, 32 cores, 125 GiB RAM. Node 24.21.0, pnpm 10.18.0, Python 3.12.3, uv 0.11.32, git 2.43.

## Verified dependency decisions

See `docs/adr/`. Summary: @xyflow/react 12.12.0, elkjs 0.12.0 (EPL-2.0), node:sqlite (FTS5 verified locally), web-tree-sitter 0.27.1 + grammar wasm (load test pending in A01), typescript ~6.0.2, zod 4, fastify 5, playwright 1.64.1, @modelcontextprotocol/server 2.4.0. Skena and Subcanvas are references only.

## Session log

- 2026-10-26: Inspected toolchain and upstream deps; created repository, CLAUDE.md, this file; created public GitHub remote.
