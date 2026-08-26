-- ADR 013 legal-hold command coordination. This migration grants no destructive
-- authority and no direct control-table access to maintenance.

CREATE FUNCTION app.lock_workspace_control_ledger(p_workspace_id uuid)
RETURNS TABLE(retention_control_sequence bigint, retention_control_hash char(64))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace id is required' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
    SELECT workspace.retention_control_sequence, workspace.retention_control_hash
    FROM app.workspaces workspace
    WHERE workspace.id=p_workspace_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace does not exist' USING ERRCODE='23503';
  END IF;
END $$;

CREATE FUNCTION app.read_workspace_control_command(
  p_workspace_id uuid, p_command_id uuid
) RETURNS TABLE(
  sequence bigint, command_id uuid, command_type varchar, subject_id uuid,
  previous_hash char(64), record_hash char(64), actor_ref varchar,
  legal_authority varchar, reason varchar, occurred_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_command_id IS NULL THEN
    RAISE EXCEPTION 'workspace id and command id are required' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
    SELECT record.sequence,record.command_id,record.command_type,record.subject_id,
      record.previous_hash,record.record_hash,record.actor_ref,
      record.legal_authority,record.reason,record.occurred_at
    FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=p_workspace_id AND record.command_id=p_command_id;
END $$;

CREATE FUNCTION app.validate_workspace_legal_hold_command(
  p_workspace_id uuid, p_command_type varchar, p_hold_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_released_sequence bigint;
BEGIN
  IF p_workspace_id IS NULL OR p_command_type IS NULL OR p_hold_id IS NULL
    OR p_command_type NOT IN ('legal_hold_placed','legal_hold_released') THEN
    RAISE EXCEPTION 'invalid legal hold command' USING ERRCODE='22023';
  END IF;

  SELECT hold.released_sequence INTO v_released_sequence
  FROM app.workspace_legal_holds hold
  WHERE hold.workspace_id=p_workspace_id AND hold.hold_id=p_hold_id;
  IF p_command_type='legal_hold_placed' AND FOUND THEN
    RAISE EXCEPTION 'legal hold already exists' USING ERRCODE='23505';
  ELSIF p_command_type='legal_hold_released'
    AND (NOT FOUND OR v_released_sequence IS NOT NULL) THEN
    RAISE EXCEPTION 'legal hold is absent or already released' USING ERRCODE='55000';
  END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION app.lock_workspace_control_ledger(uuid),
  app.read_workspace_control_command(uuid,uuid),
  app.validate_workspace_legal_hold_command(uuid,varchar,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_workspace_control_ledger(uuid),
  app.read_workspace_control_command(uuid,uuid),
  app.validate_workspace_legal_hold_command(uuid,varchar,uuid) TO {{maintenance_role}};
