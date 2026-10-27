# Views: catalog, navigation and projections

Implements plan §8. The code lives in `packages/planner` (pure functions) and is called from the scan pipeline and the daemon.

## Catalog (per snapshot)

`planViews()` runs inside the publish transaction. Every snapshot therefore has a catalog of `CanvasSpec` rows and `CanvasLink` rows (`canvases`, `canvas_links`). Catalog entries are cheap. Content is projected lazily on request.

Canvas IDs are stable: a hash of project, workspace, lens and owner entity. The same view keeps its ID across snapshots, so overlays survive regeneration.

| Lens                            | Owner                 | Generated when                                              |
| ------------------------------- | --------------------- | ----------------------------------------------------------- |
| System context                  | system                | always                                                      |
| Project structure (`component`) | system                | always                                                      |
| Coverage & unknowns             | system                | always                                                      |
| Changes since previous snapshot | system                | a previous snapshot exists (stable presence, fixed score)   |
| Deployables                     | system                | compose/deployable entities or Dockerfile entrypoints exist |
| API                             | system                | endpoints exist                                             |
| Data                            | system                | tables or databases exist                                   |
| Workflows & queues              | system                | queues, topics or jobs exist                                |
| UI navigation                   | system                | UI routes/screens exist                                     |
| `component`                     | package or deployable | it has at least 2 navigation children                       |
| `module-detail`                 | module                | it has at least 3 children (symbols, endpoints, screens)    |
| Package `· API` / `· Data`      | package               | at least 2 endpoints / read-write relations in its subtree  |

Agent/tool, deployment-infrastructure and trust-boundary lenses are not generated yet: no analyzer produces evidence for them.

### Navigation tree

- A root package, meaning a manifest at the registered root owned by the system, is merged into the system for navigation. The first canvas is therefore never a one-box chain.
- `child` links follow canonical ownership only. A canvas's parent is the nearest navigation ancestor that has a container canvas. The child graph is a forest with at most one parent per canvas; this is tested.
- `sibling` links connect lenses that share an owner.
- Other appearances of an entity, such as a package shown in the API lens, are navigable through `openCanvasId` on projection nodes, not through extra tree edges.

### Relevance policy `relevance-v1`

The score is deterministic and in the range [0, 1]:

```
0.20 × evidence    (share of relations in scope that are supported)
0.15 × entrypoints (min(1, n/2))
0.25 × interfaces  (endpoints + screens, min(1, n/5))
0.20 × boundary    (package/deployable 1, module 0.5)
0.20 × coupling    (relations crossing the boundary, min(1, n/10))
```

System-level lenses use fixed scores. Every spec carries a plain-language `relevanceReason`, which answers "Why this canvas?".

## Projections

`projectView(graph, catalog, canvasId, focus?)` returns nodes and edges for one canvas.

- **Containers.** Children are shown up to 30 at a time (`MEMBER_TARGET`). Above that they are clustered:
  - Entities with paths cluster by directory. Levels where everything sits in one directory are skipped automatically.
  - Entities without paths, such as tables and endpoints, cluster by kind.
  - Overflow folds into `other`.
- **Cluster drill-down.** The same canvas is shown with a `focus` path. It gets its own `viewId`, a hash of the canvas ID plus the focus, so overlays never mix positions between levels.
- **External libraries.** Always aggregated into one "Third-party libraries" node. Drilling in lists them, grouped by npm scope or ecosystem when there are many.
- **Boundary ports.** A relation leaving the view becomes an edge to a port node for the outside entity's anchor: its ancestor directly below the lowest common ancestor with this canvas's root. Ports link to the canvas where the anchor lives. At most 12 ports are shown; the rest fold into "N other targets".
- **Edges.** Edges aggregate relations between visible nodes, with per-kind counts, up to 50 relation IDs (for "Why this edge?" and evidence), and a status of `supported`, `inferred`, `stale` or `mixed`.
- **Determinism.** Output is ordered by ID, so identical graphs produce identical projections; this is tested.

Measured on `~/Dev/dsh` (9,175 files) on the development machine described in `IMPLEMENTATION_STATUS.md`:

| Measure            | Result                 |
| ------------------ | ---------------------- |
| Catalog size       | 1,414 canvases         |
| Catalog load       | 62 ms                  |
| Projection time    | p50 6.5 ms, p95 8.7 ms |
| Largest projection | 40 nodes               |

## API

- `GET /api/v1/snapshots/:id/canvases` returns the catalog.
- `GET /api/v1/snapshots/:id/canvases/:cid/projection?focus=` returns a projection.
- `GET /api/v1/worktrees/:id/canvases` returns the catalog of the latest snapshot.

Projections are snapshot-scoped, so runs (E04) can be shown against the snapshot that existed when they ran. The CLI command `atlas views list [path]` prints the navigation tree.

