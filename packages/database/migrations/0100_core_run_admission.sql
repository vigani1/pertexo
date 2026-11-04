-- Core owns standing and run controls; storage retains immutable pins,
-- capacity/FIFO serialization, tickets, limits and the existing lock protocol.
CREATE OR REPLACE FUNCTION app.enforce_workflow_run_admission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  entitlement record;
  actual_queued integer;
  actual_active integer;
  reserved_active integer;
  next_queued integer;
  next_active integer;
BEGIN
  IF TG_OP='UPDATE' AND NEW.admission_ticket IS DISTINCT FROM OLD.admission_ticket THEN
    RAISE EXCEPTION 'admission ticket is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
    END IF;
    RAISE EXCEPTION 'capped production runs must enter the durable queue' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL)
     AND current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=NEW.workspace_id FOR SHARE;
  IF TG_OP='INSERT' THEN
    SELECT version.version,version.active_run_limit,version.queued_run_limit
      INTO entitlement
      FROM app.workspace_execution_entitlements current
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=current.workspace_id
       AND version.version=current.current_version
     WHERE current.workspace_id=NEW.workspace_id
     FOR SHARE OF current,version;
  ELSE
    SELECT version.version,version.active_run_limit,version.queued_run_limit
      INTO entitlement
      FROM app.workspace_execution_entitlement_versions version
     WHERE version.workspace_id=OLD.workspace_id
       AND version.version=OLD.execution_entitlement_version
     FOR SHARE OF version;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters
   WHERE workspace_id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  -- Re-read the policy after the workspace counter serializes settings writes.
  -- The early guard cannot see a cap committed while this INSERT waits.
  IF TG_OP='INSERT' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
    END IF;
    RAISE EXCEPTION 'capped production runs must enter the durable queue' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.admission_ticket:=nextval('app.workflow_run_admission_ticket_seq');
  END IF;
  SELECT queued_runs,active_runs,reserved_active_slots
    INTO actual_queued,actual_active,reserved_active
    FROM app.workflow_run_slot_counts(NEW.workspace_id,NULL,
      CASE WHEN TG_OP='UPDATE' THEN OLD.id ELSE NULL END);
  next_queued:=actual_queued+CASE WHEN NEW.status='queued' THEN 1 ELSE 0 END;
  next_active:=actual_active+reserved_active;
  IF NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND NEW.timed_wait_started_at IS NULL THEN
    IF NOT EXISTS(SELECT 1 FROM app.workflow_calls call
      WHERE call.workspace_id=NEW.workspace_id AND call.parent_run_id=NEW.id AND call.slot_lent) THEN
      next_active:=next_active+1;
    END IF;
  ELSIF TG_OP='UPDATE' AND NEW.status NOT IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
    WHERE admission.workspace_id=NEW.workspace_id AND admission.workflow_run_id=OLD.id) THEN
    next_active:=next_active+1;
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.execution_entitlement_version:=entitlement.version;
  ELSIF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.execution_entitlement_version IS DISTINCT FROM OLD.execution_entitlement_version THEN
    RAISE EXCEPTION 'workflow run admission identity is immutable' USING ERRCODE='55000';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status='queued') OR
      (TG_OP='UPDATE' AND OLD.status<>'queued' AND NEW.status='queued')) AND
     next_queued>entitlement.queued_run_limit THEN
    RAISE EXCEPTION 'workspace.queued_run_limit_exceeded' USING ERRCODE='PTA02';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status IN ('running','waiting')) OR
      (TG_OP='UPDATE' AND (OLD.status NOT IN ('running','waiting') OR OLD.human_wait_started_at IS NOT NULL OR OLD.timed_wait_started_at IS NOT NULL)
       AND NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND NEW.timed_wait_started_at IS NULL)) AND
     next_active>entitlement.active_run_limit
     AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
       WHERE admission.workspace_id=NEW.workspace_id AND admission.workflow_run_id=NEW.id
         AND admission.borrowed_call_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.human_wait_started_at IS NULL))
     AND NOT EXISTS(SELECT 1 FROM app.workflow_calls loan WHERE loan.workspace_id=NEW.workspace_id AND loan.parent_run_id=NEW.id AND loan.slot_lent) THEN
    RAISE EXCEPTION 'workspace.active_run_limit_exceeded' USING ERRCODE='PTA03';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.status='queued' OR OLD.human_wait_started_at IS NOT NULL) AND NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL
     AND NOT app.workflow_concurrency_admissible(NEW.workspace_id,NEW.id,false) THEN
    RAISE EXCEPTION 'workflow concurrency admission blocked' USING ERRCODE='PTC02';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- The core helper applies workspace standing before returning this capacity-only result.
