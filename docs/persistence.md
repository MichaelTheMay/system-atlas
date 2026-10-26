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

The SQLite table layout and migrations are added in A02 and documented here.

## Daemon API

See `apps/daemon/openapi.yaml`. All `/api/v1/*` routes need `Authorization: Bearer <token>` from the discovery record.
