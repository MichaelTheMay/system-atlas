# Exports (I04)

```bash
atlas export -o ./atlas-export                      # every view of the latest snapshot, as JSON Canvas
atlas export -o ./out --view "Project structure"    # selected views, by canvas id or title
atlas export -o ./out --format mermaid --view API   # simplified Mermaid flowcharts
atlas export -o ./out --run run_… --run run_…       # runs, with their artifacts beside them
atlas export -o ./out --run run_… --include-logs    # also copy log artifacts (they may contain secrets)
```

The output must be a new or empty directory. Atlas never writes into a directory that has content.

## Layout of an export

```
atlas-export.json          versioned sidecar: what each canvas node and edge is in Atlas, plus disclosures
views/<view>.canvas        JSON Canvas 1.0, one per view
runs/<run>/run.canvas      a run: outcome, steps (nested outline), assertions, artifacts
runs/<run>/artifacts/…     copied artifact bytes (hash-verified)
```

All paths inside canvases are relative to the export directory, the way JSON Canvas file paths are relative to a vault root. This covers file nodes and the drill-down links in text nodes. Open the directory as the root in any JSON Canvas renderer.

## What maps

| Atlas                             | JSON Canvas                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Entity, cluster, port or gap node | `text` node: bold name, kind, sublabel, status, notes, and an `[open view →](views/…canvas)` link for nodes that open a child view |
| Group (boundary)                  | `group` node with its label                                                                                                        |
| Aggregated edge                   | edge with the relation kinds as its label; a non-supported status is appended as `(inferred)`, `(stale)` and so on                 |
| Positions                         | what you see in Atlas: pins, then remembered layout, then deterministic ELK; scaled for text                                       |
| Run step, tool call or assertion  | `text` nodes (a nested outline of steps and their outcomes)                                                                        |
| Image artifact                    | `file` node pointing at the copied image                                                                                           |
| Other artifact                    | `text` node with a link to the copied file, or _missing_ or _not exported_ with the reason                                         |

**Statuses** are written as text. Preset colors repeat them:

| Color      | Meaning                          |
| ---------- | -------------------------------- |
| `1` red    | Coverage gap, removed, or failed |
| `2` orange | Changed                          |
| `3` yellow | Stale or inferred                |
| `4` green  | Added                            |

## What does not map (disclosed)

`atlas export` prints these, and the sidecar lists them:

- Evidence, claims, coverage details and source excerpts are not in `.canvas` files. The sidecar maps every canvas node and edge to Atlas entity and relation IDs.
- Colors carry no meaning in the JSON Canvas spec, so status is always repeated in text.
- Drill-down depends on the renderer following markdown links in text nodes.
- Interactive features are not exported: inspectors, search, live updates, cluster expansion and the outputs timeline.
- Clustered members, truncated views and links to views outside the export are counted per view.
- **Run event payloads** are not exported beyond names, outcomes and assertions.
- **Run artifacts** are copied only when safe:
  - HTML, SVG and unknown types are never copied, because they are active content.
  - Logs are copied only with `--include-logs`.
- **Mermaid** is a simplified selected view: no evidence, positions, links or notes. Inferred edges are dotted and labeled.

## Safety

- Artifact bytes are fetched only from the isolated preview origin, with `raw=1`, and must match the recorded SHA-256. Otherwise they are not exported and the problem is reported.
- Nothing is written outside the chosen directory.
- The exporter validates every canvas against the JSON Canvas 1.0 structure before writing. Problems make the command fail.

## Verified with a renderer

`apps/cli/test/export.test.ts` opens the exported view and run canvases in [json-canvas-viewer](https://www.npmjs.com/package/json-canvas-viewer) 4.3.2 (MIT, dev-only), served as static files. It checks that:

- there are no page errors and no failed requests;
- labels and links are visible;
- the copied chart image loads.

The Skena bridge is not built. Skena is a VS Code extension, and VS Code integration was dropped by user decision; JSON Canvas files are the interoperability point.
