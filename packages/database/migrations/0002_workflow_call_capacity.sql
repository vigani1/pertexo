-- One occupancy rule serves admission, counters and public capacity reads.
-- VOLATILE sees writes made by admission triggers; public reads already hold
-- the existing repeatable-read transaction snapshot.
CREATE FUNCTION app.workflow_run_slot_counts(
  p_workspace uuid, p_workflow uuid DEFAULT NULL, p_excluded_run uuid DEFAULT NULL
) RETURNS TABLE(active_runs integer, reserved_active_slots integer, queued_runs integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'app'
  SET row_security TO 'on'
AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace AND run.status IN ('running','waiting')
        AND (p_workflow IS NULL OR run.workflow_id=p_workflow)
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run)
        AND (p_workflow IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=p_workspace
            AND call.parent_run_id=run.id AND call.slot_lent))),
    (SELECT count(*)::integer FROM app.workflow_run_active_admissions admission
      JOIN app.workflow_runs run
        ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
      WHERE admission.workspace_id=p_workspace AND run.status NOT IN ('running','waiting')
        AND (p_workflow IS NULL OR (run.workflow_id=p_workflow AND run.status='queued'))
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run)),
    (SELECT count(*)::integer FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace AND run.status='queued'
        AND (p_workflow IS NULL OR run.workflow_id=p_workflow)
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run));
END $$;
REVOKE ALL ON FUNCTION app.workflow_run_slot_counts(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workflow_run_slot_counts(uuid,uuid,uuid)
  TO {{app_role}}, {{maintenance_role}};


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
  workspace_status text;
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
     AND (OLD.cancel_requested_at IS NOT NULL OR OLD.deadline_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'terminal control cannot start work' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL)
     AND current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  SELECT status INTO workspace_status FROM app.workspaces
   WHERE id=NEW.workspace_id FOR SHARE;
  IF TG_OP='INSERT' THEN
    SELECT version.version,version.status,version.active_run_limit,
           version.queued_run_limit,version.effective_at,version.expires_at
      INTO entitlement
      FROM app.workspace_execution_entitlements current
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=current.workspace_id
       AND version.version=current.current_version
     WHERE current.workspace_id=NEW.workspace_id
     FOR SHARE OF current,version;
  ELSE
    SELECT version.version,version.status,version.active_run_limit,
           version.queued_run_limit,version.effective_at,version.expires_at
      INTO entitlement
      FROM app.workspace_execution_entitlement_versions version
     WHERE version.workspace_id=OLD.workspace_id
       AND version.version=OLD.execution_entitlement_version
     FOR SHARE OF version;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  IF TG_OP='INSERT' AND (
       entitlement.status<>'active'
       OR entitlement.effective_at>clock_timestamp()
       OR (entitlement.expires_at IS NOT NULL AND entitlement.expires_at<=clock_timestamp())
       OR workspace_status IS DISTINCT FROM 'active'
     ) THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued'
     AND NEW.status IN ('running','waiting')
     AND workspace_status IS DISTINCT FROM 'active' THEN
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
  IF NEW.status IN ('running','waiting') THEN
    IF NOT EXISTS(SELECT 1 FROM app.workflow_calls call
      WHERE call.workspace_id=NEW.workspace_id AND call.parent_run_id=NEW.id AND call.slot_lent) THEN
      next_active:=next_active+1;
    END IF;
  ELSIF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
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
      (TG_OP='UPDATE' AND OLD.status NOT IN ('running','waiting')
       AND NEW.status IN ('running','waiting'))) AND
     next_active>entitlement.active_run_limit
     AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
       WHERE admission.workspace_id=NEW.workspace_id AND admission.workflow_run_id=NEW.id
         AND admission.borrowed_call_id IS NOT NULL) THEN
    RAISE EXCEPTION 'workspace.active_run_limit_exceeded' USING ERRCODE='PTA03';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND NOT app.workflow_concurrency_admissible(NEW.workspace_id,NEW.id,false) THEN
    RAISE EXCEPTION 'workflow concurrency admission blocked' USING ERRCODE='PTC02';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.refresh_workflow_run_admission_counters() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NEW.status<>'queued' THEN
    DELETE FROM app.workflow_run_active_admissions
     WHERE workspace_id=NEW.workspace_id AND workflow_run_id=NEW.id AND borrowed_call_id IS NULL;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
     SET queued_runs=counts.queued_runs, active_runs=counts.active_runs,
         reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(NEW.workspace_id) counts
   WHERE counter.workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id AND borrowed_call_id IS NULL;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION app.release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id AND borrowed_call_id IS NULL;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION app.workflow_concurrency_admissible(p_workspace uuid, p_run uuid, p_grant boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_limit integer; v_reserved boolean; v_exempt boolean;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_run;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_run.status<>'queued' THEN RETURN true; END IF;
  SELECT active_run_limit INTO v_limit FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=v_run.workflow_id;
  IF v_limit IS NULL THEN RETURN true; END IF;
  IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    IF p_grant THEN RETURN false; END IF;
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  SELECT true,workflow_concurrency_order_exempt INTO v_reserved,v_exempt
    FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace AND workflow_run_id=p_run;
  -- A committed slot survives lowering/enabling; an order-exempt slot predates
  -- ordered grants. Controls cannot use this predicate to start node work.
  IF v_reserved AND (p_grant OR v_exempt) THEN RETURN true; END IF;
  IF NOT coalesce(v_reserved,false) AND
    (SELECT active_runs+reserved_active_slots
      FROM app.workflow_run_slot_counts(p_workspace,v_run.workflow_id))>=v_limit THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS(SELECT 1 FROM app.workflow_runs earlier
    WHERE earlier.workspace_id=p_workspace AND earlier.workflow_id=v_run.workflow_id
      AND earlier.status='queued' AND earlier.admission_ticket<v_run.admission_ticket
      AND earlier.cancel_requested_at IS NULL AND (earlier.deadline_at IS NULL OR earlier.deadline_at>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
        WHERE admission.workspace_id=p_workspace AND admission.workflow_run_id=earlier.id
          AND (p_grant OR admission.workflow_concurrency_order_exempt)));
END $$;

CREATE OR REPLACE FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_prior text; v_status text; v_limit integer; v_result boolean:=false;
BEGIN
  v_prior:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.* INTO v_run FROM app.workflow_runs run JOIN app.outbox_events event
    ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
      AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id AND event.job_name='advance-workflow-run'
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF FOUND THEN
    IF v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at<=clock_timestamp() THEN
      v_result:=true;
    ELSE
      SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace_id;
      SELECT active_run_limit INTO v_limit FROM app.workspace_execution_entitlement_versions
        WHERE workspace_id=p_workspace_id AND version=v_run.execution_entitlement_version;
      v_result:=v_status='active' AND app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,true)
        AND (EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id
          AND workflow_run_id=p_workflow_run_id AND outbox_event_id=p_outbox_event_id)
        OR (NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id)
          AND (SELECT active_runs+reserved_active_slots
            FROM app.workflow_run_slot_counts(p_workspace_id))<v_limit));
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN coalesce(v_result,false);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE active_limit integer; active_count integer; reserved_count integer; workspace_status text;
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
  SELECT status INTO workspace_status FROM app.workspaces WHERE id=p_workspace_id;
  RETURN workspace_status='active' AND (
    EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
      WHERE admission.workspace_id=p_workspace_id AND admission.workflow_run_id=p_workflow_run_id
        AND admission.borrowed_call_id IS NOT NULL)
    OR active_count+reserved_count<active_limit);
