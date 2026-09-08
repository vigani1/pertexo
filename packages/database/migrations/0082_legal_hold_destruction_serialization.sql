-- Serialize legal-hold projection with external destructive work. Runtime
-- coordinators hold the matching session advisory lock from destructive claim
-- through physical I/O and checkpoint; direct projection calls take the lock
-- before the workspace row to preserve a single lock order.

CREATE OR REPLACE FUNCTION app.project_workspace_legal_hold(
  p_workspace_id uuid, p_sequence bigint, p_command_id uuid, p_command_type varchar,
  p_hold_id uuid, p_previous_hash char(64), p_record_hash char(64),
  p_actor_ref varchar, p_legal_authority varchar, p_reason varchar, p_occurred_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace app.workspaces%ROWTYPE;
  v_existing app.workspace_control_ledger_projection%ROWTYPE;
  v_hold app.workspace_legal_holds%ROWTYPE;
  v_actor_ref varchar(128);
  v_legal_authority varchar(256);
  v_reason varchar(512);
BEGIN
  IF p_workspace_id IS NULL OR p_sequence IS NULL OR p_sequence < 1
    OR p_command_id IS NULL OR p_hold_id IS NULL
    OR p_command_type IS NULL OR p_previous_hash IS NULL OR p_record_hash IS NULL
    OR p_actor_ref IS NULL OR p_legal_authority IS NULL OR p_reason IS NULL
    OR p_command_type NOT IN ('legal_hold_placed','legal_hold_released')
    OR p_previous_hash !~ '^[0-9a-f]{64}$' OR p_record_hash !~ '^[0-9a-f]{64}$'
    OR p_previous_hash = p_record_hash OR length(btrim(p_actor_ref)) NOT BETWEEN 1 AND 128
    OR length(btrim(p_legal_authority)) NOT BETWEEN 1 AND 256
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 512
    OR p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'invalid retention control record' USING ERRCODE='22023';
  END IF;
  v_actor_ref := btrim(p_actor_ref);
  v_legal_authority := btrim(p_legal_authority);
  v_reason := btrim(p_reason);

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text,1934781127));
  SELECT * INTO STRICT v_workspace FROM app.workspaces WHERE id=p_workspace_id FOR UPDATE;
  SELECT * INTO v_existing FROM app.workspace_control_ledger_projection
    WHERE workspace_id=p_workspace_id AND command_id=p_command_id;
  IF FOUND THEN
    IF v_existing.sequence=p_sequence AND v_existing.command_type=p_command_type
      AND v_existing.subject_id=p_hold_id AND v_existing.previous_hash=p_previous_hash
      AND v_existing.record_hash=p_record_hash AND v_existing.actor_ref=v_actor_ref
      AND v_existing.legal_authority=v_legal_authority AND v_existing.reason=v_reason
      AND v_existing.occurred_at=p_occurred_at THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'retention control command replay conflicts with projection' USING ERRCODE='23505';
  END IF;
  IF p_sequence <> v_workspace.retention_control_sequence + 1 THEN
    RAISE EXCEPTION 'retention control sequence mismatch' USING ERRCODE='40001';
  END IF;
  IF p_previous_hash <> v_workspace.retention_control_hash THEN
    RAISE EXCEPTION 'retention control previous hash mismatch' USING ERRCODE='40001';
  END IF;

  SELECT * INTO v_hold FROM app.workspace_legal_holds
    WHERE workspace_id=p_workspace_id AND hold_id=p_hold_id;
  IF p_command_type='legal_hold_placed' AND FOUND THEN
    RAISE EXCEPTION 'legal hold already exists' USING ERRCODE='23505';
  ELSIF p_command_type='legal_hold_released' AND (NOT FOUND OR v_hold.released_sequence IS NOT NULL) THEN
    RAISE EXCEPTION 'legal hold is absent or already released' USING ERRCODE='55000';
  END IF;

  INSERT INTO app.workspace_control_ledger_projection
    (workspace_id,sequence,command_id,command_type,subject_id,previous_hash,record_hash,
     actor_ref,legal_authority,reason,occurred_at)
  VALUES (p_workspace_id,p_sequence,p_command_id,p_command_type,p_hold_id,p_previous_hash,p_record_hash,
    v_actor_ref,v_legal_authority,v_reason,p_occurred_at);

  IF p_command_type='legal_hold_placed' THEN
    INSERT INTO app.workspace_legal_holds
      (workspace_id,hold_id,placed_sequence,placed_record_hash,legal_authority,
       placement_reason,placed_by,placed_at)
    VALUES (p_workspace_id,p_hold_id,p_sequence,p_record_hash,v_legal_authority,
      v_reason,v_actor_ref,p_occurred_at);
  ELSE
    PERFORM set_config('app.retention_control_transition','on',true);
    UPDATE app.workspace_legal_holds SET released_sequence=p_sequence,
      released_record_hash=p_record_hash,release_authority=v_legal_authority,
      release_reason=v_reason,released_by=v_actor_ref,released_at=p_occurred_at
    WHERE workspace_id=p_workspace_id AND hold_id=p_hold_id;
  END IF;
  INSERT INTO app.retention_control_audit_facts
    (id,workspace_id,command_id,fact_type,subject_id,control_sequence,
     control_record_hash,actor_ref,occurred_at)
  VALUES (gen_random_uuid(),p_workspace_id,p_command_id,p_command_type,p_hold_id,
    p_sequence,p_record_hash,v_actor_ref,p_occurred_at);
  UPDATE app.workspaces SET retention_control_sequence=p_sequence,
    retention_control_hash=p_record_hash,updated_at=clock_timestamp()
  WHERE id=p_workspace_id;
  RETURN true;
END $$;
