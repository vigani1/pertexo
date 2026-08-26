-- Inventory every standard retention class without changing source rows. Each
-- stage freezes one typed high-water tuple, then scans only that stage by typed
-- keyset comparisons and a hard page-plus-one limit.

ALTER TABLE app.retention_batches
  ADD COLUMN dry_run_cursor jsonb,
  ADD COLUMN dry_run_upper jsonb,
  ADD CONSTRAINT retention_batches_dry_run_cursor_object
    CHECK (dry_run_cursor IS NULL OR jsonb_typeof(dry_run_cursor)='object'),
  ADD CONSTRAINT retention_batches_dry_run_upper_object
    CHECK (dry_run_upper IS NULL OR jsonb_typeof(dry_run_upper)='object');

CREATE INDEX webhook_replay_retention_dry_run_idx
  ON app.webhook_trigger_replay_records
    (workspace_id,expires_at,endpoint_id,dedupe_kind,dedupe_key_hash);
CREATE INDEX webhook_deliveries_retention_dry_run_idx
  ON app.webhook_trigger_deliveries(workspace_id,expires_at,id);
CREATE INDEX schedule_occurrences_retention_dry_run_idx
  ON app.trigger_schedule_occurrences(workspace_id,scheduled_at,id);
CREATE INDEX transport_audit_retention_dry_run_idx
  ON app.transport_security_audit_facts(workspace_id,occurred_at,id);
