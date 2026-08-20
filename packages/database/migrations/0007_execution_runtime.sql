ALTER TABLE app.workflow_runs
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_requested_by varchar(128),
  ADD COLUMN cancel_reason varchar(512),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN output_ref jsonb,
  ADD COLUMN error_summary varchar(2048),
  ADD CONSTRAINT workflow_runs_deadline_valid
    CHECK (deadline_at IS NULL OR deadline_at > created_at),
  ADD CONSTRAINT workflow_runs_cancel_metadata_complete
    CHECK (
      (cancel_requested_at IS NULL AND cancel_requested_by IS NULL AND cancel_reason IS NULL)
      OR (cancel_requested_at IS NOT NULL AND cancel_requested_by IS NOT NULL)
    ),
  ADD CONSTRAINT workflow_runs_cancel_actor_format
    CHECK (
      cancel_requested_by IS NULL
      OR cancel_requested_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    ),
  ADD CONSTRAINT workflow_runs_output_ref_bounded
    CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4096);

UPDATE app.run_events SET type = 'run.queued' WHERE type = 'run.accepted';

ALTER TABLE app.run_events
  DROP CONSTRAINT run_events_type_format;

ALTER TABLE app.run_events
  ADD CONSTRAINT run_events_type_catalog
  CHECK (type IN (
    'run.queued',
    'run.started',
    'run.waiting',
    'run.cancel_requested',
    'run.succeeded',
    'run.failed',
    'run.canceled',
    'run.timed_out',
    'run.outcome_unknown',
    'node.ready',
    'node.started',
    'node.progress',
    'node.waiting',
    'node.retry_scheduled',
    'node.succeeded',
    'node.failed',
    'node.skipped',
    'node.canceled',
    'node.timed_out',
    'node.outcome_unknown'
  ));

ALTER TABLE app.run_checkpoints
  ADD COLUMN resume_lease_owner varchar(128),
  ADD COLUMN resume_lease_token uuid,
  ADD COLUMN resume_lease_expires_at timestamptz,
  ADD CONSTRAINT run_checkpoints_resume_lease_complete
  CHECK (
    (resume_lease_owner IS NULL AND resume_lease_token IS NULL AND resume_lease_expires_at IS NULL)
    OR (resume_lease_owner IS NOT NULL AND resume_lease_token IS NOT NULL AND resume_lease_expires_at IS NOT NULL)
  );

DROP INDEX app.run_checkpoints_due_resume_idx;
CREATE INDEX run_checkpoints_due_resume_idx
  ON app.run_checkpoints (resume_at, workflow_run_id)
  WHERE resume_at IS NOT NULL;

CREATE TABLE app.node_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  node_id varchar(128) NOT NULL,
  invocation_key varchar(256) NOT NULL,
  branch_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(32) NOT NULL,
  side_effect_class varchar(32) NOT NULL,
  provider_idempotency_key varchar(256),
  input_ref jsonb,
  output_ref jsonb,
  current_attempt_id uuid,
  current_attempt_number integer,
  resume_at timestamptz,
  retry_due_at timestamptz,
  safe_error_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT node_runs_workspace_identity_unique UNIQUE (workspace_id, id),
  CONSTRAINT node_runs_invocation_unique UNIQUE (workflow_run_id, invocation_key),
  CONSTRAINT node_runs_run_workspace_fk
    FOREIGN KEY (workspace_id, workflow_run_id)
    REFERENCES app.workflow_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT node_runs_node_id_format
    CHECK (node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT node_runs_invocation_key_format
    CHECK (invocation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'),
  CONSTRAINT node_runs_status_valid
    CHECK (status IN (
      'pending', 'ready', 'running', 'waiting', 'succeeded', 'failed',
      'skipped', 'canceled', 'timed_out', 'outcome_unknown'
    )),
  CONSTRAINT node_runs_side_effect_class_valid
    CHECK (side_effect_class IN ('safe', 'idempotent_with_key', 'unsafe')),
  CONSTRAINT node_runs_provider_key_valid
    CHECK (
      (side_effect_class = 'idempotent_with_key' AND provider_idempotency_key IS NOT NULL)
      OR (side_effect_class <> 'idempotent_with_key')
    ),
  CONSTRAINT node_runs_provider_key_bounded
    CHECK (provider_idempotency_key IS NULL OR length(provider_idempotency_key) <= 256),
  CONSTRAINT node_runs_branch_context_bounded
    CHECK (octet_length(branch_context::text) <= 4096),
  CONSTRAINT node_runs_input_ref_bounded
    CHECK (input_ref IS NULL OR octet_length(input_ref::text) <= 4096),
  CONSTRAINT node_runs_output_ref_bounded
    CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4096),
  CONSTRAINT node_runs_attempt_pointer_complete
    CHECK (
      (current_attempt_id IS NULL AND current_attempt_number IS NULL)
      OR (current_attempt_id IS NOT NULL AND current_attempt_number IS NOT NULL AND current_attempt_number > 0)
    ),
  CONSTRAINT node_runs_wait_state_valid
    CHECK (
      (status = 'waiting' AND (resume_at IS NOT NULL OR retry_due_at IS NOT NULL))
      OR (status <> 'waiting' AND resume_at IS NULL AND retry_due_at IS NULL)
    )
);

