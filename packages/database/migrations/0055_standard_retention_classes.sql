-- Complete PostgreSQL-resident ADR 013 retention classes. Every destructive
-- page remains workspace-lock serialized and externally high-water gated.

ALTER TABLE app.retention_batches
  DROP CONSTRAINT retention_batches_kind_valid,
  ADD COLUMN retention_stage varchar(32) NOT NULL DEFAULT 'records',
  ADD CONSTRAINT retention_batches_kind_valid CHECK (retention_kind IN (
    'workflow_run_input','execution_detail','run_summary','trigger_summary',
    'audit_security'
  ));

ALTER TABLE app.workflow_runs ADD COLUMN details_purged_at timestamptz;
CREATE INDEX workflow_runs_detail_retention_idx
  ON app.workflow_runs(workspace_id,completed_at,id)
  WHERE completed_at IS NOT NULL AND details_purged_at IS NULL;
CREATE INDEX workflow_runs_summary_retention_idx
  ON app.workflow_runs(workspace_id,completed_at,id)
  WHERE completed_at IS NOT NULL;

ALTER TABLE app.retention_schedule_state
  DROP CONSTRAINT retention_schedule_state_pkey,
  DROP CONSTRAINT retention_schedule_state_kind_valid,
  ALTER COLUMN retention_kind DROP DEFAULT,
  ADD CONSTRAINT retention_schedule_state_pkey
    PRIMARY KEY(workspace_id,retention_kind),
  ADD CONSTRAINT retention_schedule_state_kind_valid CHECK (retention_kind IN (
    'workflow_run_input','execution_detail','run_summary','trigger_summary',
    'audit_security'
  ));

CREATE OR REPLACE FUNCTION app.provision_retention_schedule_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  INSERT INTO app.retention_schedule_state(workspace_id,retention_kind)
  SELECT NEW.id,kind FROM (VALUES ('workflow_run_input'),('execution_detail'),
    ('run_summary'),('trigger_summary'),('audit_security')) kinds(kind)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

INSERT INTO app.retention_schedule_state(workspace_id,retention_kind)
SELECT workspace.id,kind FROM app.workspaces workspace CROSS JOIN
  (VALUES ('execution_detail'),('run_summary'),('trigger_summary'),
    ('audit_security')) kinds(kind)
ON CONFLICT DO NOTHING;

