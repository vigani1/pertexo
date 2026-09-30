-- ADR 056 slice 3. Operational controls do not modify authoring receipts,
-- lifecycle, activation or any explicitly disabled trigger.
ALTER TABLE app.workflows ADD COLUMN auto_pause_settings_revision integer NOT NULL DEFAULT 1
  CHECK (auto_pause_settings_revision>0);
ALTER TABLE app.workflow_failure_streaks ADD COLUMN resumed_after timestamptz;

-- One immutable closed interval per actual resume, not one row per schedule or
-- missed occurrence. Keep these through disabled schedules and receipt expiry:
-- a scanner may encounter an old due instant after several pause/resume cycles.
CREATE TABLE app.workflow_trigger_pause_periods (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  pause_revision bigint NOT NULL CHECK (pause_revision>0),
  paused_at timestamptz NOT NULL,
  resumed_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,workflow_id,pause_revision),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id) ON DELETE CASCADE,
  CHECK (resumed_at>=paused_at)
);
CREATE INDEX workflow_trigger_pause_periods_due_idx ON app.workflow_trigger_pause_periods
  (workspace_id,workflow_id,paused_at DESC) INCLUDE(resumed_at);
ALTER TABLE app.workflow_trigger_pause_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_trigger_pause_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_trigger_pause_periods_owner ON app.workflow_trigger_pause_periods
  FOR ALL TO {{owner_role}} USING(true) WITH CHECK(true);
REVOKE ALL ON app.workflow_trigger_pause_periods
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

CREATE TABLE app.workflow_auto_pause_command_receipts (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('resume','settings','workspace_settings')),
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  result jsonb,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  PRIMARY KEY(workspace_id,actor_id,resource_id,operation,key_hash)
);
CREATE INDEX workflow_auto_pause_receipts_expiry_idx ON app.workflow_auto_pause_command_receipts(expires_at)
  WHERE result IS NOT NULL;
ALTER TABLE app.workflow_auto_pause_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_auto_pause_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_auto_pause_receipts_owner ON app.workflow_auto_pause_command_receipts
  FOR ALL TO {{owner_role}} USING(true) WITH CHECK(true);
REVOKE ALL ON app.workflow_auto_pause_command_receipts
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

