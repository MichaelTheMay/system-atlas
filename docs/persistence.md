# Persistence and data locations

Atlas never writes into a target repository unless the user runs an explicit init (planned).
All state lives in per-user directories (resolved by `@atlas/schema/node#resolveAtlasPaths`).

| Purpose               | Linux default                                                  | Override            |
| --------------------- | -------------------------------------------------------------- | ------------------- |
| Data dir              | `$XDG_DATA_HOME/system-atlas` or `~/.local/share/system-atlas` | `ATLAS_DATA_DIR`    |
| Runtime dir           | `$XDG_RUNTIME_DIR/system-atlas`, else `<data>/run`             | `ATLAS_RUNTIME_DIR` |
| Database              | `<data>/atlas.sqlite` (WAL)                                    | —                   |
| Pre-migration backups | `<data>/backups/`                                              | —                   |
| Artifact bytes        | `<data>/objects/sha256/<2>/<62>` (content-addressed)           | —                   |
| Reclaimable caches    | `<data>/cache/`                                                | —                   |
| Daemon log            | `<data>/logs/daemon.log` (0600)                                | —                   |
| Discovery record      | `<runtime>/daemon.json` (file 0600, dir 0700)                  | —                   |

macOS uses `~/Library/Application Support/system-atlas`; Windows uses `%LOCALAPPDATA%\system-atlas`.

## Contracts

Persistent contracts are the Zod schemas in `packages/schema/src` (plan §6), each with `schemaVersion`:

| Model        | Schemas                                                |
| ------------ | ------------------------------------------------------ |
| Registry     | `Project`, `Worktree`, `Snapshot`, `CoverageReport`    |
| Semantic     | `Entity`, `Relation`, `Evidence`, `Claim`              |
| View         | `CanvasSpec`, `CanvasLink`, `ViewQuery`                |
| Presentation | `ViewOverlay`                                          |
| Execution    | `Run`, `Event`, `Artifact`, `Correlation`, `Assertion` |

## SQLite layout (`packages/store/migrations`)

Migrations are numbered SQL files applied in order by `migrate()` (`packages/store/src/migrate.ts`).
Each runs in one transaction and is recorded with a checksum in `schema_migrations`. Editing an
applied migration is refused. Before applying new migrations to a database that has data,
`VACUUM INTO` writes a consistent copy to `backups/`.

| Group        | Tables                                                                          | Notes                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry     | `projects`, `worktrees`, `snapshots`, `snapshot_files`, `coverage_reports`      | `snapshot_files` is the exact input manifest                                                                                                                                                                  |
| Semantic     | `entities`, `relations`, `claims`, `evidence`, `entity_search` (FTS5), `issues` | Graph rows are keyed by `(snapshot_id, id)`; each published snapshot is a complete graph. Evidence is immutable and content-identified, so it can be shared across snapshots while its file hash is unchanged |
| View         | `canvases`, `canvas_links`, `view_overrides`                                    | Overrides (pin/suppress/promote) are not snapshot-scoped and survive regeneration                                                                                                                             |
| Presentation | `view_overlays`                                                                 | Keyed by `(view_id, profile_id)`, so overlays survive regeneration                                                                                                                                            |
| Execution    | `runs`, `events`, `artifacts`, `correlations`, `assertions`                     | `events` is append-only (UPDATE/DELETE triggers abort) and unique on `(producer_id, producer_event_id)`                                                                                                       |

Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
Writes go through the daemon, the single writer.

## Project and worktree identity

- A **project** has a generated ID (`proj_` + UUIDv7) created on first registration.
- A **worktree** is one registered root on disk, an analysis context. Its ID is derived from the project ID and the root's real path.
- The registered root is the analysis boundary. Git metadata (top level, common dir, sub-path, branch, HEAD) is recorded but never widens it.
- Another `git worktree` of the same repository at the same sub-path joins the existing project as a new worktree. Separate clones and different sub-paths become separate projects.
- Git is read with `rev-parse`, `symbolic-ref` and `config --get` only, with fsmonitor and hooks disabled and `GIT_*` variables dropped. Remote URLs are stored with credentials and query strings removed.

## Daemon API

See `apps/daemon/openapi.yaml`. All `/api/v1/*` routes need `Authorization: Bearer <token>` from the discovery record.
