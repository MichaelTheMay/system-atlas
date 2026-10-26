# Implementation status

Last updated: 2026-10-26. Spec: `docs/plan/System_Atlas_Claude_Code_Plan.md`.

Status values: `not started` · `in progress` · `done` (with PR and evidence) · `blocked` (with reason).

## Next ticket

**A04 — TS/JS and Python analyzers** on branch `feat/A04-analyzers`.

## Tickets (plan §17)

| ID  | Ticket                                            | Depends on  | Status      | PR / evidence              |
| --- | ------------------------------------------------- | ----------- | ----------- | -------------------------- |
| A00 | Repository bootstrap, GitHub remote, branch rules | —           | done        | bootstrap commit on `main` |
| A01 | Bootstrap workspace, contracts and ADRs           | —           | not started |                            |
| A02 | Project/worktree identity and SQLite migrations   | A01         | not started |                            |
| A03 | Inventory and coverage report                     | A02         | not started |                            |
| A04 | TS/JS and Python analyzers                        | A03         | not started |                            |
| A05 | Semantic identity and snapshot reconciler         | A04         | not started |                            |
| A06 | View planner and canvas navigation                | A05         | not started |                            |
| A07 | React Flow, layout worker, overlays and inspector | A06         | not started |                            |
| E01 | Run/event/artifact store and ingestion            | A02         | not started |                            |
| E02 | Process wrapper and output registration           | E01         | not started |                            |
| E03 | Playwright capture helper                         | E01         | not started |                            |
| E04 | Output canvases and isolated preview renderer     | E02,E03,A07 | not started |                            |
| M01 | Watcher and incremental invalidation              | A05,A07     | not started |                            |
| M02 | Model proposal validation, cache and budget       | M01         | not started |                            |
| I01 | MCP and generic event SDK                         | E01,A06     | not started |                            |
| I02 | VS Code integration                               | I01         | not started |                            |
| I03 | OTLP subset and bundle importer                   | E04         | not started |                            |
| I04 | Skena/JSON Canvas bridge                          | I01,A07     | not started |                            |
| H01 | Retention, recovery, export and performance       | E04,M01     | not started |                            |

## Phase acceptance checklists (plan §15)

### Phase 0 — scaffold

- [x] Clean checkout installs, typechecks and starts via documented commands. A fresh `git clone` ran `pnpm install --frozen-lockfile`, `pnpm typecheck` and `pnpm build` in 7.9 s; `atlas open` served the UI (HTTP 200).
- [x] A fixture can be registered without modifying it. Checked by a content hash before/after in the clean clone, an empty `git status` afterwards, and the `registry.test.ts` fingerprint test.
- [x] All persistence paths and contracts are explicit in docs: `docs/persistence.md`, `packages/schema/src`, `packages/store/migrations`, `apps/daemon/openapi.yaml`.

Phase 0 complete 2026-10-26 (tag `phase-0`).

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

## Ticket evidence

### A01 (2026-10-26)

- `pnpm check` exit 0: typecheck all 12 packages, ESLint, Prettier, Vitest 25 tests in 5 files, web build.
- `pnpm e2e`: 3 Playwright tests passed. The tests cover token-in-fragment connect + strip, Architecture/Outputs root switching, and the no-token UI state with API 401.
- `pnpm atlas doctor`: node, sqlite-fts5 (SQLite 3.53.4), data-dir, runtime perms, tree-sitter grammars and playwright-chromium all OK.
- `atlas open .` started a detached daemon with a 0600 discovery file. `atlas status --json` reported it, and `atlas daemon stop` stopped it.
- The UI shell was rendered via the daemon and inspected with agent-browser.
- Daemon security tests cover Host rebinding (421), foreign Origin (403), missing or wrong token (401), path traversal, and CSP headers.
- Known limits: `scan/watch/views/run/import/export` exit 2 with the owning ticket. Project registration lands in A02.
- Local note: on this Ubuntu 24.04 host, agent-browser needs `--args "--no-sandbox"` (AppArmor userns restriction). Playwright passes it itself.

