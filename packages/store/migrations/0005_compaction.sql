-- Snapshot compaction (plan §9 + retention): superseded snapshots keep their metadata, coverage,
-- change rows and issues, but their graph rows are dropped unless a run references them.
ALTER TABLE snapshots ADD COLUMN compacted_at TEXT;
