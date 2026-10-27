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
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # browser for e2e tests and evidence capture
pnpm build                               # builds the web UI the daemon serves
export PATH="$PWD/bin:$PATH"             # puts the `atlas` command on PATH (add to your shell profile)
atlas doctor                             # checks Node, SQLite FTS5, grammars, Chromium
```

`bin/atlas` runs the CLI from this checkout and acts on your current directory. Without changing
PATH, `pnpm --dir /path/to/system-atlas atlas <command>` does the same from any directory.

## Use

```bash
cd /path/to/your/repo
atlas open .        # starts the local daemon, registers and watches the repo, prints the UI URL
atlas watch .       # follow updates in the terminal; Ctrl-C stops watching (--detach, --off)
atlas scan .        # analyzes the repo and prints the snapshot, changes and coverage gaps
atlas views list .  # the generated canvas catalog
atlas status --json
atlas daemon stop
```

The printed URL carries a one-time token in its `#fragment`. The daemon listens on 127.0.0.1 only.

## Demo

```bash
pnpm demo
```

The demo is local only and uses fake data. It does the following:

1. Copies `fixtures/research-demo` into the Atlas data directory and scans it.
2. Runs its report worker twice through `atlas run`. One run fails an assertion despite exit code 0.
3. Captures a browser journey with real screenshots, including a failing step and a missing screenshot.
4. Prints the UI link. Open it, choose **research-demo**, and explore **Architecture** and **Outputs & Audit**.

## Record your own runs

```bash
cd /path/to/your/repo
atlas run -o out/report.json -- node scripts/build-report.js
```

This records logs, exit code, declared outputs and any SDK assertions. See [`docs/evidence.md`](docs/evidence.md).

## Connect a coding agent

```bash
claude mcp add atlas -- /path/to/system-atlas/bin/atlas mcp "$PWD"   # or any MCP client: atlas mcp <repo>
```

The agent can then read the map, search entities and evidence, and record its own runs as evidence. See [`docs/agents.md`](docs/agents.md).

## Develop

```bash
pnpm dev          # daemon + Vite dev server with hot reload
pnpm check        # typecheck, lint, format check, unit tests, build
pnpm e2e          # Playwright end-to-end tests
```

Contributor and agent rules, including branching, are in [`CLAUDE.md`](CLAUDE.md). Decisions are in [`docs/adr/`](docs/adr). Data locations are in [`docs/persistence.md`](docs/persistence.md).

## License

MIT. See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for dependency notices.
