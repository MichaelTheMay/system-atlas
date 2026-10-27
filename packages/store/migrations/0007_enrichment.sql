-- Optional model enrichment (plan §12): settings, a cache keyed by input digest, and a usage ledger
-- that keeps estimated and provider-reported usage separately.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE enrichment_cache (
  digest         TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  output         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE model_usage (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL,
  subject_id             TEXT,
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  digest                 TEXT NOT NULL,
  status                 TEXT NOT NULL,
  est_input_tokens       INTEGER NOT NULL,
  est_output_tokens      INTEGER NOT NULL,
  reported_input_tokens  INTEGER,
  reported_output_tokens INTEGER,
  reported_cost_usd      REAL,
  detail                 TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX model_usage_project ON model_usage(project_id, created_at);
