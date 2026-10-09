-- Concurrency limits and auto-pause settings change in TypeScript
-- (src/authoring/workflow-concurrency.ts and workflow-auto-pause.ts), with
-- command keys in idempotency_records. Run admission keeps its counters in
-- the database, so a limit change takes the same admission lock through one
-- small function.

DROP FUNCTION app.workflow_concurrency_control(uuid, uuid, uuid, text, jsonb, text, text, text, text);
DROP FUNCTION app.workflow_auto_pause_control(uuid, uuid, uuid, text, jsonb, text, text, text, text);
DROP TABLE app.workflow_concurrency_command_receipts;
DROP TABLE app.workflow_auto_pause_command_receipts;

-- Holds the workspace's entitlement and admission counter, as run grants do.
CREATE FUNCTION app.lock_workspace_admission(p_workspace uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
SET row_security TO 'on'
AS $function$
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.workspace_execution_entitlements current
    JOIN app.workspace_execution_entitlement_versions version
      ON version.workspace_id = current.workspace_id
     AND version.version = current.current_version
    WHERE current.workspace_id = p_workspace
    FOR SHARE OF current, version;
  PERFORM 1 FROM app.workspace_execution_admission_counters
    WHERE workspace_id = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace admission unavailable' USING ERRCODE = 'PTA01';
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION app.lock_workspace_admission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_workspace_admission(uuid) TO {{app_role}};

CREATE POLICY workflow_concurrency_policies_workspace_scope
  ON app.workflow_concurrency_policies TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
GRANT SELECT, INSERT ON app.workflow_concurrency_policies TO {{app_role}};
GRANT UPDATE (active_run_limit, revision)
  ON app.workflow_concurrency_policies TO {{app_role}};

CREATE POLICY workflow_trigger_pause_periods_workspace_scope
  ON app.workflow_trigger_pause_periods TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
GRANT INSERT ON app.workflow_trigger_pause_periods TO {{app_role}};

CREATE POLICY workflow_failure_streaks_workspace_scope
  ON app.workflow_failure_streaks TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
-- A resume resets the streak with an upsert, which reads only its key.
GRANT INSERT, SELECT (workspace_id, workflow_id)
  ON app.workflow_failure_streaks TO {{app_role}};
GRANT UPDATE (consecutive_failures, last_run_id, last_ended_at, resumed_after,
  updated_at) ON app.workflow_failure_streaks TO {{app_role}};

GRANT UPDATE (auto_pause_enabled, auto_pause_threshold,
  auto_pause_settings_revision, trigger_pause_state, trigger_paused_at,
  trigger_pause_reason, trigger_pause_failures, trigger_pause_last_run_id,
  trigger_pause_revision) ON app.workflows TO {{app_role}};
GRANT UPDATE (auto_pause_threshold) ON app.workspaces TO {{app_role}};
