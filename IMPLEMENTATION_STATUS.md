# Implementation status

Last updated: 2026-10-26. Spec: `docs/plan/System_Atlas_Claude_Code_Plan.md`.

Status values: `not started` · `in progress` · `done` (with PR and evidence) · `blocked` (with reason).

## Next ticket

**M01 — Watcher and incremental invalidation** (Phase 3). The storage part, M01a, is in PR #13. Incremental analysis and the watcher are next.

## Tickets (plan §17)

| ID  | Ticket                                            | Depends on  | Status      | PR / evidence                           |
| --- | ------------------------------------------------- | ----------- | ----------- | --------------------------------------- |
| A00 | Repository bootstrap, GitHub remote, branch rules | —           | done        | bootstrap commit on `main`              |
| A01 | Bootstrap workspace, contracts and ADRs           | —           | not started |                                         |
| A02 | Project/worktree identity and SQLite migrations   | A01         | not started |                                         |
| A03 | Inventory and coverage report                     | A02         | not started |                                         |
| A04 | TS/JS and Python analyzers                        | A03         | not started |                                         |
| A05 | Semantic identity and snapshot reconciler         | A04         | not started |                                         |
| A06 | View planner and canvas navigation                | A05         | done        | PR #6; see A06 evidence                 |
| A07 | React Flow, layout worker, overlays and inspector | A06         | done        | PR #7; see A07 evidence                 |
| E01 | Run/event/artifact store and ingestion            | A02         | done        | PR #8; see E01 evidence                 |
| E02 | Process wrapper and output registration           | E01         | done        | PR #9; see E02 evidence                 |
| E03 | Playwright capture helper                         | E01         | done        | PR #10; see E03 evidence                |
| E04 | Output canvases and isolated preview renderer     | E02,E03,A07 | done        | PR #11; see E04 evidence                |
| M01 | Watcher and incremental invalidation              | A05,A07     | in progress | M01a PR #13 (no-op rescans, compaction) |
| M02 | Model proposal validation, cache and budget       | M01         | not started |                                         |
| I01 | MCP and generic event SDK                         | E01,A06     | not started |                                         |
| I02 | VS Code integration                               | I01         | not started |                                         |
| I03 | OTLP subset and bundle importer                   | E04         | not started |                                         |
| I04 | Skena/JSON Canvas bridge                          | I01,A07     | not started |                                         |
| H01 | Retention, recovery, export and performance       | E04,M01     | not started |                                         |

## Phase acceptance checklists (plan §15)

### Phase 0 — scaffold

- [x] Clean checkout installs, typechecks and starts via documented commands. A fresh `git clone` ran `pnpm install --frozen-lockfile`, `pnpm typecheck` and `pnpm build` in 7.9 s; `atlas open` served the UI (HTTP 200).
- [x] A fixture can be registered without modifying it. Checked by a content hash before/after in the clean clone, an empty `git status` afterwards, and the `registry.test.ts` fingerprint test.
- [x] All persistence paths and contracts are explicit in docs: `docs/persistence.md`, `packages/schema/src`, `packages/store/migrations`, `apps/daemon/openapi.yaml`.

Phase 0 complete 2026-10-26 (tag `phase-0`).

### Phase 1 — architecture vertical slice

- [x] TS web/service fixture and Python CLI/API fixture generate different relevant views. The TS fixture has 8 root lenses plus package canvases; Python has 5 (`views.test.ts`, `atlas views list`). Both render in the UI: the TS walkthrough, plus a Python e2e test covering merged root, modules, module-detail and the API lens (`architecture.spec.ts`, screenshots inspected).
- [x] Every supported edge opens evidence. Every supported projected edge resolves to relations with evidence (`views.test.ts`). The UI edge inspector shows the relation and evidence excerpt (e2e "an edge explains itself").
- [x] Unsupported features appear as gaps: unsupported-language gaps in the coverage report and Coverage canvas (`scan.test.ts`, e2e "scans the selected project … coverage gaps" on the Elixir fixture).
- [x] Second identical scan causes no semantic/view churn. Zero snapshot changes (`reconcile.test.ts`), and identical catalogs and projections (`views.test.ts`).
- [x] Single-file change updates affected state. Only entities citing the edited file change (`reconcile.test.ts`). The catalog is stable and the changes canvas shows the edit (`views.test.ts`).
- [x] Manual pin survives refresh: drag, reload and rescan keep the position within 1 px (e2e "a manual pin survives reload and rescan"). Pins follow rename aliases (`inspector.test.ts`).
- [x] Branch/worktree contexts stay separate. Two `git worktree`s are separate contexts with their own branches (`registry.test.ts`), and snapshots are per worktree. A file moved on a feature worktree does not move main's pins or claims: aliases are followed only when the viewed snapshot lacks the old ID and has the new one (`apps/daemon/test/worktrees.test.ts`).

