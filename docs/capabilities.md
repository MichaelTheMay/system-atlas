# Capability matrix

What Atlas can and cannot see today. Every row is either backed by a test or marked as planned.
Unsupported areas appear in the product as coverage gaps, never as silence.

| Area                                                        | Status            | Depth                   | Boundary                                                                                                            |
| ----------------------------------------------------------- | ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Generic inventory (any repo)                                | planned (A03)     | inventory               | Obeys .gitignore/.atlasignore; skips binaries, secrets, vendor/build output; no symlink escape                      |
| TypeScript / JavaScript                                     | planned (A04)     | deep                    | Packages, imports/exports via compiler resolution, functions/classes, explicit server routes, UI route declarations |
| Python                                                      | planned (A04)     | syntax + explicit rules | Imports (ambiguous ones reported), functions/classes, explicit FastAPI routes, console-script entrypoints           |
| Docker Compose / Dockerfile / OpenAPI / SQL migrations / CI | planned (A04)     | config                  | Declared services, images, tables and endpoints only                                                                |
| Go, Java/JVM                                                | planned (Phase 4) | —                       | Reported as unsupported language until then                                                                         |
| Other languages                                             | not planned       | inventory               | Source browsing only; semantic analysis unavailable (gap)                                                           |
| Dynamic dispatch, reflection, generated code                | never complete    | —                       | Reported as gaps; no complete call graph is promised                                                                |
| Process runs (`atlas run`)                                  | planned (E02)     | runtime                 | Commands the user explicitly runs; no shell interpolation                                                           |
| Browser evidence (Playwright helper)                        | planned (E03)     | runtime                 | Only instrumented contexts/pages; screenshots prove a captured state, not workflow success                          |
| Third-party browser agents                                  | planned (I01)     | runtime                 | Only via SDK/MCP recording; directory watching is a degraded adapter                                                |
| OpenTelemetry                                               | planned (I03)     | runtime                 | Documented subset; incompatibilities produce diagnostics                                                            |
| Model enrichment                                            | planned (M02)     | inferred                | Optional; proposals are labeled and cannot overwrite observed facts                                                 |

## Verified environment facts

| Check                                                                  | Result | How verified                                              |
| ---------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| tree-sitter TS/TSX/Python wasm grammars load in web-tree-sitter 0.27.1 | yes    | `packages/analyzers/test/parsers.test.ts`, `atlas doctor` |
| node:sqlite FTS5 on Node 24.21                                         | yes    | `atlas doctor`                                            |
| ELK layout deterministic across input order                            | yes    | `packages/layout/test/layout.test.ts`                     |
