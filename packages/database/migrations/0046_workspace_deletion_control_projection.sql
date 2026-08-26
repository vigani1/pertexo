-- ADR 013 non-destructive workspace deletion lifecycle projection. This
-- migration changes control metadata only and performs no tenant-data deletion.

ALTER TABLE app.workspaces DROP CONSTRAINT workspaces_status_valid;
ALTER TABLE app.workspaces DROP CONSTRAINT workspaces_deletion_state_valid;
ALTER TABLE app.workspaces
  ADD CONSTRAINT workspaces_status_valid
    CHECK (status IN ('active','suspended','pending_deletion','purging','deleted')),
  ADD CONSTRAINT workspaces_deletion_state_valid CHECK (
    (status IN ('active','suspended')
      AND deletion_requested_at IS NULL AND deletion_requested_by IS NULL
      AND deletion_reason IS NULL AND purge_after IS NULL)
    OR
    (status IN ('pending_deletion','purging','deleted')
      AND deletion_requested_at IS NOT NULL AND deletion_requested_by IS NOT NULL
      AND deletion_reason IS NOT NULL
      AND length(btrim(deletion_reason)) BETWEEN 1 AND 512
      AND purge_after IS NOT NULL AND purge_after > deletion_requested_at)
  );
DROP INDEX app.workspaces_status_purge_idx;
CREATE INDEX workspaces_status_purge_idx
  ON app.workspaces (status,purge_after,id)
  WHERE status IN ('pending_deletion','purging');

ALTER TABLE app.retention_control_audit_facts
  DROP CONSTRAINT retention_control_audit_facts_type_valid;
ALTER TABLE app.retention_control_audit_facts
  ADD CONSTRAINT retention_control_audit_facts_type_valid CHECK (fact_type IN (
    'legal_hold_placed','legal_hold_released','deletion_requested',
    'deletion_restored','purge_started','deletion_completed'
  ));

ALTER TABLE app.workspace_control_ledger_projection
  DROP CONSTRAINT workspace_control_ledger_projection_authority_valid;
ALTER TABLE app.workspace_control_ledger_projection
  ADD CONSTRAINT workspace_control_ledger_projection_authority_valid CHECK (
    (command_type IN ('legal_hold_placed','legal_hold_released')
      AND legal_authority IS NOT NULL
      AND length(btrim(legal_authority)) BETWEEN 1 AND 256)
    OR (command_type NOT IN ('legal_hold_placed','legal_hold_released')
      AND legal_authority IS NULL)
  );

