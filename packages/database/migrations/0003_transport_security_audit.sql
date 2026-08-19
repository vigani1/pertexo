CREATE TABLE app.transport_security_audit_facts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  fact_type varchar(64) NOT NULL,
  consumer_name varchar(128) NOT NULL,
  message_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transport_security_audit_fact_type
    CHECK (fact_type = 'inbox_checksum_mismatch'),
  CONSTRAINT transport_security_audit_consumer_name_format
    CHECK (consumer_name ~ '^[a-z][a-z0-9._:-]{0,127}$')
);

CREATE INDEX transport_security_audit_facts_workspace_time_idx
  ON app.transport_security_audit_facts (workspace_id, occurred_at DESC);
CREATE INDEX transport_security_audit_facts_message_idx
  ON app.transport_security_audit_facts (workspace_id, message_id);

ALTER TABLE app.transport_security_audit_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.transport_security_audit_facts FORCE ROW LEVEL SECURITY;

CREATE POLICY transport_security_audit_facts_workspace_scope
  ON app.transport_security_audit_facts
  FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

GRANT SELECT, INSERT ON app.transport_security_audit_facts
  TO {{api_runtime_role}}, {{worker_runtime_role}};
