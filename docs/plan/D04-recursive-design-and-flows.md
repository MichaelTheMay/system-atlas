# D04: recursive system design and user-flow mapping

Status: planned 2026-11-09, not started. Integration branch: `feat/D04-recursive-design`.

The owner asked for "make the system design and user flow mapper recursively better". This plan
reads that as: every level of the design should be a readable picture that opens into the next
level, the same way down to modules, and user flows should follow the system down those levels.
Work is iterated as render → look → fix, with screenshots as the acceptance evidence.

The revert point taken before this work is tag `checkpoint-2026-11-09-d03`, the same tree as
`main` at `bb47ae0`.

## What is wrong today (Atlas scanning its own repo, 2026-11-09)

Seen in the running app and confirmed in code:

1. **The from-code root is flat.** It has 31 boxes and 82 "uses" flows on one canvas and no
   nesting.
   - `designModel` (`packages/planner/src/design.ts`) creates subsystems only from `subsystem`
     claims or from a deployable that runs several packages. Atlas has neither, so there is no
     hierarchy.
2. **The claims cliff.** Detected grouping runs only when _no_ usable claim exists, so accepting
   one Copilot grouping removes every detected subsystem.
3. **Test fixtures are drawn as the system.**
   - `notekeeper`, `inventory`, `ledger`, `example.com/orders`, `web`, `api`, `worker`,
     `research-jobs`, `report-jobs`, `db` and `queue` all come from `fixtures/`.
   - They sit on the root next to `@atlas/*`.
4. **Config files are drawn as services.** `vitest.config`, `eslint.config` and `playwright.config`
   become loose single-file units with archetype `service` ("a generic component").
5. **Tables join the wrong database.** All tables go to the first non-cache database
   (`buildUnits`). Here that is the ts-web-service fixture's Postgres `db`, so Atlas's own
   SQLite tables (`packages/store/migrations`) show up inside a fixture's database.
6. **The from-code board is one flat frame.**
   - `codeSpecOf` (`packages/graph/src/boards-from-code.ts`) imports only the root projection,
     and `boardSpecFromProjection` drops port nodes.
   - Internals sub-boards exist, but they are created one at a time by hand and start empty.
7. **Scenarios are flat and hand-made.**
   - Each step binds to one connection or component on one board.
   - Nothing checks that step _n_ starts where step _n − 1_ ended. The chat template's first
     scenario skips the load balancer → gateway hop and nothing flags it.
   - No flow is derived from code.
   - A step cannot open the internals of the component it passes through.
   - The step-target dropdowns are cut off in the inspector.

Facts that constrain the design:

- **Board nesting.** Boards nest a root plus two levels (`createBoard`, `boards.ts`). The design
  lens allows a root plus three subsystem levels (`MAX_SUBSYSTEM_DEPTH = 3`).
- **Deletes already cascade** recursively (`deleteBoard`).
- **`Scenario` already has `origin` and `status`.** `ScenarioStep` has `connectionId`,
  `componentId` and `text`.
- **Locations of non-code units.**
  - Queues have a location only through their evidence (`evidence.path`).
  - Databases have `composeFile`.
  - Tables have `declaredIn`.
- **Subsystem boxes already work.** `projectDesign` folds the units on a subsystem path into one
  subsystem box and draws outside units as ports, so new detected paths reuse that machinery.
- **One existing test depends on today's flat shape.** `design-agent.spec.ts` relies on
  ts-web-service never nesting, so small repos must keep today's shape.

## Milestones

Each milestone is a PR into `feat/D04-recursive-design`, not `develop`. Nothing reaches
`develop` or `main` without the owner's go-ahead. Each milestone ends with a checkpoint for review.

### M0: baseline (measure first)

- **Self-scan numbers:** root box and flow counts, canvas count, and the largest canvas.
  Screenshots of the From code root and of a from-code board.
- **Catalog and projection digests** for `ts-web-service`, `py-cli-api`, `go-service`,
  `java-service` and `research-demo`. These must not change unless a milestone says so.
- **Planning time on `~/Dev/dsh`.** `planDesign` plus a root `projectDesign` (A06 measured
  catalog planning at about 0.1 s), and the dsh root box count.
- **Output:** a short table in `IMPLEMENTATION_STATUS.md` under D04 evidence.

