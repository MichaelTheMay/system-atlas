# ADR-0004: Extraction stack — wasm tree-sitter plus language tooling

Status: accepted (2026-10-26)

## Decision

- Syntax: `web-tree-sitter` 0.27.1 with the prebuilt `.wasm` files from `tree-sitter-typescript` 0.23.2 (typescript, tsx; ABI 14) and `tree-sitter-python` 0.25.0 (ABI 15). Load test passes (`packages/analyzers/test/parsers.test.ts`, `atlas doctor`). The grammar packages' native install scripts are not run (`onlyBuiltDependencies: []`).
- TS/JS semantics: the `typescript` compiler API for module resolution and symbol export information. Tree-sitter alone does not resolve semantics.
- Python: tree-sitter syntax plus explicit, documented resolution rules; ambiguous or environment-dependent imports are reported as unresolved gaps.
- Analyzers never execute target code or install target dependencies.

## Fallback

If a future grammar fails to load under web-tree-sitter, use `tree-sitter-wasms` or build the grammar wasm from source in CI; analyzers depend only on `createParser(id)`.

## Addendum (A04, 2026-10-26)

- TS/JS uses the TypeScript compiler's **parser** (`ts.createSourceFile`), not a full `Program` or type checker.
  - Module resolution is a bundler-style resolver over the inventory only. It handles relative paths with extension and `.js`-to-`.ts` probing, `index` files, tsconfig `paths`/`baseUrl`, and workspace `package.json` names with `exports`/`main`.
  - Rationale: Atlas never reads `node_modules` or files outside the registered root, and analysis must use the same hash-verified bytes recorded as evidence. A `Program` would read the disk itself.
  - Constant values, such as queue names, are resolved through a small cross-module constant table.
- Both language analyzers run in `worker_threads` (`shared/worker-host.ts`), and workers are terminated on timeout or cancel.
- Identity keys follow `fixtures/expected/README.md`. Analyzers agree on key formats (`pkg:<dir>`, `ts:module:<path>`, `table:<name>`, ...) so cross-analyzer relations resolve, for example Dockerfile CMD to a TS module.