CREATE INDEX webhook_deliveries_run_retention_idx
  ON app.webhook_trigger_deliveries(workspace_id,workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX webhook_replay_run_retention_idx
  ON app.webhook_trigger_replay_records(workspace_id,workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX webhook_replay_delivery_retention_idx
  ON app.webhook_trigger_replay_records(workspace_id,delivery_id,expires_at)
  WHERE delivery_id IS NOT NULL;
CREATE INDEX schedule_occurrences_run_retention_idx
  ON app.trigger_schedule_occurrences(workspace_id,workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;

CREATE FUNCTION app.standard_retention_dry_run_stage_keys(
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
    v_eligible:='run.details_purged_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_deliveries delivery WHERE delivery.workspace_id=run.workspace_id AND delivery.workflow_run_id=run.id) AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay WHERE replay.workspace_id=run.workspace_id AND replay.workflow_run_id=run.id) AND NOT EXISTS (SELECT 1 FROM app.trigger_schedule_occurrences occurrence WHERE occurrence.workspace_id=run.workspace_id AND occurrence.workflow_run_id=run.id)';
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

CREATE FUNCTION app.execute_standard_retention_dry_run_page(
  p_batch_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_limit integer
) RETURNS TABLE(outcome varchar,examined_delta integer,eligible_delta integer,
  retention_stage varchar,dry_run_cursor jsonb,dry_run_upper jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_batch app.retention_batches%ROWTYPE;
  v_count integer:=0;
  v_eligible_count integer:=0;
  v_has_more boolean:=false;
  v_keys jsonb[];
  v_last_key jsonb;
  v_next_stage varchar(32);
  v_upper jsonb;
  v_cursor jsonb;
  v_completed boolean:=false;
  v_prior_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  IF p_batch_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 OR p_page_limit IS NULL OR p_page_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid standard retention dry-run page' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM app.retention_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'running' OR NOT v_batch.dry_run
    OR v_batch.retention_kind NOT IN ('execution_detail','run_summary',
      'trigger_summary','audit_security')
    OR v_batch.lease_token<>p_lease_token OR v_batch.lease_fence<>p_lease_fence
    OR v_batch.lease_expires_at<=clock_timestamp() THEN
    RETURN QUERY SELECT 'stale'::varchar,0,0,NULL::varchar,NULL::jsonb,NULL::jsonb;
    RETURN;
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_batch.workspace_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention workspace does not exist' USING ERRCODE='23503';
  END IF;
  PERFORM set_config('app.workspace_id',v_batch.workspace_id::text,true);

  IF v_batch.dry_run_upper IS NULL THEN
    SELECT stage_entry->'key' INTO v_upper
    FROM app.standard_retention_dry_run_stage_keys(v_batch.workspace_id,
      v_batch.retention_kind,v_batch.retention_stage,v_batch.cutoff_at,
      NULL,NULL,true,1) stage_entry;
  ELSE
    v_upper:=v_batch.dry_run_upper;
  END IF;
  v_cursor:=v_batch.dry_run_cursor;

  SELECT array_agg(stage_entry) INTO v_keys
  FROM app.standard_retention_dry_run_stage_keys(v_batch.workspace_id,
    v_batch.retention_kind,v_batch.retention_stage,v_batch.cutoff_at,
    v_cursor,v_upper,false,p_page_limit+1) stage_entry;
  v_count:=least(coalesce(cardinality(v_keys),0),p_page_limit);
  v_has_more:=coalesce(cardinality(v_keys),0)>p_page_limit;
  IF v_count>0 THEN
    v_last_key:=v_keys[v_count]->'key';
    v_cursor:=v_last_key;
  END IF;
  SELECT count(*)::integer INTO v_eligible_count
  FROM unnest(coalesce(v_keys,ARRAY[]::jsonb[])) WITH ORDINALITY entry(value,ordinal)
  WHERE entry.ordinal<=p_page_limit AND (entry.value->>'eligible')::boolean;

  IF NOT v_has_more THEN
    v_next_stage:=CASE v_batch.retention_kind
      WHEN 'trigger_summary' THEN CASE v_batch.retention_stage
        WHEN 'replay' THEN 'deliveries' WHEN 'deliveries' THEN 'occurrences' END
      WHEN 'audit_security' THEN CASE v_batch.retention_stage
        WHEN 'audit' THEN 'transport' END
      ELSE NULL END;
    v_completed:=v_next_stage IS NULL;
  END IF;

  PERFORM set_config('app.retention_batch_transition','on',true);
  UPDATE app.retention_batches batch SET
    dry_run_upper=CASE WHEN NOT v_has_more AND NOT v_completed THEN NULL ELSE v_upper END,
    dry_run_cursor=CASE WHEN NOT v_has_more AND NOT v_completed THEN NULL ELSE v_cursor END,
    retention_stage=CASE WHEN NOT v_has_more AND NOT v_completed
      THEN v_next_stage ELSE batch.retention_stage END,
    examined_count=batch.examined_count+v_count,
    eligible_count=batch.eligible_count+v_eligible_count,
    status=CASE WHEN v_completed THEN 'completed' ELSE batch.status END,
    completed_at=CASE WHEN v_completed THEN clock_timestamp() ELSE NULL END,
    lease_owner=CASE WHEN v_completed THEN NULL ELSE batch.lease_owner END,
    lease_token=CASE WHEN v_completed THEN NULL ELSE batch.lease_token END,
    lease_acquired_at=CASE WHEN v_completed THEN NULL ELSE batch.lease_acquired_at END,
    lease_expires_at=CASE WHEN v_completed THEN NULL ELSE batch.lease_expires_at END,
    updated_at=clock_timestamp() WHERE batch.id=p_batch_id;
  IF v_completed THEN
    INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,metadata)
    VALUES(gen_random_uuid(),v_batch.workspace_id,'retention.batch_completed',
      'retention-batch',p_batch_id,jsonb_build_object('retentionKind',v_batch.retention_kind,
      'dryRun',true,'examinedCount',v_batch.examined_count+v_count,
      'eligibleCount',v_batch.eligible_count+v_eligible_count));
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT CASE WHEN v_completed THEN 'completed' ELSE 'progressed' END::varchar,
    v_count,v_eligible_count,CASE WHEN NOT v_has_more AND NOT v_completed THEN v_next_stage
      ELSE v_batch.retention_stage END,
    CASE WHEN NOT v_has_more AND NOT v_completed THEN NULL ELSE v_cursor END,
    CASE WHEN NOT v_has_more AND NOT v_completed THEN NULL ELSE v_upper END;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.start_retention_batch(
  p_id uuid,p_workspace_id uuid,p_idempotency_key varchar,
  p_retention_kind varchar,p_cutoff_at timestamptz,p_dry_run boolean,
  p_requested_by varchar,p_reason varchar
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_existing app.retention_batches%ROWTYPE;
  v_idempotency_key varchar(128);
  v_requested_by varchar(128);
  v_reason varchar(512);
  v_prior_workspace text;
BEGIN
  IF p_id IS NULL OR p_workspace_id IS NULL OR p_idempotency_key IS NULL
    OR p_retention_kind IS NULL OR p_cutoff_at IS NULL OR p_dry_run IS NULL
    OR p_requested_by IS NULL OR p_reason IS NULL
    OR length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 128
    OR length(btrim(p_requested_by)) NOT BETWEEN 1 AND 128
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 512
    OR p_retention_kind NOT IN ('workflow_run_input','execution_detail',
      'run_summary','trigger_summary','audit_security')
    OR (NOT p_dry_run AND p_cutoff_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'invalid retention batch' USING ERRCODE='22023';
  END IF;
  v_idempotency_key:=btrim(p_idempotency_key);
  v_requested_by:=btrim(p_requested_by);
  v_reason:=btrim(p_reason);
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace does not exist' USING ERRCODE='23503';
  END IF;
  SELECT * INTO v_existing FROM app.retention_batches
    WHERE workspace_id=p_workspace_id AND idempotency_key=v_idempotency_key;
  IF FOUND THEN
    IF v_existing.id=p_id AND v_existing.retention_kind=p_retention_kind
      AND v_existing.cutoff_at=p_cutoff_at AND v_existing.dry_run=p_dry_run
      AND v_existing.requested_by=v_requested_by AND v_existing.reason=v_reason THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'retention batch replay conflicts with existing request'
      USING ERRCODE='23505';
  END IF;
  INSERT INTO app.retention_batches
    (id,workspace_id,idempotency_key,retention_kind,cutoff_at,dry_run,
     requested_by,reason,retention_stage)
  VALUES (p_id,p_workspace_id,v_idempotency_key,p_retention_kind,p_cutoff_at,
    p_dry_run,v_requested_by,v_reason,
    CASE WHEN p_dry_run AND p_retention_kind='execution_detail' THEN 'records'
      WHEN p_retention_kind='execution_detail' THEN 'attempts'
      WHEN p_retention_kind='trigger_summary' THEN 'replay'
      WHEN p_retention_kind='audit_security' THEN 'audit'
      ELSE 'records' END);
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,metadata)
  VALUES(gen_random_uuid(),p_workspace_id,'retention.batch_started','retention-batch',p_id,
    jsonb_build_object('requestedBy',v_requested_by,'reason',v_reason,
      'retentionKind',p_retention_kind,'cutoffAt',p_cutoff_at,'dryRun',p_dry_run));
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN p_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

DROP FUNCTION app.claim_retention_dry_run_batches(varchar,integer,integer);
CREATE FUNCTION app.claim_retention_dry_run_batches(
  p_lease_owner varchar,p_limit integer,p_lease_seconds integer
) RETURNS TABLE(batch_id uuid,workspace_id uuid,retention_kind varchar,
  cutoff_at timestamptz,requested_by varchar,reason varchar,
  cursor_expires_at timestamptz,cursor_id uuid,dry_run_cursor jsonb,
  dry_run_upper jsonb,lease_token uuid,lease_fence bigint,lease_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid retention dry-run claim bounds' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.retention_batch_transition','on',true);
  RETURN QUERY WITH candidates AS (SELECT batch.id FROM app.retention_batches batch
    WHERE batch.dry_run AND (batch.status='ready'
      OR (batch.status='running' AND batch.lease_expires_at<=v_now))
    ORDER BY batch.created_at,batch.id LIMIT p_limit FOR UPDATE SKIP LOCKED), claimed AS (
    UPDATE app.retention_batches batch SET status='running',
      lease_owner=btrim(p_lease_owner),lease_token=gen_random_uuid(),
      lease_fence=batch.lease_fence+1,lease_acquired_at=v_now,
      lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),updated_at=v_now
    FROM candidates WHERE batch.id=candidates.id RETURNING batch.*)
  SELECT claimed.id,claimed.workspace_id,claimed.retention_kind,claimed.cutoff_at,
    claimed.requested_by,claimed.reason,claimed.cursor_expires_at,claimed.cursor_id,
    claimed.dry_run_cursor,claimed.dry_run_upper,claimed.lease_token,
    claimed.lease_fence,claimed.lease_expires_at
  FROM claimed ORDER BY claimed.created_at,claimed.id;
END $$;

REVOKE ALL ON FUNCTION app.standard_retention_dry_run_stage_keys(uuid,varchar,varchar,timestamptz,jsonb,jsonb,boolean,integer),
  app.execute_standard_retention_dry_run_page(uuid,uuid,bigint,integer),
  app.claim_retention_dry_run_batches(varchar,integer,integer)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}},{{maintenance_role}};
GRANT EXECUTE ON FUNCTION
  app.execute_standard_retention_dry_run_page(uuid,uuid,bigint,integer),
  app.claim_retention_dry_run_batches(varchar,integer,integer)
  TO {{maintenance_role}};
