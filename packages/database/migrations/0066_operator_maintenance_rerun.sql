-- Operators may request maintenance work, but only the maintenance role may
-- consume the request before the existing fenced coordinators run.

CREATE TABLE app.operator_maintenance_rerun_requests (
  command_id uuid PRIMARY KEY REFERENCES app.operator_commands(id)
    DEFERRABLE INITIALLY DEFERRED,
  workspace_id uuid NOT NULL,
  target_type varchar(32) NOT NULL,
  target_id uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  outcome varchar(32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT operator_maintenance_rerun_target_valid
    CHECK(target_type IN ('retention_batch','workspace_purge_job')),
  CONSTRAINT operator_maintenance_rerun_status_valid
    CHECK(status IN ('pending','completed')),
  CONSTRAINT operator_maintenance_rerun_outcome_valid CHECK(
    (status='pending' AND outcome IS NULL AND completed_at IS NULL) OR
    (status='completed' AND outcome~'^[a-z][a-z0-9_]{0,31}$'
      AND completed_at IS NOT NULL)
  ),
  UNIQUE(target_type,target_id,command_id)
);

CREATE INDEX operator_maintenance_rerun_pending_idx
  ON app.operator_maintenance_rerun_requests(created_at,command_id)
  WHERE status='pending';
ALTER TABLE app.operator_maintenance_rerun_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operator_maintenance_rerun_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_maintenance_rerun_workspace_scope
  ON app.operator_maintenance_rerun_requests TO {{owner_role}},{{maintenance_role}}
  USING(true) WITH CHECK(true);
REVOKE ALL ON app.operator_maintenance_rerun_requests FROM PUBLIC,{{operator_role}},
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{lifecycle_command_role}};

CREATE FUNCTION app.request_operator_maintenance_rerun(
  p_command_id uuid,
  p_workspace_id uuid,
  p_target_type varchar,
  p_target_id uuid,
  p_actor_ref varchar,
  p_reason varchar,
  p_dry_run boolean
)
RETURNS TABLE(
  command_id uuid,
  command_status varchar,
  command_outcome varchar,
  replayed boolean,
  result jsonb
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_command_type varchar(64);
  v_existing app.operator_commands%ROWTYPE;
  v_fingerprint char(64);
  v_found boolean;
  v_material jsonb;
  v_outcome varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_result jsonb;
BEGIN
  IF p_command_id IS NULL OR p_workspace_id IS NULL OR p_target_id IS NULL
    OR p_target_type NOT IN ('retention_batch','workspace_purge_job')
    OR p_actor_ref IS NULL
    OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512
    OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'maintenance rerun command is invalid' USING ERRCODE='22023';
  END IF;
  v_command_type:=CASE p_target_type WHEN 'retention_batch'
    THEN 'retention.rerun' ELSE 'purge.rerun' END;
  v_material:=jsonb_build_object(
    'actorRef',p_actor_ref,'commandType',v_command_type,'dryRun',p_dry_run,
    'reason',p_reason,'targetId',p_target_id,'workspaceId',p_workspace_id
  );
  v_fingerprint:=encode(sha256(convert_to(v_material::text,'UTF8')),'hex');
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_command_id::text,7166118813));

  SELECT * INTO v_existing FROM app.operator_commands WHERE id=p_command_id;
  IF FOUND THEN
    v_outcome:=CASE WHEN v_existing.request_fingerprint=v_fingerprint
      THEN v_existing.outcome ELSE 'conflict' END;
    v_result:=CASE WHEN v_outcome='conflict'
      THEN jsonb_build_object('schemaVersion',1,'outcome','conflict')
      ELSE v_existing.result END;
    INSERT INTO app.audit_events(
      id,workspace_id,action,target_type,target_id,request_id,metadata
    ) VALUES(
      gen_random_uuid(),p_workspace_id,'operator.maintenance_rerun',
      p_target_type,p_target_id,p_command_id::text,jsonb_build_object(
        'actorRef',p_actor_ref,'commandType',v_command_type,'dryRun',p_dry_run,
        'outcome',v_outcome,'reason',p_reason,'replayed',true,
        'requestFingerprint',v_fingerprint
      )
    );
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT p_command_id,v_existing.status,v_outcome,true,v_result;
    RETURN;
  END IF;

  IF p_target_type='retention_batch' THEN
    SELECT EXISTS(SELECT 1 FROM app.retention_batches batch
      WHERE batch.workspace_id=p_workspace_id AND batch.id=p_target_id)
      INTO v_found;
  ELSE
    SELECT EXISTS(SELECT 1 FROM app.workspace_purge_jobs job
      WHERE job.workspace_id=p_workspace_id AND job.id=p_target_id)
      INTO v_found;
  END IF;
  v_outcome:=CASE WHEN NOT v_found THEN 'not_found'
    WHEN p_dry_run THEN 'would_request' ELSE 'rerun_requested' END;
  v_result:=jsonb_build_object(
    'schemaVersion',1,'outcome',v_outcome,'targetId',p_target_id,
    'targetType',p_target_type
  );
  INSERT INTO app.operator_commands(
    id,command_type,dry_run,request_fingerprint,status,outcome,result,completed_at
  ) VALUES(
    p_command_id,v_command_type,p_dry_run,v_fingerprint,
    CASE WHEN v_outcome='rerun_requested' THEN 'pending' ELSE 'completed' END,
    v_outcome,v_result,
    CASE WHEN v_outcome='rerun_requested' THEN NULL ELSE clock_timestamp() END
  );
  IF v_outcome='rerun_requested' THEN
    INSERT INTO app.operator_maintenance_rerun_requests(
      command_id,workspace_id,target_type,target_id
    ) VALUES(p_command_id,p_workspace_id,p_target_type,p_target_id);
  END IF;
  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.maintenance_rerun',
    p_target_type,p_target_id,p_command_id::text,jsonb_build_object(
      'actorRef',p_actor_ref,'commandType',v_command_type,'dryRun',p_dry_run,
      'outcome',v_outcome,'reason',p_reason,'requestFingerprint',v_fingerprint
    )
  );
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT p_command_id,
    CASE WHEN v_outcome='rerun_requested' THEN 'pending' ELSE 'completed' END::varchar,
    v_outcome,false,v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