CREATE OR REPLACE FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE active_limit integer; active_count integer; reserved_count integer;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  -- Protocol rejection precedes the counter, including for old lock-owning workers.
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  SELECT version.active_run_limit INTO active_limit
    FROM app.workspace_execution_admission_counters counter
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=counter.workspace_id
      AND version.version=p_entitlement_version
    WHERE counter.workspace_id=p_workspace_id FOR UPDATE OF counter;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  SELECT active_runs,reserved_active_slots INTO active_count,reserved_count
    FROM app.workflow_run_slot_counts(p_workspace_id,NULL,p_workflow_run_id);
  RETURN (
    EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
      WHERE admission.workspace_id=p_workspace_id AND admission.workflow_run_id=p_workflow_run_id
        AND admission.borrowed_call_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM app.workflow_runs paused WHERE paused.workspace_id=p_workspace_id AND paused.id=p_workflow_run_id AND paused.human_wait_started_at IS NOT NULL))
    OR EXISTS(SELECT 1 FROM app.workflow_calls loan WHERE loan.workspace_id=p_workspace_id AND loan.parent_run_id=p_workflow_run_id AND loan.slot_lent)
    OR active_count+reserved_count<active_limit);
END $$;

CREATE OR REPLACE FUNCTION app.return_workflow_run_slot(
  p_workspace uuid, p_call uuid, p_parent_outbox uuid
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'app'
  SET row_security TO 'on'
AS $$
DECLARE v_parent app.workflow_runs%ROWTYPE; v_call app.workflow_calls%ROWTYPE; v_incoming uuid; v_owner uuid;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace FOR KEY SHARE;
  SELECT * INTO v_call FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=p_call;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_parent FROM app.workflow_runs
    WHERE workspace_id=p_workspace AND id=v_call.parent_run_id FOR NO KEY UPDATE;
  SELECT * INTO v_call FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND id=p_call FOR NO KEY UPDATE;
  IF NOT v_call.slot_lent THEN RETURN false; END IF;
  PERFORM 1 FROM app.outbox_events WHERE workspace_id=p_workspace AND id=p_parent_outbox
    AND aggregate_id=v_call.parent_run_id AND aggregate_type='workflow-run' AND job_name='advance-workflow-run' FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT id INTO v_incoming FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND child_run_id=v_call.parent_run_id AND slot_lent;
  IF v_incoming IS NOT NULL THEN
    PERFORM 1 FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=v_incoming FOR KEY SHARE;
  END IF;
  SELECT workflow_run_id INTO v_owner FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace AND workflow_run_id=v_call.child_run_id AND borrowed_call_id=p_call FOR UPDATE;
  -- A nested borrower still owning the slot must return it one level first.
  IF v_owner IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=v_owner
    AND status IN ('queued','running','waiting')) THEN RETURN false; END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  -- A child that ended while suspended no longer owns a workspace slot.
  -- A live, resumed parent must compete for fresh capacity before its loan ends.
  IF v_parent.status IN ('running','waiting') AND v_parent.human_wait_started_at IS NULL
     AND EXISTS(SELECT 1 FROM app.workflow_runs child WHERE child.workspace_id=p_workspace AND child.id=v_owner AND child.human_wait_started_at IS NOT NULL)
     AND (SELECT active_runs+reserved_active_slots FROM app.workflow_run_slot_counts(p_workspace)) >=
       (SELECT active_run_limit FROM app.workspace_execution_entitlement_versions WHERE workspace_id=p_workspace AND version=v_parent.execution_entitlement_version)
  THEN RETURN false; END IF;
  UPDATE app.workflow_calls SET slot_lent=false WHERE workspace_id=p_workspace AND id=p_call;
  IF v_incoming IS NULL THEN
    DELETE FROM app.workflow_run_active_admissions
      WHERE workspace_id=p_workspace AND workflow_run_id=v_owner AND borrowed_call_id=p_call;
  ELSE
    UPDATE app.workflow_run_active_admissions
      SET workflow_run_id=v_call.parent_run_id,outbox_event_id=p_parent_outbox,borrowed_call_id=v_incoming,
        workflow_concurrency_order_exempt=true,recover_after=clock_timestamp()+interval '5 minutes'
      WHERE workspace_id=p_workspace AND workflow_run_id=v_owner AND borrowed_call_id=p_call;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
    SET active_runs=counts.active_runs,queued_runs=counts.queued_runs,reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(p_workspace) counts WHERE counter.workspace_id=p_workspace;
  RETURN true;
END $$;

DROP TRIGGER workflow_runs_execution_admission ON app.workflow_runs;
CREATE TRIGGER workflow_runs_execution_admission BEFORE INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version,human_wait_started_at ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_workflow_run_admission();
DROP TRIGGER workflow_runs_refresh_execution_admission ON app.workflow_runs;
CREATE TRIGGER workflow_runs_refresh_execution_admission AFTER INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version,human_wait_started_at ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.refresh_workflow_run_admission_counters();

