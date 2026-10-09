-- Published executables no longer pin a node release: before launch there is
-- one version of everything (ADR 069), and the engine checks a stored
-- executable against the one release the API and worker serve. Preview runs
-- drop the same pin.

DROP POLICY workflow_versions_worker_execution_read ON app.workflow_versions;
ALTER TABLE app.workflow_versions
  DROP CONSTRAINT workflow_versions_checksum_format;
ALTER TABLE app.workflow_versions DROP COLUMN compatibility_release_epoch;
CREATE POLICY workflow_versions_worker_execution_read ON app.workflow_versions
  FOR SELECT TO {{app_role}}
  USING ((workspace_id)::text = NULLIF(current_setting('app.workspace_id', true), '')
    AND (checksum)::text LIKE 'wf:v2:sha256:%'
    AND executable_schema_version = 2
    AND executable_json IS NOT NULL);
ALTER TABLE app.workflow_versions
  ADD CONSTRAINT workflow_versions_checksum_format CHECK ((
    ((checksum)::text ~ '^wf:v1:sha256:[0-9a-f]{64}$'
      AND executable_schema_version IS NULL
      AND executable_json IS NULL)
    OR ((checksum)::text ~ '^wf:v2:sha256:[0-9a-f]{64}$'
      AND executable_schema_version = 2
      AND jsonb_typeof(executable_json) = 'object')
  ) IS TRUE);

ALTER TABLE app.preview_runs
  DROP CONSTRAINT preview_runs_release_fingerprint_format,
  DROP CONSTRAINT preview_runs_release_positive,
  DROP COLUMN compatibility_release_epoch,
  DROP COLUMN compatibility_release_fingerprint;

CREATE OR REPLACE FUNCTION app.reject_preview_run_pin_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(
    OLD.workspace_id, OLD.workflow_id, OLD.draft_revision,
    OLD.draft_fingerprint, OLD.node_id, OLD.definition_key,
    OLD.definition_version, OLD.executor_key, OLD.executor_version,
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
$$;

DROP FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid);
CREATE FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) RETURNS TABLE(id uuid, workspace_id uuid, workflow_id uuid, version_number integer, schema_version integer, checksum character varying, executable_schema_version integer, executable_json jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_workflow_id IS NULL
     OR p_workflow_version_id IS NULL THEN
    RAISE EXCEPTION 'workflow replay version lock arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workflow replay workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT workflow_version.id,
           workflow_version.workspace_id,
           workflow_version.workflow_id,
           workflow_version.version_number,
           workflow_version.schema_version,
           workflow_version.checksum,
           workflow_version.executable_schema_version,
           workflow_version.executable_json
      FROM app.workflow_versions AS workflow_version
     WHERE workflow_version.workspace_id = p_workspace_id
       AND workflow_version.workflow_id = p_workflow_id
       AND workflow_version.id = p_workflow_version_id
     FOR SHARE;
END;
$$;
REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid) TO {{app_role}};
