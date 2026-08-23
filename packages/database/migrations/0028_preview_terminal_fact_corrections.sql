-- Preserve acceptance correlation and bounded integration classification for
-- terminal audit facts and metrics created after this compatibility head.

ALTER TABLE app.preview_runs
  ADD COLUMN request_id varchar(128),
  ADD COLUMN trace_id varchar(128),
  ADD COLUMN provider_key varchar(64),
  ADD COLUMN operation_key varchar(128),
  ADD CONSTRAINT preview_runs_integration_identity_consistent CHECK (
    (provider_key IS NULL AND operation_key IS NULL)
    OR
    (
      provider_key ~ '^[a-z][a-z0-9._:-]{0,63}$'
      AND operation_key ~ '^[a-z][a-z0-9._:-]{0,127}$'
    )
  );

-- Acceptance audit facts are the authoritative source for requests accepted
-- before this column existed. Preview rows remain mutable operational state;
-- immutable audit history is not rewritten.
ALTER TABLE app.preview_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events NO FORCE ROW LEVEL SECURITY;

UPDATE app.preview_runs preview
   SET request_id = accepted.request_id,
       trace_id = coalesce(
         accepted.trace_id,
         CASE WHEN preview.traceparent IS NULL THEN NULL
              ELSE substring(preview.traceparent FROM 4 FOR 32) END
       )
  FROM app.audit_events accepted
 WHERE accepted.workspace_id = preview.workspace_id
   AND accepted.action = 'preview.execution_accepted'
   AND accepted.target_type = 'preview-run'
   AND accepted.target_id = preview.id
   AND (
     accepted.request_id IS NOT NULL
     OR accepted.trace_id IS NOT NULL
     OR preview.traceparent IS NOT NULL
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
    OLD.created_at, OLD.expires_at
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
    NEW.created_at, NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'preview run identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER TABLE app.preview_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;

-- Historical facts from 0027 retain their immutable IDs. New preview terminal
-- facts must use application-generated UUIDv7 IDs.
ALTER TABLE app.audit_events
  ADD CONSTRAINT audit_events_preview_terminal_uuid_v7 CHECK (
    action <> 'preview.execution_terminal' OR uuid_extract_version(id) = 7
  ) NOT VALID;
ALTER TABLE app.usage_events
  ADD CONSTRAINT usage_events_preview_uuid_v7 CHECK (
    category <> 'preview_execution' OR uuid_extract_version(id) = 7
  ) NOT VALID;
