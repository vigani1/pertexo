-- Disposable impact index derived from immutable published workflow graphs.
-- Publication owns replacement; this table never overrides graph_json.

ALTER TABLE app.workflow_versions
  ADD CONSTRAINT workflow_versions_workspace_version_identity_unique
  UNIQUE (workspace_id, id);

CREATE TABLE app.workflow_integration_usage (
  workspace_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  provider_key varchar(64) NOT NULL,
  operation_key varchar(128) NOT NULL,
  connection_id uuid NOT NULL,
  CONSTRAINT workflow_integration_usage_identity_pk
    PRIMARY KEY (
      workflow_version_id, provider_key, operation_key, connection_id
    ),
  CONSTRAINT workflow_integration_usage_version_fk
    FOREIGN KEY (workspace_id, workflow_version_id)
    REFERENCES app.workflow_versions (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_integration_usage_connection_fk
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES app.connections (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_integration_usage_provider_key_format
    CHECK (provider_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
  CONSTRAINT workflow_integration_usage_operation_key_format
    CHECK (operation_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$')
);

CREATE INDEX workflow_integration_usage_impact_idx
  ON app.workflow_integration_usage (
    workspace_id, provider_key, operation_key,
    workflow_version_id, connection_id
  );
CREATE INDEX workflow_integration_usage_connection_idx
  ON app.workflow_integration_usage (
    workspace_id, connection_id, workflow_version_id,
    provider_key, operation_key
  );

ALTER TABLE app.workflow_integration_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_integration_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_integration_usage_workspace_scope
  ON app.workflow_integration_usage FOR ALL
  TO {{owner_role}}, {{api_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

ALTER TABLE app.workflow_integration_usage OWNER TO {{owner_role}};

REVOKE ALL ON app.workflow_integration_usage
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT SELECT, INSERT, DELETE ON app.workflow_integration_usage
  TO {{api_runtime_role}};
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER
  ON app.workflow_integration_usage
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