Phase 1 complete 2026-10-26 (tag `phase-1`).

### Phase 2 — real outputs vertical slice

- [x] Real fixture browser journey captures screenshots of three steps and a failure. 3 post-action, 1 failure-state and the final screenshot are captured (`journey.spec.ts`), and the UI filmstrip shows them with images loaded (`outputs.spec.ts`).
- [x] Real CLI run records stdout/stderr and produces a JSON file and an image: `apps/cli/test/run.test.ts`. The UI shows the command output and the 360 px PNG chart (`outputs.spec.ts`).
- [x] Both appear in Outputs & Audit and link to the correct snapshot. The run's `snapshotId` equals the worktree's latest snapshot, and the UI badge shows it (`outputs.spec.ts`).
- [x] Failed assertion remains failed despite exit code 0. The worker card shows "process succeeded" and "task failed" (`outputs.spec.ts`, `store.test.ts`).
- [x] Missing screenshot appears as missing. The filmstrip has one missing frame with reason "page is closed" (`outputs.spec.ts`).
- [x] Malicious HTML cannot read app storage or execute with app privileges. In the sandboxed frame from the preview origin (`outputs.spec.ts`):
  - the frame's origin is `null`;
  - parent DOM, top `sessionStorage`, storage, cookie and API fetch are all blocked;
  - the app DOM and token are unchanged, and no API requests come from the frame.

Phase 2 complete 2026-10-26 (tag `phase-2`).

### Phase 3 — continuous reconciliation and richer view planning

- [ ] Rapid edits coalesce (M01 watcher).
- [ ] Stale inference is invalidated (M01/M02).
- [x] Failed extraction does not erase good state. Covered by `scan.test.ts` "carries a failing analyzer's previous facts forward" and `reconcile.test.ts` "reports stale changes…".
- [ ] Overlays survive renames where identity is supported.
- [ ] Ambiguous renames surface as issues **in the UI**. Today they show only in the API and CLI (`reconcile.test.ts`).
- [ ] Model output with invented evidence is rejected (M02).
- [ ] Cross-view selection uses a single entity identity.
- [ ] Edit-to-publish latency is at most 3 s on dsh. M01a measured about 5.3 s, nearly all of it full TS/JS analysis.

Phases 4–5: see plan §15.

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

### A04 (2026-10-26)

- Analyzers: `ts-js` and `python` (worker threads), `generic-sql` (migrations), `generic-docker` (Compose and Dockerfiles), plus the A03 `generic-manifests`. Defaults are in `defaultAnalyzers()`.
- Hand-authored expected graphs are in `fixtures/expected/`, written before the analyzers ran. `expected-graphs.test.ts` reports per-analyzer, per-relation-kind precision and recall:
  - ts-web-service: 46 relations across 11 analyzer and kind rows. 47 entities. All rows are precision 1.00 and recall 1.00, with no missing or extra entities.
  - py-cli-api: 13 relations across 5 rows. 26 entities. All rows are precision 1.00 and recall 1.00.
  - These fixtures are small and were written alongside the analyzers, so 1.00 shows the documented patterns work. It is not a claim about arbitrary code.
- Tests: 83 Vitest tests in 13 files.
- Real-repo checks (read-only, scratch data dir):
  - Atlas self-scan: 178 files in 458 ms.
  - `~/Dev/dsh`: 9,175 files and 11,641 entities. Scans took 4.9-5.3 s; `ts-js` was 3.9 s of that. Peak heap was 182 MB and 25 MB after GC. RSS stayed at about 1.4 GB because worker memory is not returned to the OS; this is tracked for H01.
  - The target repo's `git status` was unchanged before and after.
