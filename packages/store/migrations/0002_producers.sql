-- Record which analyzer produced each graph row, so a failing analyzer's previous facts can be
-- carried forward as stale instead of erased (plan §7), and keep each manifest file's role.
ALTER TABLE entities ADD COLUMN producer TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE relations ADD COLUMN producer TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE snapshot_files ADD COLUMN role TEXT NOT NULL DEFAULT 'other';
CREATE INDEX entities_producer ON entities(snapshot_id, producer);
CREATE INDEX relations_producer ON relations(snapshot_id, producer);
