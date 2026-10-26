# ADR-0004: Extraction stack — wasm tree-sitter plus language tooling

Status: accepted (2026-10-26)

## Decision

- Syntax: `web-tree-sitter` 0.27.1 with the prebuilt `.wasm` files from `tree-sitter-typescript` 0.23.2 (typescript, tsx; ABI 14) and `tree-sitter-python` 0.25.0 (ABI 15). Load test passes (`packages/analyzers/test/parsers.test.ts`, `atlas doctor`). The grammar packages' native install scripts are not run (`onlyBuiltDependencies: []`).
- TS/JS semantics: the `typescript` compiler API for module resolution and symbol export information. Tree-sitter alone does not resolve semantics.
- Python: tree-sitter syntax plus explicit, documented resolution rules; ambiguous or environment-dependent imports are reported as unresolved gaps.
- Analyzers never execute target code or install target dependencies.

## Fallback

If a future grammar fails to load under web-tree-sitter, use `tree-sitter-wasms` or build the grammar wasm from source in CI; analyzers depend only on `createParser(id)`.
