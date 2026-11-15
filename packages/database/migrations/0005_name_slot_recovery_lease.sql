-- The slot protocol's recovery lease, five minutes, had one literal per use:
-- nine across five functions. It now has one definition, an immutable
-- function every use reads; each function below is the same body with the
-- literal replaced, so every reservation expires when it did before.
CREATE FUNCTION app.workflow_run_slot_recovery_lease() RETURNS interval
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'app'
    AS $$ SELECT interval '5 minutes' $$;
ALTER FUNCTION app.workflow_run_slot_recovery_lease() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workflow_run_slot_recovery_lease() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  UPDATE app.workflow_run_active_admissions
     SET recover_after=clock_timestamp()+app.workflow_run_slot_recovery_lease()
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION app.lend_workflow_run_slot(p_workspace uuid, p_call uuid, p_child uuid, p_outbox uuid) RETURNS boolean
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
    VALUES(p_workspace,p_child,p_outbox,p_call,true,clock_timestamp()+app.workflow_run_slot_recovery_lease());
  ELSE
    UPDATE app.workflow_run_active_admissions
      SET workflow_run_id=p_child,outbox_event_id=p_outbox,borrowed_call_id=p_call,
        workflow_concurrency_order_exempt=true,recover_after=clock_timestamp()+app.workflow_run_slot_recovery_lease()
      WHERE workspace_id=p_workspace AND workflow_run_id=v_call.parent_run_id;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
    SET active_runs=counts.active_runs,queued_runs=counts.queued_runs,reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(p_workspace) counts WHERE counter.workspace_id=p_workspace;
  RETURN true;
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
  UPDATE app.workflow_run_active_admissions SET outbox_event_id=p_new_outbox_event_id,recover_after=CASE WHEN borrowed_call_id IS NULL THEN NULL ELSE clock_timestamp()+app.workflow_run_slot_recovery_lease() END
    WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
      AND outbox_event_id=p_old_outbox_event_id;
  RETURN FOUND;
END $$;

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
          SET recover_after=clock_timestamp()+app.workflow_run_slot_recovery_lease()
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
        SET recover_after=clock_timestamp()+app.workflow_run_slot_recovery_lease(),recovery_count=recovery_count+1
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
           recover_after=CASE WHEN borrowed_call_id IS NULL THEN NULL ELSE clock_timestamp()+app.workflow_run_slot_recovery_lease() END,
             recovery_count=recovery_count+1
       WHERE workflow_run_id=admission.workflow_run_id;
      recovered:=recovered+1;
    ELSIF admission.borrowed_call_id IS NOT NULL THEN
      -- The dispatcher still owns this unpublished hint; retain the slot and
      -- move the poll behind other due return obligations.
      UPDATE app.workflow_run_active_admissions
        SET recover_after=clock_timestamp()+app.workflow_run_slot_recovery_lease()
        WHERE workspace_id=admission.workspace_id AND workflow_run_id=admission.workflow_run_id;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN recovered;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.return_workflow_run_slot(p_workspace uuid, p_call uuid, p_parent_outbox uuid) RETURNS boolean
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
        workflow_concurrency_order_exempt=true,recover_after=clock_timestamp()+app.workflow_run_slot_recovery_lease()
      WHERE workspace_id=p_workspace AND workflow_run_id=v_owner AND borrowed_call_id=p_call;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
    SET active_runs=counts.active_runs,queued_runs=counts.queued_runs,reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(p_workspace) counts WHERE counter.workspace_id=p_workspace;
  RETURN true;
END $$;
