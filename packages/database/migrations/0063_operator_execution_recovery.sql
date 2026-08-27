-- Synchronous execution recovery commands. The operator receives only narrow
-- wrappers; the shared dispatcher remains owner-only and cannot be invoked by
-- any runtime role.

CREATE TABLE app.operator_unknown_outcome_evidence (
  command_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  evidence_kind varchar(64) NOT NULL,
  evidence_ref jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operator_unknown_evidence_attempt_fk
    FOREIGN KEY(workspace_id,attempt_id)
    REFERENCES app.node_attempts(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT operator_unknown_evidence_kind_valid
    CHECK(evidence_kind~'^[a-z][a-z0-9_.-]{0,63}$'),
  CONSTRAINT operator_unknown_evidence_ref_valid
    CHECK(jsonb_typeof(evidence_ref)='object' AND octet_length(evidence_ref::text)<=4096)
);
ALTER TABLE app.operator_unknown_outcome_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operator_unknown_outcome_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_unknown_evidence_owner_all
  ON app.operator_unknown_outcome_evidence FOR ALL TO {{owner_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY operator_unknown_evidence_worker_select
  ON app.operator_unknown_outcome_evidence FOR SELECT TO {{worker_runtime_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));

CREATE INDEX node_runs_operator_due_idx ON app.node_runs(
  workspace_id,workflow_run_id,(coalesce(retry_due_at,resume_at)),id
) WHERE status='waiting';

CREATE FUNCTION app.execute_operator_execution_command(
  p_command_id uuid,p_command_type varchar,p_workspace_id uuid,p_target_id uuid,
  p_expected_fence bigint,p_action varchar,p_evidence_kind varchar,
  p_evidence_ref jsonb,p_actor_ref varchar,p_reason varchar,p_dry_run boolean
) RETURNS TABLE(command_id uuid,command_status varchar,command_outcome varchar,
  replayed boolean,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_existing app.operator_commands%ROWTYPE;
  v_fingerprint char(64);
  v_material jsonb;
  v_result jsonb;
  v_outcome varchar(32);
  v_outbox_id uuid;
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_attempt record;
  v_run app.workflow_runs%ROWTYPE;
  v_due_nodes integer;
  v_due_nodes_remaining boolean;
  v_due_wait boolean;
  v_run_id uuid;
  v_sequence integer;
BEGIN
  IF p_command_id IS NULL OR p_workspace_id IS NULL OR p_target_id IS NULL
    OR p_actor_ref IS NULL OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512
    OR p_dry_run IS NULL OR p_command_type NOT IN (
      'attempt.reconcile','due-work.resume','unknown-outcome.record-evidence','run.cancel'
    ) THEN
    RAISE EXCEPTION 'operator execution command is invalid' USING ERRCODE='22023';
  END IF;
  IF p_command_type='attempt.reconcile' AND (
    p_expected_fence IS NULL OR p_expected_fence<1
    OR p_action NOT IN ('reclaim','outcome_unknown')
  ) THEN RAISE EXCEPTION 'attempt reconciliation material is invalid' USING ERRCODE='22023'; END IF;
  IF p_command_type='unknown-outcome.record-evidence' AND (
    p_dry_run OR p_evidence_kind IS NULL
    OR p_evidence_kind!~'^[a-z][a-z0-9_.-]{0,63}$'
    OR jsonb_typeof(p_evidence_ref)<>'object'
    OR octet_length(p_evidence_ref::text)>4096
  ) THEN RAISE EXCEPTION 'unknown outcome evidence is invalid' USING ERRCODE='22023'; END IF;

  v_material:=jsonb_strip_nulls(jsonb_build_object(
    'action',p_action,'actorRef',p_actor_ref,'commandType',p_command_type,
    'dryRun',p_dry_run,'evidenceKind',p_evidence_kind,
    'evidenceRef',p_evidence_ref,'expectedFence',p_expected_fence,
    'reason',p_reason,'targetId',p_target_id,'workspaceId',p_workspace_id
  ));
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
    INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,request_id,metadata)
    VALUES(gen_random_uuid(),p_workspace_id,'operator.'||replace(p_command_type,'.','_'),
      'operator-command-target',p_target_id,p_command_id::text,
      jsonb_build_object('actorRef',p_actor_ref,'dryRun',p_dry_run,
        'outcome',v_outcome,'reason',p_reason,'replayed',true,
        'requestFingerprint',v_fingerprint));
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT p_command_id,'completed'::varchar,v_outcome,true,v_result;
    RETURN;
  END IF;

  IF p_command_type='attempt.reconcile' THEN
    SELECT node.workflow_run_id INTO v_run_id
    FROM app.node_attempts attempt
    JOIN app.node_runs node ON node.workspace_id=attempt.workspace_id
      AND node.id=attempt.node_run_id
    WHERE attempt.workspace_id=p_workspace_id AND attempt.id=p_target_id;
    IF FOUND THEN
      PERFORM 1 FROM app.workflow_runs WHERE workspace_id=p_workspace_id
        AND id=v_run_id FOR UPDATE;
    END IF;
    SELECT attempt.id,attempt.status,attempt.fence_token,attempt.lease_expires_at,
      attempt.dispatch_marked_at,attempt.side_effect_class,node.id node_run_id,
      node.workflow_run_id run_id
    INTO v_attempt FROM app.node_attempts attempt
    JOIN app.node_runs node ON node.workspace_id=attempt.workspace_id
      AND node.id=attempt.node_run_id
    WHERE attempt.workspace_id=p_workspace_id AND attempt.id=p_target_id
    FOR UPDATE OF attempt,node;
    v_outcome:=CASE
      WHEN NOT FOUND THEN 'not_found'
      WHEN v_attempt.status<>'running' THEN 'not_running'
      WHEN v_attempt.fence_token<>p_expected_fence THEN 'fence_conflict'
      WHEN v_attempt.lease_expires_at IS NULL
        OR v_attempt.lease_expires_at>clock_timestamp() THEN 'lease_active'
      WHEN p_action='reclaim' AND v_attempt.dispatch_marked_at IS NOT NULL
        AND v_attempt.side_effect_class='unsafe' THEN 'reclaim_unsafe'
      WHEN p_dry_run AND p_action='reclaim' THEN 'would_reclaim'
      WHEN p_dry_run THEN 'would_mark_unknown'
      WHEN p_action='reclaim' THEN 'reclaimed'
      ELSE 'marked_unknown' END;
    IF v_outcome IN ('reclaimed','marked_unknown') THEN
      UPDATE app.node_attempts SET status=CASE WHEN p_action='reclaim' THEN 'ready' ELSE 'outcome_unknown' END,
        fence_token=p_expected_fence+1,lease_owner=NULL,lease_expires_at=NULL,
        reconciliation_ref=CASE WHEN p_action='outcome_unknown'
          THEN jsonb_build_object('operatorCommandId',p_command_id) ELSE reconciliation_ref END,
        completed_at=CASE WHEN p_action='outcome_unknown' THEN clock_timestamp() ELSE NULL END,
        updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace_id AND id=p_target_id;
      IF p_action='outcome_unknown' THEN
        UPDATE app.node_runs SET status='outcome_unknown',completed_at=clock_timestamp(),
          updated_at=clock_timestamp() WHERE workspace_id=p_workspace_id
          AND id=v_attempt.node_run_id AND current_attempt_id=p_target_id;
        INSERT INTO app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
        SELECT p_workspace_id,v_attempt.run_id,coalesce(max(sequence),0)+1,
          'node.outcome_unknown',jsonb_build_object('attemptId',p_target_id,
            'nodeRunId',v_attempt.node_run_id,'operatorCommandId',p_command_id,
            'reconciliation',true,'schemaVersion',1)
        FROM app.run_events WHERE workspace_id=p_workspace_id
          AND workflow_run_id=v_attempt.run_id RETURNING sequence INTO v_sequence;
      END IF;
      v_outbox_id:=gen_random_uuid();
      INSERT INTO app.outbox_events(id,workspace_id,job_name,schema_version,
        aggregate_type,aggregate_id,payload,payload_checksum)
      SELECT v_outbox_id,p_workspace_id,
        CASE WHEN p_action='reclaim' THEN 'execute-node-attempt' ELSE 'advance-workflow-run' END,
        1,CASE WHEN p_action='reclaim' THEN 'node-attempt' ELSE 'workflow-run' END,
        CASE WHEN p_action='reclaim' THEN p_target_id ELSE v_attempt.run_id END,
        payload,encode(sha256(convert_to(CASE WHEN p_action='reclaim' THEN
          '{"attemptId":"'||p_target_id::text||'","nodeRunId":"'||v_attempt.node_run_id::text||
          '","outboxEventId":"'||v_outbox_id::text||'","runId":"'||v_attempt.run_id::text||
          '","schemaVersion":1,"workspaceId":"'||p_workspace_id::text||'"}'
        ELSE '{"outboxEventId":"'||v_outbox_id::text||'","runId":"'||v_attempt.run_id::text||
          '","schemaVersion":1,"workspaceId":"'||p_workspace_id::text||'"}' END,'UTF8')),'hex')
      FROM (SELECT CASE WHEN p_action='reclaim' THEN jsonb_build_object(
          'attemptId',p_target_id,'nodeRunId',v_attempt.node_run_id,
          'outboxEventId',v_outbox_id,'runId',v_attempt.run_id,
          'schemaVersion',1,'workspaceId',p_workspace_id)
        ELSE jsonb_build_object('outboxEventId',v_outbox_id,
          'runId',v_attempt.run_id,'schemaVersion',1,'workspaceId',p_workspace_id)
        END payload) encoded;
    END IF;
    v_result:=jsonb_strip_nulls(jsonb_build_object('schemaVersion',1,
      'action',p_action,'fenceToken',CASE WHEN v_outcome IN ('reclaimed','marked_unknown')
        THEN p_expected_fence+1 ELSE p_expected_fence END,
      'outboxEventId',v_outbox_id,'outcome',v_outcome));

  ELSIF p_command_type='due-work.resume' THEN
    SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace_id
      AND id=p_target_id FOR UPDATE;
    IF NOT FOUND THEN
      v_outcome:='not_found'; v_due_nodes:=0; v_due_wait:=false;
    ELSE
      SELECT count(*)::integer INTO v_due_nodes FROM (
        SELECT 1 FROM app.node_runs
        WHERE workspace_id=p_workspace_id AND workflow_run_id=p_target_id
          AND status='waiting' AND coalesce(retry_due_at,resume_at)<=clock_timestamp()
          AND due_wakeup_at IS DISTINCT FROM coalesce(retry_due_at,resume_at)
        ORDER BY coalesce(retry_due_at,resume_at),id LIMIT 101
      ) due;
      v_due_nodes_remaining:=v_due_nodes>100;
      v_due_nodes:=least(v_due_nodes,100);
      SELECT EXISTS(SELECT 1 FROM app.run_checkpoints WHERE workspace_id=p_workspace_id
        AND workflow_run_id=p_target_id AND resume_at<=clock_timestamp()
        AND (resume_lease_expires_at IS NULL OR resume_lease_expires_at<=clock_timestamp()))
        INTO v_due_wait;
      v_outcome:=CASE WHEN v_run.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
        THEN 'terminal' WHEN v_due_nodes=0 AND NOT v_due_wait THEN 'not_due'
        WHEN p_dry_run THEN 'would_resume' ELSE 'resumed' END;
      IF v_outcome='resumed' THEN
        WITH due AS (
          SELECT id FROM app.node_runs
          WHERE workspace_id=p_workspace_id AND workflow_run_id=p_target_id
            AND status='waiting' AND coalesce(retry_due_at,resume_at)<=clock_timestamp()
            AND due_wakeup_at IS DISTINCT FROM coalesce(retry_due_at,resume_at)
          ORDER BY coalesce(retry_due_at,resume_at),id FOR UPDATE LIMIT 100
        )
        UPDATE app.node_runs node SET due_wakeup_at=coalesce(node.retry_due_at,node.resume_at),
          updated_at=clock_timestamp() FROM due WHERE node.workspace_id=p_workspace_id
          AND node.id=due.id;
        UPDATE app.run_checkpoints SET resume_at=NULL,resume_lease_owner=NULL,
          resume_lease_token=NULL,resume_lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE workspace_id=p_workspace_id AND workflow_run_id=p_target_id
          AND resume_at<=clock_timestamp()
          AND (resume_lease_expires_at IS NULL OR resume_lease_expires_at<=clock_timestamp());
        v_outbox_id:=gen_random_uuid();
        INSERT INTO app.outbox_events(id,workspace_id,job_name,schema_version,
          aggregate_type,aggregate_id,payload,payload_checksum)
        SELECT v_outbox_id,p_workspace_id,'advance-workflow-run',1,'workflow-run',p_target_id,
          payload,encode(sha256(convert_to(
            '{"outboxEventId":"'||v_outbox_id::text||'","runId":"'||p_target_id::text||
            '","schemaVersion":1,"workspaceId":"'||p_workspace_id::text||'"}','UTF8')),'hex')
        FROM (SELECT jsonb_build_object('outboxEventId',v_outbox_id,
          'runId',p_target_id,'schemaVersion',1,'workspaceId',p_workspace_id) payload) encoded;
      END IF;
    END IF;
    v_result:=jsonb_strip_nulls(jsonb_build_object('schemaVersion',1,
      'dueNodeCount',v_due_nodes,'dueNodesRemaining',v_due_nodes_remaining,
      'dueWorkflowWait',v_due_wait,
      'outboxEventId',v_outbox_id,'outcome',v_outcome));

  ELSIF p_command_type='run.cancel' THEN
    SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace_id
      AND id=p_target_id FOR UPDATE;
    v_outcome:=CASE WHEN NOT FOUND THEN 'not_found'
      WHEN v_run.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown') THEN 'terminal'
      WHEN v_run.cancel_requested_at IS NOT NULL THEN 'already_requested'
      WHEN p_dry_run THEN 'would_cancel' ELSE 'cancel_requested' END;
    IF v_outcome='cancel_requested' THEN
      UPDATE app.workflow_runs SET cancel_requested_at=clock_timestamp(),
        cancel_requested_by=p_actor_ref,cancel_reason=p_reason,updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace_id AND id=p_target_id;
      INSERT INTO app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
      SELECT p_workspace_id,p_target_id,coalesce(max(sequence),0)+1,'run.cancel_requested',
        jsonb_build_object('actor',p_actor_ref,'reason',p_reason,'schemaVersion',1)
      FROM app.run_events WHERE workspace_id=p_workspace_id
        AND workflow_run_id=p_target_id RETURNING sequence INTO v_sequence;
      v_outbox_id:=gen_random_uuid();
      INSERT INTO app.outbox_events(id,workspace_id,job_name,schema_version,
        aggregate_type,aggregate_id,payload,payload_checksum)
      SELECT v_outbox_id,p_workspace_id,'advance-workflow-run',1,'workflow-run',p_target_id,
        payload,encode(sha256(convert_to(
          '{"outboxEventId":"'||v_outbox_id::text||'","runId":"'||p_target_id::text||
          '","schemaVersion":1,"workspaceId":"'||p_workspace_id::text||'"}','UTF8')),'hex')
      FROM (SELECT jsonb_build_object('outboxEventId',v_outbox_id,
        'runId',p_target_id,'schemaVersion',1,'workspaceId',p_workspace_id) payload) encoded;
    END IF;
    v_result:=jsonb_strip_nulls(jsonb_build_object('schemaVersion',1,
      'eventSequence',v_sequence,'outboxEventId',v_outbox_id,'outcome',v_outcome));

  ELSE
    SELECT attempt.id,attempt.status,node.workflow_run_id run_id
      INTO v_attempt FROM app.node_attempts attempt
      JOIN app.node_runs node ON node.workspace_id=attempt.workspace_id
        AND node.id=attempt.node_run_id
      WHERE attempt.workspace_id=p_workspace_id AND attempt.id=p_target_id
      FOR UPDATE OF attempt;
    v_outcome:=CASE WHEN NOT FOUND THEN 'not_found'
      WHEN v_attempt.status<>'outcome_unknown' THEN 'not_unknown'
      ELSE 'evidence_recorded' END;
    IF v_outcome='evidence_recorded' THEN
      INSERT INTO app.operator_unknown_outcome_evidence(
        command_id,workspace_id,attempt_id,evidence_kind,evidence_ref
      ) VALUES(p_command_id,p_workspace_id,p_target_id,p_evidence_kind,p_evidence_ref);
      v_outbox_id:=gen_random_uuid();
      INSERT INTO app.outbox_events(id,workspace_id,job_name,schema_version,
        aggregate_type,aggregate_id,payload,payload_checksum)
      SELECT v_outbox_id,p_workspace_id,'reconcile-unknown-outcome',1,
        'node-attempt',p_target_id,payload,encode(sha256(convert_to(
          '{"attemptId":"'||p_target_id::text||'","evidenceCommandId":"'||p_command_id::text||
          '","outboxEventId":"'||v_outbox_id::text||'","schemaVersion":1,"workspaceId":"'||
          p_workspace_id::text||'"}','UTF8')),'hex')
      FROM (SELECT jsonb_build_object('attemptId',p_target_id,
        'evidenceCommandId',p_command_id,'outboxEventId',v_outbox_id,
        'schemaVersion',1,'workspaceId',p_workspace_id) payload) encoded;
    END IF;
    v_result:=jsonb_build_object('schemaVersion',1,'evidenceKind',p_evidence_kind,
      'outboxEventId',v_outbox_id,'outcome',v_outcome);
  END IF;

  INSERT INTO app.operator_commands(id,command_type,dry_run,request_fingerprint,
    status,outcome,result) VALUES(p_command_id,p_command_type,p_dry_run,
    v_fingerprint,'completed',v_outcome,v_result);
  INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,request_id,metadata)
  VALUES(gen_random_uuid(),p_workspace_id,'operator.'||replace(p_command_type,'.','_'),
    'operator-command-target',p_target_id,p_command_id::text,
    jsonb_build_object('actorRef',p_actor_ref,'dryRun',p_dry_run,
      'outcome',v_outcome,'reason',p_reason,'requestFingerprint',v_fingerprint));
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT p_command_id,'completed'::varchar,v_outcome,false,v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.reconcile_operator_attempt(uuid,uuid,uuid,bigint,varchar,varchar,varchar,boolean)
RETURNS TABLE(command_id uuid,command_status varchar,command_outcome varchar,replayed boolean,result jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app,pg_temp AS $$
  SELECT * FROM app.execute_operator_execution_command($1,'attempt.reconcile',$2,$3,$4,$5,NULL,NULL,$6,$7,$8)
$$;
CREATE FUNCTION app.resume_operator_due_work(uuid,uuid,uuid,varchar,varchar,boolean)
RETURNS TABLE(command_id uuid,command_status varchar,command_outcome varchar,replayed boolean,result jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app,pg_temp AS $$
  SELECT * FROM app.execute_operator_execution_command($1,'due-work.resume',$2,$3,NULL,NULL,NULL,NULL,$4,$5,$6)
$$;
CREATE FUNCTION app.record_operator_unknown_outcome_evidence(uuid,uuid,uuid,varchar,jsonb,varchar,varchar)
RETURNS TABLE(command_id uuid,command_status varchar,command_outcome varchar,replayed boolean,result jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app,pg_temp AS $$
  SELECT * FROM app.execute_operator_execution_command($1,'unknown-outcome.record-evidence',$2,$3,NULL,NULL,$4,$5,$6,$7,false)
$$;
CREATE FUNCTION app.cancel_operator_run(uuid,uuid,uuid,varchar,varchar,boolean)
RETURNS TABLE(command_id uuid,command_status varchar,command_outcome varchar,replayed boolean,result jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app,pg_temp AS $$
  SELECT * FROM app.execute_operator_execution_command($1,'run.cancel',$2,$3,NULL,NULL,NULL,NULL,$4,$5,$6)
$$;

REVOKE ALL ON app.operator_unknown_outcome_evidence FROM PUBLIC;
GRANT SELECT(command_id,workspace_id,attempt_id)
  ON app.operator_unknown_outcome_evidence TO {{worker_runtime_role}};
REVOKE ALL ON FUNCTION app.execute_operator_execution_command(
  uuid,varchar,uuid,uuid,bigint,varchar,varchar,jsonb,varchar,varchar,boolean
) FROM PUBLIC,{{operator_role}},{{api_runtime_role}},{{worker_runtime_role}},
  {{dispatcher_role}},{{maintenance_role}},{{lifecycle_command_role}};
REVOKE ALL ON FUNCTION app.reconcile_operator_attempt(uuid,uuid,uuid,bigint,varchar,varchar,varchar,boolean),
  app.resume_operator_due_work(uuid,uuid,uuid,varchar,varchar,boolean),
  app.record_operator_unknown_outcome_evidence(uuid,uuid,uuid,varchar,jsonb,varchar,varchar),
  app.cancel_operator_run(uuid,uuid,uuid,varchar,varchar,boolean)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.reconcile_operator_attempt(uuid,uuid,uuid,bigint,varchar,varchar,varchar,boolean),
  app.resume_operator_due_work(uuid,uuid,uuid,varchar,varchar,boolean),
  app.record_operator_unknown_outcome_evidence(uuid,uuid,uuid,varchar,jsonb,varchar,varchar),
  app.cancel_operator_run(uuid,uuid,uuid,varchar,varchar,boolean)
  TO {{operator_role}};