CREATE FUNCTION app.reject_workspace_control_direct_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_setting('app.workspace_deletion_projection',true) IS DISTINCT FROM 'on'
    AND current_setting('app.retention_control_transition',true) IS DISTINCT FROM 'on'
    AND (NEW.retention_control_sequence IS DISTINCT FROM OLD.retention_control_sequence
      OR NEW.retention_control_hash IS DISTINCT FROM OLD.retention_control_hash) THEN
    RAISE EXCEPTION 'workspace control anchors change only through control projection'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION app.arm_workspace_control_projection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF NEW.retention_control_sequence IS DISTINCT FROM OLD.retention_control_sequence
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.deletion_requested_at IS NOT DISTINCT FROM OLD.deletion_requested_at
    AND NEW.deletion_requested_by IS NOT DISTINCT FROM OLD.deletion_requested_by
    AND NEW.deletion_reason IS NOT DISTINCT FROM OLD.deletion_reason
    AND NEW.purge_after IS NOT DISTINCT FROM OLD.purge_after
    AND EXISTS (
      SELECT 1 FROM app.workspace_control_ledger_projection record
      WHERE record.workspace_id=OLD.id
        AND record.sequence=NEW.retention_control_sequence
        AND record.record_hash=NEW.retention_control_hash
    ) THEN
    PERFORM set_config('app.retention_control_transition','on',true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspaces_arm_control_projection
  BEFORE UPDATE ON app.workspaces FOR EACH ROW
  EXECUTE FUNCTION app.arm_workspace_control_projection();
CREATE TRIGGER workspaces_controlled_lifecycle_mutation
  BEFORE UPDATE ON app.workspaces FOR EACH ROW
  EXECUTE FUNCTION app.reject_workspace_control_direct_mutation();

CREATE FUNCTION app.validate_workspace_deletion_command(
  p_workspace_id uuid, p_command_type varchar, p_occurred_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace app.workspaces%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_occurred_at IS NULL
    OR p_command_type NOT IN ('deletion_requested','deletion_restored') THEN
    RAISE EXCEPTION 'invalid workspace deletion command' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_workspace FROM app.workspaces WHERE id=p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace does not exist' USING ERRCODE='23503';
  END IF;
  IF p_command_type='deletion_requested'
    AND v_workspace.status NOT IN ('active','suspended') THEN
    RAISE EXCEPTION 'workspace is not deletable' USING ERRCODE='55000';
  ELSIF p_command_type='deletion_restored'
    AND (v_workspace.status<>'pending_deletion'
      OR p_occurred_at<v_workspace.deletion_requested_at
      OR p_occurred_at>=v_workspace.purge_after) THEN
    RAISE EXCEPTION 'workspace is not restorable' USING ERRCODE='55000';
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION app.project_workspace_deletion(
  p_workspace_id uuid, p_sequence bigint, p_command_id uuid, p_command_type varchar,
  p_subject_id uuid, p_previous_hash char(64), p_record_hash char(64),
  p_actor_ref varchar, p_legal_authority varchar, p_reason varchar,
  p_occurred_at timestamptz, p_recovery_interval interval DEFAULT interval '30 days'
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace app.workspaces%ROWTYPE;
  v_existing app.workspace_control_ledger_projection%ROWTYPE;
  v_actor_ref varchar(128);
  v_actor_id uuid;
  v_reason varchar(512);
  v_latest_lifecycle_at timestamptz;
  v_purge_started_at timestamptz;
BEGIN
  IF p_workspace_id IS NULL OR p_sequence IS NULL OR p_sequence<1
    OR p_command_id IS NULL OR p_subject_id IS DISTINCT FROM p_workspace_id
    OR p_command_type NOT IN ('deletion_requested','deletion_restored','purge_started','deletion_completed')
    OR p_previous_hash IS NULL OR p_record_hash IS NULL
    OR p_previous_hash !~ '^[0-9a-f]{64}$' OR p_record_hash !~ '^[0-9a-f]{64}$'
    OR p_previous_hash=p_record_hash OR p_actor_ref IS NULL OR p_reason IS NULL
    OR length(btrim(p_actor_ref)) NOT BETWEEN 1 AND 128
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 512 OR p_occurred_at IS NULL
    OR p_legal_authority IS NOT NULL
    OR p_recovery_interval IS NULL OR p_recovery_interval<>interval '30 days' THEN
    RAISE EXCEPTION 'invalid retention control record' USING ERRCODE='22023';
  END IF;
  v_actor_ref := btrim(p_actor_ref);
  v_reason := btrim(p_reason);

  SELECT * INTO STRICT v_workspace FROM app.workspaces WHERE id=p_workspace_id FOR UPDATE;
  SELECT * INTO v_existing FROM app.workspace_control_ledger_projection
    WHERE workspace_id=p_workspace_id AND command_id=p_command_id;
  IF FOUND THEN
    IF v_existing.sequence=p_sequence AND v_existing.command_type=p_command_type
      AND v_existing.subject_id=p_subject_id AND v_existing.previous_hash=p_previous_hash
      AND v_existing.record_hash=p_record_hash AND v_existing.actor_ref=v_actor_ref
      AND v_existing.legal_authority IS NULL AND v_existing.reason=v_reason
      AND v_existing.occurred_at=p_occurred_at THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'retention control command replay conflicts with projection' USING ERRCODE='23505';
  END IF;
  IF p_sequence<>v_workspace.retention_control_sequence+1 THEN
    RAISE EXCEPTION 'retention control sequence mismatch' USING ERRCODE='40001';
  END IF;
  IF p_previous_hash<>v_workspace.retention_control_hash THEN
    RAISE EXCEPTION 'retention control previous hash mismatch' USING ERRCODE='40001';
  END IF;
  SELECT record.occurred_at INTO v_latest_lifecycle_at
  FROM app.workspace_control_ledger_projection record
  WHERE record.workspace_id=p_workspace_id
    AND record.command_type IN (
      'deletion_requested','deletion_restored','purge_started','deletion_completed'
    )
  ORDER BY record.sequence DESC LIMIT 1;
  IF v_latest_lifecycle_at IS NOT NULL AND p_occurred_at<v_latest_lifecycle_at THEN
    RAISE EXCEPTION 'workspace deletion lifecycle event predates its predecessor'
      USING ERRCODE='55000';
  END IF;

  IF p_command_type='deletion_requested' THEN
    IF v_workspace.status NOT IN ('active','suspended') THEN
      RAISE EXCEPTION 'workspace is not deletable' USING ERRCODE='55000';
    END IF;
    BEGIN
      v_actor_id := v_actor_ref::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'deletion request actor must be a user UUID' USING ERRCODE='22023';
    END;
    IF NOT EXISTS (SELECT 1 FROM app.users WHERE id=v_actor_id) THEN
      RAISE EXCEPTION 'deletion request actor does not exist' USING ERRCODE='23503';
    END IF;
  ELSIF p_command_type='deletion_restored' THEN
    IF v_workspace.status<>'pending_deletion'
      OR p_occurred_at<v_workspace.deletion_requested_at
      OR p_occurred_at>=v_workspace.purge_after THEN
      RAISE EXCEPTION 'workspace is not restorable' USING ERRCODE='55000';
    END IF;
  ELSIF p_command_type='purge_started' THEN
    IF v_workspace.status<>'pending_deletion' OR p_occurred_at<v_workspace.purge_after THEN
      RAISE EXCEPTION 'workspace is not ready for purge' USING ERRCODE='55000';
    END IF;
  ELSE
    IF v_workspace.status<>'purging' THEN
      RAISE EXCEPTION 'workspace purge is not in progress' USING ERRCODE='55000';
    END IF;
    SELECT record.occurred_at INTO v_purge_started_at
    FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=p_workspace_id AND record.command_type='purge_started'
    ORDER BY record.sequence DESC LIMIT 1;
    IF v_purge_started_at IS NULL OR p_occurred_at<v_purge_started_at THEN
      RAISE EXCEPTION 'deletion completion predates purge start' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_sequence IS NULL
    ) THEN
      RAISE EXCEPTION 'active workspace legal hold blocks deletion completion' USING ERRCODE='55000';
    END IF;
  END IF;

  INSERT INTO app.workspace_control_ledger_projection
    (workspace_id,sequence,command_id,command_type,subject_id,previous_hash,record_hash,
     actor_ref,legal_authority,reason,occurred_at)
  VALUES (p_workspace_id,p_sequence,p_command_id,p_command_type,p_subject_id,p_previous_hash,
    p_record_hash,v_actor_ref,NULL,v_reason,p_occurred_at);
  INSERT INTO app.retention_control_audit_facts
    (id,workspace_id,command_id,fact_type,subject_id,control_sequence,
     control_record_hash,actor_ref,occurred_at)
  VALUES (gen_random_uuid(),p_workspace_id,p_command_id,p_command_type,p_subject_id,
    p_sequence,p_record_hash,v_actor_ref,p_occurred_at);

  PERFORM set_config('app.workspace_deletion_projection','on',true);
  UPDATE app.workspaces SET
    status=CASE p_command_type
      WHEN 'deletion_requested' THEN 'pending_deletion'
      WHEN 'deletion_restored' THEN 'suspended'
      WHEN 'purge_started' THEN 'purging'
      ELSE 'deleted' END,
    deletion_requested_at=CASE WHEN p_command_type='deletion_requested'
      THEN p_occurred_at WHEN p_command_type='deletion_restored' THEN NULL
      ELSE deletion_requested_at END,
    deletion_requested_by=CASE WHEN p_command_type='deletion_requested'
      THEN v_actor_id WHEN p_command_type='deletion_restored' THEN NULL
      ELSE deletion_requested_by END,
    deletion_reason=CASE WHEN p_command_type='deletion_requested'
      THEN v_reason WHEN p_command_type='deletion_restored' THEN NULL
      ELSE deletion_reason END,
    purge_after=CASE WHEN p_command_type='deletion_requested'
      THEN p_occurred_at+p_recovery_interval WHEN p_command_type='deletion_restored' THEN NULL
      ELSE purge_after END,
    retention_control_sequence=p_sequence,retention_control_hash=p_record_hash,
    updated_at=clock_timestamp()
  WHERE id=p_workspace_id;
  RETURN true;
END $$;

CREATE FUNCTION app.enumerate_workspace_control_anchors(
  p_after_workspace_id uuid, p_limit integer
) RETURNS TABLE(workspace_id uuid,retention_control_sequence bigint,retention_control_hash char(64))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'workspace anchor enumeration limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT workspace.id,workspace.retention_control_sequence,workspace.retention_control_hash
    FROM app.workspaces workspace
    WHERE p_after_workspace_id IS NULL OR workspace.id>p_after_workspace_id
    ORDER BY workspace.id LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION app.reject_workspace_control_direct_mutation(),
  app.arm_workspace_control_projection(),
  app.validate_workspace_deletion_command(uuid,varchar,timestamptz),
  app.project_workspace_deletion(uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz,interval),
  app.enumerate_workspace_control_anchors(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.validate_workspace_deletion_command(uuid,varchar,timestamptz),
  app.project_workspace_deletion(uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz,interval),
  app.enumerate_workspace_control_anchors(uuid,integer) TO {{maintenance_role}};
