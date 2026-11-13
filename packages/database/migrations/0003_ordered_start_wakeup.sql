-- Granted runs of a limited workflow start in ticket order. A later run whose
-- start lands first is deferred while holding its slot. When the run ahead of it
-- starts, the coordinator calls this in the same transaction, so the next
-- granted run's deferred delivery is due at once instead of after the deferral.
-- It moves only that delivery; the app may not move any other advance.
CREATE FUNCTION app.wake_next_ordered_workflow_run_start(p_workspace uuid, p_started_run uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  -- SKIP LOCKED: a delivery the dispatcher holds is already due, so never wait for it.
  UPDATE app.outbox_events event
     SET available_at=clock_timestamp(), updated_at=clock_timestamp()
   WHERE event.id IN (
     SELECT deferred.id FROM app.outbox_events deferred
      WHERE deferred.workspace_id=p_workspace AND deferred.job_name='advance-workflow-run'
        AND deferred.published_at IS NULL AND deferred.failed_at IS NULL
        AND deferred.lease_expires_at IS NULL AND deferred.available_at>clock_timestamp()
        AND deferred.id=(
          -- Non-exempt grants exist only under a workflow limit.
          SELECT admission.outbox_event_id
            FROM app.workflow_run_active_admissions admission
            JOIN app.workflow_runs started
              ON started.workspace_id=admission.workspace_id AND started.id=p_started_run
            JOIN app.workflow_runs waiting
              ON waiting.workspace_id=admission.workspace_id AND waiting.id=admission.workflow_run_id
           WHERE admission.workspace_id=p_workspace AND NOT admission.workflow_concurrency_order_exempt
             AND waiting.workflow_id=started.workflow_id AND waiting.status='queued'
             AND waiting.cancel_requested_at IS NULL
             AND (waiting.deadline_at IS NULL OR waiting.deadline_at>clock_timestamp())
           ORDER BY waiting.admission_ticket
           LIMIT 1)
      FOR UPDATE SKIP LOCKED);
  RETURN FOUND;
END $$;

ALTER FUNCTION app.wake_next_ordered_workflow_run_start(p_workspace uuid, p_started_run uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.wake_next_ordered_workflow_run_start(p_workspace uuid, p_started_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.wake_next_ordered_workflow_run_start(p_workspace uuid, p_started_run uuid) TO {{app_role}};

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