CREATE POLICY node_runs_retention_scope ON app.node_runs
  FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_runs_retention_delete_scope ON app.workflow_runs
  FOR DELETE TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY node_attempts_retention_scope ON app.node_attempts
  FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY run_events_retention_scope ON app.run_events
  FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY run_checkpoints_retention_scope ON app.run_checkpoints
  FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_trigger_deliveries_retention_scope
  ON app.webhook_trigger_deliveries FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_trigger_replay_records_retention_scope
  ON app.webhook_trigger_replay_records FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY trigger_schedule_occurrences_retention_scope
  ON app.trigger_schedule_occurrences FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY audit_events_retention_scope ON app.audit_events
  FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY transport_security_audit_facts_retention_scope
  ON app.transport_security_audit_facts FOR ALL TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));

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
    OR (p_dry_run AND p_retention_kind<>'workflow_run_input')
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
    CASE p_retention_kind WHEN 'execution_detail' THEN 'attempts'
      WHEN 'trigger_summary' THEN 'replay' WHEN 'audit_security' THEN 'audit'
      ELSE 'records' END);
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
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.schedule_workflow_run_input_retention(p_limit integer)
RETURNS TABLE(scanned_count integer,scheduled_count integer,cutoff_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_batch_id uuid;
  v_cutoff_at timestamptz:=clock_timestamp();
  v_idempotency_key varchar(128);
  v_next_scan_at timestamptz:=(date_trunc('day',v_cutoff_at AT TIME ZONE 'UTC')
    AT TIME ZONE 'UTC')+interval '1 day';
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_scanned_count integer:=0;
  v_scheduled_count integer:=0;
  v_state record;
  v_due boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid retention schedule limit' USING ERRCODE='22023';
  END IF;
  FOR v_state IN
    SELECT state.workspace_id,state.retention_kind
    FROM app.retention_schedule_state state
    JOIN app.workspaces workspace ON workspace.id=state.workspace_id
    WHERE state.next_scan_at<=v_cutoff_at
    ORDER BY state.next_scan_at,state.workspace_id,state.retention_kind LIMIT p_limit
    FOR UPDATE OF workspace,state SKIP LOCKED
  LOOP
    v_scanned_count:=v_scanned_count+1;
    PERFORM set_config('app.workspace_id',v_state.workspace_id::text,true);
    v_idempotency_key:='scheduled:'||v_state.retention_kind||':'
      ||to_char(v_cutoff_at AT TIME ZONE 'UTC','YYYY-MM-DD');
    v_due:=CASE v_state.retention_kind
      WHEN 'workflow_run_input' THEN EXISTS (SELECT 1 FROM app.workflow_runs run
        WHERE run.workspace_id=v_state.workspace_id AND run.input_ref IS NOT NULL
          AND run.input_ref_expires_at<=v_cutoff_at)
      WHEN 'execution_detail' THEN EXISTS (SELECT 1 FROM app.workflow_runs run
        WHERE run.workspace_id=v_state.workspace_id AND run.completed_at<=v_cutoff_at-interval '30 days'
          AND run.details_purged_at IS NULL)
      WHEN 'run_summary' THEN EXISTS (SELECT 1 FROM app.workflow_runs run
        WHERE run.workspace_id=v_state.workspace_id AND run.completed_at<=v_cutoff_at-interval '90 days')
      WHEN 'trigger_summary' THEN EXISTS (
        SELECT 1 FROM app.webhook_trigger_replay_records replay
          WHERE replay.workspace_id=v_state.workspace_id AND replay.expires_at<=v_cutoff_at
        UNION ALL SELECT 1 FROM app.webhook_trigger_deliveries delivery
          WHERE delivery.workspace_id=v_state.workspace_id AND delivery.expires_at<=v_cutoff_at
        UNION ALL SELECT 1 FROM app.trigger_schedule_occurrences occurrence
          WHERE occurrence.workspace_id=v_state.workspace_id
            AND occurrence.scheduled_at<=v_cutoff_at-interval '90 days')
      WHEN 'audit_security' THEN EXISTS (
        SELECT 1 FROM app.audit_events audit WHERE audit.workspace_id=v_state.workspace_id
          AND audit.occurred_at<=v_cutoff_at-interval '365 days'
        UNION ALL SELECT 1 FROM app.transport_security_audit_facts fact
          WHERE fact.workspace_id=v_state.workspace_id
            AND fact.occurred_at<=v_cutoff_at-interval '365 days')
      ELSE false END;
    IF v_due AND NOT EXISTS (
      SELECT 1 FROM app.retention_batches batch
      WHERE batch.workspace_id=v_state.workspace_id
        AND batch.retention_kind=v_state.retention_kind AND NOT batch.dry_run
        AND batch.status<>'completed'
    ) AND NOT EXISTS (
      SELECT 1 FROM app.retention_batches batch
      WHERE batch.workspace_id=v_state.workspace_id
        AND batch.idempotency_key=v_idempotency_key
    ) THEN
      v_batch_id:=gen_random_uuid();
      PERFORM app.start_retention_batch(v_batch_id,v_state.workspace_id,
        v_idempotency_key,v_state.retention_kind,v_cutoff_at,false,
        'retention-scheduler','scheduled bounded retention enforcement');
      v_scheduled_count:=v_scheduled_count+1;
    END IF;
    UPDATE app.retention_schedule_state SET next_scan_at=v_next_scan_at,
      last_scanned_at=v_cutoff_at,last_cutoff_at=v_cutoff_at,
      updated_at=clock_timestamp()
      WHERE workspace_id=v_state.workspace_id
        AND retention_kind=v_state.retention_kind;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT v_scanned_count,v_scheduled_count,v_cutoff_at;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.execute_standard_retention_page(
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

-- Available run artifacts require an explicit object-store acknowledgement;
-- PostgreSQL never treats metadata deletion as proof that bytes were removed.
ALTER TABLE app.artifacts ADD COLUMN retention_retry_at timestamptz;
CREATE INDEX artifacts_available_retention_idx
  ON app.artifacts(expires_at,retention_retry_at,id)
  WHERE status='available';

CREATE POLICY artifacts_owner_retention_inventory ON app.artifacts
  FOR SELECT TO {{owner_role}} USING (true);
CREATE POLICY artifacts_owner_retention_update ON app.artifacts
  FOR UPDATE TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY artifacts_owner_retention_delete ON app.artifacts
  FOR DELETE TO {{owner_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));

CREATE FUNCTION app.lock_execution_artifact_references()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_artifact_id uuid;
  v_workspace_id uuid:=(to_jsonb(NEW)->>'workspace_id')::uuid;
BEGIN
  FOR v_artifact_id IN
    SELECT DISTINCT (reference->>'artifactId')::uuid
    FROM jsonb_path_query(to_jsonb(NEW),'lax $.** ? (@.kind == "artifact")') reference
    WHERE reference ? 'artifactId'
      AND (reference->>'artifactId')~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  LOOP
    PERFORM 1 FROM app.artifacts artifact
      WHERE artifact.workspace_id=v_workspace_id AND artifact.id=v_artifact_id
        AND artifact.status='available' AND artifact.deleted_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'execution artifact reference is unavailable'
        USING ERRCODE='23503';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_runs_lock_artifact_references
  BEFORE INSERT OR UPDATE OF input_ref,output_ref ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();
CREATE TRIGGER run_events_lock_artifact_references
  BEFORE INSERT OR UPDATE OF payload ON app.run_events
  FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();
CREATE TRIGGER run_checkpoints_lock_artifact_references
  BEFORE INSERT OR UPDATE OF scheduler_state ON app.run_checkpoints
  FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();
CREATE TRIGGER node_runs_lock_artifact_references
  BEFORE INSERT OR UPDATE OF input_ref,output_ref ON app.node_runs
  FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();
CREATE TRIGGER node_attempts_lock_artifact_references
  BEFORE INSERT OR UPDATE OF output_ref,reconciliation_ref ON app.node_attempts
  FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();

CREATE FUNCTION app.jsonb_references_artifact(p_value jsonb,p_artifact_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path=pg_catalog,pg_temp AS $$
  SELECT coalesce(EXISTS (
    SELECT 1 FROM jsonb_path_query(p_value,'lax $.**.artifactId') reference
    WHERE reference=to_jsonb(p_artifact_id::text)
  ),false)
$$;

CREATE FUNCTION app.find_due_run_artifact_retention(p_limit integer)
RETURNS TABLE(workspace_id uuid,artifact_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid run artifact retention discovery limit'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT artifact.workspace_id,artifact.id
  FROM app.artifacts artifact
  WHERE artifact.status='available' AND artifact.expires_at<=clock_timestamp()
    AND (artifact.retention_retry_at IS NULL
      OR artifact.retention_retry_at<=clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=artifact.workspace_id AND link.artifact_id=artifact.id)
  ORDER BY artifact.expires_at,artifact.id LIMIT p_limit;
END $$;

CREATE FUNCTION app.prepare_run_artifact_retention(
  p_workspace_id uuid,p_artifact_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS varchar LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_artifact app.artifacts%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_artifact_id IS NULL
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid run artifact retention step' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=p_workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_artifact FROM app.artifacts artifact
    WHERE artifact.workspace_id=p_workspace_id AND artifact.id=p_artifact_id
    FOR UPDATE;
  IF NOT FOUND OR v_artifact.status<>'available'
    OR v_artifact.expires_at>clock_timestamp() THEN RETURN 'stale'; END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    UPDATE app.artifacts SET retention_retry_at=clock_timestamp()+interval '1 day',
      updated_at=clock_timestamp() WHERE id=p_artifact_id;
    RETURN 'held';
  END IF;
  IF EXISTS (SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=p_workspace_id AND link.artifact_id=p_artifact_id)
    OR EXISTS (SELECT 1 FROM app.workflow_runs run WHERE run.workspace_id=p_workspace_id
      AND (app.jsonb_references_artifact(run.input_ref,p_artifact_id)
        OR app.jsonb_references_artifact(run.output_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.node_runs node WHERE node.workspace_id=p_workspace_id
      AND (app.jsonb_references_artifact(node.input_ref,p_artifact_id)
        OR app.jsonb_references_artifact(node.output_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.node_attempts attempt
      WHERE attempt.workspace_id=p_workspace_id
        AND (app.jsonb_references_artifact(attempt.output_ref,p_artifact_id)
          OR app.jsonb_references_artifact(attempt.reconciliation_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.run_events event WHERE event.workspace_id=p_workspace_id
      AND app.jsonb_references_artifact(event.payload,p_artifact_id))
    OR EXISTS (SELECT 1 FROM app.run_checkpoints checkpoint
      WHERE checkpoint.workspace_id=p_workspace_id
        AND app.jsonb_references_artifact(checkpoint.scheduler_state,p_artifact_id)) THEN
    UPDATE app.artifacts SET retention_retry_at=clock_timestamp()+interval '1 day',
      updated_at=clock_timestamp() WHERE id=p_artifact_id;
    RETURN 'referenced';
  END IF;
  UPDATE app.artifacts SET status='deleting',retention_retry_at=NULL,
    updated_at=clock_timestamp() WHERE id=p_artifact_id;
  RETURN 'artifact';
END $$;

CREATE FUNCTION app.complete_run_artifact_retention(
  p_workspace_id uuid,p_artifact_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=p_workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    RETURN false;
  END IF;
  DELETE FROM app.artifacts artifact WHERE artifact.workspace_id=p_workspace_id
    AND artifact.id=p_artifact_id AND artifact.status='deleting';
  RETURN FOUND;
END $$;

CREATE FUNCTION app.defer_run_artifact_retention(
  p_workspace_id uuid,p_artifact_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=p_workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  UPDATE app.artifacts SET status='available',
    retention_retry_at=clock_timestamp()+interval '1 minute',
    updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND id=p_artifact_id AND status='deleting';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION app.lock_execution_artifact_references(),
  app.jsonb_references_artifact(jsonb,uuid),
  app.find_due_run_artifact_retention(integer),
  app.prepare_run_artifact_retention(uuid,uuid,bigint,char),
  app.complete_run_artifact_retention(uuid,uuid,bigint,char),
  app.defer_run_artifact_retention(uuid,uuid,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.find_due_run_artifact_retention(integer),
  app.prepare_run_artifact_retention(uuid,uuid,bigint,char),
  app.complete_run_artifact_retention(uuid,uuid,bigint,char),
  app.defer_run_artifact_retention(uuid,uuid,bigint,char)
  TO {{maintenance_role}};
