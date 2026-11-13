-- When a limited workflow's run starts, the coordinator brings forward the next
-- granted run's deferred delivery in the same transaction, so that run's slot
-- isn't left idle for the deferral. The app may already set available_at; the
-- policy lets it do so for its own workspace's undelivered advances.
CREATE POLICY outbox_events_ordered_start_wakeup ON app.outbox_events FOR UPDATE TO {{app_role}}
  USING (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid
    AND job_name = 'advance-workflow-run' AND published_at IS NULL AND failed_at IS NULL)
  WITH CHECK (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid
    AND job_name = 'advance-workflow-run' AND published_at IS NULL AND failed_at IS NULL);

CREATE OR REPLACE FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE active_limit integer;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  -- Protocol rejection precedes the counter, including for old lock-owning workers.
  -- An order rejection is decided under the counter, so a deferral and the start
  -- of the run ahead of it serialize, and that start's wake sees the deferral.
  PERFORM app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false);
  SELECT version.active_run_limit INTO active_limit
    FROM app.workspace_execution_admission_counters counter
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=counter.workspace_id
      AND version.version=p_entitlement_version
    WHERE counter.workspace_id=p_workspace_id FOR UPDATE OF counter;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  RETURN (
    EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
      WHERE admission.workspace_id=p_workspace_id AND admission.workflow_run_id=p_workflow_run_id
        AND admission.borrowed_call_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM app.workflow_runs paused WHERE paused.workspace_id=p_workspace_id AND paused.id=p_workflow_run_id AND paused.human_wait_started_at IS NOT NULL))
    OR EXISTS(SELECT 1 FROM app.workflow_calls loan WHERE loan.workspace_id=p_workspace_id AND loan.parent_run_id=p_workflow_run_id AND loan.slot_lent)
    OR app.workflow_run_active_slots(p_workspace_id,NULL,p_workflow_run_id)
      +app.workflow_run_reserved_slots(p_workspace_id,NULL,p_workflow_run_id)<active_limit);
END $$;