## UI (A07)

`apps/web` renders projections with React Flow:

- **Layout.** ELK runs in its own Web Worker through `elk-api` and ELK's `elk-worker.min.js`, wrapped by `@atlas/layout` for deterministic input order and pinned positions. Compound nodes, such as package groups and services with containers, get a label band.
- **Nodes.** Shapes and icons differ per kind: entities, clusters, aggregates, ports, gaps and groups. Stale, removed and change states carry text tags, not color alone. Secondary labels hide below 60% zoom.
- **Edges.** Supported edges are solid, inferred edges dashed, stale edges dotted, and mixed edges dash-dot. Labels sit near the target end, and non-supported labels name their status.
- **Navigation.** Double-click (or Enter) on a node opens its child canvas or expands a cluster. The catalog tree shows `child` links, with search across all canvases. Breadcrumbs, back/forward and the lens switcher (siblings) complete it.
- **Inspector.**
  - Canvas: "Why this canvas?", "What is missing?" and "Last changed".
  - Entity: ownership chain, relations with status and confidence, evidence with freshness (current, changed or deleted relative to the latest snapshot), claims and last change.
  - Edge: "Why this edge?", with each relation and its evidence.
  - Source: the cited lines highlighted. Source is only shown when the file still matches the snapshot hash.
- **Overlays.** Per view and local profile, stored in `view_overlays`, saved after a 350 ms debounce with optimistic revisions; a conflict re-applies the edit on top of the stored version.
  - Dragging pins a node. Entity positions are keyed by entity ID and follow accepted rename aliases, so pins survive rescans and file moves.
  - Notes are presentation only and never become facts. The viewport is remembered only after user moves.
- **List view.** A table alternative to the canvas (nodes, relations, inspect and open actions) for keyboard and screen-reader use.

### Overlay and inspector API

- `GET/PUT /api/v1/views/:viewId/overlay` (`?project=` to follow aliases). PUT returns 409 with the current overlay on a stale revision.
- `GET /api/v1/snapshots/:id/entities/:eid` returns entity details.
- `GET /api/v1/snapshots/:id/relations?ids=` returns relation details with evidence.
- `GET /api/v1/snapshots/:id/source?path=` returns manifest files only. It rejects paths with `..` or a leading `/` and paths escaping the root, and it never returns bytes that differ from the snapshot.

### Stable maps (M01c)

A map should not rearrange itself every time the code changes (plan §9).

- **Remembered positions.** After every layout, each view's overlay records where its unpinned top-level nodes landed, in `autoPositions`. Entries are keyed by entity ID, so they follow accepted renames, or by projection node ID.
- **Re-layout.** Nodes with a remembered position, and user pins, are fixed and carry their group children along. Every other top-level node keeps its ELK position if that spot is free. Otherwise it moves to the nearest free spot, searched on a 24 px grid ring by ring, which is deterministic. The layout version is `v5`.
- **Viewport.** A live refresh of the view on screen keeps the viewport.
- **Reset.** The canvas header's **Re-layout** button clears remembered positions but keeps pins.
- **Tests.** The `layout.test.ts` stability test, and `watch.spec.ts`: a file added while watching leaves every existing node at its exact position and the new node overlaps none.

### Rename issues (M01c)

Ambiguous renames are never merged automatically. Neither are possible renames, where the same file name has different content. The header shows "N rename issues to review", which opens a panel listing each issue's old and new candidates.

- **Link** records a `user-accepted` alias from the old entity to the new one. Child symbols with the same kind and name follow when both snapshots are still stored. Pins, notes and remembered positions follow when read, and human claims follow from the next scan.
- **Several candidates.** Nothing is preselected, because a wrong link is worse than none.
- **Resolution.** The issue resolves once every old file is linked. **Dismiss** closes it without linking.
- **API.** `GET /projects/:id/issues`, `POST /issues/:id/resolve`.
- **IDs.** Issues record candidate entity IDs when they are raised, so they stay linkable after the old snapshot is compacted.

### One selection across views (Phase 3)

The selection is an entity, not a node of one canvas.

- Navigating to another view keeps an entity selection. Edge and cluster selections reset.
- Every canvas that shows the entity shows it selected, and the list alternative marks its row with `aria-current`.
- A canvas that shows the entity only inside an owner, for example the Data lens showing a module's package, marks the nearest visible owner as _contains selection_: a dashed outline and ◎.
- The Inspector keeps the entity's details throughout.
- Test: `selection.spec.ts`.

## System design lens (D01)

A third workspace, `design`, draws whiteboard views of the same semantic graph: a few boxes with plain flows between them, the way a person sketches a system. `planDesign` and `projectDesign` in `packages/planner/src/design.ts` produce it.

### Views, never facts