### M1: detected hierarchy in the design lens (planner, deterministic, no model)

1. **Location of every unit.**
   - Code units use their anchor's path.
   - Non-code units use `composeFile` or `declaredIn`, else the path of their first evidence.
   - A unit with no location joins the group of the code that publishes to, subscribes to, reads
     or writes it, if there is exactly one such group.
2. **Detected subsystems by layout.** The rule applies only when the root would show more than 12
   boxes, so small repos and every current fixture keep their shape.
   - **Fixtures and examples:** units under `fixtures/`, `examples/`, `testdata/`, `__fixtures__/`
     or `samples/` go into one group, "Fixtures & examples". Below it there is one subsystem per
     fixture directory (`fixtures/ts-web-service`, …) when the group still has more than 12 boxes.
   - **Tooling:** root-level config modules (`*.config.*`, `.*rc.*`) and `scripts/` go into a
     "Build & test tooling" group. This replaces `service` for config files. No new archetype is
     added, so there is no schema change.
   - **Workspace folders:** the remaining code units are grouped by top-level workspace folder
     (`apps/`, `packages/`, `extensions/`, `services/`, `libs/`, `cmd/`, …). A group forms when the
     folder has at least two units. A single-unit folder stays on the root.
   - **Nesting:** this repeats inside a group above the same threshold, by the next folder level,
     up to `MAX_SUBSYSTEM_DEPTH`.
   - **Keys:** paths use the `name#id` form already used by the deployable baseline, so they can
     never collide with a claim path. Provenance is `detected`, and the reason names the rule,
     for example "Detected: 9 packages under packages/".
3. **Fix the claims cliff.**
   - Claims win per unit, as today.
   - A unit with no claim path keeps its detected path.
   - Detected and claim subsystems may sit on the same canvas.
   - Generate and the Copilot may propose over detected groups. A proposal or human claim for a
     unit moves only that unit.
4. **Tables.** Tables go to the database declared in the same project directory: compose file and
   migration under the same top-level folder or fixture. If no database matches, they go to a
   "Database tables" store in that group. They no longer go to the first database found.
5. **Ports stay bounded.** Each subsystem canvas keeps the existing port cap of 12.
6. **Docs.** `docs/views.md` lists the new rules in order, as D01d did for the existing ones.

**Acceptance:**

- **Self-scan:**
  - The root has 12 boxes or fewer, and no fixture or config file sits on it.
  - Every subsystem canvas has 30 boxes or fewer.
  - Each fixture opens as its own subsystem.
  - Atlas's tables sit in a store under `packages/`.
- **Stability:** fixture catalogs and projections are byte-identical to M0. Re-planning the same
  graph is byte-identical, as `views.test.ts` and `design.test.ts` already require.
- **Claims cliff:** a new unit test accepts one human `subsystem` claim and checks that the other
  detected subsystems remain.
- **Performance:** dsh planning time stays within 2× of M0, and the dsh root box count is recorded.
- `export.test.ts` still resolves every realized-by link.
- **Screenshots:** before and after of the self-scan root, plus one subsystem canvas.

### M2: recursive from-code import (boards)

1. **One board per subsystem.**
   - `codeSpecOf` walks the design catalog. Each subsystem canvas becomes an internals sub-board,
     and its subsystem box on the parent gets `internalsBoardId`.
   - **Depth rule:** the board cap stays at a root plus two levels. The lens's third level is
     drawn as frames on its level-2 board, so nothing is lost and no migration is needed.
2. **Atomic tree.**
   - The whole board tree is created in one transaction, with one `design.board.changed` event
     for the root.
   - A failure creates nothing. A test fails inside the walk and checks that no board rows remain.
3. **Ports become stubs.** Boundary ports become faded external stubs (a `box` component with
   `origin.author = 'code'`, labeled "outside: <name>"), so a sub-board's flows still show where
   they leave.
4. **Import into an open board.** "Import as built" into an existing board stays root-only, so a
   drawing is never flooded. Its menu entry says so.
5. **Navigation.** Breadcrumbs (parent link) appear on sub-boards, and **Open internals** on any
   imported subsystem box.

**Acceptance:**

