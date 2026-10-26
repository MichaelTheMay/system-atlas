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

## Scan pipeline (A03)

`scanWorktree` (`packages/graph/src/scan.ts`) runs these steps:

1. Inventory.
2. Insert a `building` snapshot.
3. Run analyzers with timeouts. They can only read inventoried files, and each read is re-hashed against the inventory hash.
4. Assemble and schema-validate the graph in memory.
5. Carry forward stale rows from analyzers that failed.
6. Re-check every file's size and mtime.
7. Publish in one synchronous transaction that also supersedes the previous snapshot.

A cancelled or crashed scan leaves the previous snapshot current and marks its own row `failed`.
Migration `0002_producers.sql` adds `producer` to `entities` and `relations`, recording which analyzer made each row.

## Reconciliation (A05)

Migration `0003_reconciliation.sql` adds three things:

- **`snapshot_changes`**: one row per entity or relation that was added, removed, changed, renamed, went stale or was restored since the previous snapshot. Removed rows keep the entity's last known kind, name and owner as a tombstone.
- **`entity_aliases`**: accepted identity continuations, from an old ID to a new ID.
- **`snapshots.change_summary`**: the counts.

Rules (`packages/graph/src/reconcile.ts`):

- Stable keys make most entities keep their ID with no matching at all.
- A module whose exact file content moved, with exactly one candidate, is accepted as a rename. Its child symbols with the same name and kind follow it.
- Several identical-content candidates create an `ambiguous-rename` issue. The same file name with different content creates a `possible-rename` issue. Neither is merged.
- A change counts as `changed` when the semantic fields differ, or when the cited evidence differs (for example, a line shift in the same file).
- Human and model claims carry forward with their subject following aliases. They become `stale` when an evidence file hash no longer matches the new manifest or the subject is gone.
- `checkSnapshotIntegrity()` verifies that supported relations cite existing evidence from the snapshot's own manifest, owners exist, and ownership is acyclic.

## No-op rescans and compaction (M01a)

**No-op rescans.** A rescan publishes nothing when four things all match the latest `ready` snapshot:

- the manifest digest;
- the configuration digest (analyzer versions and limits);
- the HEAD commit;
- dirtiness.

The rescan returns that snapshot with `noop: true`. The change view keeps showing the last real change. A `partial` latest snapshot is always rescanned, so a failing analyzer gets retried.

**Compaction.** Migration `0005_compaction.sql` adds `snapshots.compacted_at`. After every publishing scan, `compactSnapshots()` drops the per-snapshot graph rows of superseded or failed snapshots. The dropped tables are entities, relations, claims, files, canvases, canvas links and search.

These snapshots are always kept whole:

- the latest published snapshot;
- its predecessor, needed to review changes;
- every snapshot that a run references, because runs are always shown against the tree they ran on.

A compacted snapshot keeps its metadata, coverage report, change rows and issues. Graph endpoints answer `410 compacted` for it.

Measured on the dsh repository, about 8,900 files, over 20 consecutive edited rescans:

|                                | Before          | After         |
| ------------------------------ | --------------- | ------------- |
| Database size after 20 rescans | 607 MB, growing | 168 MB, level |
| Growth per rescan              | 26 MB           | 0.3 MB        |
