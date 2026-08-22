CREATE TABLE app.connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  provider_key varchar(64) NOT NULL,
  name varchar(128) NOT NULL,
  auth_type varchar(64) NOT NULL,
  status varchar(32) NOT NULL,
  current_secret_version_id uuid NOT NULL,
  last_tested_at timestamptz,
  last_healthy_at timestamptz,
  last_error_code varchar(128),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT connections_workspace_identity_unique UNIQUE (workspace_id, id),
  CONSTRAINT connections_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT connections_created_by_fk
    FOREIGN KEY (created_by) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT connections_provider_key_format
    CHECK (provider_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
  CONSTRAINT connections_name_bounded
    CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 128),
  CONSTRAINT connections_auth_type_valid CHECK (auth_type IN ('http_headers')),
  CONSTRAINT connections_status_valid
    CHECK (status IN ('active', 'reauthorization_required', 'revoked')),
  CONSTRAINT connections_health_time_order
    CHECK (last_healthy_at IS NULL OR last_tested_at IS NOT NULL),
  CONSTRAINT connections_error_code_format
    CHECK (
      last_error_code IS NULL
      OR last_error_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
    )
);

CREATE UNIQUE INDEX connections_active_name_provider_unique
  ON app.connections (workspace_id, provider_key, lower(name))
  WHERE status <> 'revoked';
CREATE INDEX connections_workspace_status_idx
  ON app.connections (workspace_id, status, created_at DESC, id);

CREATE TABLE app.connection_secret_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  schema_version smallint NOT NULL,
  kms_key_reference varchar(2048) NOT NULL,
  encrypted_data_key text NOT NULL,
  ciphertext text NOT NULL,
  nonce varchar(64) NOT NULL,
  auth_tag varchar(64) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT connection_secret_versions_workspace_connection_identity_unique
    UNIQUE (workspace_id, connection_id, id),
  CONSTRAINT connection_secret_versions_connection_fk
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES app.connections (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_secret_versions_created_by_fk
    FOREIGN KEY (created_by) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT connection_secret_versions_schema_valid CHECK (schema_version = 1),
  CONSTRAINT connection_secret_versions_kms_reference_bounded
    CHECK (length(kms_key_reference) BETWEEN 1 AND 2048),
  CONSTRAINT connection_secret_versions_encrypted_key_bounded
    CHECK (
      length(encrypted_data_key) BETWEEN 1 AND 10923
      AND encrypted_data_key ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT connection_secret_versions_ciphertext_bounded
    CHECK (
      length(ciphertext) BETWEEN 1 AND 87382
      AND ciphertext ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT connection_secret_versions_nonce_valid
    CHECK (length(nonce) = 16 AND nonce ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT connection_secret_versions_tag_valid
    CHECK (length(auth_tag) = 22 AND auth_tag ~ '^[A-Za-z0-9_-]+$')
);

ALTER TABLE app.connections
  ADD CONSTRAINT connections_current_secret_same_connection_fk
  FOREIGN KEY (workspace_id, id, current_secret_version_id)
  REFERENCES app.connection_secret_versions (workspace_id, connection_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX connection_secret_versions_connection_created_idx
  ON app.connection_secret_versions
    (workspace_id, connection_id, created_at DESC, id);

CREATE TABLE app.connection_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  event_type varchar(64) NOT NULL,
  actor_kind varchar(32) NOT NULL,
  actor_id varchar(128) NOT NULL,
  request_id varchar(128),
  trace_id varchar(128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT connection_events_connection_fk
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES app.connections (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_events_type_valid
    CHECK (event_type IN (
      'connection.created',
      'connection.secret_rotated',
      'connection.test_succeeded',
      'connection.test_failed',
      'connection.reauthorization_required',
      'connection.revoked',
      'connection.credential_accessed'
    )),
  CONSTRAINT connection_events_actor_kind_valid
    CHECK (actor_kind IN ('user', 'worker', 'system')),
  CONSTRAINT connection_events_actor_id_format
    CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  CONSTRAINT connection_events_request_id_bounded
    CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT connection_events_trace_id_bounded
    CHECK (trace_id IS NULL OR length(trace_id) BETWEEN 1 AND 128),
  CONSTRAINT connection_events_metadata_bounded
    CHECK (octet_length(metadata::text) <= 4096)
);

CREATE INDEX connection_events_workspace_time_idx
  ON app.connection_events (workspace_id, created_at DESC, id);
CREATE INDEX connection_events_connection_time_idx
  ON app.connection_events
    (workspace_id, connection_id, created_at DESC, id);

CREATE FUNCTION app.reject_connection_history_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  RAISE EXCEPTION 'connection history is immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER connection_secret_versions_immutable
BEFORE UPDATE OR DELETE ON app.connection_secret_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_connection_history_change();

CREATE TRIGGER connection_events_immutable
BEFORE UPDATE OR DELETE ON app.connection_events
FOR EACH ROW EXECUTE FUNCTION app.reject_connection_history_change();

ALTER TABLE app.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE app.connection_secret_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_secret_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.connection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_events FORCE ROW LEVEL SECURITY;

CREATE POLICY connections_workspace_scope
  ON app.connections FOR ALL
  TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

CREATE POLICY connection_secret_versions_workspace_scope
  ON app.connection_secret_versions FOR ALL
  TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

CREATE POLICY connection_events_workspace_scope
  ON app.connection_events FOR ALL
  TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

ALTER TABLE app.connections OWNER TO {{owner_role}};
ALTER TABLE app.connection_secret_versions OWNER TO {{owner_role}};
ALTER TABLE app.connection_events OWNER TO {{owner_role}};
ALTER FUNCTION app.reject_connection_history_change() OWNER TO {{owner_role}};

REVOKE ALL ON app.connections, app.connection_secret_versions,
  app.connection_events
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
REVOKE ALL ON FUNCTION app.reject_connection_history_change() FROM PUBLIC;

GRANT SELECT, INSERT ON app.connections TO {{api_runtime_role}};
GRANT UPDATE (
  current_secret_version_id, status, last_tested_at, last_healthy_at,
  last_error_code, updated_at
) ON app.connections TO {{api_runtime_role}};
GRANT SELECT, INSERT ON app.connection_secret_versions TO {{api_runtime_role}};
GRANT SELECT, INSERT ON app.connection_events TO {{api_runtime_role}};

GRANT SELECT ON app.connections, app.connection_secret_versions
  TO {{worker_runtime_role}};
GRANT UPDATE (
  status, last_tested_at, last_healthy_at, last_error_code, updated_at
) ON app.connections TO {{worker_runtime_role}};
GRANT INSERT ON app.connection_events TO {{worker_runtime_role}};

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.connections, app.connection_secret_versions, app.connection_events
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
REVOKE UPDATE ON app.connection_secret_versions, app.connection_events
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
