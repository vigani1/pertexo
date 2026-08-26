-- ADR 013 first destructive retention category. The coordinator must hold the
-- workspace control lock while proving exact external-ledger high water before
-- invoking the page function.

ALTER TABLE app.retention_batches
  DROP CONSTRAINT retention_batches_dry_run_only,
  DROP CONSTRAINT retention_batches_status_valid,
  ADD COLUMN pause_reason varchar(32),
  ADD COLUMN paused_at timestamptz,
  ADD CONSTRAINT retention_batches_status_valid
    CHECK (status IN ('ready','running','paused','completed')),
  ADD CONSTRAINT retention_batches_pause_valid CHECK (
    (status='paused' AND pause_reason='legal_hold' AND paused_at IS NOT NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR (status<>'paused' AND pause_reason IS NULL AND paused_at IS NULL)
  );

DROP INDEX app.retention_batches_claim_idx;
CREATE INDEX retention_batches_claim_idx
  ON app.retention_batches (created_at,id)
  WHERE status IN ('ready','running','paused');

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
    OR p_retention_kind<>'workflow_run_input'
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
     requested_by,reason)
  VALUES (p_id,p_workspace_id,v_idempotency_key,p_retention_kind,p_cutoff_at,
    p_dry_run,v_requested_by,v_reason);
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  INSERT INTO app.audit_events
    (id,workspace_id,action,target_type,target_id,metadata)
  VALUES (gen_random_uuid(),p_workspace_id,'retention.batch_started',
    'retention-batch',p_id,
    jsonb_build_object('requestedBy',v_requested_by,'reason',v_reason,
      'retentionKind',p_retention_kind,'cutoffAt',p_cutoff_at,'dryRun',p_dry_run));
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN p_id;
EXCEPTION WHEN OTHERS THEN
  IF v_prior_workspace IS NOT NULL THEN
    PERFORM set_config('app.workspace_id',v_prior_workspace,true);
  END IF;
  RAISE;
END $$;

CREATE FUNCTION app.claim_retention_destructive_batches(
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
    RAISE EXCEPTION 'invalid destructive retention claim bounds' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.retention_batch_transition','on',true);
  RETURN QUERY WITH candidates AS (
    SELECT batch.id FROM app.retention_batches batch
    WHERE NOT batch.dry_run AND (
      batch.status='ready'
      OR (batch.status='running' AND batch.lease_expires_at<=v_now)
      OR (batch.status='paused' AND NOT EXISTS (
        SELECT 1 FROM app.workspace_legal_holds hold
        WHERE hold.workspace_id=batch.workspace_id AND hold.released_at IS NULL)))
    ORDER BY batch.created_at,batch.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE app.retention_batches batch SET status='running',
      pause_reason=NULL,paused_at=NULL,lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=batch.lease_fence+1,
      lease_acquired_at=v_now,
      lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),updated_at=v_now
    FROM candidates WHERE batch.id=candidates.id RETURNING batch.*
  ) SELECT claimed.id,claimed.workspace_id,claimed.retention_kind,claimed.cutoff_at,
      claimed.requested_by,claimed.reason,claimed.cursor_expires_at,claimed.cursor_id,
      claimed.lease_token,claimed.lease_fence,claimed.lease_expires_at
    FROM claimed ORDER BY claimed.created_at,claimed.id;
END $$;

CREATE FUNCTION app.release_retention_batch(
  p_batch_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_batch_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid retention release' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.retention_batch_transition','on',true);
  UPDATE app.retention_batches SET status='ready',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp()
  WHERE id=p_batch_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.execute_workflow_run_input_retention_page(
  p_batch_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_limit integer,
  p_expected_control_sequence bigint,p_expected_control_hash char(64)
) RETURNS TABLE(
  outcome varchar,examined_delta integer,eligible_delta integer,
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
    OR p_lease_fence<1 OR p_page_limit IS NULL OR p_page_limit NOT BETWEEN 1 AND 1000
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid destructive retention page' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM app.retention_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'running' OR v_batch.dry_run
    OR v_batch.retention_kind<>'workflow_run_input'
    OR v_batch.lease_token<>p_lease_token OR v_batch.lease_fence<>p_lease_fence
    OR v_batch.lease_expires_at<=clock_timestamp() THEN
    RETURN QUERY SELECT 'stale'::varchar,0,0,NULL::timestamptz,NULL::uuid;
    RETURN;
  END IF;
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=v_batch.workspace_id
      AND workspace.retention_control_sequence=p_expected_control_sequence
      AND workspace.retention_control_hash=p_expected_control_hash
    FOR UPDATE;
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

  WITH page_plus_one AS MATERIALIZED (
    SELECT run.input_ref_expires_at,run.id
    FROM app.workflow_runs run
    WHERE run.workspace_id=v_batch.workspace_id AND run.input_ref IS NOT NULL
      AND run.input_ref_expires_at<=v_batch.cutoff_at
      AND (v_batch.cursor_expires_at IS NULL
        OR (run.input_ref_expires_at,run.id)>(v_batch.cursor_expires_at,v_batch.cursor_id))
    ORDER BY run.input_ref_expires_at,run.id LIMIT p_page_limit+1
  ), page AS MATERIALIZED (
    SELECT * FROM page_plus_one ORDER BY input_ref_expires_at,id LIMIT p_page_limit
  ), cleared AS (
    UPDATE app.workflow_runs run SET input_ref=NULL,input_ref_expires_at=NULL,
      updated_at=clock_timestamp()
    FROM page WHERE run.id=page.id AND run.workspace_id=v_batch.workspace_id
      AND run.input_ref IS NOT NULL AND run.input_ref_expires_at=page.input_ref_expires_at
    RETURNING run.id
  ) SELECT (SELECT count(*)::integer FROM cleared),
      EXISTS(SELECT 1 FROM page_plus_one OFFSET p_page_limit),
      (SELECT input_ref_expires_at FROM page ORDER BY input_ref_expires_at DESC,id DESC LIMIT 1),
      (SELECT id FROM page ORDER BY input_ref_expires_at DESC,id DESC LIMIT 1)
    INTO v_count,v_has_more,v_last_expires_at,v_last_id;

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
      jsonb_build_object('retentionKind',v_batch.retention_kind,'dryRun',false,
        'examinedCount',v_batch.examined_count+v_count,
        'eligibleCount',v_batch.eligible_count+v_count));
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  END IF;
  RETURN QUERY SELECT CASE WHEN v_has_more THEN 'progressed' ELSE 'completed' END::varchar,
    v_count,v_count,v_last_expires_at,v_last_id;
EXCEPTION WHEN OTHERS THEN
  IF v_prior_workspace IS NOT NULL THEN
    PERFORM set_config('app.workspace_id',v_prior_workspace,true);
  END IF;
  RAISE;
END $$;

REVOKE EXECUTE ON FUNCTION
  app.claim_retention_batches(varchar,integer,integer),
  app.checkpoint_retention_batch(uuid,uuid,bigint,timestamptz,uuid,integer,integer,boolean)
  FROM {{maintenance_role}};
REVOKE ALL ON FUNCTION
  app.claim_retention_destructive_batches(varchar,integer,integer),
  app.release_retention_batch(uuid,uuid,bigint),
  app.execute_workflow_run_input_retention_page(uuid,uuid,bigint,integer,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION
  app.claim_retention_destructive_batches(varchar,integer,integer),
  app.release_retention_batch(uuid,uuid,bigint),
  app.execute_workflow_run_input_retention_page(uuid,uuid,bigint,integer,bigint,char)
  TO {{maintenance_role}};
