CREATE TABLE app.workflow_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  trigger_type varchar(32) NOT NULL,
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_runs_workspace_identity_unique
    UNIQUE (workspace_id, id),
  CONSTRAINT workflow_runs_trigger_type_valid
    CHECK (trigger_type IN ('api', 'manual', 'replay', 'schedule', 'webhook')),
  CONSTRAINT workflow_runs_status_valid
    CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'))
);

CREATE INDEX workflow_runs_workspace_status_created_idx
  ON app.workflow_runs (workspace_id, status, created_at DESC, id DESC);
CREATE INDEX workflow_runs_workflow_version_idx
  ON app.workflow_runs (workspace_id, workflow_version_id, id);

CREATE TABLE app.run_events (
  workspace_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  sequence integer NOT NULL,
  type varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_run_id, sequence),
  CONSTRAINT run_events_run_workspace_fk
    FOREIGN KEY (workspace_id, workflow_run_id)
    REFERENCES app.workflow_runs (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT run_events_sequence_positive
    CHECK (sequence > 0),
  CONSTRAINT run_events_type_format
    CHECK (type ~ '^[a-z][a-z0-9.]{0,63}$'),
  CONSTRAINT run_events_payload_bounded
    CHECK (octet_length(payload::text) <= 4096)
);

CREATE INDEX run_events_workspace_created_idx
  ON app.run_events (workspace_id, created_at DESC, workflow_run_id, sequence);

CREATE TABLE app.run_checkpoints (
  workflow_run_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL,
  engine_version varchar(64) NOT NULL,
  scheduler_state jsonb NOT NULL,
  resume_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_checkpoints_run_workspace_fk
    FOREIGN KEY (workspace_id, workflow_run_id)
    REFERENCES app.workflow_runs (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT run_checkpoints_revision_nonnegative
    CHECK (revision >= 0),
  CONSTRAINT run_checkpoints_engine_version_format
    CHECK (engine_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT run_checkpoints_scheduler_state_bounded
    CHECK (octet_length(scheduler_state::text) <= 16384)
);

CREATE INDEX run_checkpoints_due_resume_idx
  ON app.run_checkpoints (resume_at, workflow_run_id)
  WHERE resume_at IS NOT NULL;

CREATE TABLE app.idempotency_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation varchar(64) NOT NULL,
  scope varchar(128) NOT NULL,
  key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(16) NOT NULL,
  resource_id uuid NOT NULL,
  result_ref jsonb NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_active_key_unique
    UNIQUE (workspace_id, operation, scope, key_hash),
  CONSTRAINT idempotency_records_operation_format
    CHECK (operation ~ '^[a-z][a-z0-9.]{0,63}$'),
  CONSTRAINT idempotency_records_scope_format
    CHECK (scope ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT idempotency_records_key_hash_format
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_records_request_hash_format
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_records_status_valid
    CHECK (status IN ('claimed', 'completed')),
  CONSTRAINT idempotency_records_result_ref_bounded
    CHECK (octet_length(result_ref::text) <= 4096),
  CONSTRAINT idempotency_records_expiry_valid
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX idempotency_records_expiry_idx
  ON app.idempotency_records (expires_at, id)
  WHERE expires_at IS NOT NULL;
CREATE INDEX idempotency_records_resource_idx
  ON app.idempotency_records (workspace_id, resource_id);

ALTER TABLE app.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.run_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_records FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_runs_workspace_scope
  ON app.workflow_runs
  FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

CREATE POLICY run_events_workspace_scope
  ON app.run_events
  FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

CREATE POLICY run_checkpoints_workspace_scope
  ON app.run_checkpoints
  FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

CREATE POLICY idempotency_records_workspace_scope
  ON app.idempotency_records
  FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

REVOKE ALL
  ON app.workflow_runs, app.run_events, app.run_checkpoints,
    app.idempotency_records
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

GRANT SELECT, INSERT
  ON app.workflow_runs, app.run_events, app.run_checkpoints,
    app.idempotency_records
  TO {{api_runtime_role}};

GRANT SELECT
  ON app.workflow_runs, app.run_events, app.run_checkpoints,
    app.idempotency_records
  TO {{worker_runtime_role}};
