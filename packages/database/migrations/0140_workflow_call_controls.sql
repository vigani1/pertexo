-- ADR065: complete the existing coordinator child-control adapter. No new
-- admission/history authority, rollout change, or retained owner rewrite.
CREATE FUNCTION app.propagate_workflow_call_control(
  p_parent uuid,p_revision integer,p_child uuid,p_reason text,p_delivery jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_parent app.workflow_runs%ROWTYPE;
  v_child app.workflow_runs%ROWTYPE;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE;
BEGIN
  IF v_workspace IS NULL OR p_parent IS NULL OR p_child IS NULL
    OR p_parent=p_child OR p_revision IS NULL OR p_revision NOT BETWEEN 0 AND 2147483646
    OR p_reason IS NULL OR p_reason NOT IN ('cancel_requested','deadline_expired')
    OR (jsonb_typeof(p_delivery)='object'
      AND p_delivery ?& ARRAY['outboxEventId','payloadChecksum']
      AND p_delivery-ARRAY['outboxEventId','payloadChecksum']='{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'workflow Call control context is invalid' USING ERRCODE='22023';
  END IF;
  -- Parent-owned authority only. Child metadata reads below acquire no child
  -- row locks; the canonical wakeup is an intent, not an applied control.
  PERFORM app.prelock_native_coordinator_lineage(p_parent,
    (p_delivery->>'outboxEventId')::uuid,p_delivery->>'payloadChecksum');
  PERFORM app.assert_native_advance_delivery(p_parent,
    (p_delivery->>'outboxEventId')::uuid,p_delivery->>'payloadChecksum');
  IF NOT EXISTS(SELECT 1 FROM app.inbox_receipts receipt WHERE receipt.workspace_id=v_workspace
    AND receipt.consumer_name='workflow-coordinator'
    AND receipt.message_id=(p_delivery->>'outboxEventId')::uuid
    AND receipt.payload_checksum=p_delivery->>'payloadChecksum' AND receipt.completed_at IS NULL) THEN
    RAISE EXCEPTION 'workflow Call control receipt is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_parent FROM app.workflow_runs run
    WHERE run.workspace_id=v_workspace AND run.id=p_parent FOR NO KEY UPDATE;
  IF NOT FOUND OR v_parent.status NOT IN ('running','waiting') THEN
    RAISE EXCEPTION 'workflow Call control parent is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints checkpoint
    WHERE checkpoint.workspace_id=v_workspace AND checkpoint.workflow_run_id=p_parent FOR NO KEY UPDATE;
  IF NOT FOUND OR v_checkpoint.revision<>p_revision
    OR v_checkpoint.workflow_version_id<>v_parent.workflow_version_id
    OR v_checkpoint.scheduler_state->'schemaVersion' IS DISTINCT FROM '3'::jsonb
    OR v_checkpoint.scheduler_state->'revision' IS DISTINCT FROM to_jsonb(p_revision) THEN
    RAISE EXCEPTION 'workflow Call control revision differs' USING ERRCODE='55000';
  END IF;
  IF (p_reason='cancel_requested' AND v_parent.cancel_requested_at IS NULL)
    OR (p_reason='deadline_expired' AND (v_parent.cancel_requested_at IS NOT NULL
      OR v_parent.deadline_at IS NULL OR NOT isfinite(v_parent.deadline_at)
      OR v_parent.deadline_at>clock_timestamp())) THEN
    RAISE EXCEPTION 'workflow Call control is not authoritative' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_call FROM app.workflow_calls call WHERE call.workspace_id=v_workspace
    AND call.parent_run_id=p_parent AND call.parent_workflow_version_id=v_parent.workflow_version_id
    AND call.child_run_id=p_child AND call.outcome_kind='admitted' AND call.sealed;
  IF NOT FOUND OR v_call.detail_retired_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_checkpoint.scheduler_state->'calls') call
      WHERE call->>'invocationKey'=v_call.invocation_key
        AND call->>'declarationAttemptId'=v_call.declaration_attempt_id::text
        AND call#>>'{pin,versionId}'=v_call.callee_workflow_version_id::text
        AND (call->>'status'='awaiting_admission'
          OR (call->>'status'='admitted' AND call->>'childRunId'=p_child::text))) THEN
    RAISE EXCEPTION 'workflow Call control admitted child differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_child FROM app.workflow_runs run
    WHERE run.workspace_id=v_workspace AND run.id=p_child;
  IF NOT FOUND OR v_child.workflow_id<>v_call.callee_workflow_id
    OR v_child.workflow_version_id<>v_call.child_workflow_version_id
    OR v_child.trigger_type<>'workflow_call' OR v_child.deadline_at IS NULL
    OR v_child.deadline_at>v_parent.deadline_at THEN
    RAISE EXCEPTION 'workflow Call control child identity differs' USING ERRCODE='23514';
  END IF;
  -- Read-only canonical derivation rejects a poisoned sealed edge/root/depth.
  -- This helper takes no child locks and confers no new mutation authority.
  PERFORM app.native_call_lineage(p_child);
  IF v_child.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
    OR v_child.cancel_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('kind','unchanged');
  END IF;
  IF p_reason='deadline_expired' THEN
    -- Immutable inherited deadlines already stop the child. Wake its normal
    -- coordinator without inventing a cancellation or rewriting its deadline.
    RETURN jsonb_build_object('kind','wake');
  END IF;
  RETURN jsonb_build_object('kind','requested');
