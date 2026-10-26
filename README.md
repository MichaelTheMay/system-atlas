# System Atlas

A local, project-aware architecture and execution-evidence workspace.

Open a repository and Atlas discovers its software boundaries, builds an evidence-backed semantic graph, and generates the relevant nested and sibling canvases. A separate **Outputs & Audit** workspace shows real runs, browser screenshots, command results and rendered artifacts, linked back to architecture components and exact source revisions.

**Status:** early development. [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) lists what works today and what is next. The full specification is [`docs/plan/System_Atlas_Claude_Code_Plan.md`](docs/plan/System_Atlas_Claude_Code_Plan.md).

Atlas runs entirely locally. No hosted service or model is required for analysis or evidence viewing.

## Requirements

- Node.js 24.21 or newer (`.nvmrc`)
- pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)
- Linux or macOS. Windows is untested.

## Setup

```bash
git clone https://github.com/MichaelTheMay/system-atlas.git
cd system-atlas
pnpm install
pnpm exec playwright install chromium   # browser for e2e tests and evidence capture
pnpm build                               # builds the web UI the daemon serves
pnpm atlas doctor                        # checks Node, SQLite FTS5, grammars, Chromium
```

## Use

```bash
pnpm atlas open /path/to/repo    # starts the local daemon and prints the UI URL
pnpm atlas status --json
pnpm atlas daemon stop
```

The printed URL carries a one-time token in its `#fragment`. The daemon listens on 127.0.0.1 only.

## Develop

```bash
pnpm dev          # daemon + Vite dev server with hot reload
pnpm check        # typecheck, lint, format check, unit tests, build
pnpm e2e          # Playwright end-to-end tests
```

Contributor and agent rules, including branching, are in [`CLAUDE.md`](CLAUDE.md). Decisions are in [`docs/adr/`](docs/adr). Data locations are in [`docs/persistence.md`](docs/persistence.md).

## License

MIT. See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for dependency notices.
