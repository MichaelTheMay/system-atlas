-- System Atlas initial schema (plan §6). JSON columns hold validated @atlas/schema payloads.
-- Semantic rows are snapshot-scoped: each published snapshot is a complete graph, so runs can
-- always be shown against the exact graph that existed when they ran.

-- Registry -----------------------------------------------------------------------------------

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  remote_url    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE worktrees (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  root_path       TEXT NOT NULL UNIQUE,
  git_top_level   TEXT,
  git_common_dir  TEXT,
  git_sub_path    TEXT,
  branch          TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX worktrees_project ON worktrees(project_id);
CREATE INDEX worktrees_git ON worktrees(git_common_dir, git_sub_path);

CREATE TABLE snapshots (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  worktree_id         TEXT NOT NULL REFERENCES worktrees(id),
  head_commit         TEXT,
  dirty_tree_digest   TEXT NOT NULL,
  dirty               INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  published_at        TEXT,
  analyzer_versions   TEXT NOT NULL,
  config_digest       TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('building','partial','ready','failed','superseded')),
  previous_snapshot_id TEXT REFERENCES snapshots(id),
  coverage_report_id  TEXT
);
CREATE INDEX snapshots_worktree ON snapshots(worktree_id, created_at);

-- Exact input manifest of a snapshot: identifies the analyzed tree.
CREATE TABLE snapshot_files (
  snapshot_id  TEXT NOT NULL REFERENCES snapshots(id),
  path         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  language     TEXT NOT NULL,
  support      TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, path)
) WITHOUT ROWID;

CREATE TABLE coverage_reports (
  id           TEXT PRIMARY KEY,
  snapshot_id  TEXT NOT NULL REFERENCES snapshots(id),
  body         TEXT NOT NULL
);

-- Semantic model --------------------------------------------------------------------------

CREATE TABLE entities (
  snapshot_id        TEXT NOT NULL REFERENCES snapshots(id),
  id                 TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  kind               TEXT NOT NULL,
  canonical_name     TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  owner_entity_id    TEXT,
  lifecycle          TEXT NOT NULL CHECK (lifecycle IN ('active','stale','removed')),
  attributes         TEXT NOT NULL,
  first_seen_snapshot TEXT NOT NULL,
  last_seen_snapshot  TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;
CREATE INDEX entities_owner ON entities(snapshot_id, owner_entity_id);
CREATE INDEX entities_kind ON entities(snapshot_id, kind);

CREATE TABLE relations (
  snapshot_id   TEXT NOT NULL REFERENCES snapshots(id),
  id            TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  qualifiers    TEXT NOT NULL,
  evidence_ids  TEXT NOT NULL,
  status        TEXT NOT NULL,
  confidence    TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;
CREATE INDEX relations_from ON relations(snapshot_id, from_id);
CREATE INDEX relations_to ON relations(snapshot_id, to_id);

-- Evidence is immutable and content-identified; the same evidence may support several snapshots
-- as long as its (path, content hash) is still in their manifest.
CREATE TABLE evidence (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  body          TEXT NOT NULL,
  path          TEXT,
  content_hash  TEXT,
  run_id        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX evidence_path ON evidence(project_id, path, content_hash);

CREATE TABLE claims (
  snapshot_id   TEXT NOT NULL REFERENCES snapshots(id),
  id            TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  origin        TEXT NOT NULL,
  status        TEXT NOT NULL,
  body          TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;
CREATE INDEX claims_subject ON claims(snapshot_id, subject_id);

CREATE VIRTUAL TABLE entity_search USING fts5(
  snapshot_id UNINDEXED,
  entity_id UNINDEXED,
  kind UNINDEXED,
  canonical_name,
  display_name,
  tokenize = 'unicode61 tokenchars ''_-./:'''
);

-- Reconciliation issues (ambiguous renames, conflicts) surfaced instead of silent merges.
CREATE TABLE issues (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- View model ------------------------------------------------------------------------------

CREATE TABLE canvases (
  snapshot_id      TEXT NOT NULL REFERENCES snapshots(id),
  id               TEXT NOT NULL,
  workspace        TEXT NOT NULL,
  lens             TEXT NOT NULL,
  owner_canvas_id  TEXT,
  root_entity_id   TEXT,
  state            TEXT NOT NULL,
  body             TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;

CREATE TABLE canvas_links (
  snapshot_id     TEXT NOT NULL REFERENCES snapshots(id),
  from_canvas_id  TEXT NOT NULL,
  to_canvas_id    TEXT NOT NULL,
  relation        TEXT NOT NULL,
  via_entity_id   TEXT,
  PRIMARY KEY (snapshot_id, from_canvas_id, to_canvas_id, relation)
) WITHOUT ROWID;

-- User decisions about views (pin/suppress/promote) survive regeneration: not snapshot-scoped.
CREATE TABLE view_overrides (
  project_id  TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('pin','suppress','promote')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, target_id, action)
) WITHOUT ROWID;

-- Presentation overlay --------------------------------------------------------------------

CREATE TABLE view_overlays (
  view_id     TEXT NOT NULL,
  profile_id  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  body        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (view_id, profile_id)
) WITHOUT ROWID;

-- Execution model -------------------------------------------------------------------------

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  worktree_id  TEXT,
  snapshot_id  TEXT,
  status       TEXT NOT NULL,
  start_at     TEXT NOT NULL,
  end_at       TEXT,
  body         TEXT NOT NULL
);
CREATE INDEX runs_project ON runs(project_id, start_at);

CREATE TABLE events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  producer_id        TEXT NOT NULL,
  producer_event_id  TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  type               TEXT NOT NULL,
  occurred_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  body               TEXT NOT NULL,
  UNIQUE (producer_id, producer_event_id)
);
CREATE INDEX events_run ON events(run_id, seq);

CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  bytes_state   TEXT NOT NULL,
  body          TEXT NOT NULL
);
CREATE INDEX artifacts_run ON artifacts(run_id);
CREATE INDEX artifacts_sha ON artifacts(sha256);

CREATE TABLE correlations (
  id                    TEXT PRIMARY KEY,
  event_or_artifact_id  TEXT NOT NULL,
  entity_id             TEXT NOT NULL,
  status                TEXT NOT NULL,
  body                  TEXT NOT NULL
);
CREATE INDEX correlations_subject ON correlations(event_or_artifact_id);
CREATE INDEX correlations_entity ON correlations(entity_id);

CREATE TABLE assertions (
  id       TEXT PRIMARY KEY,
  run_id   TEXT NOT NULL,
  outcome  TEXT NOT NULL,
  body     TEXT NOT NULL
);
CREATE INDEX assertions_run ON assertions(run_id);
