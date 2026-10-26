-- Execution evidence ingestion (plan §10-11).

-- Per-run scoped ingestion credential (hash only) and the tree the run executed against.
ALTER TABLE runs ADD COLUMN ingest_token_hash TEXT;
ALTER TABLE runs ADD COLUMN source_manifest_digest TEXT;
ALTER TABLE runs ADD COLUMN worktree_digest_matched INTEGER NOT NULL DEFAULT 0;
CREATE INDEX runs_unbound ON runs(worktree_id, source_manifest_digest) WHERE snapshot_id IS NULL;

-- Content-addressed object store. One object may back many artifacts (dedupe by sha256).
CREATE TABLE objects (
  sha256       TEXT PRIMARY KEY,
  byte_length  INTEGER NOT NULL,
  sniffed_type TEXT,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);

ALTER TABLE artifacts ADD COLUMN event_id TEXT;
ALTER TABLE artifacts ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
CREATE INDEX artifacts_event ON artifacts(event_id);

ALTER TABLE assertions ADD COLUMN event_id TEXT;
