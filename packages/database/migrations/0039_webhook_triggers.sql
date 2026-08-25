ALTER TABLE app.workflows DROP CONSTRAINT workflows_activation_status_valid;
ALTER TABLE app.workflows ADD CONSTRAINT workflows_activation_status_valid CHECK(
  activation_status IN ('inactive','activating','active','deactivating','degraded','error')
);

CREATE TABLE app.workflow_triggers (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  node_id varchar(128) NOT NULL,
  kind varchar(16) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'desired',
  desired_config jsonb NOT NULL,
  config_fingerprint varchar(82) NOT NULL,
  health_status varchar(32) NOT NULL DEFAULT 'pending',
  last_error_code varchar(128),
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_triggers_workspace_identity_unique UNIQUE(workspace_id,id),
  CONSTRAINT workflow_triggers_version_node_unique UNIQUE(workflow_version_id,node_id),
  CONSTRAINT workflow_triggers_version_fk FOREIGN KEY(workspace_id,workflow_id,workflow_version_id)
    REFERENCES app.workflow_versions(workspace_id,workflow_id,id) ON DELETE RESTRICT,
  CONSTRAINT workflow_triggers_kind_valid CHECK(kind IN ('webhook','schedule')),
  CONSTRAINT workflow_triggers_status_valid CHECK(status IN ('desired','configuration_required','pending','active','degraded','disabled','error')),
  CONSTRAINT workflow_triggers_health_valid CHECK(health_status IN ('pending','healthy','degraded','unhealthy','disabled')),
  CONSTRAINT workflow_triggers_fingerprint_valid CHECK(config_fingerprint ~ '^trigger:v1:sha256:[0-9a-f]{64}$'),
  CONSTRAINT workflow_triggers_config_bounded CHECK(octet_length(desired_config::text)<=4096),
  CONSTRAINT workflow_triggers_config_strict CHECK(
    (kind='webhook' AND desired_config='{}'::jsonb) OR
    (kind='schedule' AND jsonb_typeof(desired_config)='object')
  )
);
CREATE INDEX workflow_triggers_active_kind_idx
  ON app.workflow_triggers(workspace_id,kind,status,id)
  WHERE status IN ('configuration_required','pending','active','degraded');
CREATE INDEX workflow_triggers_workflow_version_idx
  ON app.workflow_triggers(workspace_id,workflow_id,workflow_version_id,node_id);

