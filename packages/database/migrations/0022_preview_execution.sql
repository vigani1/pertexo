-- ADR 016 preview execution is durable but isolated from production runs,
-- checkpoints, and events. The API creates exactly one immutable preview run
-- identity and one logical attempt; the worker owns execution state only.

CREATE TABLE app.preview_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  draft_revision integer NOT NULL,
  draft_fingerprint char(64) NOT NULL,
  node_id varchar(256) NOT NULL,
  definition_key varchar(128) NOT NULL,
  definition_version integer NOT NULL,
  executor_key varchar(128) NOT NULL,
  executor_version integer NOT NULL,
  compatibility_release_epoch integer NOT NULL,
  compatibility_release_fingerprint varchar(128) NOT NULL,
  actor_user_id uuid NOT NULL,
  idempotency_key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  executable_node_json jsonb NOT NULL,
  input_ref jsonb NOT NULL,
  prior_preview_run_id uuid,
  side_effect_class varchar(32) NOT NULL,
  may_contact_provider boolean NOT NULL,
  may_cause_external_side_effect boolean NOT NULL,
  dry_run varchar(32) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  output_ref jsonb,
  safe_error_code varchar(128),
  traceparent varchar(55),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT preview_runs_workspace_identity_unique
    UNIQUE (workspace_id, id),
  CONSTRAINT preview_runs_workspace_workflow_identity_unique
    UNIQUE (workspace_id, workflow_id, id),
  CONSTRAINT preview_runs_workflow_fk
    FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES app.workflows (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT preview_runs_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT preview_runs_idempotency_hashes_format CHECK (
    idempotency_key_hash ~ '^[0-9a-f]{64}$'
    AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT preview_runs_release_fk
    FOREIGN KEY (compatibility_release_epoch, compatibility_release_fingerprint)
    REFERENCES app.node_compatibility_releases (epoch, fingerprint)
    ON DELETE RESTRICT,
  CONSTRAINT preview_runs_prior_preview_fk
    FOREIGN KEY (workspace_id, workflow_id, prior_preview_run_id)
    REFERENCES app.preview_runs (workspace_id, workflow_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT preview_runs_revision_positive CHECK (draft_revision > 0),
  CONSTRAINT preview_runs_draft_fingerprint_format
    CHECK (draft_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT preview_runs_node_id_bounded
    CHECK (length(node_id) BETWEEN 1 AND 256),
  CONSTRAINT preview_runs_definition_key_format
    CHECK (definition_key ~ '^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$'),
  CONSTRAINT preview_runs_executor_key_format
    CHECK (executor_key ~ '^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$'),
  CONSTRAINT preview_runs_versions_positive
    CHECK (definition_version > 0 AND executor_version > 0),
  CONSTRAINT preview_runs_release_positive
    CHECK (compatibility_release_epoch > 0),
  CONSTRAINT preview_runs_release_fingerprint_format
    CHECK (
      compatibility_release_fingerprint
      ~ '^node-compat:v1:sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT preview_runs_node_object
    CHECK (jsonb_typeof(executable_node_json) = 'object'),
  CONSTRAINT preview_runs_node_bounded
    CHECK (octet_length(executable_node_json::text) <= 2097152),
  CONSTRAINT preview_runs_input_bounded
    CHECK (octet_length(input_ref::text) <= 4194304),
  CONSTRAINT preview_runs_output_bounded
    CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4194304),
  CONSTRAINT preview_runs_side_effect_class_valid
    CHECK (side_effect_class IN ('safe', 'idempotent_with_key', 'unsafe')),
  CONSTRAINT preview_runs_dry_run_valid
    CHECK (dry_run IN ('not_supported', 'provider_supported')),
  CONSTRAINT preview_runs_disclosure_consistent CHECK (
    may_cause_external_side_effect IS FALSE OR may_contact_provider IS TRUE
  ),
  CONSTRAINT preview_runs_status_valid CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out',
    'outcome_unknown'
  )),
  CONSTRAINT preview_runs_safe_error_code_format CHECK (
    safe_error_code IS NULL
    OR safe_error_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT preview_runs_traceparent_format CHECK (
    traceparent IS NULL
    OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
  ),
  CONSTRAINT preview_runs_retention_future CHECK (expires_at > created_at),
  CONSTRAINT preview_runs_time_order CHECK (
    (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
    AND (completed_at IS NULL OR started_at IS NOT NULL)
  ),
  CONSTRAINT preview_runs_terminal_shape CHECK (
    (status IN ('queued', 'running') AND completed_at IS NULL)
    OR
    (status IN (
      'succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'
    ) AND completed_at IS NOT NULL)
  ),
  CONSTRAINT preview_runs_output_truth CHECK (
    (status = 'succeeded' AND output_ref IS NOT NULL AND safe_error_code IS NULL)
    OR
    (status <> 'succeeded' AND output_ref IS NULL)
  )
);

CREATE INDEX preview_runs_workspace_created_idx
  ON app.preview_runs (workspace_id, created_at DESC, id);
CREATE INDEX preview_runs_workflow_created_idx
  ON app.preview_runs (workspace_id, workflow_id, created_at DESC, id);
CREATE INDEX preview_runs_expiry_idx
  ON app.preview_runs (expires_at, id);

CREATE TABLE app.preview_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  preview_run_id uuid NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  side_effect_class varchar(32) NOT NULL,
  provider_idempotency_key varchar(256),
  lease_owner varchar(128),
  lease_expires_at timestamptz,
  fence_token bigint NOT NULL DEFAULT 0,
  dispatch_marked_at timestamptz,
  output_ref jsonb,
  safe_error_code varchar(128),
  reconciliation_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT preview_attempts_workspace_identity_unique
    UNIQUE (workspace_id, id),
  CONSTRAINT preview_attempts_one_per_run UNIQUE (preview_run_id),
  CONSTRAINT preview_attempts_run_fk
    FOREIGN KEY (workspace_id, preview_run_id)
    REFERENCES app.preview_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT preview_attempts_status_valid CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out',
    'outcome_unknown'
  )),
  CONSTRAINT preview_attempts_side_effect_class_valid
    CHECK (side_effect_class IN ('safe', 'idempotent_with_key', 'unsafe')),
  CONSTRAINT preview_attempts_provider_key_bounded
    CHECK (
      provider_idempotency_key IS NULL
      OR length(provider_idempotency_key) BETWEEN 1 AND 256
    ),
  CONSTRAINT preview_attempts_lease_complete CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT preview_attempts_lease_owner_format CHECK (
    lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  CONSTRAINT preview_attempts_fence_nonnegative CHECK (fence_token >= 0),
  CONSTRAINT preview_attempts_output_bounded
    CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4194304),
  CONSTRAINT preview_attempts_error_code_format CHECK (
    safe_error_code IS NULL
    OR safe_error_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT preview_attempts_reconciliation_bounded CHECK (
    reconciliation_ref IS NULL
    OR octet_length(reconciliation_ref::text) <= 4096
  ),
  CONSTRAINT preview_attempts_time_order CHECK (
    (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
    AND (completed_at IS NULL OR started_at IS NOT NULL)
    AND (dispatch_marked_at IS NULL OR started_at IS NOT NULL)
  ),
  CONSTRAINT preview_attempts_terminal_shape CHECK (
    (status IN ('queued', 'running') AND completed_at IS NULL)
    OR
    (status IN (
      'succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'
    ) AND completed_at IS NOT NULL)
  ),
  CONSTRAINT preview_attempts_output_truth CHECK (
    (status = 'succeeded' AND output_ref IS NOT NULL AND safe_error_code IS NULL)
    OR
    (status <> 'succeeded' AND output_ref IS NULL)
  )
);

CREATE INDEX preview_attempts_claim_idx
  ON app.preview_attempts (status, lease_expires_at, id)
  WHERE status IN ('queued', 'running');

CREATE FUNCTION app.reject_preview_run_pin_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF ROW(
    OLD.workspace_id, OLD.workflow_id, OLD.draft_revision,
    OLD.draft_fingerprint, OLD.node_id, OLD.definition_key,
    OLD.definition_version, OLD.executor_key, OLD.executor_version,
    OLD.compatibility_release_epoch, OLD.compatibility_release_fingerprint,
    OLD.actor_user_id, OLD.idempotency_key_hash, OLD.request_hash,
    OLD.executable_node_json, OLD.input_ref,
    OLD.prior_preview_run_id, OLD.side_effect_class, OLD.may_contact_provider,
    OLD.may_cause_external_side_effect, OLD.dry_run, OLD.traceparent,
    OLD.created_at, OLD.expires_at
  ) IS DISTINCT FROM ROW(
    NEW.workspace_id, NEW.workflow_id, NEW.draft_revision,
    NEW.draft_fingerprint, NEW.node_id, NEW.definition_key,
    NEW.definition_version, NEW.executor_key, NEW.executor_version,
    NEW.compatibility_release_epoch, NEW.compatibility_release_fingerprint,
    NEW.actor_user_id, NEW.idempotency_key_hash, NEW.request_hash,
    NEW.executable_node_json, NEW.input_ref,
    NEW.prior_preview_run_id, NEW.side_effect_class, NEW.may_contact_provider,
    NEW.may_cause_external_side_effect, NEW.dry_run, NEW.traceparent,
    NEW.created_at, NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'preview run identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER preview_run_pins_immutable
  BEFORE UPDATE ON app.preview_runs
  FOR EACH ROW EXECUTE FUNCTION app.reject_preview_run_pin_change();

ALTER TABLE app.preview_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.preview_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.preview_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.preview_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY preview_runs_workspace_scope ON app.preview_runs
  FOR ALL TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY preview_attempts_workspace_scope ON app.preview_attempts
  FOR ALL TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

ALTER TABLE app.preview_runs OWNER TO {{owner_role}};
ALTER TABLE app.preview_attempts OWNER TO {{owner_role}};
ALTER FUNCTION app.reject_preview_run_pin_change() OWNER TO {{owner_role}};

REVOKE ALL ON app.preview_runs, app.preview_attempts
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
REVOKE ALL ON FUNCTION app.reject_preview_run_pin_change() FROM PUBLIC;

GRANT SELECT, INSERT ON app.preview_runs, app.preview_attempts
  TO {{api_runtime_role}};
GRANT SELECT ON app.preview_runs, app.preview_attempts
  TO {{worker_runtime_role}};
GRANT UPDATE (status, output_ref, safe_error_code, started_at, completed_at, updated_at)
  ON app.preview_runs TO {{worker_runtime_role}};
GRANT UPDATE (
  status, lease_owner, lease_expires_at, fence_token, dispatch_marked_at,
  output_ref, safe_error_code, reconciliation_ref, started_at, completed_at,
  updated_at
) ON app.preview_attempts TO {{worker_runtime_role}};

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.preview_runs, app.preview_attempts
  FROM {{api_runtime_role}}, {{dispatcher_role}};
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.preview_runs, app.preview_attempts
  FROM {{worker_runtime_role}}, {{dispatcher_role}};
