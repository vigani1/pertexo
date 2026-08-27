-- Request a fresh normal trigger-reconciliation delivery without granting the
-- operator any trigger mutation authority.

CREATE FUNCTION app.retry_operator_trigger_reconciliation(
  p_command_id uuid,
  p_workspace_id uuid,
  p_workflow_id uuid,
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
  v_published_version_id uuid;
  v_result jsonb;
BEGIN
  IF p_command_id IS NULL OR p_workspace_id IS NULL OR p_workflow_id IS NULL
    OR p_actor_ref IS NULL
    OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512
    OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'trigger reconciliation command is invalid' USING ERRCODE='22023';
  END IF;

  v_material:=jsonb_build_object(
    'actorRef',p_actor_ref,
    'commandType','trigger.reconcile',
    'dryRun',p_dry_run,
    'reason',p_reason,
    'workflowId',p_workflow_id,
    'workspaceId',p_workspace_id
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
      gen_random_uuid(),p_workspace_id,'operator.trigger_reconcile',
      'workflow',p_workflow_id,p_command_id::text,jsonb_build_object(
        'actorRef',p_actor_ref,'dryRun',p_dry_run,'outcome',v_outcome,
        'reason',p_reason,'replayed',true,'requestFingerprint',v_fingerprint
      )
    );
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT p_command_id,'completed'::varchar,v_outcome,true,v_result;
    RETURN;
  END IF;

  SELECT workflow.published_version_id INTO v_published_version_id
  FROM app.workflows workflow
  WHERE workflow.workspace_id=p_workspace_id AND workflow.id=p_workflow_id
    AND workflow.lifecycle_status='active'
  FOR SHARE;
  v_outcome:=CASE
    WHEN NOT FOUND THEN 'not_found'
    WHEN v_published_version_id IS NULL THEN 'not_published'
    WHEN p_dry_run THEN 'would_retry'
    ELSE 'retry_requested' END;

  IF v_outcome='retry_requested' THEN
    v_outbox_id:=gen_random_uuid();
    INSERT INTO app.outbox_events(
      id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
      payload,payload_checksum
    ) SELECT
      v_outbox_id,p_workspace_id,'reconcile-workflow-triggers',1,
      'workflow',p_workflow_id,payload,encode(sha256(convert_to(
        '{"outboxEventId":"'||v_outbox_id::text||
        '","publishedVersionId":"'||v_published_version_id::text||
        '","schemaVersion":1,"workflowId":"'||p_workflow_id::text||
        '","workspaceId":"'||p_workspace_id::text||'"}','UTF8')),'hex')
    FROM (SELECT jsonb_build_object(
      'outboxEventId',v_outbox_id,
      'publishedVersionId',v_published_version_id,
      'schemaVersion',1,
      'workflowId',p_workflow_id,
      'workspaceId',p_workspace_id
    ) payload) encoded;
  END IF;

  v_result:=jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion',1,
    'outboxEventId',v_outbox_id,
    'outcome',v_outcome,
    'publishedVersionId',v_published_version_id
  ));
  INSERT INTO app.operator_commands(
    id,command_type,dry_run,request_fingerprint,status,outcome,result
  ) VALUES(
    p_command_id,'trigger.reconcile',p_dry_run,v_fingerprint,
    'completed',v_outcome,v_result
  );
  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.trigger_reconcile',
    'workflow',p_workflow_id,p_command_id::text,jsonb_build_object(
      'actorRef',p_actor_ref,'dryRun',p_dry_run,'outcome',v_outcome,
      'reason',p_reason,'requestFingerprint',v_fingerprint
    )
  );
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT p_command_id,'completed'::varchar,v_outcome,false,v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

REVOKE ALL ON FUNCTION app.retry_operator_trigger_reconciliation(
  uuid,uuid,uuid,varchar,varchar,boolean
) FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.retry_operator_trigger_reconciliation(
  uuid,uuid,uuid,varchar,varchar,boolean
) TO {{operator_role}};