CREATE INDEX node_runs_run_status_idx
  ON app.node_runs (workspace_id, workflow_run_id, status, id);
CREATE INDEX node_runs_due_idx
  ON app.node_runs (workspace_id, retry_due_at, resume_at, id)
  WHERE status = 'waiting';

CREATE TABLE app.node_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  node_run_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  status varchar(32) NOT NULL,
  side_effect_class varchar(32) NOT NULL,
  provider_idempotency_key varchar(256),
  lease_owner varchar(128),
  lease_expires_at timestamptz,
  fence_token bigint NOT NULL DEFAULT 0,
  dispatch_marked_at timestamptz,
  output_ref jsonb,
  safe_error_code varchar(128),
  error_summary varchar(2048),
  reconciliation_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT node_attempts_workspace_identity_unique UNIQUE (workspace_id, id),
  CONSTRAINT node_attempts_number_unique UNIQUE (node_run_id, attempt_number),
  CONSTRAINT node_attempts_node_run_workspace_fk
    FOREIGN KEY (workspace_id, node_run_id)
    REFERENCES app.node_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT node_attempts_number_positive CHECK (attempt_number > 0),
  CONSTRAINT node_attempts_status_valid
    CHECK (status IN (
      'pending', 'ready', 'running', 'waiting', 'succeeded', 'failed',
      'skipped', 'canceled', 'timed_out', 'outcome_unknown'
    )),
  CONSTRAINT node_attempts_side_effect_class_valid
    CHECK (side_effect_class IN ('safe', 'idempotent_with_key', 'unsafe')),
  CONSTRAINT node_attempts_provider_key_valid
    CHECK (
      (side_effect_class = 'idempotent_with_key' AND provider_idempotency_key IS NOT NULL)
      OR (side_effect_class <> 'idempotent_with_key')
    ),
  CONSTRAINT node_attempts_lease_complete
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND status = 'running')
    ),
  CONSTRAINT node_attempts_fence_nonnegative CHECK (fence_token >= 0),
  CONSTRAINT node_attempts_output_ref_bounded
    CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4096),
  CONSTRAINT node_attempts_reconciliation_ref_bounded
    CHECK (reconciliation_ref IS NULL OR octet_length(reconciliation_ref::text) <= 4096)
);

CREATE INDEX node_attempts_node_status_idx
  ON app.node_attempts (workspace_id, node_run_id, status, attempt_number);
CREATE INDEX node_attempts_expired_lease_idx
  ON app.node_attempts (lease_expires_at, id)
  WHERE status = 'running' AND lease_expires_at IS NOT NULL;
CREATE UNIQUE INDEX node_attempts_one_nonterminal_idx
  ON app.node_attempts (node_run_id)
  WHERE status IN ('pending', 'ready', 'running', 'waiting');

ALTER TABLE app.node_runs
  ADD CONSTRAINT node_runs_current_attempt_workspace_fk
  FOREIGN KEY (workspace_id, current_attempt_id)
  REFERENCES app.node_attempts (workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE app.node_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.node_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.node_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.node_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY node_runs_workspace_scope
  ON app.node_runs FOR ALL TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

CREATE POLICY node_attempts_workspace_scope
  ON app.node_attempts FOR ALL TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

REVOKE ALL ON app.node_runs, app.node_attempts
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

GRANT SELECT ON app.node_runs, app.node_attempts
  TO {{api_runtime_role}}, {{worker_runtime_role}};
GRANT INSERT ON app.node_runs, app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE (
  status, output_ref, current_attempt_id, current_attempt_number, resume_at,
  retry_due_at, safe_error_code, updated_at, started_at, completed_at
) ON app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE (
  status, lease_owner, lease_expires_at, fence_token, dispatch_marked_at,
  output_ref, safe_error_code, error_summary, reconciliation_ref, updated_at,
  started_at, completed_at
) ON app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE (
  status, started_at, completed_at, output_ref, error_summary, updated_at
) ON app.workflow_runs TO {{worker_runtime_role}};
GRANT UPDATE (
  revision, engine_version, scheduler_state, resume_at, resume_lease_owner,
  resume_lease_token, resume_lease_expires_at, updated_at
) ON app.run_checkpoints TO {{worker_runtime_role}};
GRANT INSERT ON app.run_events TO {{worker_runtime_role}};

GRANT UPDATE (
  cancel_requested_at, cancel_requested_by, cancel_reason, updated_at
) ON app.workflow_runs TO {{api_runtime_role}};

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.node_runs, app.node_attempts
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
