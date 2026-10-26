# ADR-0003: node:sqlite as the local store

Status: accepted (2026-10-26)

## Context

Plan §3/§5: SQLite for entity/relation indexes, views, events, FTS search; no graph database.

## Decision

- Use Node's built-in `node:sqlite` (`DatabaseSync`). Node 24 marks it Stability 1.2 (release candidate); no flag needed. FTS5 verified working on Node 24.21.0 / SQLite 3.53.4 (`atlas doctor` re-checks).
- Zero native dependencies keeps `pnpm install` free of build scripts.
- Access goes through a thin `Db` interface in the daemon so `better-sqlite3` 13 can be swapped in if the RC API changes.
- WAL mode; plain SQL migration files applied by a small runner with a `schema_migrations` table and a pre-migration backup copy (A02).
- One database file per user data dir (`atlas.sqlite`); rows are namespaced by project and worktree IDs.

## Consequences

Requires Node >= 24.21 (`engines`, `.nvmrc`, `engine-strict`).