END $$;

-- Call actions take authority/pin/policy locks in TypeScript before these
-- existing-slot transfers. Capacity has no input, publication or user proofs.
CREATE FUNCTION app.lend_workflow_run_slot(
  p_workspace uuid, p_call uuid, p_child uuid, p_outbox uuid
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'app'
  SET row_security TO 'on'
AS $$
DECLARE v_call app.workflow_calls%ROWTYPE; v_parent_status text; v_admission app.workflow_run_active_admissions%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace FOR KEY SHARE;
  SELECT * INTO v_call FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=p_call;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT status INTO v_parent_status FROM app.workflow_runs
    WHERE workspace_id=p_workspace AND id=v_call.parent_run_id FOR NO KEY UPDATE;
  IF v_parent_status NOT IN ('running','waiting') OR v_parent_status IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_call FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND id=p_call FOR NO KEY UPDATE;
  IF v_call.slot_lent THEN
    RETURN EXISTS(SELECT 1 FROM app.workflow_run_active_admissions
      WHERE workspace_id=p_workspace AND workflow_run_id=p_child AND borrowed_call_id=p_call);
  END IF;
  IF EXISTS(SELECT 1 FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND parent_run_id=v_call.parent_run_id AND slot_lent) THEN RETURN false; END IF;
  PERFORM 1 FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_child AND status='queued' FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM app.outbox_events WHERE workspace_id=p_workspace AND id=p_outbox
    AND aggregate_id=p_child AND aggregate_type='workflow-run' AND job_name='advance-workflow-run' FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_admission FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace AND workflow_run_id=v_call.parent_run_id FOR UPDATE;
  PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  IF NOT app.workflow_concurrency_admissible(p_workspace,p_child,true) THEN RETURN false; END IF;
  UPDATE app.workflow_calls SET slot_lent=true WHERE workspace_id=p_workspace AND id=p_call;
  IF v_admission.workflow_run_id IS NULL THEN
    INSERT INTO app.workflow_run_active_admissions
      (workspace_id,workflow_run_id,outbox_event_id,borrowed_call_id,workflow_concurrency_order_exempt,recover_after)
    VALUES(p_workspace,p_child,p_outbox,p_call,true,clock_timestamp()+interval '5 minutes');
  ELSE
    UPDATE app.workflow_run_active_admissions
      SET workflow_run_id=p_child,outbox_event_id=p_outbox,borrowed_call_id=p_call,
        workflow_concurrency_order_exempt=true,recover_after=clock_timestamp()+interval '5 minutes'
      WHERE workspace_id=p_workspace AND workflow_run_id=v_call.parent_run_id;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
    SET active_runs=counts.active_runs,queued_runs=counts.queued_runs,reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(p_workspace) counts WHERE counter.workspace_id=p_workspace;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.lend_workflow_run_slot(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lend_workflow_run_slot(uuid,uuid,uuid,uuid) TO {{maintenance_role}};

-- A return never locks the existing child run or competes for a fresh slot.
CREATE FUNCTION app.return_workflow_run_slot(
  p_workspace uuid, p_call uuid, p_parent_outbox uuid
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'app'
  SET row_security TO 'on'
AS $$
DECLARE v_call app.workflow_calls%ROWTYPE; v_incoming uuid; v_owner uuid;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace FOR KEY SHARE;
  SELECT * INTO v_call FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=p_call;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM app.workflow_runs
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
REVOKE ALL ON FUNCTION app.return_workflow_run_slot(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.return_workflow_run_slot(uuid,uuid,uuid) TO {{maintenance_role}};


CREATE OR REPLACE FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  admission record;
  canonical_payload text;
  new_outbox_event_id uuid;
  new_payload jsonb;
  old_payload jsonb;
  prior_workspace text;
  recovered integer:=0;
  owner_status text;
  return_parent uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid active admission recovery limit' USING ERRCODE='22023';
  END IF;
  prior_workspace:=current_setting('app.workspace_id',true);
  FOR admission IN
    SELECT active.workspace_id,active.workflow_run_id,active.outbox_event_id,active.borrowed_call_id
      FROM app.workflow_run_active_admissions active
     WHERE active.recover_after<=clock_timestamp()
     ORDER BY active.recover_after,active.outbox_event_id
     FOR UPDATE OF active SKIP LOCKED LIMIT p_limit
  LOOP
    PERFORM set_config('app.workspace_id',admission.workspace_id::text,true);
    SELECT status INTO owner_status FROM app.workflow_runs
      WHERE workspace_id=admission.workspace_id AND id=admission.workflow_run_id;
    IF owner_status IS NULL THEN CONTINUE; END IF;
    IF owner_status<>'queued' THEN
      IF admission.borrowed_call_id IS NULL THEN CONTINUE; END IF;
      IF owner_status IN ('running','waiting') THEN
        -- A bounded recovery batch must progress past live borrowers.
        UPDATE app.workflow_run_active_admissions
          SET recover_after=clock_timestamp()+interval '5 minutes'
          WHERE workspace_id=admission.workspace_id AND workflow_run_id=admission.workflow_run_id;
        CONTINUE;
      END IF;
      SELECT parent_run_id INTO return_parent FROM app.workflow_calls
        WHERE workspace_id=admission.workspace_id AND id=admission.borrowed_call_id
          AND child_run_id=admission.workflow_run_id AND slot_lent;
      IF return_parent IS NULL THEN CONTINUE; END IF;
      new_outbox_event_id:=gen_random_uuid();
      new_payload:=jsonb_build_object('workspaceId',admission.workspace_id,
        'runId',return_parent,'outboxEventId',new_outbox_event_id);
      canonical_payload:='{"outboxEventId":"'||new_outbox_event_id::text||
        '","runId":"'||return_parent::text||'","workspaceId":"'||admission.workspace_id::text||'"}';
      INSERT INTO app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,last_error_code)
        VALUES(new_outbox_event_id,admission.workspace_id,'advance-workflow-run','workflow-run',return_parent,new_payload,
          encode(sha256(convert_to(canonical_payload,'UTF8')),'hex'),'publish.delivery_recovery');
      UPDATE app.workflow_run_active_admissions
        SET recover_after=clock_timestamp()+interval '5 minutes',recovery_count=recovery_count+1
        WHERE workspace_id=admission.workspace_id AND workflow_run_id=admission.workflow_run_id;
      recovered:=recovered+1;
      CONTINUE;
    END IF;
    SELECT payload INTO old_payload FROM app.outbox_events
     WHERE workspace_id=admission.workspace_id
       AND id=admission.outbox_event_id
       AND ((published_at IS NOT NULL AND failed_at IS NULL)
         OR (admission.borrowed_call_id IS NOT NULL AND failed_at IS NOT NULL));
    IF FOUND THEN
      new_outbox_event_id:=gen_random_uuid();
      new_payload:=old_payload||jsonb_build_object('outboxEventId',new_outbox_event_id);
      canonical_payload:='{"outboxEventId":"'||new_outbox_event_id::text||
        '","runId":"'||admission.workflow_run_id::text||
        '"'||
        CASE WHEN old_payload?'traceparent'
          THEN ',"traceparent":'||to_jsonb(old_payload->>'traceparent')::text
          ELSE '' END||
        ',"workspaceId":"'||admission.workspace_id::text||'"}';
      INSERT INTO app.outbox_events(
        id,workspace_id,job_name,aggregate_type,aggregate_id,
        payload,payload_checksum,available_at,last_error_code
      ) VALUES(
        new_outbox_event_id,admission.workspace_id,'advance-workflow-run',
        'workflow-run',admission.workflow_run_id,new_payload,
        encode(sha256(convert_to(canonical_payload,'UTF8')),'hex'),
        clock_timestamp(),'publish.delivery_recovery'
      );
      UPDATE app.workflow_run_active_admissions
         SET outbox_event_id=new_outbox_event_id,
           recover_after=CASE WHEN borrowed_call_id IS NULL THEN NULL ELSE clock_timestamp()+interval '5 minutes' END,
             recovery_count=recovery_count+1
       WHERE workflow_run_id=admission.workflow_run_id;
      recovered:=recovered+1;
    ELSIF admission.borrowed_call_id IS NOT NULL THEN
      -- The dispatcher still owns this unpublished hint; retain the slot and
      -- move the poll behind other due return obligations.
      UPDATE app.workflow_run_active_admissions
        SET recover_after=clock_timestamp()+interval '5 minutes'
        WHERE workspace_id=admission.workspace_id AND workflow_run_id=admission.workflow_run_id;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN recovered;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;


CREATE OR REPLACE FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  IF p_old_outbox_event_id=p_new_outbox_event_id THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workflow_runs run
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id AND run.status='queued')
    OR NOT EXISTS(SELECT 1 FROM app.outbox_events old_event,app.outbox_events new_event
      WHERE old_event.workspace_id=p_workspace_id AND old_event.id=p_old_outbox_event_id
        AND new_event.workspace_id=p_workspace_id AND new_event.id=p_new_outbox_event_id
        AND old_event.aggregate_id=p_workflow_run_id AND new_event.aggregate_id=p_workflow_run_id
        AND old_event.aggregate_type='workflow-run' AND new_event.aggregate_type='workflow-run'
        AND old_event.job_name='advance-workflow-run' AND new_event.job_name='advance-workflow-run'

        AND old_event.payload->>'workspaceId'=p_workspace_id::text
        AND new_event.payload->>'workspaceId'=p_workspace_id::text
        AND old_event.payload->>'runId'=p_workflow_run_id::text
        AND new_event.payload->>'runId'=p_workflow_run_id::text
        AND old_event.payload->>'outboxEventId'=p_old_outbox_event_id::text
        AND new_event.payload->>'outboxEventId'=p_new_outbox_event_id::text
        AND new_event.published_at IS NULL AND new_event.failed_at IS NULL) THEN RETURN false;
  END IF;
  UPDATE app.workflow_run_active_admissions SET outbox_event_id=p_new_outbox_event_id,recover_after=CASE WHEN borrowed_call_id IS NULL THEN NULL ELSE clock_timestamp()+interval '5 minutes' END
    WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
      AND outbox_event_id=p_old_outbox_event_id;
  RETURN FOUND;
END $$;