### A02 (2026-10-26)

- New `packages/store`: Db interface over `node:sqlite` (WAL, foreign keys), checksummed migration runner with `VACUUM INTO` backups, and `0001_init.sql` with tables for every plan §6 contract.
- `packages/graph`: read-only git inspection, remote URL redaction, `registerRoot`, `listProjects`, `manifestDigest`.
- Daemon opens and migrates the DB at startup and exposes `GET/POST /api/v1/projects`. `atlas open` registers the root, and `atlas projects` lists projects. The UI selector lists projects and worktrees with their branches.
- Tests: 41 Vitest tests in 7 files, 4 Playwright tests.
  - Store: migrations apply, re-run is a no-op, backup before upgrade, edited migration refused, failed migration fully rolled back, events append-only and deduped, FTS5 search.
  - Registry: two `git worktree`s give one project with separate contexts and branches; a clone and a sub-path are separate projects; re-registration is idempotent and refreshes the branch; non-git dirs work; the fixture fingerprint is unchanged.
  - Git safety: `core.fsmonitor` is not executed. Remote URL redaction is tested.
  - Daemon: register, list, and reject bad paths.
- Manual: CLI registered both fixtures against a scratch data dir, and `git status -- fixtures` was unchanged. The UI was screenshotted with the populated selector.
- Not yet: snapshots and manifests are written by A03/A05. The `dirty` flag versus HEAD is computed in A03 from the inventory.

### A03 (2026-10-26)

- Inventory (`packages/analyzers/src/inventory`): git or walker listing, gitignore/.atlasignore/default excludes, secret/binary/size/symlink/nested-repo skipping, language and role classification, SHA-256 and git blob ids, dirty-vs-HEAD.
- Generic manifest analyzer, excerpt redaction, coverage report builder.
- Scan pipeline with timeouts, verified reads, manifest re-validation, stale carry-forward for failed analyzers, atomic publish and supersede. Migration `0002_producers.sql`.
- Daemon serial job runner (newer scan cancels older) and scan/job/snapshot routes. `atlas scan` CLI. The UI has a scan button, snapshot card and coverage panel.
- Tests: 72 Vitest tests in 10 files and 5 Playwright tests.
  - Inventory runs on temp repos: gitignore, untracked node_modules, secrets, binaries, size, symlink escape, tracked gitlink and untracked nested repo. Dirty detection covers modify, delete and untracked files.
  - Scan: TS fixture packages and depends-on with manifest-matching evidence. Python package. Elixir unsupported-language gap. Stable IDs on rescan. Fixtures unchanged. Failure carry-forward, changed-during-scan, timeout, cancel, and HEAD/dirty.
  - Redaction patterns.
- Manual: `atlas scan` on ts-web-service, elixir-unsupported and Atlas itself (158 files, 155 ms). The UI was screenshotted after the self-scan.
- Known limits: TS/JS and Python source analysis is A04. The canvas still shows a summary card until A06/A07. `.npmrc` is always treated as secret-like (conservative).

## Environment record (2026-10-26)

Ubuntu 24.04 x86_64, 32 cores, 125 GiB RAM. Node 24.21.0, pnpm 10.18.0, Python 3.12.3, uv 0.11.32, git 2.43.

## Verified dependency decisions

See `docs/adr/`. Summary: @xyflow/react 12.12.0, elkjs 0.12.0 (EPL-2.0), node:sqlite (FTS5 verified locally), web-tree-sitter 0.27.1 + grammar wasm (load test pending in A01), typescript ~6.0.2, zod 4, fastify 5, playwright 1.64.1, @modelcontextprotocol/server 2.4.0. Skena and Subcanvas are references only.

## Session log

- 2026-10-26: Inspected toolchain and upstream deps; created repository, CLAUDE.md, this file; created public GitHub remote.