END $$;
ALTER FUNCTION app.propagate_workflow_call_control(uuid,integer,uuid,text,jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.propagate_workflow_call_control(uuid,integer,uuid,text,jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.propagate_workflow_call_control(uuid,integer,uuid,text,jsonb) TO {{worker_runtime_role}};

-- Apply inherited cancellation ONLY to the actual advancing run, before its
-- read snapshot. The caller appends the own-run audit on this same client;
-- neither this function nor that preliminary transaction completes a receipt.
CREATE FUNCTION app.apply_workflow_call_control(p_child uuid,p_delivery jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_child app.workflow_runs%ROWTYPE;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_path uuid[];
  v_index integer;
  v_ancestor app.workflow_runs%ROWTYPE;
  v_cancel_parent uuid;
  v_deadline timestamptz;
  v_actor text;
BEGIN
  IF v_workspace IS NULL OR p_child IS NULL OR
    (jsonb_typeof(p_delivery)='object'
      AND p_delivery ?& ARRAY['outboxEventId','payloadChecksum']
      AND p_delivery-ARRAY['outboxEventId','payloadChecksum']='{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'workflow Call apply context is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM app.prelock_native_coordinator_lineage(p_child,
    (p_delivery->>'outboxEventId')::uuid,p_delivery->>'payloadChecksum');
  v_path:=app.native_call_lineage(p_child);
  SELECT * INTO v_child FROM app.workflow_runs run
    WHERE run.workspace_id=v_workspace AND run.id=p_child FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow Call apply child is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints checkpoint
    WHERE checkpoint.workspace_id=v_workspace AND checkpoint.workflow_run_id=p_child FOR NO KEY UPDATE;
  IF NOT FOUND OR (v_checkpoint.workflow_version_id=v_child.workflow_version_id
    AND v_checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
    AND v_checkpoint.scheduler_state->>'workflowVersionId'=v_child.workflow_version_id::text
    AND v_checkpoint.scheduler_state->'revision'=to_jsonb(v_checkpoint.revision)
    AND v_checkpoint.scheduler_state->>'runStatus'=v_child.status
    AND EXISTS(SELECT 1 FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
      AND version.id=v_child.workflow_version_id AND version.workflow_id=v_child.workflow_id
      AND version.schema_version=2 AND version.executable_schema_version=3)) IS NOT TRUE
    OR app.native_call_lineage(p_child) IS DISTINCT FROM v_path THEN
    RAISE EXCEPTION 'workflow Call apply source differs' USING ERRCODE='23514';
  END IF;
  PERFORM app.assert_native_advance_delivery(p_child,
    (p_delivery->>'outboxEventId')::uuid,p_delivery->>'payloadChecksum');
  IF v_child.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
    OR v_child.cancel_requested_at IS NOT NULL OR array_length(v_path,1)=1 THEN
    RETURN jsonb_build_object('kind','unchanged');
  END IF;
  IF v_child.trigger_type<>'workflow_call' OR v_child.deadline_at IS NULL
    OR NOT isfinite(v_child.deadline_at) THEN
    RAISE EXCEPTION 'workflow Call apply child identity differs' USING ERRCODE='23514';
  END IF;
  v_deadline:=v_child.deadline_at;
  -- native_call_lineage is child→root; prefer the nearest authoritative
  -- cancellation, deterministically, and recheck every already-fenced ancestor.
  FOR v_index IN 2..array_length(v_path,1) LOOP
    SELECT * INTO v_ancestor FROM app.workflow_runs run
      WHERE run.workspace_id=v_workspace AND run.id=v_path[v_index];
    IF NOT FOUND OR v_ancestor.deadline_at IS NULL OR NOT isfinite(v_ancestor.deadline_at)
      OR v_child.deadline_at>v_ancestor.deadline_at THEN
      RAISE EXCEPTION 'workflow Call apply ancestor differs' USING ERRCODE='23514';
    END IF;
    IF v_cancel_parent IS NULL AND v_ancestor.cancel_requested_at IS NOT NULL THEN
      v_cancel_parent:=v_ancestor.id;
    END IF;
    v_deadline:=least(v_deadline,v_ancestor.deadline_at);
  END LOOP;
  IF v_cancel_parent IS NULL THEN
    RETURN jsonb_build_object('kind',CASE WHEN v_deadline<=clock_timestamp() THEN 'wake' ELSE 'unchanged' END);
  END IF;
  v_actor:='workflow-call:'||v_cancel_parent::text;
  UPDATE app.workflow_runs SET cancel_requested_at=clock_timestamp(),
    cancel_requested_by=v_actor,cancel_reason='parent cancellation',updated_at=clock_timestamp()
    WHERE workspace_id=v_workspace AND id=p_child;
  RETURN jsonb_build_object('kind','requested','actor',v_actor,'reason','parent cancellation');
END $$;
ALTER FUNCTION app.apply_workflow_call_control(uuid,jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.apply_workflow_call_control(uuid,jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.apply_workflow_call_control(uuid,jsonb) TO {{worker_runtime_role}};