REVOKE ALL ON FUNCTION app.request_operator_maintenance_rerun(
  uuid,uuid,varchar,uuid,varchar,varchar,boolean
) FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.request_operator_maintenance_rerun(
  uuid,uuid,varchar,uuid,varchar,varchar,boolean
) TO {{operator_role}};

CREATE FUNCTION app.process_operator_maintenance_rerun()
RETURNS TABLE(
  command_id uuid,
  workspace_id uuid,
  target_type varchar,
  target_id uuid,
  outcome varchar
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_request app.operator_maintenance_rerun_requests%ROWTYPE;
  v_outcome varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_status varchar(16);
  v_lease_expires_at timestamptz;
  v_hold boolean;
  v_dry_run boolean;
BEGIN
  SELECT * INTO v_request FROM app.operator_maintenance_rerun_requests request
  WHERE request.status='pending' ORDER BY request.created_at,request.command_id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM set_config('app.workspace_id',v_request.workspace_id::text,true);
  SELECT EXISTS(SELECT 1 FROM app.workspace_legal_holds hold
    WHERE hold.workspace_id=v_request.workspace_id AND hold.released_at IS NULL)
    INTO v_hold;
  IF v_request.target_type='retention_batch' THEN
    SELECT batch.status,batch.lease_expires_at,batch.dry_run
      INTO v_status,v_lease_expires_at,v_dry_run
    FROM app.retention_batches batch WHERE batch.id=v_request.target_id
      AND batch.workspace_id=v_request.workspace_id FOR UPDATE;
    v_outcome:=CASE
      WHEN NOT FOUND THEN 'not_found'
      WHEN v_status='completed' THEN 'already_completed'
      WHEN v_hold AND NOT v_dry_run THEN 'legal_hold'
      WHEN v_status='running' AND v_lease_expires_at>clock_timestamp()
        THEN 'lease_active'
      ELSE 'rerun_accepted' END;
  ELSE
    SELECT job.status,job.lease_expires_at INTO v_status,v_lease_expires_at
    FROM app.workspace_purge_jobs job WHERE job.id=v_request.target_id
      AND job.workspace_id=v_request.workspace_id FOR UPDATE;
    v_outcome:=CASE
      WHEN NOT FOUND THEN 'not_found'
      WHEN v_status='completed' THEN 'already_completed'
      WHEN v_hold THEN 'legal_hold'
      WHEN v_status='running' AND v_lease_expires_at>clock_timestamp()
        THEN 'lease_active'
      ELSE 'rerun_accepted' END;
  END IF;
  UPDATE app.operator_maintenance_rerun_requests request SET
    status='completed',outcome=v_outcome,completed_at=clock_timestamp()
  WHERE request.command_id=v_request.command_id AND request.status='pending';
  UPDATE app.operator_commands command SET
    status='completed',outcome=v_outcome,completed_at=clock_timestamp(),
    result=command.result||jsonb_build_object('outcome',v_outcome)
  WHERE command.id=v_request.command_id AND command.status='pending';
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT v_request.command_id,v_request.workspace_id,
    v_request.target_type,v_request.target_id,v_outcome;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

REVOKE ALL ON FUNCTION app.process_operator_maintenance_rerun()
  FROM PUBLIC,{{operator_role}},{{api_runtime_role}},{{worker_runtime_role}},
  {{dispatcher_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.process_operator_maintenance_rerun()
  TO {{maintenance_role}};