- **Nothing here is a fact.** The planner reads entities, relations, `subsystem` claims and view overrides. It never writes a claim, a relation or an entity, and it never mutates its inputs.
- **Derived on demand, never persisted.** Architecture canvases are stored when a snapshot publishes. Design canvases are not, because they depend on claims and overrides, which change after publish.
  - The daemon plans them when a catalog is requested.
  - It replans them when a `claims.proposed`, `claims.reviewed`, `issue.resolved` or `views.changed` event moves the project's view revision. No rescan is needed.
  - The `canvases` table never holds a design canvas (`apps/daemon/test/design.test.ts`).
- **Deterministic.** The same graph, claims and overrides give the same catalog and the same projections. No model is involved.
- **Always there.** With no claims at all, every snapshot with at least one box has a design root.

### Canvases and hierarchy

- **`design-system`** is the root, titled "System design". Its reason states how many boxes and subsystems it has.
- **`design-subsystem`** canvases nest beneath it, up to three levels: System design > `A` > `A/B` > `A/B/C`.
  - Each path prefix that has members is a canvas.
  - Each is linked to its parent by a `child` link, so the navigation tree stays acyclic.
- **Where subsystems come from:**
  - **Claims.** Each non-rejected `subsystem` claim places the box that contains its subject on a path. A claim on a module lifts to the box that module belongs to; a box is never split.
  - **Baseline.** Used only when no usable `subsystem` claim exists. A deployable that runs two or more packages becomes a `detected` subsystem named after the deployable. As soon as any claim applies, the baseline is not computed.
- **Paths.**
  - The value is split on `/`. Each segment is trimmed and its whitespace collapsed.
  - The lowercased segments are the identity, so `Backend/Auth` and `backend / auth` are the same subsystem.
  - The planner ignores segments past the third. `atlas_propose_view` rejects names deeper than three levels, but a raw `POST /api/v1/proposals/claims` checks only the 80-character limit.
- **One path per box.** When claims put a box on several paths, the lexicographically first normalized path wins.
- **Titles.** A subsystem canvas is titled with its own, last segment, so `Backend/Auth` is titled "Auth". The casing comes from the first human claim, otherwise from the first claim by id.
- **Context ports.** On a subsystem canvas, boxes outside it that exchange flows with it are drawn as ports.
  - Flows between two ports are dropped.
  - Ports with no flows are removed.
- **Subsystem boxes.** On the parent canvas, a subsystem is one box that opens its canvas.
  - Its archetype is the most common archetype of its members.
  - Ties are broken in this order: client, api-service, worker, queue, datastore, cache, external-api, library, service.
- **Caps.**
  - At most 200 nodes per design canvas, the plan §16 hard cap.
  - A single-package repo is grouped by directory, with up to 10 groups. The smallest fold into one "N more modules" box.

### Boxes and archetypes

Every non-test entity belongs to at most one box, so relations aggregate into flows between boxes. Each box has an archetype and a one-sentence reason, shown in the UI and in exports.

| Box                                                                             | Archetype                                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| All third-party packages, as one box                                            | `library`                                                                                                              |
| External system                                                                 | `external-api`                                                                                                         |
| Queue or topic                                                                  | `queue`, with publisher and subscriber counts                                                                          |
| Database whose name or image matches redis, memcached, valkey or dragonfly      | `cache` (labeled heuristic)                                                                                            |
| Other database                                                                  | `datastore`. The first one also holds the declared tables. With no database, the tables form one "Database tables" box |
| Infrastructure resource                                                         | See the infrastructure rules below. All are labeled heuristic                                                          |
| Code: a deployable fused with the one package it runs                           | Code rules below                                                                                                       |
| Code: a package run by a deployable that runs several packages                  | Code rules below. These packages form the baseline subsystem                                                           |
| Code: any other internal package, or a directory group of a single-package repo | Code rules below                                                                                                       |

A deployable "runs" a package when its entrypoints call into the package, or when its Dockerfile sits in the package directory.

**Infrastructure rules**, checked in order:

1. Named like a broker (`queue`, `queues`, `broker`, `mq`, `bus`, or containing kafka, rabbit, nats, sqs or pubsub), or built from a broker image: `queue`. This check comes first, so a Redis service named `queue` is a queue.
2. A cache name or image: `cache`.
3. A database image: `datastore`.
4. Otherwise: `service`.

**Code rules**, first match wins:

1. Owns UI routes or screens: `client`.
2. Exposes endpoints: `api-service`.
3. Subscribes to a queue or topic outside the box: `worker`.
4. Owns jobs: `worker`.
5. Has entrypoints. Then the first of these that applies:
   - The box is an `api-service` when any of these holds:
     - its code reaches endpoints through imports;
     - it imports an HTTP server framework, such as express, fastify, hono, Nest, chi, gin, Flask, FastAPI or Spring Boot;
     - it is a `main` in a package that exposes endpoints.
   - A CLI-like entrypoint makes it a `client`: `cli`, `cmd` or `command` in the entrypoint target, or `cli` in the entrypoint name or the box label. Command-line programs are clients.
   - Otherwise it is a `worker`, a background process.