-- One narrow owner command owns authority, receipt, state, streak and audit.
-- Caller-installed actor and workspace must agree; runtime roles gain no
-- direct access to streaks or the new receipts table.
CREATE FUNCTION app.workflow_auto_pause_control(
  p_workspace uuid,p_actor uuid,p_workflow uuid,p_operation text,
  p_request jsonb,p_key_hash text,p_request_hash text,p_request_id text,p_trace_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_role text; v_workflow app.workflows%ROWTYPE; v_workspace app.workspaces%ROWTYPE;
  v_receipt app.workflow_auto_pause_command_receipts%ROWTYPE;
  v_resource uuid; v_settings jsonb; v_changed boolean:=false; v_action text; v_resumed_at timestamptz;
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')
     OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'auto pause context denied' USING ERRCODE='PT404';
  END IF;
  IF p_operation NOT IN ('read','settings','resume','workspace_read','workspace_settings') THEN
    RAISE EXCEPTION 'invalid auto pause operation' USING ERRCODE='22023';
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request)<>'object'
    OR (p_operation='resume' AND (p_request->>'expectedPauseRevision' IS NULL
      OR p_request->>'expectedPauseRevision' !~ '^[1-9][0-9]{0,18}$'
      OR (p_request->>'expectedPauseRevision')::numeric>9223372036854775807
      OR p_request- 'expectedPauseRevision'<>'{}'::jsonb))
    OR (p_operation='settings' AND (jsonb_typeof(p_request->'enabled') IS DISTINCT FROM 'boolean'
      OR NOT p_request ? 'thresholdOverride' OR p_request->>'expectedSettingsRevision' IS NULL
      OR (p_request->>'expectedSettingsRevision')::integer<1
      OR p_request-ARRAY['enabled','thresholdOverride','expectedSettingsRevision']<>'{}'::jsonb))
    OR (p_operation='workspace_settings' AND (p_request->>'threshold' IS NULL
      OR (p_request->>'threshold')::integer NOT BETWEEN 3 AND 100
      OR p_request->>'expectedRevision' IS NULL OR (p_request->>'expectedRevision')::integer<1
      OR p_request-ARRAY['threshold','expectedRevision']<>'{}'::jsonb)) THEN
    RAISE EXCEPTION 'invalid auto pause request' USING ERRCODE='22023';
  END IF;
  IF p_operation='workspace_settings' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('auto-pause-workspace:'||p_workspace::text,0));
    SELECT * INTO v_workspace FROM app.workspaces WHERE id=p_workspace FOR NO KEY UPDATE;
  ELSE
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('auto-pause-workspace:'||p_workspace::text,0));
    SELECT * INTO v_workspace FROM app.workspaces WHERE id=p_workspace FOR SHARE;
  END IF;
  IF NOT FOUND OR v_workspace.status<>'active' THEN
    RAISE EXCEPTION 'auto pause workspace not visible' USING ERRCODE='PT404';
  END IF;
  SELECT membership.role INTO v_role FROM app.workspace_memberships membership
    JOIN app.users actor ON actor.id=membership.user_id
    JOIN app.workspaces workspace ON workspace.id=membership.workspace_id
    WHERE membership.workspace_id=p_workspace AND membership.user_id=p_actor
      AND membership.status='active' AND actor.status='active' AND workspace.status='active'
    FOR SHARE OF membership,actor;
  IF NOT FOUND OR (p_operation IN ('settings','resume') AND v_role NOT IN ('owner','admin','builder'))
     OR (p_operation='workspace_settings' AND v_role<>'owner') THEN
    RAISE EXCEPTION 'auto pause resource not visible' USING ERRCODE='PT404';
  END IF;
  v_resource:=CASE WHEN p_operation IN ('workspace_read','workspace_settings') THEN p_workspace ELSE p_workflow END;
  IF v_resource IS NULL THEN RAISE EXCEPTION 'workflow required' USING ERRCODE='22023'; END IF;

  IF p_operation IN ('settings','resume','workspace_settings') THEN
    IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$'
       OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'command hashes required' USING ERRCODE='22023';
    END IF;
    INSERT INTO app.workflow_auto_pause_command_receipts
      (workspace_id,actor_id,resource_id,operation,key_hash,request_hash)
      VALUES(p_workspace,p_actor,v_resource,p_operation,p_key_hash,p_request_hash)
      ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT v_receipt FROM app.workflow_auto_pause_command_receipts
      WHERE workspace_id=p_workspace AND actor_id=p_actor AND resource_id=v_resource
        AND operation=p_operation AND key_hash=p_key_hash FOR UPDATE;
    IF v_receipt.request_hash<>p_request_hash THEN
      RAISE EXCEPTION 'auto pause idempotency conflict' USING ERRCODE='PT409';
    END IF;
    IF v_receipt.result IS NOT NULL THEN
      RETURN jsonb_build_object('settings',v_receipt.result,'replayed',true);
    END IF;
  END IF;

  -- Workspace default edits exclude evaluators and workflow controls without
  -- changing the globally shared workspace:manage capability (owner only).
  IF p_operation IN ('workspace_read','workspace_settings') THEN
    IF p_operation='workspace_settings' THEN
      IF v_workspace.revision<>(p_request->>'expectedRevision')::integer THEN
        RAISE EXCEPTION 'workspace auto pause revision conflict' USING ERRCODE='PTW09',DETAIL=v_workspace.revision::text;
      END IF;
      IF (p_request->>'threshold')::integer NOT BETWEEN 3 AND 100 THEN
        RAISE EXCEPTION 'invalid threshold' USING ERRCODE='22023';
      END IF;
      IF v_workspace.auto_pause_threshold<>(p_request->>'threshold')::integer THEN
        UPDATE app.workspaces SET auto_pause_threshold=(p_request->>'threshold')::smallint,
          revision=revision+1,updated_at=clock_timestamp() WHERE id=p_workspace RETURNING * INTO v_workspace;
        v_changed:=true; v_action:='workspace.auto_pause_settings_changed';
      END IF;
    END IF;
    v_settings:=jsonb_build_object('threshold',v_workspace.auto_pause_threshold,'revision',v_workspace.revision);
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('auto-pause-workflow:'||p_workspace::text||':'||p_workflow::text,0));
    SELECT * INTO v_workflow FROM app.workflows
      WHERE workspace_id=p_workspace AND id=p_workflow FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow not visible' USING ERRCODE='PT404'; END IF;
    IF p_operation='resume' THEN
      IF v_workflow.trigger_pause_revision::text<>p_request->>'expectedPauseRevision' THEN
        RAISE EXCEPTION 'pause revision conflict' USING ERRCODE='PTP09',DETAIL=v_workflow.trigger_pause_revision::text;
      END IF;
      IF v_workflow.trigger_pause_state='paused' THEN
        v_resumed_at:=clock_timestamp();
        INSERT INTO app.workflow_trigger_pause_periods
          (workspace_id,workflow_id,pause_revision,paused_at,resumed_at)
          VALUES(p_workspace,p_workflow,v_workflow.trigger_pause_revision,
            v_workflow.trigger_paused_at,v_resumed_at);
        -- Cut on terminal time, not queue insertion time: even an outcome
        -- transaction committing late cannot apply a pre-resume failure.
        INSERT INTO app.workflow_failure_streaks(workspace_id,workflow_id,consecutive_failures,resumed_after)
          VALUES(p_workspace,p_workflow,0,v_resumed_at)
          ON CONFLICT ON CONSTRAINT workflow_failure_streaks_pkey DO UPDATE
          SET consecutive_failures=0,last_run_id=NULL,last_ended_at=NULL,
              resumed_after=v_resumed_at,updated_at=clock_timestamp();
        UPDATE app.workflows SET trigger_pause_state='none',trigger_paused_at=NULL,
          trigger_pause_reason=NULL,trigger_pause_failures=NULL,trigger_pause_last_run_id=NULL,
          trigger_pause_revision=trigger_pause_revision+1
          WHERE workspace_id=p_workspace AND id=p_workflow RETURNING * INTO v_workflow;
        v_changed:=true; v_action:='workflow.triggers_resumed';
      END IF;
    ELSIF p_operation='settings' THEN
      IF v_workflow.auto_pause_settings_revision<>(p_request->>'expectedSettingsRevision')::integer THEN
        RAISE EXCEPTION 'settings revision conflict' USING ERRCODE='PTS09',DETAIL=v_workflow.auto_pause_settings_revision::text;
      END IF;
      IF jsonb_typeof(p_request->'enabled') IS DISTINCT FROM 'boolean'
         OR (p_request->>'thresholdOverride' IS NOT NULL
           AND (p_request->>'thresholdOverride')::integer NOT BETWEEN 3 AND 100) THEN
        RAISE EXCEPTION 'invalid workflow auto pause settings' USING ERRCODE='22023';
      END IF;
      IF v_workflow.auto_pause_enabled IS DISTINCT FROM (p_request->>'enabled')::boolean
         OR v_workflow.auto_pause_threshold IS DISTINCT FROM (p_request->>'thresholdOverride')::smallint THEN
        UPDATE app.workflows SET auto_pause_enabled=(p_request->>'enabled')::boolean,
          auto_pause_threshold=(p_request->>'thresholdOverride')::smallint,
          auto_pause_settings_revision=auto_pause_settings_revision+1
          WHERE workspace_id=p_workspace AND id=p_workflow RETURNING * INTO v_workflow;
        v_changed:=true; v_action:='workflow.auto_pause_settings_changed';
      END IF;
    END IF;
    v_settings:=jsonb_build_object('enabled',v_workflow.auto_pause_enabled,
      'thresholdOverride',v_workflow.auto_pause_threshold,'workspaceThreshold',v_workspace.auto_pause_threshold,
      'effectiveThreshold',coalesce(v_workflow.auto_pause_threshold,v_workspace.auto_pause_threshold),
      'settingsRevision',v_workflow.auto_pause_settings_revision,
      'pauseState',v_workflow.trigger_pause_state,'pauseRevision',v_workflow.trigger_pause_revision::text,
      'pausedAt',to_char(v_workflow.trigger_paused_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'pauseReason',v_workflow.trigger_pause_reason,'pausedFailures',v_workflow.trigger_pause_failures,
      'pausedLastRunId',v_workflow.trigger_pause_last_run_id);
  END IF;
  IF p_operation IN ('read','workspace_read') THEN RETURN v_settings; END IF;
  IF v_changed THEN
    INSERT INTO app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
      VALUES(gen_random_uuid(),p_workspace,p_actor,v_action,
        CASE WHEN p_operation='workspace_settings' THEN 'workspace' ELSE 'workflow' END,
        v_resource,p_request_id,p_trace_id,jsonb_build_object('settings',v_settings));
  END IF;
  UPDATE app.workflow_auto_pause_command_receipts SET result=v_settings
    WHERE workspace_id=p_workspace AND actor_id=p_actor AND resource_id=v_resource
      AND operation=p_operation AND key_hash=p_key_hash;
  RETURN jsonb_build_object('settings',v_settings,'replayed',false);
END $$;

-- The existing bounded transient reaper owns the same 24-hour command receipt
-- retention as authoring. A legal hold preserves these audit-linked receipts.
DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.reap_transient_data(integer)'::regprocedure) INTO v_definition;
  v_marker:='GET DIAGNOSTICS v_idempotency_records_deleted = ROW_COUNT;';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'transient reaper shape is incompatible'; END IF;
  EXECUTE replace(v_definition,v_marker,v_marker||'
  WITH candidates AS (
    SELECT receipt.workspace_id,receipt.actor_id,receipt.resource_id,receipt.operation,receipt.key_hash
      FROM app.workflow_auto_pause_command_receipts receipt
      WHERE receipt.result IS NOT NULL AND receipt.expires_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds hold
          WHERE hold.workspace_id=receipt.workspace_id AND hold.released_sequence IS NULL)
      ORDER BY receipt.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM app.workflow_auto_pause_command_receipts receipt USING candidates
      WHERE receipt.workspace_id=candidates.workspace_id AND receipt.actor_id=candidates.actor_id
        AND receipt.resource_id=candidates.resource_id AND receipt.operation=candidates.operation
        AND receipt.key_hash=candidates.key_hash RETURNING 1
  ) SELECT v_idempotency_records_deleted+count(*)::integer INTO v_idempotency_records_deleted FROM deleted;');
END $$;
ALTER FUNCTION app.workflow_auto_pause_control(uuid,uuid,uuid,text,jsonb,text,text,text,text) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workflow_auto_pause_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)
  FROM PUBLIC,{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.workflow_auto_pause_control(uuid,uuid,uuid,text,jsonb,text,text,text,text) TO {{api_runtime_role}};

-- Admission uses the actual greatest due instant, not the scanner's current
-- observation. The indexed predecessor interval lookup is bounded (LIMIT 1)
-- even after many cycles. Lock workspace before workflow, as resume/fold/purge
-- do; do not lock schedules here or make resume acquire a schedule lease lock.
CREATE FUNCTION app.schedule_claim_workflow_paused(
  p_trigger_id uuid,p_lease_token uuid,p_scheduled_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace_id uuid; v_workflow_id uuid; v_state varchar;
  v_resumed_at timestamptz; v_prior_workspace text;
BEGIN
  IF p_scheduled_at IS NULL THEN RAISE EXCEPTION 'scheduled instant required' USING ERRCODE='22023'; END IF;
  v_prior_workspace:=current_setting('app.workspace_id',true);
  SELECT trigger.workspace_id,trigger.workflow_id INTO v_workspace_id,v_workflow_id
    FROM app.workflow_triggers trigger WHERE trigger.id=p_trigger_id;
  IF v_workspace_id IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.workspace_id',v_workspace_id::text,true);
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace_id FOR SHARE;
  SELECT workflow.trigger_pause_state INTO v_state
    FROM app.trigger_schedules schedule
    JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
    JOIN app.workflows workflow ON workflow.workspace_id=trigger.workspace_id
      AND workflow.id=trigger.workflow_id
    WHERE schedule.trigger_id=p_trigger_id AND schedule.lease_token=p_lease_token
      AND schedule.lease_expires_at>clock_timestamp()
    FOR SHARE OF workflow;
  IF FOUND AND v_state<>'paused' THEN
    SELECT period.resumed_at INTO v_resumed_at FROM app.workflow_trigger_pause_periods period
      WHERE period.workspace_id=v_workspace_id AND period.workflow_id=v_workflow_id
        AND period.paused_at<=p_scheduled_at
      ORDER BY period.paused_at DESC LIMIT 1;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN coalesce(v_state='paused' OR p_scheduled_at<v_resumed_at,false);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;
ALTER FUNCTION app.schedule_claim_workflow_paused(uuid,uuid,timestamptz) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.schedule_claim_workflow_paused(uuid,uuid,timestamptz)
  FROM PUBLIC,{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.schedule_claim_workflow_paused(uuid,uuid,timestamptz)
  TO {{api_runtime_role}},{{worker_runtime_role}};

-- Select at most p_limit candidates without row locks. Lock workspace before
-- workflow before queue, matching lifecycle/purge commands. Several evaluators
-- may see the same candidates; only committed deletions count. Neither resume
-- nor settings touches the queue. NO KEY UPDATE lets terminal producers keep
-- their FK KEY SHARE locks without reversing the queue/workflow lock order.
CREATE OR REPLACE FUNCTION app.fold_workflow_trigger_outcomes(p_limit integer,p_enforce boolean)
RETURNS TABLE(workspace_id uuid,workflow_id uuid,consecutive_failures integer,paused boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
#variable_conflict use_column
DECLARE
  v_candidates uuid[]; v_group record; v_outcome record; v_batch jsonb;
  v_prior_workspace text; v_streak integer; v_resumed_after timestamptz;
  v_threshold integer; v_enabled boolean; v_lifecycle varchar; v_state varchar;
  v_workspace_status varchar; v_reached_run uuid; v_reached_count integer;
  v_last_run uuid; v_last_ended timestamptz;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR p_enforce IS NULL THEN
    RAISE EXCEPTION 'invalid trigger outcome fold parameters' USING ERRCODE='22023';
  END IF;
  v_prior_workspace:=current_setting('app.workspace_id',true);
  SELECT array_agg(candidate.id) INTO v_candidates FROM (
    SELECT outcome.id FROM app.workflow_trigger_outcomes outcome
      ORDER BY outcome.created_at,outcome.id LIMIT p_limit
  ) candidate;
  FOR v_group IN
    SELECT outcome.workspace_id,outcome.workflow_id
      FROM app.workflow_trigger_outcomes outcome WHERE outcome.id=ANY(v_candidates)
      GROUP BY outcome.workspace_id,outcome.workflow_id
      ORDER BY outcome.workspace_id,outcome.workflow_id
  LOOP
    PERFORM set_config('app.workspace_id',v_group.workspace_id::text,true);
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('auto-pause-workspace:'||v_group.workspace_id::text,0));
    SELECT workspace.status INTO v_workspace_status FROM app.workspaces workspace
      WHERE workspace.id=v_group.workspace_id FOR SHARE;
    CONTINUE WHEN NOT FOUND;
    PERFORM pg_advisory_xact_lock(hashtextextended('auto-pause-workflow:'||v_group.workspace_id::text||':'||v_group.workflow_id::text,0));
    SELECT workflow.auto_pause_enabled,workflow.lifecycle_status,workflow.trigger_pause_state,
      coalesce(workflow.auto_pause_threshold,workspace.auto_pause_threshold)
      INTO v_enabled,v_lifecycle,v_state,v_threshold
      FROM app.workflows workflow JOIN app.workspaces workspace ON workspace.id=workflow.workspace_id
      WHERE workflow.workspace_id=v_group.workspace_id AND workflow.id=v_group.workflow_id
      FOR NO KEY UPDATE OF workflow;
    CONTINUE WHEN NOT FOUND;
    WITH picked AS MATERIALIZED (
      SELECT outcome.id,outcome.run_id,outcome.counts_as_failure,outcome.ended_at
        FROM app.workflow_trigger_outcomes outcome
        WHERE outcome.id=ANY(v_candidates) AND outcome.workspace_id=v_group.workspace_id
          AND outcome.workflow_id=v_group.workflow_id
        ORDER BY outcome.ended_at,outcome.id FOR UPDATE SKIP LOCKED
    ), consumed AS (
      DELETE FROM app.workflow_trigger_outcomes outcome USING picked WHERE outcome.id=picked.id
        RETURNING picked.id,picked.run_id,picked.counts_as_failure,picked.ended_at
    ) SELECT coalesce(jsonb_agg(to_jsonb(consumed)),'[]'::jsonb) INTO v_batch FROM consumed;
    CONTINUE WHEN jsonb_array_length(v_batch)=0;
    INSERT INTO app.workflow_failure_streaks(workspace_id,workflow_id,consecutive_failures)
      VALUES(v_group.workspace_id,v_group.workflow_id,0)
      ON CONFLICT ON CONSTRAINT workflow_failure_streaks_pkey DO NOTHING;
    SELECT streak.consecutive_failures,streak.resumed_after,streak.last_run_id,streak.last_ended_at
      INTO v_streak,v_resumed_after,v_last_run,v_last_ended FROM app.workflow_failure_streaks streak
      WHERE streak.workspace_id=v_group.workspace_id AND streak.workflow_id=v_group.workflow_id FOR UPDATE;
    v_reached_run:=NULL; v_reached_count:=NULL;
    FOR v_outcome IN
      SELECT * FROM jsonb_to_recordset(v_batch) AS outcome(
        id uuid,run_id uuid,counts_as_failure boolean,ended_at timestamptz)
        ORDER BY outcome.ended_at,outcome.id
    LOOP
      CONTINUE WHEN v_resumed_after IS NOT NULL AND v_outcome.ended_at<=v_resumed_after;
      IF v_outcome.counts_as_failure THEN
        v_streak:=v_streak+1;
        IF v_streak>=v_threshold AND v_reached_run IS NULL THEN
          v_reached_run:=v_outcome.run_id; v_reached_count:=v_streak;
        END IF;
      ELSE v_streak:=0;
      END IF;
      v_last_run:=v_outcome.run_id; v_last_ended:=v_outcome.ended_at;
    END LOOP;
    UPDATE app.workflow_failure_streaks SET consecutive_failures=v_streak,
      last_run_id=v_last_run,last_ended_at=v_last_ended,updated_at=clock_timestamp()
      WHERE workspace_id=v_group.workspace_id AND workflow_id=v_group.workflow_id;
    IF v_reached_run IS NOT NULL AND v_enabled AND v_lifecycle='active'
       AND v_state='none' AND v_workspace_status='active' THEN
      IF p_enforce THEN
        UPDATE app.workflows SET trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
          trigger_pause_reason='consecutive_failures',trigger_pause_failures=v_reached_count,
          trigger_pause_last_run_id=v_reached_run,trigger_pause_revision=trigger_pause_revision+1
          WHERE workspace_id=v_group.workspace_id AND id=v_group.workflow_id;
        INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,metadata)
          VALUES(gen_random_uuid(),v_group.workspace_id,'workflow.triggers_paused','workflow',v_group.workflow_id,
            jsonb_build_object('reason','consecutive_failures','failures',v_reached_count,
              'threshold',v_threshold,'lastRunId',v_reached_run));
      END IF;
      workspace_id:=v_group.workspace_id; workflow_id:=v_group.workflow_id;
      consecutive_failures:=v_reached_count; paused:=p_enforce; RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure) INTO v_definition;
  v_marker:='''workspace_inbox_events'', ''workflow_failure_streaks''';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN
    RAISE EXCEPTION 'workspace tenant purge shape is incompatible';
  END IF;
  EXECUTE replace(v_definition,'''workspace_inbox_events'', ''workflow_failure_streaks''',
    '''workspace_inbox_events'', ''workflow_auto_pause_command_receipts'', ''workflow_trigger_pause_periods'', ''workflow_failure_streaks''');
END $$;