- Fixed from real-repo findings (re-verified on dsh: 43 `.d.ts` files now syntax-level, no TypeScript gap; unit test in `scan.test.ts`): `.d.ts` and TS files outside source roles no longer appear as unsupported; style/asset imports are not reported as unresolved; `CREATE VIRTUAL TABLE` is recognized.
- Known limits: see `docs/capabilities.md`. No call graph, no OpenAPI/CI modeling yet, Python has no type inference.

### A05 (2026-10-26)

- `reconcile()` computes added, removed (tombstones), changed, renamed, stale and restored changes, plus accepted aliases and open issues. These are persisted atomically with the snapshot (migration 0003).
- Human and model claims carry forward and turn stale on evidence change. `checkSnapshotIntegrity()` and `resolveAlias()` were added.
- API: `GET /snapshots/:id/changes`, and the snapshot response now includes the change summary and open issue count. CLI `scan` prints "since previous". The UI card shows "Last changed" and open issues.
- Tests: 92 Vitest tests in 14 files.
  - No-op rescans of both fixtures produce zero changes and pass integrity.
  - A single-file edit changes only entities citing that file.
  - Deletion produces tombstones and unresolved-import gaps.
  - An exact-content move gives content-hash and parent-rename aliases.
  - Ambiguous and possible renames become issues, not merges.
  - A human claim stays supported, then turns stale after an edit.
  - An analyzer failure makes rows stale, and recovery restores the same count.
  - The integrity check catches corruption.
- Open issues are counted per project, not per snapshot, so they stay visible across later scans until resolved (regression test in `server.test.ts`).
- Manual: `atlas scan` on a scratch copy showed first snapshot, then no changes, then after a one-line edit: 1 entity added, 2 changed; 1 relation added, 3 changed.

### A06 (2026-10-26)

- `packages/planner`:
  - `planViews()` builds the catalog: lens eligibility, `relevance-v1` scoring with reasons, stable IDs, child links along canonical ownership, sibling links, and root-package merge.
  - `projectView()` builds projections: container clustering (member target 30, single-directory levels skipped, kind clusters, `other`), external aggregation with scope drill-down, boundary ports capped at 12, per-lens scenes (context, deployables, API, data, workflow, UI, coverage, changes), deterministic edges with relation IDs, breadcrumbs, siblings and children.
- The catalog is persisted in the publish transaction. Daemon routes added for catalog and projection (snapshot-scoped, with a cache). New CLI command `atlas views list`. Docs in `docs/views.md`.
- Tests: 102 Vitest tests in 15 files.
  - TS and Python catalogs differ and are evidence-gated.
  - The navigation tree is a forest with a single parent per canvas.
  - The system context is not a single box, and the root package is merged.
  - Ports and third-party aggregation work.
  - Every supported projected edge resolves to relations with evidence.
  - Identical rescans give byte-identical catalogs and projections (snapshot ID masked), and the catalog is stable across "edit, rescan, rescan".
  - Clustering descends levels and drill-down view IDs are distinct.
  - The port cap holds.
- dsh measurement (9,175 files):
  - 1,414 canvases. Catalog load took 62 ms. Projections were p50 6.5 ms, p95 8.7 ms, max 73 ms.
  - Before the port cap, one canvas had 197 ports and hit the 200-node cap. After it, 0 of 1,414 canvases exceed 40 nodes: 1,067 have 10 or fewer, 327 have 11-30, 20 have 31-40.

### A07 (2026-10-26)

- Web UI (`apps/web`):
  - React Flow canvases with custom node and edge types. Status is shown by line style and text, not color alone.
  - ELK layout in its own Web Worker via `elk-api`. `@atlas/layout` accepts an injected ELK.
  - Overlay hook with debounced, revision-checked saves. Drag pins nodes; the viewport is saved only for user moves.
  - Catalog tree with search, breadcrumbs, back/forward, lens switcher, and a list-view alternative.
  - Inspector with canvas, entity, edge, node and source panels.
- Daemon routes for overlays (alias-following reads, 409 on stale revision), entity details, relation details and manifest-restricted source. The `ViewOverlay` schema gains `nodePositions`.
- Advisor review fixes before tagging:
  - Rename aliases are followed only relative to the viewed snapshot, for both overlays and claims. A two-worktree regression test was added.
  - An e2e test now renders the Python fixture.
  - A default viewport counts as unset, so a pin-only save no longer pins the camera. The pin test asserts the node is on screen after reload.
  - Double-click zoom is disabled. It moved and persisted the viewport of the canvas being left.
  - Edgeless canvases use rectangle packing.
