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
