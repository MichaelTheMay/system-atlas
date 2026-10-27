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

## System design lens (D01, in progress)

A third workspace, `design`, shows whiteboard views of the same semantic graph. These are views, not new facts. Nothing in this lens becomes a supported claim or a relation.

- **Lenses.** `design-system` is the root ("System design"). `design-subsystem` canvases nest beneath it, up to three levels deep.
- **Boxes.** Each box has an archetype: `client`, `api-service`, `worker`, `queue`, `datastore`, `cache`, `external-api`, `library` or `service`. The archetype is inferred deterministically from detected entities and comes with a stated reason.
- **Flows.** Aggregated relations are labeled HTTP, enqueue, consume, reads/writes, uses, or runs on, and keep their supported, inferred or stale status.
- **Provenance.**
  - `detected` means analyzers only.
  - `proposed` means a model or agent `subsystem` claim, labeled inferred.
  - `accepted` means a person: human-origin claims, or a promoted proposal.
- **Overrides** (plan §8): pin, suppress and promote are stored in `view_overrides` and survive regeneration.
- **Realized by.** Every box links down to the architecture canvas of its entity, keeping the same entity identity, so selection carries across.

Contract types: `Workspace`, `DesignLens` and `CanvasSpec.provenance` in `@atlas/schema`; `Archetype`, `Provenance`, `GraphClaim` and `ViewOverrideRow` in `@atlas/planner`.
