CREATE TABLE reports (
  id UUID PRIMARY KEY,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report_sources (
  report_id UUID NOT NULL REFERENCES reports(id),
  url TEXT NOT NULL
);
