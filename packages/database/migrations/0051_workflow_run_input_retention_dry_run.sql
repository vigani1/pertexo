-- ADR 013 dry-run execution. This function inventories due workflow-run inputs
-- and checkpoints bounded progress without deleting or clearing tenant data.

CREATE FUNCTION app.execute_workflow_run_input_retention_dry_run_page(
  p_batch_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_limit integer
) RETURNS TABLE(
  examined_delta integer,eligible_delta integer,completed boolean,
  cursor_expires_at timestamptz,cursor_id uuid
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_batch app.retention_batches%ROWTYPE;
  v_count integer;
  v_has_more boolean;
  v_last_expires_at timestamptz;
  v_last_id uuid;
  v_prior_workspace text;
BEGIN
  IF p_batch_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 OR p_page_limit IS NULL OR p_page_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid retention dry-run page' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_batch FROM app.retention_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'running' OR NOT v_batch.dry_run
    OR v_batch.retention_kind<>'workflow_run_input'
    OR v_batch.lease_token<>p_lease_token OR v_batch.lease_fence<>p_lease_fence
    OR v_batch.lease_expires_at<=clock_timestamp() THEN
    RETURN QUERY SELECT 0,0,false,NULL::timestamptz,NULL::uuid;
    RETURN;
  END IF;

  PERFORM 1 FROM app.workspaces WHERE id=v_batch.workspace_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention workspace does not exist' USING ERRCODE='23503';
  END IF;

  WITH page_plus_one AS MATERIALIZED (
    SELECT run.input_ref_expires_at,run.id
    FROM app.workflow_runs run
    WHERE run.workspace_id=v_batch.workspace_id AND run.input_ref IS NOT NULL
      AND run.input_ref_expires_at<=v_batch.cutoff_at
      AND (v_batch.cursor_expires_at IS NULL
        OR (run.input_ref_expires_at,run.id)>(v_batch.cursor_expires_at,v_batch.cursor_id))
    ORDER BY run.input_ref_expires_at,run.id
    LIMIT p_page_limit+1
  ), page AS MATERIALIZED (
    SELECT * FROM page_plus_one
    ORDER BY input_ref_expires_at,id LIMIT p_page_limit
  )
  SELECT count(*)::integer,
    EXISTS(SELECT 1 FROM page_plus_one OFFSET p_page_limit),
    (SELECT input_ref_expires_at FROM page ORDER BY input_ref_expires_at DESC,id DESC LIMIT 1),
    (SELECT id FROM page ORDER BY input_ref_expires_at DESC,id DESC LIMIT 1)
  INTO v_count,v_has_more,v_last_expires_at,v_last_id FROM page;

  PERFORM set_config('app.retention_batch_transition','on',true);
  UPDATE app.retention_batches batch SET
    cursor_expires_at=coalesce(v_last_expires_at,batch.cursor_expires_at),
    cursor_id=coalesce(v_last_id,batch.cursor_id),
    examined_count=batch.examined_count+v_count,
    eligible_count=batch.eligible_count+v_count,
    status=CASE WHEN NOT v_has_more THEN 'completed' ELSE batch.status END,
    completed_at=CASE WHEN NOT v_has_more THEN clock_timestamp() ELSE NULL END,
    lease_owner=CASE WHEN NOT v_has_more THEN NULL ELSE batch.lease_owner END,
    lease_token=CASE WHEN NOT v_has_more THEN NULL ELSE batch.lease_token END,
    lease_acquired_at=CASE WHEN NOT v_has_more THEN NULL ELSE batch.lease_acquired_at END,
    lease_expires_at=CASE WHEN NOT v_has_more THEN NULL ELSE batch.lease_expires_at END,
    updated_at=clock_timestamp()
  WHERE batch.id=p_batch_id;

  IF NOT v_has_more THEN
    v_prior_workspace:=current_setting('app.workspace_id',true);
    PERFORM set_config('app.workspace_id',v_batch.workspace_id::text,true);
    INSERT INTO app.audit_events
      (id,workspace_id,action,target_type,target_id,metadata)
    VALUES (gen_random_uuid(),v_batch.workspace_id,'retention.batch_completed',
      'retention-batch',p_batch_id,
      jsonb_build_object('retentionKind',v_batch.retention_kind,'dryRun',true,
        'examinedCount',v_batch.examined_count+v_count,
        'eligibleCount',v_batch.eligible_count+v_count));
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  END IF;

  RETURN QUERY SELECT v_count,v_count,NOT v_has_more,v_last_expires_at,v_last_id;
EXCEPTION WHEN OTHERS THEN
  IF v_prior_workspace IS NOT NULL THEN
    PERFORM set_config('app.workspace_id',v_prior_workspace,true);
  END IF;
  RAISE;
END $$;

CREATE FUNCTION app.claim_retention_dry_run_batches(
  p_lease_owner varchar,p_limit integer,p_lease_seconds integer
) RETURNS TABLE(
  batch_id uuid,workspace_id uuid,retention_kind varchar,cutoff_at timestamptz,
  requested_by varchar,reason varchar,cursor_expires_at timestamptz,cursor_id uuid,
  lease_token uuid,lease_fence bigint,lease_expires_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid retention dry-run claim bounds' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.retention_batch_transition','on',true);
  RETURN QUERY WITH candidates AS (
    SELECT batch.id FROM app.retention_batches batch
    WHERE batch.dry_run AND (batch.status='ready'
      OR (batch.status='running' AND batch.lease_expires_at<=v_now))
    ORDER BY batch.created_at,batch.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE app.retention_batches batch SET status='running',
      lease_owner=btrim(p_lease_owner),lease_token=gen_random_uuid(),
      lease_fence=batch.lease_fence+1,lease_acquired_at=v_now,
      lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),updated_at=v_now
    FROM candidates WHERE batch.id=candidates.id RETURNING batch.*
  ) SELECT claimed.id,claimed.workspace_id,claimed.retention_kind,claimed.cutoff_at,
      claimed.requested_by,claimed.reason,claimed.cursor_expires_at,claimed.cursor_id,
      claimed.lease_token,claimed.lease_fence,claimed.lease_expires_at
    FROM claimed ORDER BY claimed.created_at,claimed.id;
END $$;

REVOKE ALL ON FUNCTION
  app.execute_workflow_run_input_retention_dry_run_page(uuid,uuid,bigint,integer),
  app.claim_retention_dry_run_batches(varchar,integer,integer)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION
  app.execute_workflow_run_input_retention_dry_run_page(uuid,uuid,bigint,integer),
  app.claim_retention_dry_run_batches(varchar,integer,integer)
  TO {{maintenance_role}};
