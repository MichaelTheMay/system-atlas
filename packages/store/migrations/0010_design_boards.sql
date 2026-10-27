-- Design boards (D03): design-first system whiteboards. A board is view data drawn by a person (or
-- proposed by an agent) that says how a system should work; it is keyed by project, independent of
-- snapshots, and never read as semantic facts. The document holds the Excalidraw scene plus the
-- typed registry (components, connections, scenarios, design doc).
CREATE TABLE design_boards (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  name            TEXT NOT NULL,
  document        TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('blank', 'template', 'prompt', 'markdown', 'code')),
  template_id     TEXT,
  parent_board_id TEXT,
  revision        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX design_boards_project ON design_boards(project_id, updated_at);
