# Implementation status

Last updated: 2026-10-26. Spec: `docs/plan/System_Atlas_Claude_Code_Plan.md`.

Status values: `not started` · `in progress` · `done` (with PR and evidence) · `blocked` (with reason).

## Next ticket

**D02: interactive whiteboard, design copilot and on-demand generation**, planned in `~/.claude/plans/execute-step-19-in-dapper-possum.md` (section "D02"). Merged into `develop`: wave 0 contracts (#26), D02a design elements (#30), D02c runtimes and job runner (#31). In review: the whiteboard UI (wave 2a) and D02b (copilot, Generate dialog, review, settings, docs). Then the final verification: `pnpm check`, e2e three times, screenshots, and one real-runtime smoke test only with the user's go-ahead.

## Tickets (plan §17)

| ID  | Ticket                                               | Depends on  | Status      | PR / evidence                                                                             |
| --- | ---------------------------------------------------- | ----------- | ----------- | ----------------------------------------------------------------------------------------- |
| A00 | Repository bootstrap, GitHub remote, branch rules    | —           | done        | bootstrap commit on `main`                                                                |
| A01 | Bootstrap workspace, contracts and ADRs              | —           | not started |                                                                                           |
| A02 | Project/worktree identity and SQLite migrations      | A01         | not started |                                                                                           |
| A03 | Inventory and coverage report                        | A02         | not started |                                                                                           |
| A04 | TS/JS and Python analyzers                           | A03         | not started |                                                                                           |
| A05 | Semantic identity and snapshot reconciler            | A04         | not started |                                                                                           |
| A06 | View planner and canvas navigation                   | A05         | done        | PR #6; see A06 evidence                                                                   |
| A07 | React Flow, layout worker, overlays and inspector    | A06         | done        | PR #7; see A07 evidence                                                                   |
| E01 | Run/event/artifact store and ingestion               | A02         | done        | PR #8; see E01 evidence                                                                   |
| E02 | Process wrapper and output registration              | E01         | done        | PR #9; see E02 evidence                                                                   |
| E03 | Playwright capture helper                            | E01         | done        | PR #10; see E03 evidence                                                                  |
| E04 | Output canvases and isolated preview renderer        | E02,E03,A07 | done        | PR #11; see E04 evidence                                                                  |
| M01 | Watcher and incremental invalidation                 | A05,A07     | done        | PRs #13, #14, #15                                                                         |
| M02 | Model proposal validation, cache and budget          | M01         | done        | PRs #17, #18 (view proposals deferred)                                                    |
| I01 | MCP and generic event SDK                            | E01,A06     | done        | PR #16                                                                                    |
| I02 | VS Code integration                                  | I01         | dropped     | user decision 2026-10-26                                                                  |
| I03 | OTLP subset and bundle importer                      | E04         | done        | PR #20                                                                                    |
| I04 | Skena/JSON Canvas bridge                             | I01,A07     | done        | PR #21 (JSON Canvas export; no Skena bridge)                                              |
| H01 | Retention, recovery, export and performance          | E04,M01     | not started |                                                                                           |
| L01 | Go and Java/JVM analyzers (Phase 4; not in plan §17) | A04         | done        | PR #22                                                                                    |
| D01 | System-design lens (not in plan §17)                 | A06,M02     | in progress | wave 0 PR #24, D01a PR #27, D01b PR #25; D01c, D01d in review; see D01 evidence           |
| D02 | Whiteboard, design copilot, on-demand generation     | D01         | in progress | wave 0 #26, D02a #30, D02c #31 merged; whiteboard UI and D02b in review; see D02 evidence |

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

- [x] Rapid edits coalesce. In `watch.test.ts`, 20 edits across 3 files become 1 flush and 1 published snapshot, and continuous edits are still published within the max wait. The UI updates live (`watch.spec.ts`).
- [x] Stale inference is invalidated. A model claim citing `db.ts` turns `stale` after `db.ts` is edited and a rescan publishes (`proposals.test.ts`).
- [x] Failed extraction does not erase good state. Covered by `scan.test.ts` "carries a failing analyzer's previous facts forward" and `reconcile.test.ts` "reports stale changes…".
- [x] Overlays survive renames where identity is supported. Pins, notes and remembered positions follow content-hash and user-accepted aliases relative to the viewed snapshot (`inspector.test.ts`). In `issues.spec.ts`, a pin on a moved file follows the link made in the UI.
- [x] Ambiguous renames surface as issues in the UI. A header badge opens a panel where each pair can be linked or the issue dismissed. With several candidates nothing is preselected (`issues.spec.ts`, `reconcile.test.ts`).
- [x] Model output with invented evidence is rejected. These are rejected with reasons and write nothing: an unknown evidence ID, another project's evidence, a path not in the snapshot, lines past the end, a wrong quote, a file edited after the snapshot, and a stale precondition (`proposals.test.ts`). Through MCP the same holds (`mcp.test.ts`), and in the UI (`claims.spec.ts`).
- [x] Cross-view selection uses a single entity identity. The selection is an entity that survives navigation; the node showing it is selected in every view; a view showing only its owner marks that owner; the list marks the row (`selection.spec.ts`).
- [x] A single-file update publishes within 3 s on dsh. It takes 2.6 to 2.7 s through the watcher, including the 750 ms debounce; M01a measured 5.3 s plus the debounce.

Known Phase 3 gaps, recorded rather than claimed:

- **Agent/tool, deployment-infrastructure and trust-boundary lenses are not generated.** No analyzer finds agent or tool registries, infrastructure or trust boundaries, so these lenses would be empty. The research-demo's tool calls are visible only as runtime events in Outputs & Audit.
- **View proposals (M02c) are deferred.** Groupings can be proposed as `subsystem` claims.

Phase 3 complete 2026-10-26 (tag `phase-3`).

### Phase 4 — integrations and wider language support

- [x] An external instrumented agent records a run through public tools. `mcp.test.ts` records through stdio MCP; `localDaemon` and `recorderFor` do the same for the generic SDK.
- [x] Late and duplicate events reconcile. Re-importing a trace or bundle reopens the same run: duplicates dedupe and late spans or events are appended under their parents (`import.test.ts`). Store-level deduplication is covered by `store.test.ts`.
- [~] A VS Code workspace opens the correct worktree. **Dropped by user decision (2026-10-26)**; I02 will not be built.
- [x] Supported JSON Canvas exports open in the selected renderer with relative asset links. View and run canvases render in json-canvas-viewer 4.3.2 with no errors or failed requests, labels and links visible, and the copied chart image loaded (`export.test.ts`; screenshots inspected).
- [x] Unsupported export features are disclosed. Fixed disclosures and per-view or per-run ones are printed and written to the sidecar (`export.test.ts`, `docs/export.md`).
- [x] OTLP incompatibilities produce diagnostics, not silently dropped evidence. Each case in `fixtures/otlp/` yields a diagnostic, and warnings become capture gaps on the run (`import.test.ts`).
- [x] Go and Java/JVM analyzer coverage, with capability reports. Tree-sitter analyzers with documented boundaries (`docs/capabilities.md`).
  - Hand-authored expected graphs for `go-service` and `java-service` reach precision and recall of 1.0 with no coverage gaps (`expected-graphs.test.ts`).
  - Edge cases are covered in `go-java.test.ts`.

Phase 4 complete 2026-10-26 (tag `phase-4`). VS Code integration was dropped by user decision.

Phase 5: see plan §15.

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

### M01b (2026-10-26): incremental TS/JS analysis and watcher

- TS/JS extraction is split into per-file facts and a resolve step. Facts are cached by content hash and only changed files are parsed. The dsh output is byte-identical before and after the split (sha256 prefix `2129f04c11e85b12`).
  - `incremental.test.ts`: an edit parses 1 file, and the graph equals a cold scan of the same tree.
- The daemon watcher watches only directories with inventoried files (1,410 on dsh) plus new non-excluded ones. Debounce is 750 ms with a capped wait. Watcher scans queue behind a running scan instead of cancelling it.
- Interfaces:
  - `GET` and `PUT /worktrees/:id/watch`; status lists watched worktrees.
  - `atlas watch [--detach|--off]`. `atlas open` now watches; `--no-watch` opts out.
  - A Watch/Live toggle in the UI.
- View planning on dsh dropped from 0.65 s to 0.1 s through a relation index for relevance scoring. The catalog digest is identical.
- dsh edit-to-publish: 2.6 to 2.7 s, including debounce.
- Bugs found while testing:
  - **UI lost daemon events** that arrived in the same render, leaving it stuck on "Scanning…". It now uses a queue.
  - **No-op publish events** were ignored even when the UI had not loaded that snapshot yet.
  - **Shell e2e test** depended on project order. It now registers its own project.
- Full e2e passed 6 consecutive runs, and the watch test passed `--repeat-each 4`.

### M01c (2026-10-26): stable maps and rename issues in the UI

- **Stable layout.**
  - Each view remembers where its top-level nodes were laid out (`autoPositions` in the overlay; aliases are followed).
  - Re-layout holds those nodes fixed and places new nodes in the nearest free space (layout `v5`). Fixed groups carry their children.
  - A live refresh keeps the viewport. **Re-layout** resets remembered positions but keeps pins.
  - Evidence:
    - `layout.test.ts`: fixed nodes stay put, the new node overlaps nothing, and the result is deterministic.
    - `watch.spec.ts`: every existing node keeps its exact transform while a new file appears live.
    - Screenshots before and after adding a package and a file live.
- **Rename issues.**
  - Issues now carry candidate entity IDs.
  - `listIssues` and `resolveIssue` link a pair as a `user-accepted` alias, and same-name children follow; the issue resolves when all old files are linked. Dismissing is also supported.
  - Interfaces: `GET /projects/:id/issues`, `POST /issues/:id/resolve`, a header badge and the issues panel.
  - Evidence: `reconcile.test.ts`, which also covers wrong-candidate (400) and double-link (409) errors; `issues.spec.ts`; and screenshots of the panel.
- **Fixes found by looking at screenshots.**
  - The canvas header overflowed into the inspector when the issues badge appeared. Status badges now truncate.
  - The ambiguous-rename rows preselected the first candidate, which made a wrong one-click link easy.

### I01 (2026-10-26): MCP server and generic event SDK

- **`atlas mcp [path]`** is a stdio MCP server (`@modelcontextprotocol/server` 2.4.0) scoped to one project. It has 15 tools:
  - reads: status, views, view, search, entity, evidence and refresh;
  - run reads;
  - run recording.

  It has no filesystem, SQL or command tools. Reads paginate and trim excerpts and payloads. The server's instructions mark repository and run text as untrusted. Run ingest tokens stay in the server process, and only runs started in the same session can be written. Artifact paths must resolve, after symlinks, inside the project root.

- **Daemon routes:** `GET /snapshots/:id/search` (FTS5, with FTS syntax neutralized), `GET /worktrees/:id/freshness`, `GET /artifacts/:id`.
- **Generic SDK:** `localDaemon()` and `recorderFor(client)` let any Node program record a run without `atlas run`.
- **Bug found:** malformed `assertion.result` payloads were stored but silently not counted toward the task outcome. Ingestion now rejects them with a message, and the MCP tool description documents the payload.
- **Tests.** `apps/cli/test/mcp.test.ts` uses a real stdio client spawning `atlas mcp` against a daemon found through discovery. It checks:
  - the tool list and the untrusted-content instructions;
  - reading the map end to end;
  - an agent run with explicit entity links, a failed assertion with process succeeded and task failed, and text and file artifacts;
  - path traversal, symlink and absolute-path escapes refused;
  - writes to runs from other sessions refused;
  - the generic SDK path.

  Also `search.test.ts` and the evidence assertion-rejection test.

### M02a (2026-10-26): claim proposals validated in the daemon

- `proposeClaims`:
  - Uses a closed predicate set: summary, responsibility, subsystem, role, concern, depends-on.
  - Verifies every citation, either existing evidence matching the snapshot or project run, or a file range whose bytes and quote match. File citations are stored as hash-pinned evidence.
  - Model claims are capped at `inferred`, and no relation rows are ever written.
  - The snapshot precondition is re-checked inside the write transaction.
  - Every call is audited in migration `0006`, including rejected items with reasons.
- `rejectClaim` records a human override that survives carry-forward.
- Routes: `POST /proposals/claims`, `POST /claims/:id/reject`, `GET /projects/:id/proposals`.
- MCP tools:
  - `atlas_propose_claims`. Model metadata is what the client reported, never invented.
  - `atlas_annotate`, which writes an agent-labeled note through the overlay API and retries on 409.
- Inspector: claims show text labels for origin, reported model, status and citation count, with a Reject action. Agent notes are labeled.
- Tests:
  - `proposals.test.ts`, 4 tests: the invented-evidence matrix, a stale precondition, stale-on-edit with a published rescan, rejection surviving carry-forward, and model claims staying inferred with no relations.
  - `mcp.test.ts`, which adds proposals and annotate.
  - `claims.spec.ts`.
- Screenshots of the Inspector were inspected, showing claims and an agent note made by a real `atlas mcp` session.

### M02b (2026-10-26): provider contract, mock providers, cache and budget

- `ModelProvider.enrich(bundle, existingClaims, outputSchemaVersion, budget, signal)`.
  - Only the deterministic `mock` and `mock-adversarial` providers exist; no network provider ships.
  - The daemon `Enricher` builds a redacted, bounded bundle with hash-verified excerpts.
  - Its cache key is the bundle, output schema, provider, model and prompt.
  - The ledger records estimated and reported usage separately (migration `0007`). A daily budget stops requests before they are sent, and a newer request for the same entity cancels the older one.
  - Output goes through `proposeClaims`.
- Explicit triggers only: `POST /worktrees/:id/enrich`, `atlas enrich`, and the Inspector button that appears when a provider is configured. Scans and watchers never enrich.
- **Bug found:** the validator rejected the TS analyzer's own module evidence (`1-15` for a 14-line file ending in a newline). Line counting now follows the analyzers' convention.
- `enrich.test.ts` covers:
  - off by default, with zero calls;
  - honest output accepted as inferred;
  - a cached repeat with zero calls and no duplicates;
  - adversarial invented citations rejected with reasons;
  - a secret redacted before the provider;
  - the budget skip, with zero calls;
  - cancellation of a superseded request;
  - zero calls during watcher churn.
- Tried by hand: `atlas enrich` (disabled, configure, run, cached, status) and the Inspector button, screenshot inspected.
- **Deferred (M02c):** `atlas_propose_view` and the suppress/pin UI for proposed views. Subsystem groupings can be proposed as `subsystem` claims meanwhile.

### I03 (2026-10-26): OTLP/JSON trace and run bundle import

- `atlas import <file|dir> [--root]` handles two formats:
  - **OTLP/JSON traces** (documented subset): one run per trace, spans become nested steps or tool calls, and every incompatibility is a diagnostic and a capture gap.
  - **Atlas run bundle v1**: local event IDs with parents, and artifacts confined to the bundle with symlinks resolved.
- Imported runs use `binding: none`, so they are never linked to a snapshot and carry an `imported` gap. `externalRef` (migration `0008`) makes re-imports reopen the same run with deduplication and late events appended.
- Runs' real start and end times are kept.
- The Steps tab now nests child steps under their parents, and it recognizes completions that point at their start event (the unpaired imported tool calls showed "no completion recorded").
- Tests: `import.test.ts` has 4 tests covering the mapping, diagnostics, re-import deduplication, late append, refusals, and bundle escapes and missing files.
- Tried by hand: imported both fixtures into the demo instance and inspected the run detail screenshot. Before the end-time fix the duration showed 365 days and the steps were flat.

### I04 (2026-10-26): JSON Canvas and Mermaid export

- `atlas export -o <new dir> [--view …] [--run …] [--format canvas|mermaid] [--include-logs]`.
- **Pure converters** in `@atlas/export`: views and runs to JSON Canvas, views to Mermaid, and a JSON Canvas 1.0 validator.
- **Views:**
  - positions follow the user's map (pins, then remembered layout);
  - text nodes carry status and notes;
  - drill-down is a root-relative link to the child view's `.canvas` file;
  - a versioned sidecar maps nodes and edges to Atlas IDs.
- **Runs:** artifacts come only from the isolated preview origin (`preview-url?raw=1`) and are hash-verified. HTML, SVG and unknown types are never copied, and logs only on request.
- **Bugs found by rendering with json-canvas-viewer:**
  - file paths must be root-relative, as in a vault; the image was broken;
  - SDK tool calls pair by name and order;
  - text nodes clipped their last line.
- **Tests:** `export.test.ts`, 3 tests: valid linked views opened in the renderer, run export with verified bytes and exclusions, Mermaid, and refusal to write into a non-empty directory.
- **Skena bridge:** not built. Skena is a VS Code extension, and VS Code was dropped by the user.

### L01 (2026-10-26): Go and Java/JVM analyzers

- Grammars: `tree-sitter-go` 0.25.0 and `tree-sitter-java` 0.23.5 (MIT, prebuilt wasm), verified to load under web-tree-sitter 0.27.1.
- **Go:** each package directory is a module. Exported symbols and methods are extracted. Imports resolve by the go.mod module path, and third-party imports map to the longest `require` (exact) or else heuristically. Routes are found for net/http (including `METHOD /path` patterns), chi, gin, echo and gorilla; `Handle("/", h)` counts as a router mount. Also `main` entrypoints and SQL.
- **Java:** each file is a module named by its primary type, and public methods are extracted. Imports (single, wildcard, static) resolve within the project; JDK imports are skipped, and others map to pom or Gradle group IDs (exact) or heuristically. Also Spring MVC and JAX-RS routes with class prefixes, public static `main`, and JDBC or `@Query` SQL.
- **Fixtures** `go-service` and `java-service` come with hand-authored expected graphs: 0 missing, 0 extra, 0 false positives or negatives, 0 gaps.
- **Tests:** 163 Vitest tests in 31 files, 18 Playwright tests.

### D02 (2026-10-26): whiteboard, design copilot and on-demand generation

User guide: `docs/design.md`. Waves (PRs into `develop`):

| Part          | What                                                                                                         | PR / status                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| D02 wave 0    | Contracts: `DesignElement`, drift, runtime interface, job request/event shapes, migration `0009`             | #26, merged                                         |
| D02a          | `design_elements` store and API (optimistic revisions), grouping as human claims, hide, planner merge, drift | #30, merged                                         |
| D02c          | Runtimes (Claude Code CLI, Anthropic SDK, mock), job runner, estimate, settings, `atlas design generate`     | #31, merged                                         |
| Whiteboard UI | Palette, connect, grouping, undo/redo, ghost rendering, drift markers (wave 2a)                              | parallel PR, in review                              |
| D02b          | Copilot panel, Generate design dialog, review sheet, Settings → Design agent, docs, e2e on the mock runtime  | this PR (`feat/D02-copilot-generate-ui`), in review |

### D02b (2026-10-26): copilot panel, Generate design dialog, review sheet and settings

- **Copilot** (`apps/web/src/components/design/CopilotPanel.tsx`), toggled from the design toolbar and docked right of the canvas. Deterministic suggestions computed in the browser from the projection, its `drift` and the snapshot's design claims: coupling groupings (clients/services/workers sharing ≥3 neighbors), unplaced root boxes by layer, adopt a code flow, remove a drawn flow not in code, unbind missing entities, boxes without a responsibility. Apply and Dismiss (dismissals in localStorage per project). Ask actions (propose grouping, name subsystem, explain flow, suggest responsibilities) run the configured runtime only on click; results show `agent: <model>`, citations resolved to `file:line`, Accept and Reject (promote / human group / sticky note / human responsibility claims; reject = claim reject).
- **Generate design…** (`GenerateDialog.tsx`): runtime, model, what leaves the machine, estimated tokens vs the daily budget (estimate endpoint), depth 1–3, max subsystems per level, keep or replace earlier proposals. Non-consented runtimes show the consent screen and Generate stays disabled. Progress from `design.job` SSE (forwarded by `App.tsx`) with Cancel; then the **review sheet** (`ReviewSheet.tsx`): proposals by level, Accept all, Accept (promote, nested included), Reject (rejects the agent's `subsystem` claims at and below the path), link to the run in Outputs & Audit.
- **Settings → Design agent** (`DesignAgentSettings.tsx`, a Settings button in the navigation): runtimes with availability (Claude Code listed first, "default when available"), model, write-only API key ("key stored"), one-time consent screen listing what is sent and what is never sent, withdraw consent. Recording consent never starts a job.
- **Backend:** `GET /api/v1/snapshots/{id}/design/claims` (non-rejected `subsystem`/`responsibility` claims with ids, origin, status, model), in `openapi.yaml`, with a daemon test. Copilot answers were already returned by `GET …/design/jobs/{jobId}` (`output`, kept in the run's `model.enrichment` event); the test now covers it.
- **Commands and results** (worktree of this PR):
  - `pnpm -s format && pnpm check`: exit 0. Vitest 225 tests in 40 files.
  - `ATLAS_E2E_PORT=4422 pnpm e2e`: 24 passed. Runs after the last code fixes: 3 of 3 green (default 10 workers; the third after the copilot scroll fix). Before the last two fixes: default workers 2 of 3 green, `--workers=4` 1 of 1 green. The red runs timed out in `selection.spec.ts` and `design.spec.ts` (a 34 s run instead of 8 s, while another worktree's e2e suite was also running); whether those specs also flake on `develop` was not checked. `design-agent.spec.ts` passed in every run. Settings are now loaded only when a design-agent surface opens, because reading them runs `claude --version` for availability. The suite includes `design-agent.spec.ts` (3 tests): Generate dialog with estimate → mock run → review lists proposals → accept Services (accepted in the catalog) → reject Clients (gone) → run is a `design-agent` run and opens in Outputs & Audit; copilot dismiss persists, coupling suggestion "Group worker and api" applies (accepted subsystem), Explain this flow and Name this subsystem on mock show `agent: mock-design` with `package.json` citations, Accept groups; Settings lists the three runtimes, choosing the API-key runtime shows the consent screen (cancelled), the Generate dialog disables Generate for it, and the daemon answers `403 consent_required` for `anthropic-api` and `claude-code` with the run list unchanged.
  - Manual: own daemon (`node apps/cli/src/main.ts open <copy of fixtures/ts-web-service>`, scratch `ATLAS_DATA_DIR`/`ATLAS_RUNTIME_DIR`), driven with agent-browser; screenshots of the copilot, an Explain this flow result with citations, the Generate dialog, the review sheet, and settings with the consent screen inspected. Rendering found a long copilot growing the page instead of scrolling in its panel (fixed), a wrapped button row in the review sheet (fixed) and a misleading box count (fixed). Only the mock runtime ran; `claude` was run only as `--version` by the availability check.
- **No real model call** was made, and consent was never recorded for a non-mock runtime.
- **Gaps:** the stored runtime default stays `mock` until a person picks one (Claude Code is only labeled "default when available"); the mock never nests on ts-web-service (every layer has ≤6 boxes), so level ≥1 review and nested accept are not exercised in e2e; Reject in the review sheet rejects `subsystem` claims only, not the agent's `responsibility` claims of the same members; the review sheet lists all proposed subsystems of the snapshot, not only the last job's (claims carry no job id); "Propose a grouping" works on chip-picked boxes because the canvas selection is single; the copilot's coupling heuristic is a simple shared-neighbor count.

### D02c (2026-10-26): design-agent runtimes, job runner and `atlas design generate`

- **Runtimes** (`@atlas/agent-api`, contract `DesignRuntime`, prompt `design-v1`), all working only through the design subset of the Atlas MCP tools (reads + `atlas_propose_view` / `atlas_propose_claims`; no refresh, notes or run tools):
  - `mock`: deterministic and free. Level 0 groups the System design boxes by archetype layer, subsystems with more than 6 boxes split by folder down to `depth`, capped per level; submitted with `atlas_propose_view` citing the evidence ids it read. Copilot kinds answer deterministically.
  - `claude-code`: `claude -p <prompt> --output-format stream-json --verbose [--model] --no-session-persistence --permission-prompts none --strict-mcp-config --tools "" --disallowedTools Bash,Edit,Write,WebFetch,WebSearch --allowedTools mcp__atlas__atlas_<8 tools> --mcp-config <temp json>` (flags from `claude --help` 2.1.311), argv array in an empty temp cwd; the config starts `node apps/cli/src/main.ts mcp <root>` (no token in it). Parses tool calls, usage and the result; cancel kills the child.
  - `anthropic-api`: `@anthropic-ai/sdk` 1.3.0 tool-use loop in process, default `claude-sonnet-5-5`; key only from `ATLAS_ANTHROPIC_API_KEY`, `secret-tool`, or `<dataDir>/secrets/anthropic-api-key` (0600), always passed explicitly (never ambient credentials), scrubbed from errors.
- **Job runner** (`apps/daemon/src/design-jobs.ts`): `POST/GET /projects/:id/design/jobs`, `GET …/:jobId`, `DELETE …/:jobId` (cancel), `GET …/estimate`, `GET/PUT /settings/design-agent`. Manual only; one job per project (409); non-mock runtimes need recorded consent (403); `anthropic-api` held to the M02 daily budget (429) and ledgered. Each job is a run with adapter `design-agent` bound to the snapshot it reads (tool calls, progress, usage, output as events); progress streams as `design.job` SSE events. `replaceProposals` rejects earlier model `subsystem`/`responsibility` claims of that snapshot (audited). Interrupted jobs are marked failed on restart.
- **CLI:** `atlas design generate [--depth] [--runtime] [--model] [--replace-proposals] [--yes]` prints the estimate and what leaves the machine (non-mock needs `--yes` or a TTY confirmation); `atlas design status`; `atlas doctor` reports `claude --version`.
- **Tests:** runtime unit tests (mock determinism/depth/cap/copilot; claude-code against a fake `claude` on a private PATH incl. malformed lines, error result, crash, failed MCP server, cancel kills the child; anthropic with an injected fake client, key scrubbing, no-key refusal), daemon job tests (mock end to end → proposed `design-subsystem` canvases and a `design-agent` run; consent 403; key file 0600 never echoed; cancel; 409; budget 429 + ledger), CLI `design generate --runtime mock`. No real model call and no real `claude` run in tests. `pnpm check` exit 0 (210 tests). Generation never collects boxes inside accepted subsystems (tested with a human grouping).
- **Gaps:** generation proposes claims only (`proposedElements` is 0; ghost design elements belong to wave 1a/2b); the token estimate is a rough formula; `claude-code` usage is not held to the API budget (it counts against the Claude plan); copilot output is kept in the run, not a dedicated column; the planner places a unit on the lexicographically first subsystem path regardless of claim origin (D01 owners), so the runtimes avoid proposing for accepted boxes; the CLI consent step also makes that runtime the configured default.

### D01 (2026-10-26): system-design lens

A third workspace, `design`: whiteboard canvases derived on demand from the semantic graph, `subsystem` claims and view overrides. They are views, never facts, and never persisted. See `docs/views.md` ("System design lens (D01)").

| Part   | What                                                                                                                                                           | PR / status |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| wave 0 | Contracts: `Workspace`, `DesignLens`, `CanvasSpec.provenance`, `Archetype`, `Provenance` (the `view_overrides` table already existed in migration 0001)        | #24, merged |
| D01a   | `planDesign` / `projectDesign`: archetypes with reasons, flow labels, subsystem canvases from normalized `/` paths (depth 3), context ports, realized-by links | #27, merged |
| D01b   | Daemon plans design canvases on read and replans on claim, issue and override events; override routes; promote through the validator; `atlas_propose_view`     | #25, merged |
| D01c   | Web UI: design root, whiteboard theme, provenance badges, realized-by navigation, pin/suppress/promote                                                         | in progress |
| D01d   | Docs, demo proposal, export "Realized by" links                                                                                                                | this PR     |

D01d evidence (commands run in the D01d worktree):

- **Docs:** `docs/views.md` documents what `design.ts` actually does: archetype and infrastructure rules in order, flow labels, paths, titles, ports, caps, provenance, overrides, and the on-demand invariant. Also `docs/capabilities.md` (design-lens row; the "view proposals not implemented" note is removed), `docs/export.md` and the README.
- **Export:** design boxes get an archetype/provenance line and a root-relative `[Realized by: <title> →](views/….canvas)` link. Design edges carry the flow label. Links to views outside the export are disclosed.
  - `pnpm exec vitest run apps/cli/test/export.test.ts`: 3 passed.
  - The test asserts that `views/system-design.canvas` exists, that every realized-by link resolves to an exported non-design canvas, and that json-canvas-viewer renders it with no page errors or failed requests.
  - Screenshot inspected. The first render clipped the link line, so design boxes are now taller.
- **Demo:** `ATLAS_DATA_DIR=<dir> ATLAS_RUNTIME_DIR=<dir> pnpm demo`, with two fresh `mktemp -d` directories. After the runs, it rescans and proposes "Research backend" (`@research/api` and `@research/worker`) through `POST /api/v1/proposals/claims`. The claims are `origin: model`, labeled with model `demo-mock` (no model is called), and cite the packages' scan evidence ids. Output:
  `system design: "Research backend" (proposed): Proposed by demo-mock: groups 2 box(es) (@research/api, @research/worker).`
  - The root projection then showed web (client), research-jobs (queue), Third-party libraries (library) and a "Research backend" subsystem box (api-service, proposed) with `enqueue` and `uses` flows.
  - The subsystem canvas showed @research/api (api-service) and @research/worker (worker), with two context ports.
  - The daemon was stopped with `atlas daemon stop`, using the same environment.
- **Full check:** `pnpm -s format && pnpm check`: exit 0, 186 Vitest tests in 35 files. `pnpm e2e` was not run in this ticket because another agent was using the fixed port.

## Environment record (2026-10-26)

Ubuntu 24.04 x86_64, 32 cores, 125 GiB RAM. Node 24.21.0, pnpm 10.18.0, Python 3.12.3, uv 0.11.32, git 2.43.

## Verified dependency decisions

See `docs/adr/`. Summary: @xyflow/react 12.12.0, elkjs 0.12.0 (EPL-2.0), node:sqlite (FTS5 verified locally), web-tree-sitter 0.27.1 + grammar wasm (load test pending in A01), typescript ~6.0.2, zod 4, fastify 5, playwright 1.64.1, @modelcontextprotocol/server 2.4.0. Skena and Subcanvas are references only.

## Session log

- 2026-10-26: Inspected toolchain and upstream deps; created repository, CLAUDE.md, this file; created public GitHub remote.
