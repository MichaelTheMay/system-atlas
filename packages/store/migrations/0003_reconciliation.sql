-- Change summaries, rename aliases and snapshot-level summary (plan §9).

-- One row per change between a snapshot and its predecessor. Removed entities keep their last
-- known shape here (tombstones), so views can show a removed state during change review without
-- polluting the current graph.
CREATE TABLE snapshot_changes (
  snapshot_id   TEXT NOT NULL REFERENCES snapshots(id),
  target        TEXT NOT NULL CHECK (target IN ('entity','relation')),
  id            TEXT NOT NULL,
  change        TEXT NOT NULL CHECK (change IN ('added','removed','changed','renamed','stale','restored')),
  previous_id   TEXT,
  detail        TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, target, id, change)
) WITHOUT ROWID;
CREATE INDEX snapshot_changes_id ON snapshot_changes(id);

-- Accepted identity continuations (e.g. a file moved with identical content). Overlays and
-- human claims follow old_id -> new_id. Ambiguous candidates become issues instead.
CREATE TABLE entity_aliases (
  project_id   TEXT NOT NULL,
  old_id       TEXT NOT NULL,
  new_id       TEXT NOT NULL,
  method       TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, old_id)
) WITHOUT ROWID;
CREATE INDEX entity_aliases_new ON entity_aliases(project_id, new_id);

ALTER TABLE snapshots ADD COLUMN change_summary TEXT;
CREATE INDEX issues_snapshot ON issues(snapshot_id, status);
