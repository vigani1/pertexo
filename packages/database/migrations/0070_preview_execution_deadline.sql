-- ADR 016 amendment: execution timeout and retained visibility are separate
-- immutable policies. Existing previews receive the conservative five-minute
-- deadline, capped by their already-pinned retention expiry.

ALTER TABLE app.preview_runs
  ADD COLUMN execution_deadline_at timestamptz;

-- Migration connections intentionally carry no tenant context. Temporarily
-- let the table owner bypass forced RLS so every retained preview is backfilled;
-- the whole migration is atomic and FORCE is restored before commit.
ALTER TABLE app.preview_runs NO FORCE ROW LEVEL SECURITY;

UPDATE app.preview_runs
SET execution_deadline_at = LEAST(
  expires_at,
  created_at + interval '5 minutes'
);

ALTER TABLE app.preview_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE app.preview_runs
  ALTER COLUMN execution_deadline_at SET NOT NULL,
  ADD CONSTRAINT preview_runs_execution_deadline_order CHECK (
    execution_deadline_at > created_at
    AND execution_deadline_at <= expires_at
  );

CREATE OR REPLACE FUNCTION app.reject_preview_run_pin_change()
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
    OLD.request_id, OLD.trace_id, OLD.provider_key, OLD.operation_key,
    OLD.executable_node_json, OLD.input_ref,
    OLD.prior_preview_run_id, OLD.side_effect_class, OLD.may_contact_provider,
    OLD.may_cause_external_side_effect, OLD.dry_run, OLD.traceparent,
    OLD.created_at, OLD.execution_deadline_at, OLD.expires_at
  ) IS DISTINCT FROM ROW(
    NEW.workspace_id, NEW.workflow_id, NEW.draft_revision,
    NEW.draft_fingerprint, NEW.node_id, NEW.definition_key,
    NEW.definition_version, NEW.executor_key, NEW.executor_version,
    NEW.compatibility_release_epoch, NEW.compatibility_release_fingerprint,
    NEW.actor_user_id, NEW.idempotency_key_hash, NEW.request_hash,
    NEW.request_id, NEW.trace_id, NEW.provider_key, NEW.operation_key,
    NEW.executable_node_json, NEW.input_ref,
    NEW.prior_preview_run_id, NEW.side_effect_class, NEW.may_contact_provider,
    NEW.may_cause_external_side_effect, NEW.dry_run, NEW.traceparent,
    NEW.created_at, NEW.execution_deadline_at, NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'preview run identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
