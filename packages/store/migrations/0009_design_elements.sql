-- User-authored design layer (D02): boxes, flows, sticky notes and subsystems drawn on the System
-- design canvases. View data keyed by project (not snapshot), so it survives every rescan; never
-- read as semantic facts. Agent proposals land as status 'proposed' until a person accepts them.
CREATE TABLE design_elements (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  kind             TEXT NOT NULL CHECK (kind IN ('box', 'flow', 'sticky', 'subsystem')),
  body             TEXT NOT NULL,
  bound_entity_ids TEXT NOT NULL DEFAULT '[]',
  author           TEXT NOT NULL CHECK (author IN ('user', 'agent')),
  author_name      TEXT,
  citations        TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL CHECK (status IN ('active', 'proposed', 'rejected')),
  job_id           TEXT,
  revision         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX design_elements_project ON design_elements(project_id, status);

-- Manual design-agent jobs (generate / copilot actions). Each also creates a run for the audit trail.
CREATE TABLE design_jobs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  kind        TEXT NOT NULL,
  runtime     TEXT NOT NULL,
  model       TEXT,
  request     TEXT NOT NULL,
  state       TEXT NOT NULL,
  run_id      TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX design_jobs_project ON design_jobs(project_id, created_at);