CREATE TABLE app.webhook_trigger_secret_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  trigger_id uuid NOT NULL,
  purpose varchar(32) NOT NULL DEFAULT 'webhook_hmac_sha256',
  schema_version smallint NOT NULL,
  kms_key_reference varchar(2048) NOT NULL,
  encrypted_data_key text NOT NULL,
  ciphertext text NOT NULL,
  nonce varchar(64) NOT NULL,
  auth_tag varchar(64) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webhook_trigger_secret_versions_trigger_identity_unique UNIQUE(workspace_id,trigger_id,id),
  CONSTRAINT webhook_trigger_secret_versions_trigger_fk FOREIGN KEY(workspace_id,trigger_id)
    REFERENCES app.workflow_triggers(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_secret_versions_creator_fk FOREIGN KEY(created_by)
    REFERENCES app.users(id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_secret_versions_purpose_valid CHECK(purpose='webhook_hmac_sha256'),
  CONSTRAINT webhook_trigger_secret_versions_schema_valid CHECK(schema_version=1)
);

CREATE TABLE app.webhook_trigger_endpoints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  trigger_id uuid NOT NULL UNIQUE,
  endpoint_key_hash char(64) NOT NULL UNIQUE,
  status varchar(16) NOT NULL DEFAULT 'active',
  current_secret_version_id uuid NOT NULL,
  previous_secret_version_id uuid,
  previous_secret_valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webhook_trigger_endpoints_workspace_identity_unique UNIQUE(workspace_id,id),
  CONSTRAINT webhook_trigger_endpoints_trigger_fk FOREIGN KEY(workspace_id,trigger_id)
    REFERENCES app.workflow_triggers(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_endpoints_current_secret_fk FOREIGN KEY(workspace_id,trigger_id,current_secret_version_id)
    REFERENCES app.webhook_trigger_secret_versions(workspace_id,trigger_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_endpoints_previous_secret_fk FOREIGN KEY(workspace_id,trigger_id,previous_secret_version_id)
    REFERENCES app.webhook_trigger_secret_versions(workspace_id,trigger_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_endpoints_hash_valid CHECK(endpoint_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT webhook_trigger_endpoints_status_valid CHECK(status IN ('active','disabled')),
  CONSTRAINT webhook_trigger_endpoints_rotation_valid CHECK(
    (previous_secret_version_id IS NULL AND previous_secret_valid_until IS NULL) OR
    (previous_secret_version_id IS NOT NULL AND previous_secret_valid_until IS NOT NULL
      AND previous_secret_version_id<>current_secret_version_id)
  )
);

CREATE TABLE app.webhook_trigger_deliveries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  trigger_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  dedupe_kind varchar(16) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webhook_trigger_deliveries_workspace_identity_unique UNIQUE(workspace_id,id),
  CONSTRAINT webhook_trigger_deliveries_trigger_fk FOREIGN KEY(workspace_id,trigger_id)
    REFERENCES app.workflow_triggers(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_deliveries_endpoint_fk FOREIGN KEY(workspace_id,endpoint_id)
    REFERENCES app.webhook_trigger_endpoints(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_deliveries_run_fk FOREIGN KEY(workspace_id,workflow_run_id)
    REFERENCES app.workflow_runs(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_deliveries_dedupe_valid CHECK(dedupe_kind IN ('keyed','fingerprint'))
);
CREATE INDEX webhook_trigger_deliveries_trigger_time_idx
  ON app.webhook_trigger_deliveries(workspace_id,trigger_id,received_at DESC,id);

CREATE TABLE app.webhook_trigger_replay_records (
  workspace_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  dedupe_kind varchar(16) NOT NULL,
  dedupe_key_hash char(64) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  delivery_id uuid NOT NULL,
  workflow_run_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(endpoint_id,dedupe_kind,dedupe_key_hash),
  CONSTRAINT webhook_trigger_replay_records_endpoint_fk FOREIGN KEY(workspace_id,endpoint_id)
    REFERENCES app.webhook_trigger_endpoints(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_replay_records_delivery_fk FOREIGN KEY(workspace_id,delivery_id)
    REFERENCES app.webhook_trigger_deliveries(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT webhook_trigger_replay_records_run_fk FOREIGN KEY(workspace_id,workflow_run_id)
    REFERENCES app.workflow_runs(workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT webhook_trigger_replay_records_kind_valid CHECK(dedupe_kind IN ('keyed','fingerprint')),
  CONSTRAINT webhook_trigger_replay_records_hashes_valid CHECK(
    dedupe_key_hash ~ '^[0-9a-f]{64}$' AND request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT webhook_trigger_replay_records_expiry_valid CHECK(expires_at>created_at)
);
CREATE INDEX webhook_trigger_replay_records_expiry_idx
  ON app.webhook_trigger_replay_records(expires_at,endpoint_id);

CREATE FUNCTION app.reject_webhook_trigger_secret_version_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'webhook trigger secret versions are immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER webhook_trigger_secret_versions_immutable
  BEFORE UPDATE OR DELETE ON app.webhook_trigger_secret_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_webhook_trigger_secret_version_mutation();

CREATE FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash char(64))
RETURNS TABLE(
  endpoint_id uuid,workspace_id uuid,trigger_id uuid,workflow_id uuid,
  workflow_version_id uuid,node_id varchar,current_secret_version_id uuid,
  current_schema_version smallint,current_kms_key_reference varchar,
  current_encrypted_data_key text,current_ciphertext text,current_nonce varchar,current_auth_tag varchar,
  previous_secret_version_id uuid,previous_secret_valid_until timestamptz,
  previous_schema_version smallint,previous_kms_key_reference varchar,
  previous_encrypted_data_key text,previous_ciphertext text,previous_nonce varchar,previous_auth_tag varchar,
  database_time timestamptz
) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  resolved_workspace uuid;
  prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  SELECT endpoint.workspace_id INTO resolved_workspace
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflow_triggers trigger
      ON trigger.workspace_id=endpoint.workspace_id AND trigger.id=endpoint.trigger_id
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash
     AND endpoint.status='active' AND trigger.kind='webhook' AND trigger.status='active';
  IF resolved_workspace IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.workspace_id',resolved_workspace::text,true);
  RETURN QUERY SELECT endpoint.id,endpoint.workspace_id,trigger.id,trigger.workflow_id,
         trigger.workflow_version_id,trigger.node_id,current_secret.id,
         current_secret.schema_version,current_secret.kms_key_reference,
         current_secret.encrypted_data_key,current_secret.ciphertext,current_secret.nonce,current_secret.auth_tag,
         previous_secret.id,endpoint.previous_secret_valid_until,
         previous_secret.schema_version,previous_secret.kms_key_reference,
         previous_secret.encrypted_data_key,previous_secret.ciphertext,previous_secret.nonce,previous_secret.auth_tag,
         clock_timestamp()
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflow_triggers trigger ON trigger.workspace_id=endpoint.workspace_id AND trigger.id=endpoint.trigger_id
    JOIN app.workflows workflow ON workflow.workspace_id=trigger.workspace_id AND workflow.id=trigger.workflow_id
    JOIN app.workspaces workspace ON workspace.id=trigger.workspace_id
    JOIN app.webhook_trigger_secret_versions current_secret
      ON current_secret.workspace_id=endpoint.workspace_id AND current_secret.trigger_id=trigger.id
     AND current_secret.id=endpoint.current_secret_version_id
    LEFT JOIN app.webhook_trigger_secret_versions previous_secret
      ON previous_secret.workspace_id=endpoint.workspace_id AND previous_secret.trigger_id=trigger.id
     AND previous_secret.id=endpoint.previous_secret_version_id
     AND endpoint.previous_secret_valid_until>clock_timestamp()
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active'
     AND trigger.kind='webhook' AND trigger.status='active'
     AND workflow.lifecycle_status='active' AND workflow.activation_status IN ('active','degraded')
     AND workflow.published_version_id=trigger.workflow_version_id
     AND workspace.status='active';
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;

ALTER TABLE app.workflow_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_triggers FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_trigger_secret_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_trigger_secret_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_trigger_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_trigger_endpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_trigger_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_trigger_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_trigger_replay_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_trigger_replay_records FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_triggers_workspace_scope ON app.workflow_triggers FOR ALL
  TO {{owner_role}},{{api_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_trigger_secret_versions_api_scope ON app.webhook_trigger_secret_versions FOR ALL
  TO {{api_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_trigger_secret_versions_owner_resolver ON app.webhook_trigger_secret_versions FOR SELECT
  TO {{owner_role}} USING(true);
CREATE POLICY webhook_trigger_endpoints_api_scope ON app.webhook_trigger_endpoints FOR ALL
  TO {{api_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_trigger_endpoints_owner_resolver ON app.webhook_trigger_endpoints FOR SELECT
  TO {{owner_role}} USING(true);
CREATE POLICY workflow_triggers_owner_resolver ON app.workflow_triggers FOR SELECT
  TO {{owner_role}} USING(true);
CREATE POLICY webhook_trigger_deliveries_workspace_scope ON app.webhook_trigger_deliveries FOR ALL
  TO {{owner_role}},{{api_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_trigger_replay_records_workspace_scope ON app.webhook_trigger_replay_records FOR ALL
  TO {{owner_role}},{{api_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));

REVOKE ALL ON app.workflow_triggers,app.webhook_trigger_secret_versions,
  app.webhook_trigger_endpoints,app.webhook_trigger_deliveries,
  app.webhook_trigger_replay_records
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT SELECT,INSERT,DELETE ON app.workflow_triggers TO {{api_runtime_role}};
GRANT UPDATE(desired_config,config_fingerprint,status,health_status,last_error_code,reconciled_at,updated_at)
  ON app.workflow_triggers TO {{api_runtime_role}};
GRANT INSERT ON app.webhook_trigger_secret_versions TO {{api_runtime_role}};
GRANT SELECT,INSERT ON app.webhook_trigger_endpoints TO {{api_runtime_role}};
GRANT UPDATE(endpoint_key_hash,status,current_secret_version_id,previous_secret_version_id,
  previous_secret_valid_until,updated_at) ON app.webhook_trigger_endpoints TO {{api_runtime_role}};
GRANT SELECT,INSERT ON app.webhook_trigger_deliveries,app.webhook_trigger_replay_records TO {{api_runtime_role}};
GRANT UPDATE(workflow_run_id) ON app.webhook_trigger_replay_records TO {{api_runtime_role}};
GRANT DELETE ON app.webhook_trigger_replay_records TO {{api_runtime_role}};
REVOKE UPDATE,DELETE,TRUNCATE ON app.webhook_trigger_secret_versions FROM {{api_runtime_role}};
REVOKE ALL ON FUNCTION app.resolve_public_webhook_endpoint(char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_public_webhook_endpoint(char) TO {{api_runtime_role}};
