-- Preserve the registered native attempt authority while avoiding concurrent
-- current-run SHARE-to-UPDATE upgrades. Ancestors precede the existing exact
-- receipt/current-run/node/attempt lock order used by claim and Call completion.
CREATE OR REPLACE FUNCTION app.lock_native_attempt_value_owner(p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.native_attempt_value_owner(p_authority);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_path uuid[];
  v_index integer;
BEGIN
  IF app.lock_workspace_run_admission(v_workspace) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'native attempt workspace is not active' USING ERRCODE='55000';
  END IF;
  v_path:=app.native_call_lineage((v_scope->>'runId')::uuid);
  FOR v_index IN REVERSE cardinality(v_path)..2 LOOP
    PERFORM 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
      AND run.id=v_path[v_index] FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'native attempt ancestor is missing' USING ERRCODE='55000'; END IF;
  END LOOP;
  PERFORM 1 FROM app.inbox_receipts receipt WHERE receipt.workspace_id=v_workspace
    AND receipt.consumer_name='node-attempt-worker'
    AND receipt.message_id=(p_authority#>>'{delivery,outboxEventId}')::uuid FOR UPDATE;
  PERFORM 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
    AND run.id=(v_scope->>'runId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'native attempt current run is missing' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.node_runs node WHERE node.workspace_id=v_workspace
    AND node.id=(v_scope->>'nodeRunId')::uuid FOR UPDATE;
  PERFORM 1 FROM app.node_attempts attempt WHERE attempt.workspace_id=v_workspace
    AND attempt.id=(v_scope->>'attemptId')::uuid FOR UPDATE;
  IF app.native_call_lineage((v_scope->>'runId')::uuid) IS DISTINCT FROM v_path THEN
    RAISE EXCEPTION 'native attempt locked lineage changed' USING ERRCODE='55000';
  END IF;
  -- Recheck canonical delivery, receipt, current lease/fence/version and clocks
  -- AFTER all ancestor-first locks, not from the preliminary read projection.
  RETURN app.native_attempt_value_owner(p_authority);
END $$;
