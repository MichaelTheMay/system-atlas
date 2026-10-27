-- Imported runs (OTLP traces, run bundles) carry an external reference so a re-import reopens
-- the same run and its events dedupe, instead of creating a copy.
ALTER TABLE runs ADD COLUMN external_ref TEXT;
CREATE UNIQUE INDEX runs_external_ref ON runs(project_id, external_ref) WHERE external_ref IS NOT NULL;
