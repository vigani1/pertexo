-- A reclaimed attempt is immediately deliverable again. Keep its owning node
-- in the matching ready state in the same operator-command transaction.
CREATE OR REPLACE FUNCTION app.reconcile_operator_attempt(
  p_command_id uuid,p_workspace_id uuid,p_attempt_id uuid,p_expected_fence bigint,
  p_action varchar,p_actor_ref varchar,p_reason varchar,p_dry_run boolean
) RETURNS TABLE(command_id uuid,command_status varchar,command_outcome varchar,
  replayed boolean,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_command record;
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_updated integer;
BEGIN
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);

  SELECT * INTO v_command
  FROM app.execute_operator_execution_command(
    p_command_id,'attempt.reconcile',p_workspace_id,p_attempt_id,
    p_expected_fence,p_action,NULL,NULL,p_actor_ref,p_reason,p_dry_run
  );

  IF v_command.command_outcome='reclaimed' AND NOT v_command.replayed THEN
    UPDATE app.node_runs node
       SET status='ready',updated_at=clock_timestamp()
      FROM app.node_attempts attempt
     WHERE attempt.workspace_id=p_workspace_id
       AND attempt.id=p_attempt_id
       AND attempt.status='ready'
       AND node.workspace_id=attempt.workspace_id
       AND node.id=attempt.node_run_id
       AND node.current_attempt_id=attempt.id
       AND node.status='running';
    GET DIAGNOSTICS v_updated=ROW_COUNT;
    IF v_updated<>1 THEN
      RAISE EXCEPTION 'reclaimed attempt owning node state is invalid'
        USING ERRCODE='P0001';
    END IF;
  END IF;

  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT v_command.command_id,v_command.command_status,
    v_command.command_outcome,v_command.replayed,v_command.result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

ALTER FUNCTION app.reconcile_operator_attempt(
  uuid,uuid,uuid,bigint,varchar,varchar,varchar,boolean
) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.reconcile_operator_attempt(
  uuid,uuid,uuid,bigint,varchar,varchar,varchar,boolean
) FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.reconcile_operator_attempt(
  uuid,uuid,uuid,bigint,varchar,varchar,varchar,boolean
) TO {{operator_role}};
