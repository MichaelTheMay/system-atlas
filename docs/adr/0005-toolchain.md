# ADR-0005: Toolchain — TypeScript 6.0, source-run Node packages

Status: accepted (2026-10-26)

## Decision

- TypeScript pinned to 6.0.3. TypeScript 7.0 (Go port, 2026-07-08) has no stable programmatic API yet, and analyzers need the compiler API; `typescript-eslint` 8 also requires `<6.1`. Revisit when TS 7's API ships.
- pnpm 10.18 workspace, no turbo: `pnpm -r` scripts are enough at this size.
- Internal packages export TypeScript source (`exports: ./src/index.ts`). Node 24 runs the daemon and CLI directly with built-in type stripping; code uses only erasable syntax (`erasableSyntaxOnly`) and `.ts` import specifiers. Vite/Vitest consume the same source. Only the web app has a build step.
- Vitest 5 for unit/contract tests, Playwright 1.64.1 for e2e, ESLint 10 flat config, Prettier 3.

## Consequences

No build step for daemon/CLI keeps stack traces pointing at source. Packaging a standalone binary later (H01) will need a bundling step.