- The daemon test uses a fixture that nests: a new small `fixtures/monorepo-nested` with 14 or
  more units across `apps/`, `packages/` and `fixtures/`. ts-web-service never nests, so the
  D03b test proves nothing here.
- The test checks the tree shape, `internalsBoardId` links, stubs, atomicity, and that a
  recursive delete removes everything.
- e2e: create a from-code board, open internals two levels down and come back, and check
  breadcrumbs.
- Screenshots of the self-scan from-code board tree, root and one sub-board.

### M3: user-flow mapper (scenarios)

1. **Continuity check** (a pure function in `@atlas/export`, unit-tested).
   - Flag step _n_ when its hop does not start where step _n − 1_ ended. A component step counts
     as both ends.
   - Offer **Insert missing hops**: the shortest path over the board's connections, found by BFS
     with a deterministic tie-break.
   - Shown as a warning chip on the step and in the sequence view. Never blocking.
2. **Recursive steps.**
   - Add an optional `drillInto: { boardId, scenarioId }` to `ScenarioStep`. Old documents must
     still parse, with a schema test using a D03 document.
   - In the panel, "Open internals flow" on a step whose component has internals.
   - The Player descends into the sub-board, plays the linked scenario, and returns to the next
     step.
   - **Risk:** `openBoard` remounts `BoardView`. Player state (the scenario stack) must be lifted
     above the board view and kept in the board route, or it is lost on descent.
3. **Flows derived from code** on from-code boards. Deterministic, labeled
   `origin.author = 'code'`, status `active`, never facts. Each derived flow:
   - **Path:** UI surface → endpoint it calls → service that exposes it → stores and queues that
     service reads, writes or publishes to.
   - **Size:** at most 8 flows per board, ranked by the number of hops.
   - **Recursion:** on a recursive import, the root flow's hop through a subsystem drills into a
     flow derived on that sub-board.
4. **Mermaid nesting.** The sequence view renders a drill-down as a `rect` block with the
   sub-flow's steps. Markdown export does the same.
5. **Agents.** `atlas_get_board` shows `drillInto`, and the prompt version becomes `board-v2`.
   The mock's "explain a scenario" follows drill-downs.
6. **Dropdowns.** Step-target dropdowns no longer clip: full width in the panel, with a title on
   hover.

**Acceptance:**

- Unit tests:
  - continuity check, missing-hop insertion and tie-break;
  - derivation on `ts-web-service` (expected flows written by hand first) and on the M2 nested
    fixture (a drill-down link exists);
  - Mermaid nesting.
- e2e on the chat template: the gap warning appears on step 2, and Insert missing hops fixes it.
  On the nested fixture board, the Player descends into the sub-board and returns.
- Screenshots of the warning, the player inside a sub-board, and the nested sequence diagram.

### M4: verification and wrap-up

- `pnpm -s format && pnpm check`.
- `ATLAS_E2E_PORT=<free> pnpm e2e` three times, compared with the flake baseline in the D03
  evidence (`develop` lost one whiteboard test in 1 of 3 runs).
- Before and after screenshots of the self-scan for the From code root and the from-code board
  tree, looked at before reporting.
- `docs/design.md` and `docs/views.md` updated, and `IMPLEMENTATION_STATUS.md` D04 evidence with
  real commands and outcomes.
- **Release** only on the owner's go-ahead: `feat/D04-recursive-design` → `develop` → `main`.
  The 2026-11-09 squash to `main` means `main` is not an ancestor of `develop`, so the next
  release PR diff will repeat D01–D03. Squash again, or ask to allow a merge commit for
  releases.

## Out of scope

- New archetypes or component types.
- Model calls of any kind; everything above is deterministic. The mock runtime is the only one
  exercised.
- Live re-sync of from-code boards with later scans. Boards stay copies, by design.
- The e2e flakes recorded in D03, unless they block a milestone.

## Risks

- **The threshold is a heuristic.** 12 root boxes and the folder names are tuned on a few repos.
  M0 records dsh so the effect on a large repo is measured, not guessed.
- **Moving tables changes current output.** Check that the expected-graph fixtures do not cover
  the design lens. Analyzer facts do not change; this is a view rule.
- **Player recursion touches `BoardView` mounting,** the same area as the D03c reload-after-job
  logic. Keep the change behind the route state and cover it with e2e.