6. Named like a front end (web, ui, frontend, client, browser, spa): `client`. When the label or sublabel matches and the box calls endpoints of other boxes, the reason says so; otherwise only the label is checked and the reason says it is a name heuristic.
7. Imported, depended on or called by other boxes: `library`.
8. Calls endpoints of other boxes: `client`.
9. Otherwise: `service`, a generic component.

### Flows

Relations between two boxes aggregate into one edge. Its `flow` label lists every label that applies, in this order:

| Label          | From relations                                                 |
| -------------- | -------------------------------------------------------------- |
| `HTTP`         | `calls` to an endpoint                                         |
| `runs`         | `calls` from an entrypoint                                     |
| `calls`        | other `calls`                                                  |
| `enqueue`      | `publishes`                                                    |
| `consume`      | `subscribes`                                                   |
| `reads/writes` | both `reads` and `writes`; otherwise `reads` or `writes` alone |
| `invokes`      | `invokes-tool`                                                 |
| `configures`   | `configures`                                                   |
| `produces`     | `produces`                                                     |
| `exposes`      | `exposes`                                                      |
| `runs on`      | `deploys-to`                                                   |
| `uses`         | `imports` or `depends-on`, only when no other label applies    |

The edge keeps its relation kinds, its relation ids and its supported, inferred or stale status, exactly as in architecture views.

### Provenance

Every design canvas and subsystem box carries a provenance label. Code-derived boxes are always `detected`.

| Label      | Meaning                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `detected` | Analyzers only: the root and the deployable baseline. The reason names the deployable and its packages                        |
| `proposed` | A model or agent `subsystem` claim, stored as `inferred`. The reason says "Proposed by `<model>`" and lists the grouped boxes |
| `accepted` | A person decided: a human-origin `subsystem` claim, or a proposal that was promoted                                           |

### Overrides

Overrides are presentation decisions keyed on stable canvas ids. They are stored in `view_overrides` (`packages/graph/src/overrides.ts`). Canvas ids are stable, so overrides survive rescans and regeneration.

- **API.**
  - `PUT /api/v1/views/:viewId/override { action, enabled, projectId, snapshotId?, subsystemPath? }` sets or clears one override.
  - `GET /api/v1/projects/:id/overrides` lists them.
  - Every change publishes `views.changed`, so open views update.
- **Suppress.** The subsystem canvas stays in the catalog with state `suppressed`. Its parent draws the member boxes directly instead of one subsystem box.
- **Pin.** When cited evidence changes, claims become `stale` and normally stop counting.
  - A pinned subsystem keeps its stale claims. The pin applies to the canvas of the claim's full path: pinning a parent does not keep the stale claims of nested subsystems.
  - Its reason gains "Pinned: kept while its evidence changed."
  - Its state is `stale` when every contributing claim is stale.
- **Promote** needs `snapshotId` and `subsystemPath`. It re-proposes every matching model claim, for that path or nested beneath it, as a human claim citing the same evidence. The validator checks them again; nothing is forced.
  - When all are accepted, the `promote` override is recorded and the subsystem reads `accepted`.
  - When any is refused, for example because a cited file changed, the response is `409 promotion_rejected` with reasons. The accepted part is kept, and the override is not recorded.
  - A subject that already has the same human claim is not re-proposed.
- **Reject.** Rejecting the claims of a proposal (`POST /api/v1/claims/:id/reject`) removes the subsystem. Rejected claims are always ignored.

### Realized by

Every box links to the architecture canvas that realizes it, through `realizedByCanvasId`. The planner looks for a component or module-detail canvas in this order:

1. the canvas of the box's own entities;
2. the canvas of the nearest ancestor;
3. the system canvas.

The box keeps the entity id, so a selection carries across to the architecture view. JSON Canvas exports write the same link; see [export.md](export.md).

### Proposing a subsystem

- An agent calls `atlas_propose_view` over MCP; see [agents.md](agents.md).
- Any client can `POST /api/v1/proposals/claims` with `predicate: 'subsystem'` and cited evidence. Model-origin claims need `modelMetadata`.
- `pnpm demo` does this with the mock label `demo-mock`, so the demo shows a proposed "Research backend" subsystem. No model is called.

Contract types: `Workspace`, `DesignLens` and `CanvasSpec.provenance` in `@atlas/schema`; `Archetype`, `Provenance`, `GraphClaim` and `ViewOverrideRow` in `@atlas/planner`. Tests: `packages/graph/test/design.test.ts` and `apps/daemon/test/design.test.ts`.
