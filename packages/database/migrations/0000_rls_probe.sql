CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

CREATE TABLE app.rls_probe_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rls_probe_records_workspace_idx
  ON app.rls_probe_records (workspace_id, id);

ALTER TABLE app.rls_probe_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rls_probe_records FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_probe_records_workspace_scope
  ON app.rls_probe_records
  FOR ALL
  TO pertexo_api, pertexo_worker
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

GRANT USAGE ON SCHEMA app TO pertexo_api, pertexo_worker;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.rls_probe_records
  TO pertexo_api, pertexo_worker;
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON app.rls_probe_records
  FROM pertexo_api, pertexo_worker;