- Bugs found by real-browser testing and fixed:
  - `elk.bundled.js` becomes ELK's own worker when loaded inside a worker, which caused "o is not a constructor".
  - Expression-bodied React effects returned a Promise from `scrollIntoView` in Chromium 156 and crashed on unmount. A lint rule now forbids them.
  - The structure canvas showed the merged root package as a port.
  - Programmatic `fitView` was saved as the user's viewport.
  - Group nodes lacked edge handles.
- Tests: 109 Vitest tests in 17 files, 10 Playwright tests. The Playwright tests fail on any uncaught page error. The walkthrough covers open, nested component, evidence and highlighted source, plus back/forward, edge explanation, pin survival across reload and rescan, list view, root switching and the coverage gap.
- Visual checks were done with agent-browser screenshots: system context, structure, `@reports/api`, source, API, Deployables, Data, Coverage, and dsh's structure (21 nodes, clusters and aggregated libraries).

### E01 (2026-10-26)

- `packages/evidence` provides:
  - Runs with a per-run ingestion token (hash stored).
  - Validated, redacted, deduplicated append-only events, with assertion extraction and explicit entity correlations.
  - Reserve, then upload, then verify for artifacts, with a content-addressed `ObjectStore` (atomic rename, size limit) and magic-byte MIME sniffing. Failures and declared gaps are kept as `missing`.
  - Process and task outcome reported separately, interrupted-run recovery, and snapshot binding by exact tree digest.
- Migration `0004_evidence.sql`.
- Daemon:
  - Run routes, where the run token is accepted only for that run's ingestion endpoints.
  - Runs bind on publish, and runs are recovered at startup.
  - The **isolated preview server** on a second loopback port serves only HMAC-signed, expiring URLs, with sandboxed CSP, no network, `frame-ancestors` set to the app, and nosniff.
  - The UI CSP allows frames and images only from the preview origin. The discovery record includes `previewPort`.
- Redaction moved to `@atlas/schema` and gained `redactValue` and `redactUrl`. Docs are in `docs/evidence.md`.
- Tests: 123 Vitest tests in 19 files.
  - Store: token scoping, dedupe, ordering, missing parents, redaction, correlations, task-versus-process outcome, recovery and late finish, digest binding, verified upload and dedupe, hash mismatch and oversize kept missing, sniffing.
  - Daemon: scan-then-bind and immediate bind; cross-run token rejected and run token not valid for other APIs.
  - Upload, 422 on mismatch, missing marker, finish, detail and list.
  - Preview: signed and expiring links, tamper and host checks, sandbox CSP without same-origin, and the app origin never serving bytes.
  - UI CSP includes the preview origin.
- e2e: 10 tests passed.

### E02 (2026-10-26)

- `@atlas/adapters` provides:
  - `IngestClient`: sequenced and batched events, hashed and streamed artifact uploads with dedupe, declared-missing artifacts, and finish with ingestion errors reported as gaps.
  - `runProcess`, the `atlas run` command.
  - `recorderFromEnv`, the SDK, which is a no-op outside Atlas.
- Run creation with `waitForSnapshot` snapshots the tree **before** the command runs. This removes a race found on the first real run: the command writes outputs into the tree, so a scan running concurrently could produce a digest different from the run's start digest.
- New fixture `fixtures/research-demo` (plan §18):
  - A local search page.
  - API plus queue code for analysis.
  - A dependency-free worker with two tools that writes `report.json`, a real PNG chart and `report.html`, and records tool events and an assertion via raw HTTP.
- Tests: 4 integration tests against a real in-process daemon over HTTP.
  - The demo run binds to its snapshot, captures stdout, stderr and tool events, and records a failed assertion with exit 0 as process succeeded and task failed. Outputs keep their sniffed types and an undeclared output is missing.
  - Non-zero exit, spawn failure as a gap, cancellation, and an inline cap with the full log attached.
  - A child using the SDK records steps, artifact and assertion.
- Manual: `atlas run` on a copy of the demo printed process succeeded, task failed, 3 outputs uploaded and 1 missing.
- Phase 2 checklist: "Real CLI run records stdout/stderr and produces a JSON file and an image" and "Failed assertion remains failed despite exit code 0" are exercised at the API level. UI display is E04.

### E03 (2026-10-26)

