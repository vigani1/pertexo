-- Persist replay intent under operator authority, then let a normal worker
-- verify the pinned executable and admit a new run with explicit lineage.

ALTER TABLE app.operator_commands
  DROP CONSTRAINT operator_commands_status_valid,
  DROP CONSTRAINT operator_commands_completion_order,
  ALTER COLUMN completed_at DROP NOT NULL,
  ADD CONSTRAINT operator_commands_status_valid
    CHECK(status IN ('pending','completed','failed')),
  ADD CONSTRAINT operator_commands_completion_order CHECK(
    (status='pending' AND completed_at IS NULL) OR
    (status IN ('completed','failed') AND completed_at>=created_at)
  );

ALTER TABLE app.workflow_runs
  ADD COLUMN replay_source_run_id uuid,
  ADD COLUMN replay_command_id uuid,
  ADD CONSTRAINT workflow_runs_replay_source_fk
    FOREIGN KEY(workspace_id,replay_source_run_id)
    REFERENCES app.workflow_runs(workspace_id,id),
  ADD CONSTRAINT workflow_runs_replay_command_unique UNIQUE(replay_command_id),
  ADD CONSTRAINT workflow_runs_replay_lineage_valid CHECK(
    (trigger_type='replay')=(replay_source_run_id IS NOT NULL AND replay_command_id IS NOT NULL)
  ) NOT VALID;

-- Worker admission already has bounded run-insert authority. Keep validation
-- under the table owner's metadata reads instead of widening worker secret
-- and notification-configuration grants.
ALTER FUNCTION app.validate_workflow_run_failure_notification_pin()
  SECURITY DEFINER;

CREATE INDEX workflow_runs_replay_source_idx
  ON app.workflow_runs(workspace_id,replay_source_run_id,id)
  WHERE replay_source_run_id IS NOT NULL;

