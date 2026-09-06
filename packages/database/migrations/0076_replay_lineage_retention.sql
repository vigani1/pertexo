-- Keep replay sources until every replay descendant is retention-eligible.
-- These forward replacements preserve the bounded, leased, high-water-fenced
-- retention state machine from 0055/0060 while extending both summary candidate
-- predicates for the replay lineage foreign key introduced by 0065.

-- Keep dry-run eligibility in lockstep with the destructive page. This is a
-- forward replacement because 0060 is already applied in deployed databases.
CREATE OR REPLACE FUNCTION app.standard_retention_dry_run_stage_keys(
  p_workspace_id uuid,p_retention_kind varchar,p_retention_stage varchar,
  p_cutoff_at timestamptz,p_cursor jsonb,p_upper jsonb,p_descending boolean,
  p_limit integer
) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_from text;
  v_filter text;
  v_eligible text:='true';
  v_key text;
  v_order text;
  v_typed_bounds text;
  v_typed_upper text;
BEGIN
  IF p_workspace_id IS NULL OR p_cutoff_at IS NULL OR p_descending IS NULL
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1001 THEN
    RAISE EXCEPTION 'invalid standard retention dry-run stage page' USING ERRCODE='22023';
  END IF;
  IF p_retention_kind='execution_detail' AND p_retention_stage='records' THEN
    v_from:='app.workflow_runs run';
    v_filter:='run.workspace_id=$1 AND run.details_purged_at IS NULL AND run.completed_at<=$2-interval ''30 days''';
    v_order:='run.completed_at,run.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(run.completed_at,run.id))';
    v_typed_bounds:='(run.completed_at,run.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (run.completed_at,run.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(run.completed_at,run.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='run_summary' AND p_retention_stage='records' THEN
    v_from:='app.workflow_runs run';
    v_filter:='run.workspace_id=$1 AND run.completed_at<=$2-interval ''90 days''';
    v_eligible:='run.details_purged_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.workflow_runs child WHERE child.workspace_id=run.workspace_id AND child.replay_source_run_id=run.id) AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_deliveries delivery WHERE delivery.workspace_id=run.workspace_id AND delivery.workflow_run_id=run.id) AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay WHERE replay.workspace_id=run.workspace_id AND replay.workflow_run_id=run.id) AND NOT EXISTS (SELECT 1 FROM app.trigger_schedule_occurrences occurrence WHERE occurrence.workspace_id=run.workspace_id AND occurrence.workflow_run_id=run.id)';
    v_order:='run.completed_at,run.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(run.completed_at,run.id))';
    v_typed_bounds:='(run.completed_at,run.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (run.completed_at,run.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(run.completed_at,run.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='trigger_summary' AND p_retention_stage='replay' THEN
    v_from:='app.webhook_trigger_replay_records replay';
    v_filter:='replay.workspace_id=$1 AND replay.expires_at<=$2';
    v_order:='replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid_text_text'',''values'',jsonb_build_array(replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash))';
    v_typed_bounds:='(replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid,$3->''values''->>2,$3->''values''->>3) AND (replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid,$4->''values''->>2,$4->''values''->>3)';
    v_typed_upper:='(replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid,$4->''values''->>2,$4->''values''->>3)';
  ELSIF p_retention_kind='trigger_summary' AND p_retention_stage='deliveries' THEN
    v_from:='app.webhook_trigger_deliveries delivery';
    v_filter:='delivery.workspace_id=$1 AND delivery.expires_at<=$2';
    v_eligible:='NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay WHERE replay.workspace_id=delivery.workspace_id AND replay.delivery_id=delivery.id AND replay.expires_at>$2)';
    v_order:='delivery.expires_at,delivery.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(delivery.expires_at,delivery.id))';
    v_typed_bounds:='(delivery.expires_at,delivery.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (delivery.expires_at,delivery.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(delivery.expires_at,delivery.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='trigger_summary' AND p_retention_stage='occurrences' THEN
    v_from:='app.trigger_schedule_occurrences occurrence';
    v_filter:='occurrence.workspace_id=$1 AND occurrence.scheduled_at<=$2-interval ''90 days''';
    v_order:='occurrence.scheduled_at,occurrence.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(occurrence.scheduled_at,occurrence.id))';
    v_typed_bounds:='(occurrence.scheduled_at,occurrence.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (occurrence.scheduled_at,occurrence.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(occurrence.scheduled_at,occurrence.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='audit_security' AND p_retention_stage='audit' THEN
    v_from:='app.audit_events audit';
    v_filter:='audit.workspace_id=$1 AND audit.occurred_at<=$2-interval ''365 days''';
    v_order:='audit.occurred_at,audit.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(audit.occurred_at,audit.id))';
    v_typed_bounds:='(audit.occurred_at,audit.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (audit.occurred_at,audit.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(audit.occurred_at,audit.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='audit_security' AND p_retention_stage='transport' THEN
    v_from:='app.transport_security_audit_facts fact';
    v_filter:='fact.workspace_id=$1 AND fact.occurred_at<=$2-interval ''365 days''';
    v_order:='fact.occurred_at,fact.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(fact.occurred_at,fact.id))';
    v_typed_bounds:='(fact.occurred_at,fact.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (fact.occurred_at,fact.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(fact.occurred_at,fact.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSE
    RAISE EXCEPTION 'invalid standard retention dry-run stage' USING ERRCODE='22023';
  END IF;
  IF p_descending THEN
    RETURN QUERY EXECUTE 'SELECT jsonb_build_object(''key'','||v_key
      ||',''eligible'',('||v_eligible||')) FROM '||v_from||' WHERE '||v_filter
      ||' ORDER BY '||replace(v_order,',',' DESC,')||' DESC LIMIT $5'
      USING p_workspace_id,p_cutoff_at,p_cursor,p_upper,p_limit;
  ELSIF p_upper IS NOT NULL THEN
    RETURN QUERY EXECUTE 'SELECT jsonb_build_object(''key'','||v_key
      ||',''eligible'',('||v_eligible||')) FROM '||v_from||' WHERE '||v_filter
      ||' AND ('||CASE WHEN p_cursor IS NULL THEN v_typed_upper ELSE v_typed_bounds END
      ||') ORDER BY '||v_order||' LIMIT $5'
      USING p_workspace_id,p_cutoff_at,p_cursor,p_upper,p_limit;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.execute_standard_retention_page(
  p_batch_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_limit integer,
  p_expected_control_sequence bigint,p_expected_control_hash char(64)
) RETURNS TABLE(outcome varchar,examined_delta integer,eligible_delta integer,
  cursor_expires_at timestamptz,cursor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_batch app.retention_batches%ROWTYPE;
  v_count integer:=0;
  v_next_stage varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  IF p_batch_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 OR p_page_limit IS NULL OR p_page_limit NOT BETWEEN 1 AND 1000
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid standard retention page' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM app.retention_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'running' OR v_batch.dry_run
    OR v_batch.retention_kind NOT IN ('execution_detail','run_summary',
      'trigger_summary','audit_security')
    OR v_batch.lease_token<>p_lease_token OR v_batch.lease_fence<>p_lease_fence
    OR v_batch.lease_expires_at<=clock_timestamp() THEN
    RETURN QUERY SELECT 'stale'::varchar,0,0,NULL::timestamptz,NULL::uuid;
    RETURN;
  END IF;
  PERFORM set_config('app.workspace_id',v_batch.workspace_id::text,true);
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_batch.workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_batch.workspace_id AND hold.released_at IS NULL) THEN
    PERFORM set_config('app.retention_batch_transition','on',true);
    UPDATE app.retention_batches SET status='paused',pause_reason='legal_hold',
      paused_at=clock_timestamp(),lease_owner=NULL,lease_token=NULL,
      lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=p_batch_id;
    RETURN QUERY SELECT 'paused'::varchar,0,0,NULL::timestamptz,NULL::uuid;
    RETURN;
  END IF;

  IF v_batch.retention_kind='execution_detail' THEN
    IF v_batch.retention_stage='attempts' THEN
      WITH candidates AS MATERIALIZED (SELECT attempt.id FROM app.node_attempts attempt
        JOIN app.node_runs node ON node.id=attempt.node_run_id
        JOIN app.workflow_runs run ON run.id=node.workflow_run_id
        WHERE attempt.workspace_id=v_batch.workspace_id
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
        ORDER BY attempt.id LIMIT p_page_limit), cleared AS (
        UPDATE app.node_runs node SET current_attempt_id=NULL,current_attempt_number=NULL,
          updated_at=clock_timestamp() WHERE node.current_attempt_id IN (SELECT id FROM candidates)
      ), removed AS (DELETE FROM app.node_attempts WHERE id IN (SELECT id FROM candidates)
        RETURNING id) SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='node_runs';
    ELSIF v_batch.retention_stage='node_runs' THEN
      WITH candidates AS MATERIALIZED (SELECT node.id FROM app.node_runs node
        JOIN app.workflow_runs run ON run.id=node.workflow_run_id
        WHERE node.workspace_id=v_batch.workspace_id
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
        ORDER BY node.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.node_runs WHERE id IN (SELECT id FROM candidates) RETURNING id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='events';
    ELSIF v_batch.retention_stage='events' THEN
      WITH candidates AS MATERIALIZED (SELECT event.workflow_run_id,event.sequence
        FROM app.run_events event JOIN app.workflow_runs run ON run.id=event.workflow_run_id
        WHERE event.workspace_id=v_batch.workspace_id
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
        ORDER BY event.workflow_run_id,event.sequence LIMIT p_page_limit), removed AS (
        DELETE FROM app.run_events event USING candidates
        WHERE event.workflow_run_id=candidates.workflow_run_id
          AND event.sequence=candidates.sequence RETURNING event.sequence)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='checkpoints';
    ELSIF v_batch.retention_stage='checkpoints' THEN
      WITH candidates AS MATERIALIZED (SELECT checkpoint.workflow_run_id
        FROM app.run_checkpoints checkpoint JOIN app.workflow_runs run
          ON run.id=checkpoint.workflow_run_id
        WHERE checkpoint.workspace_id=v_batch.workspace_id
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
        ORDER BY checkpoint.workflow_run_id LIMIT p_page_limit), removed AS (
        DELETE FROM app.run_checkpoints checkpoint USING candidates
        WHERE checkpoint.workflow_run_id=candidates.workflow_run_id
        RETURNING checkpoint.workflow_run_id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='summaries';
    ELSE
      WITH candidates AS MATERIALIZED (SELECT run.id FROM app.workflow_runs run
        WHERE run.workspace_id=v_batch.workspace_id AND run.details_purged_at IS NULL
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
        ORDER BY run.completed_at,run.id LIMIT p_page_limit), changed AS (
        UPDATE app.workflow_runs run SET output_ref=NULL,error_summary=NULL,
          cancel_reason=NULL,details_purged_at=clock_timestamp(),updated_at=clock_timestamp()
        FROM candidates WHERE run.id=candidates.id RETURNING run.id)
        SELECT count(*)::integer INTO v_count FROM changed;
      v_next_stage:=NULL;
    END IF;
  ELSIF v_batch.retention_kind='trigger_summary' THEN
    IF v_batch.retention_stage='replay' THEN
      WITH candidates AS MATERIALIZED (SELECT replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash
        FROM app.webhook_trigger_replay_records replay
        WHERE replay.workspace_id=v_batch.workspace_id AND replay.expires_at<=v_batch.cutoff_at
        ORDER BY replay.expires_at,replay.endpoint_id LIMIT p_page_limit), removed AS (
        DELETE FROM app.webhook_trigger_replay_records replay USING candidates
        WHERE replay.endpoint_id=candidates.endpoint_id AND replay.dedupe_kind=candidates.dedupe_kind
          AND replay.dedupe_key_hash=candidates.dedupe_key_hash RETURNING replay.endpoint_id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='deliveries';
    ELSIF v_batch.retention_stage='deliveries' THEN
      WITH candidates AS MATERIALIZED (SELECT delivery.id FROM app.webhook_trigger_deliveries delivery
        WHERE delivery.workspace_id=v_batch.workspace_id AND delivery.expires_at<=v_batch.cutoff_at
          AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay
            WHERE replay.workspace_id=delivery.workspace_id AND replay.delivery_id=delivery.id)
        ORDER BY delivery.expires_at,delivery.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.webhook_trigger_deliveries delivery USING candidates
        WHERE delivery.id=candidates.id RETURNING delivery.id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='occurrences';
    ELSE
      WITH candidates AS MATERIALIZED (SELECT occurrence.id FROM app.trigger_schedule_occurrences occurrence
        WHERE occurrence.workspace_id=v_batch.workspace_id
          AND occurrence.scheduled_at<=v_batch.cutoff_at-interval '90 days'
        ORDER BY occurrence.scheduled_at,occurrence.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.trigger_schedule_occurrences occurrence USING candidates
        WHERE occurrence.id=candidates.id RETURNING occurrence.id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:=NULL;
    END IF;
  ELSIF v_batch.retention_kind='run_summary' THEN
    WITH candidates AS MATERIALIZED (SELECT run.id FROM app.workflow_runs run
      WHERE run.workspace_id=v_batch.workspace_id
        AND run.completed_at<=v_batch.cutoff_at-interval '90 days'
        AND run.details_purged_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM app.workflow_runs child
          WHERE child.workspace_id=run.workspace_id
            AND child.replay_source_run_id=run.id)
        AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_deliveries delivery
          WHERE delivery.workspace_id=run.workspace_id AND delivery.workflow_run_id=run.id)
        AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay
          WHERE replay.workspace_id=run.workspace_id AND replay.workflow_run_id=run.id)
        AND NOT EXISTS (SELECT 1 FROM app.trigger_schedule_occurrences occurrence
          WHERE occurrence.workspace_id=run.workspace_id AND occurrence.workflow_run_id=run.id)
      ORDER BY run.completed_at,run.id LIMIT p_page_limit), removed AS (
      DELETE FROM app.workflow_runs run USING candidates WHERE run.id=candidates.id RETURNING run.id)
      SELECT count(*)::integer INTO v_count FROM removed;
    v_next_stage:=NULL;
  ELSE
    IF v_batch.retention_stage='audit' THEN
      WITH candidates AS MATERIALIZED (SELECT audit.id FROM app.audit_events audit
        WHERE audit.workspace_id=v_batch.workspace_id
          AND audit.occurred_at<=v_batch.cutoff_at-interval '365 days'
        ORDER BY audit.occurred_at,audit.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.audit_events audit USING candidates WHERE audit.id=candidates.id RETURNING audit.id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='transport';
    ELSE
      WITH candidates AS MATERIALIZED (SELECT fact.id FROM app.transport_security_audit_facts fact
        WHERE fact.workspace_id=v_batch.workspace_id
          AND fact.occurred_at<=v_batch.cutoff_at-interval '365 days'
        ORDER BY fact.occurred_at,fact.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.transport_security_audit_facts fact USING candidates
        WHERE fact.id=candidates.id RETURNING fact.id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:=NULL;
    END IF;
  END IF;

  PERFORM set_config('app.retention_batch_transition','on',true);
  IF v_count=0 AND v_next_stage IS NULL THEN
    UPDATE app.retention_batches SET status='completed',completed_at=clock_timestamp(),
      lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
      updated_at=clock_timestamp() WHERE id=p_batch_id;
    INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,metadata)
    VALUES(gen_random_uuid(),v_batch.workspace_id,'retention.batch_completed',
      'retention-batch',p_batch_id,jsonb_build_object('retentionKind',v_batch.retention_kind,
      'dryRun',false,'examinedCount',v_batch.examined_count,'eligibleCount',v_batch.eligible_count));
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT 'completed'::varchar,0,0,NULL::timestamptz,NULL::uuid;
    RETURN;
  END IF;
  UPDATE app.retention_batches SET
    retention_stage=CASE WHEN v_count=0 THEN v_next_stage ELSE retention_stage END,
    examined_count=examined_count+v_count,eligible_count=eligible_count+v_count,
    updated_at=clock_timestamp() WHERE id=p_batch_id;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT 'progressed'::varchar,v_count,v_count,NULL::timestamptz,NULL::uuid;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

REVOKE ALL ON FUNCTION app.execute_standard_retention_page(uuid,uuid,bigint,integer,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.execute_standard_retention_page(uuid,uuid,bigint,integer,bigint,char)
  TO {{maintenance_role}};
