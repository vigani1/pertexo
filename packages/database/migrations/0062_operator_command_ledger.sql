-- Broaden the durable operator-command ledger before adding more narrow
-- command-specific functions. Tenant-bound request material remains in the
-- normally retained workspace audit stream; the command row keeps only bounded
-- non-sensitive replay/status facts.

ALTER TABLE app.operator_commands
  DROP CONSTRAINT operator_commands_type_valid,
  DROP CONSTRAINT operator_commands_outcome_valid,
  ADD COLUMN result jsonb;

UPDATE app.operator_commands SET result=jsonb_build_object(
  'schemaVersion',1,
  'outcome',outcome,
  'priorErrorCode',prior_error_code,
  'priorFailedAt',prior_failed_at,
  'priorPublishAttempts',prior_publish_attempts
);

CREATE FUNCTION app.populate_operator_command_result()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp AS $$
BEGIN
  IF NEW.result IS NULL AND NEW.command_type='outbox.redispatch' THEN
    NEW.result:=jsonb_build_object(
      'schemaVersion',1,
      'outcome',NEW.outcome,
      'priorErrorCode',NEW.prior_error_code,
      'priorFailedAt',NEW.prior_failed_at,
      'priorPublishAttempts',NEW.prior_publish_attempts
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operator_commands_result_default
  BEFORE INSERT ON app.operator_commands FOR EACH ROW
  EXECUTE FUNCTION app.populate_operator_command_result();
REVOKE ALL ON FUNCTION app.populate_operator_command_result() FROM PUBLIC;

ALTER TABLE app.operator_commands
  ALTER COLUMN result SET NOT NULL,
  ADD CONSTRAINT operator_commands_type_valid CHECK(command_type IN (
    'outbox.redispatch','attempt.reconcile','due-work.resume',
    'unknown-outcome.record-evidence','run.cancel','run.replay',
    'trigger.reconcile','retention.rerun','purge.rerun'
  )),
  ADD CONSTRAINT operator_commands_outcome_valid
    CHECK(outcome~'^[a-z][a-z0-9_]{0,31}$'),
  ADD CONSTRAINT operator_commands_result_valid
    CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=16384);

DROP FUNCTION app.get_operator_command(uuid,uuid,varchar,varchar);
CREATE FUNCTION app.get_operator_command(
  p_command_id uuid,
  p_workspace_id uuid,
  p_actor_ref varchar,
  p_reason varchar
)
RETURNS TABLE(
  command_id uuid,
  command_type varchar,
  dry_run boolean,
  request_fingerprint char(64),
  command_status varchar,
  command_outcome varchar,
  result jsonb,
  created_at timestamptz,
  completed_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_found boolean;
BEGIN
  IF p_actor_ref IS NULL OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' THEN
    RAISE EXCEPTION 'operator actor reference is invalid' USING ERRCODE='22023';
  END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'operator reason is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT EXISTS(
    SELECT 1 FROM app.operator_commands command
    WHERE command.id=p_command_id AND EXISTS(
      SELECT 1 FROM app.audit_events audit
      WHERE audit.workspace_id=p_workspace_id
        AND audit.request_id=p_command_id::text
        AND audit.action LIKE 'operator.%'
        AND audit.action<>'operator.command_status'
        AND NOT (audit.metadata?'replayed')
    )
  ) INTO v_found;
  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.command_status','operator-command',
    p_command_id,gen_random_uuid()::text,jsonb_build_object(
      'actorRef',p_actor_ref,'found',v_found,'reason',p_reason
    )
  );
  RETURN QUERY SELECT command.id,command.command_type,command.dry_run,
    command.request_fingerprint,command.status,command.outcome,command.result,
    command.created_at,command.completed_at
    FROM app.operator_commands command
    WHERE command.id=p_command_id AND v_found;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION app.get_operator_command(uuid,uuid,varchar,varchar)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.get_operator_command(uuid,uuid,varchar,varchar)
  TO {{operator_role}};