- `BrowserCapture` (`@atlas/adapters`):
  - Steps with post-action and failure-state screenshots, with tab, redacted URL, viewport and wait-policy provenance.
  - Bounded screenshot count. Missing captures are recorded as missing artifacts plus gaps.
  - Network and console summaries, and the Playwright trace attached (or a gap when the caller owns tracing).
- `startRun` is shared by the process wrapper and the journey.
- `scripts/research-journey.ts` is the §18 journey over the fixture page, served by a local static server with traversal guard. `pnpm demo` runs the full local demo.
- e2e `journey.spec.ts` (real Chromium) checks:
  - The run binds to its snapshot.
  - 3 post-action screenshots, 1 failure-state and the final are captured as PNGs with tab, viewport and URL.
  - One screenshot is missing with reason "page is closed".
  - 3 completed steps and 1 failed step, in sequence order, plus the assertion and summaries.
  - The trace zip is attached.
- Manual: `pnpm demo` against a scratch data dir produced the two worker runs and the journey. The post-search screenshot was inspected; it shows the 6 results. Identical failure and final bytes are deduplicated in the object store.

### E04 (2026-10-26)

- Outputs & Audit UI: run overview with filters, and run detail with Steps, Browser journey (filmstrip), Code execution, Artifacts gallery and Audit trail tabs. The detail shows linked components and the source snapshot badge.
- Previews only via the isolated origin:
  - A new server-rendered, escaped, script-free `/v/:id` viewer for JSON, CSV and text.
  - Sandboxed frames for HTML and SVG.
  - `Cross-Origin-Resource-Policy: cross-origin`. Chrome blocked `same-site` between loopback ports (`ERR_BLOCKED_BY_RESPONSE.NotSameSite`, found in real-browser testing). Access is gated by signed URLs.
- Correlation: explicit IDs, command mapping (supported) and route signature (inferred). It runs on finish and on snapshot binding, and is idempotent. Entity details list runs.
- Cross-navigation opens the run's own snapshot, with a visible historical badge.
- `atlas run` titles use the command basename, not the absolute interpreter path.
- Tests: 129 Vitest tests in 21 files, 14 Playwright tests.
  - Outputs overview and detail.
  - The full walkthrough: component, outputs, run, artifact, component, source.
  - Malicious-HTML isolation.
- Screenshots were inspected for the overview, journey filmstrip, code execution and artifact gallery (JSON viewer, PNG chart, sandboxed HTML report).

### M01a (2026-10-26): no-op rescans and snapshot compaction

These were measured first, on a copy of dsh with about 8,900 files, as the advisor recommended:

| Measure                   | Value                                              |
| ------------------------- | -------------------------------------------------- |
| Storage growth per rescan | 26 MB                                              |
| Edit-to-publish           | about 5.3 s (TS/JS analysis 3.6 s, publish 1 s)    |
| Daemon resident memory    | 1.34 GB rising to 1.66 GB over 20 scans, then flat |

Changes:

- An identical tree and configuration returns the existing snapshot (`noop: true`). A no-op rescan of dsh takes about 0.3 s.
- `compactSnapshots()` runs after each publish. It keeps the latest snapshot, its predecessor and run-bound snapshots, and drops the graph rows of the others. Graph routes answer 410 for compacted snapshots.
- After the change, dsh measures 168 MB after 20 edited rescans and is level, growing about 0.3 MB per scan from change rows and coverage. Before the change it was 607 MB and growing.
- Tests: 131 Vitest tests, 14 Playwright tests. Tests that rescanned an unchanged tree now edit it first, or assert the no-op.

## Environment record (2026-10-26)

Ubuntu 24.04 x86_64, 32 cores, 125 GiB RAM. Node 24.21.0, pnpm 10.18.0, Python 3.12.3, uv 0.11.32, git 2.43.

## Verified dependency decisions

See `docs/adr/`. Summary: @xyflow/react 12.12.0, elkjs 0.12.0 (EPL-2.0), node:sqlite (FTS5 verified locally), web-tree-sitter 0.27.1 + grammar wasm (load test pending in A01), typescript ~6.0.2, zod 4, fastify 5, playwright 1.64.1, @modelcontextprotocol/server 2.4.0. Skena and Subcanvas are references only.

## Session log

- 2026-10-26: Inspected toolchain and upstream deps; created repository, CLAUDE.md, this file; created public GitHub remote.
