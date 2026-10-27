-- Audit of every claim/annotation proposal (plan §11 audit trail; §16 rejected evidence stays
-- inspectable): accepted and rejected items with per-item reasons, origin and model metadata.
CREATE TABLE proposals (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  origin      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  accepted    INTEGER NOT NULL,
  rejected    INTEGER NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX proposals_project ON proposals(project_id, created_at);