CREATE TABLE app.operator_run_replay_requests (
  command_id uuid PRIMARY KEY REFERENCES app.operator_commands(id)
    DEFERRABLE INITIALLY DEFERRED,
  workspace_id uuid NOT NULL,
  source_run_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  run_input jsonb NOT NULL,
  request_fingerprint char(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  result_run_id uuid,
  safe_error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT operator_run_replay_source_fk
    FOREIGN KEY(workspace_id,source_run_id)
    REFERENCES app.workflow_runs(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT operator_run_replay_version_fk
    FOREIGN KEY(workspace_id,workflow_version_id)
    REFERENCES app.workflow_versions(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT operator_run_replay_result_fk
    FOREIGN KEY(workspace_id,result_run_id)
    REFERENCES app.workflow_runs(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT operator_run_replay_fingerprint_valid
    CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  CONSTRAINT operator_run_replay_input_bounded
    CHECK(octet_length(run_input::text)<=65536),
  CONSTRAINT operator_run_replay_status_valid
    CHECK(status IN ('pending','completed','failed')),
  CONSTRAINT operator_run_replay_completion_valid CHECK(
    (status='pending' AND result_run_id IS NULL AND safe_error_code IS NULL AND completed_at IS NULL) OR
    (status='completed' AND result_run_id IS NOT NULL AND safe_error_code IS NULL AND completed_at IS NOT NULL) OR
    (status='failed' AND result_run_id IS NULL AND safe_error_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

ALTER TABLE app.operator_run_replay_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operator_run_replay_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_run_replay_requests_workspace_scope
  ON app.operator_run_replay_requests TO {{owner_role}},{{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));

REVOKE ALL ON app.operator_run_replay_requests FROM PUBLIC,{{operator_role}},
  {{api_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{lifecycle_command_role}};
GRANT SELECT ON app.operator_run_replay_requests TO {{worker_runtime_role}};
CREATE FUNCTION app.request_operator_run_replay(
  p_command_id uuid,
  p_workspace_id uuid,
  p_source_run_id uuid,
  p_workflow_version_id uuid,
  p_run_input jsonb,
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
  v_existing app.operator_commands%ROWTYPE;
  v_fingerprint char(64);
  v_material jsonb;
  v_outbox_id uuid;
  v_outcome varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_result jsonb;
  v_source_workflow_id uuid;
  v_target_workflow_id uuid;
BEGIN
  IF p_command_id IS NULL OR p_workspace_id IS NULL OR p_source_run_id IS NULL
    OR p_workflow_version_id IS NULL OR p_run_input IS NULL
    OR octet_length(p_run_input::text)>65536 OR p_actor_ref IS NULL
    OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512
    OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'run replay command is invalid' USING ERRCODE='22023';
  END IF;

  v_material:=jsonb_build_object(
    'actorRef',p_actor_ref,'commandType','run.replay','dryRun',p_dry_run,
    'reason',p_reason,'runInput',p_run_input,'sourceRunId',p_source_run_id,
    'workflowVersionId',p_workflow_version_id,'workspaceId',p_workspace_id
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
      gen_random_uuid(),p_workspace_id,'operator.run_replay','workflow-run',
      p_source_run_id,p_command_id::text,jsonb_build_object(
        'actorRef',p_actor_ref,'dryRun',p_dry_run,'outcome',v_outcome,
        'reason',p_reason,'replayed',true,'requestFingerprint',v_fingerprint,
        'workflowVersionId',p_workflow_version_id
      )
    );
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT p_command_id,v_existing.status,v_outcome,true,v_result;
    RETURN;
  END IF;

  SELECT run.workflow_id INTO v_source_workflow_id
  FROM app.workflow_runs run
  WHERE run.workspace_id=p_workspace_id AND run.id=p_source_run_id
  FOR SHARE;
  IF FOUND THEN
    SELECT version.workflow_id INTO v_target_workflow_id
    FROM app.workflow_versions version
    WHERE version.workspace_id=p_workspace_id AND version.id=p_workflow_version_id
      AND version.executable_schema_version=2 AND version.executable_json IS NOT NULL
    FOR SHARE;
  END IF;
  v_outcome:=CASE
    WHEN v_source_workflow_id IS NULL THEN 'source_not_found'
    WHEN v_target_workflow_id IS NULL THEN 'version_not_executable'
    WHEN v_target_workflow_id<>v_source_workflow_id THEN 'workflow_mismatch'
    WHEN p_dry_run THEN 'would_request'
    ELSE 'replay_requested' END;

  IF v_outcome='replay_requested' THEN
    v_outbox_id:=gen_random_uuid();
    INSERT INTO app.operator_run_replay_requests(
      command_id,workspace_id,source_run_id,workflow_id,workflow_version_id,
      run_input,request_fingerprint
    ) VALUES(
      p_command_id,p_workspace_id,p_source_run_id,v_source_workflow_id,
      p_workflow_version_id,p_run_input,v_fingerprint
    );
    INSERT INTO app.outbox_events(
      id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
      payload,payload_checksum
    ) SELECT v_outbox_id,p_workspace_id,'replay-workflow-run',1,
      'operator-command',p_command_id,payload,
      encode(sha256(convert_to(
        '{"commandId":"'||p_command_id::text||
        '","outboxEventId":"'||v_outbox_id::text||
        '","schemaVersion":1,"workspaceId":"'||p_workspace_id::text||'"}',
        'UTF8')),'hex')
    FROM (SELECT jsonb_build_object(
      'commandId',p_command_id,'outboxEventId',v_outbox_id,
      'schemaVersion',1,'workspaceId',p_workspace_id
    ) payload) encoded;
  END IF;

  v_result:=jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion',1,'outboxEventId',v_outbox_id,'outcome',v_outcome,
    'sourceRunId',p_source_run_id,'workflowVersionId',p_workflow_version_id
  ));
  INSERT INTO app.operator_commands(
    id,command_type,dry_run,request_fingerprint,status,outcome,result,completed_at
  ) VALUES(
    p_command_id,'run.replay',p_dry_run,v_fingerprint,
    CASE WHEN v_outcome='replay_requested' THEN 'pending' ELSE 'completed' END,
    v_outcome,v_result,
    CASE WHEN v_outcome='replay_requested' THEN NULL ELSE clock_timestamp() END
  );
  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.run_replay','workflow-run',
    p_source_run_id,p_command_id::text,jsonb_build_object(
      'actorRef',p_actor_ref,'dryRun',p_dry_run,'outcome',v_outcome,
      'reason',p_reason,'requestFingerprint',v_fingerprint,
      'workflowVersionId',p_workflow_version_id
    )
  );
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT p_command_id,
    CASE WHEN v_outcome='replay_requested' THEN 'pending' ELSE 'completed' END::varchar,
    v_outcome,false,v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

REVOKE ALL ON FUNCTION app.request_operator_run_replay(
  uuid,uuid,uuid,uuid,jsonb,varchar,varchar,boolean
) FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.request_operator_run_replay(
  uuid,uuid,uuid,uuid,jsonb,varchar,varchar,boolean
) TO {{operator_role}};

CREATE FUNCTION app.complete_operator_run_replay(
  p_command_id uuid,
  p_workspace_id uuid,
  p_result_run_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_updated integer;
BEGIN
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  UPDATE app.operator_run_replay_requests request SET
    status='completed',result_run_id=p_result_run_id,completed_at=clock_timestamp()
  WHERE request.command_id=p_command_id AND request.workspace_id=p_workspace_id
    AND request.status='pending' AND EXISTS(
      SELECT 1 FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace_id AND run.id=p_result_run_id
        AND run.replay_command_id=p_command_id
        AND run.replay_source_run_id=request.source_run_id
        AND run.workflow_version_id=request.workflow_version_id
    );
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>1 THEN
    RAISE EXCEPTION 'run replay completion does not match durable request'
      USING ERRCODE='P0001';
  END IF;
  UPDATE app.operator_commands command SET
    status='completed',outcome='replay_created',completed_at=clock_timestamp(),
    result=command.result||jsonb_build_object(
      'outcome','replay_created','resultRunId',p_result_run_id
    )
  WHERE command.id=p_command_id AND command.status='pending';
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>1 THEN
    RAISE EXCEPTION 'run replay command completion was lost' USING ERRCODE='P0001';
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.fail_operator_run_replay(
  p_command_id uuid,
  p_workspace_id uuid,
  p_safe_error_code varchar
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_prior_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  IF p_safe_error_code IS NULL OR
    p_safe_error_code!~'^[a-z][a-z0-9_.-]{0,63}$' THEN
    RAISE EXCEPTION 'run replay failure code is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  UPDATE app.operator_run_replay_requests SET
    status='failed',safe_error_code=p_safe_error_code,completed_at=clock_timestamp()
  WHERE command_id=p_command_id AND workspace_id=p_workspace_id AND status='pending';
  IF FOUND THEN
    UPDATE app.operator_commands SET
      status='failed',outcome='replay_failed',completed_at=clock_timestamp(),
      result=result||jsonb_build_object(
        'outcome','replay_failed','safeErrorCode',p_safe_error_code
      )
    WHERE id=p_command_id AND status='pending';
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

REVOKE ALL ON FUNCTION app.complete_operator_run_replay(uuid,uuid,uuid)
  FROM PUBLIC,{{operator_role}},{{api_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
REVOKE ALL ON FUNCTION app.fail_operator_run_replay(uuid,uuid,varchar)
  FROM PUBLIC,{{operator_role}},{{api_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.complete_operator_run_replay(uuid,uuid,uuid)
  TO {{worker_runtime_role}};
GRANT EXECUTE ON FUNCTION app.fail_operator_run_replay(uuid,uuid,varchar)
  TO {{worker_runtime_role}};
