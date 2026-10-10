-- The reset keeps one format. These fields and development engine labels no
-- longer distinguish anything; existing pre-launch data is discarded locally.
ALTER TABLE app.run_failure_notification_intents
  DROP CONSTRAINT run_failure_notification_intents_run_pin_fk,
  DROP CONSTRAINT run_failure_notification_intents_logical_unique;
ALTER TABLE app.workflow_runs
  DROP CONSTRAINT workflow_runs_failure_notification_pin_unique,
  DROP CONSTRAINT workflow_runs_failure_notification_policy_complete;

ALTER TABLE app.workflow_drafts DROP COLUMN schema_version;
ALTER TABLE app.workflow_versions DROP COLUMN schema_version;
ALTER TABLE app.outbox_events DROP COLUMN schema_version;
ALTER TABLE app.run_checkpoints DROP COLUMN engine_version;
ALTER TABLE app.run_failure_notification_intents DROP COLUMN policy_version;
ALTER TABLE app.workflow_runs DROP COLUMN failure_notification_policy_version;
ALTER TABLE app.connection_secret_versions DROP COLUMN schema_version;
ALTER TABLE app.webhook_trigger_secret_versions DROP COLUMN schema_version;

ALTER TABLE app.workflow_runs ADD CONSTRAINT workflow_runs_failure_notification_pin_unique
  UNIQUE (workspace_id,id,failure_notification_destination_id,
    failure_notification_destination_config_version,failure_notification_side_effect_class,
    failure_notification_connection_secret_version_id);
ALTER TABLE app.workflow_runs ADD CONSTRAINT workflow_runs_failure_notification_policy_complete
  CHECK (((failure_notification_destination_id IS NULL
    AND failure_notification_destination_config_version IS NULL
    AND failure_notification_side_effect_class IS NULL
    AND failure_notification_connection_secret_version_id IS NULL)
  OR (failure_notification_destination_id IS NOT NULL
    AND failure_notification_destination_config_version IS NOT NULL
    AND failure_notification_destination_config_version > 0
    AND failure_notification_side_effect_class IS NOT NULL
    AND failure_notification_side_effect_class IN ('safe','idempotent_with_key','unsafe'))) IS TRUE);
ALTER TABLE app.run_failure_notification_intents
  ADD CONSTRAINT run_failure_notification_intents_logical_unique
    UNIQUE (workflow_run_id,terminal_event_sequence),
  ADD CONSTRAINT run_failure_notification_intents_run_pin_fk
    FOREIGN KEY (workspace_id,workflow_run_id,destination_id,destination_config_version,
      side_effect_class,connection_secret_version_id)
    REFERENCES app.workflow_runs (workspace_id,id,failure_notification_destination_id,
      failure_notification_destination_config_version,failure_notification_side_effect_class,
      failure_notification_connection_secret_version_id) ON DELETE CASCADE;

-- PostgreSQL requires recreation when a result row or argument list changes.
DROP FUNCTION app.lock_workflow_run_replay_version(uuid,uuid,uuid);
DROP FUNCTION app.resolve_public_webhook_endpoint(character);
DROP FUNCTION app.fold_workflow_trigger_outcomes(integer,boolean);

CREATE OR REPLACE FUNCTION app.claim_due_node_run_wakeups(p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  claimed_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'due node wakeup limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  WITH due AS MATERIALIZED (
    SELECT node.id, node.workspace_id, node.workflow_run_id,
           coalesce(node.retry_due_at, node.resume_at) AS due_at
      FROM app.node_runs node
     WHERE node.status = 'waiting'
       AND coalesce(node.retry_due_at, node.resume_at) <= clock_timestamp()
       AND node.due_wakeup_at IS DISTINCT FROM
           coalesce(node.retry_due_at, node.resume_at)
     ORDER BY coalesce(node.retry_due_at, node.resume_at), node.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE app.node_runs node
       SET due_wakeup_at = due.due_at,
           updated_at = clock_timestamp()
      FROM due
     WHERE node.id = due.id
     RETURNING node.workspace_id, node.workflow_run_id
  ), events AS (
    SELECT marked.workspace_id, marked.workflow_run_id,
           gen_random_uuid() AS outbox_event_id
      FROM marked
  )
  INSERT INTO app.outbox_events (
    id, workspace_id, job_name, aggregate_type,
    aggregate_id, payload, payload_checksum
  )
  SELECT event.outbox_event_id, event.workspace_id, 'advance-workflow-run',
         'workflow-run', event.workflow_run_id,
         jsonb_build_object(
           'outboxEventId', event.outbox_event_id,
           'runId', event.workflow_run_id,
           'workspaceId', event.workspace_id
         ),
         encode(sha256(convert_to(
           '{"outboxEventId":"' || event.outbox_event_id::text ||
           '","runId":"' || event.workflow_run_id::text ||
           '","workspaceId":"' || event.workspace_id::text || '"}',
           'UTF8'
         )), 'hex')
    FROM events event;

  GET DIAGNOSTICS claimed_count = ROW_COUNT;
  RETURN claimed_count;
END;
$function$
;
CREATE OR REPLACE FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE claimed_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'due workflow deadline limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  WITH due AS MATERIALIZED (
    SELECT run.id, run.workspace_id, run.deadline_at
      FROM app.workflow_runs run
     WHERE run.status IN ('queued', 'running', 'waiting')
       AND run.deadline_at <= clock_timestamp()
       AND run.deadline_wakeup_at IS DISTINCT FROM run.deadline_at
     ORDER BY run.deadline_at, run.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE app.workflow_runs run
       SET deadline_wakeup_at = due.deadline_at,
           updated_at = clock_timestamp()
      FROM due WHERE run.id = due.id
    RETURNING run.id, run.workspace_id
  ), events AS (
    SELECT marked.*, gen_random_uuid() AS outbox_event_id FROM marked
  )
  INSERT INTO app.outbox_events (
    id, workspace_id, job_name, aggregate_type,
    aggregate_id, payload, payload_checksum
  )
  SELECT outbox_event_id, workspace_id, 'advance-workflow-run',
         'workflow-run', id,
         jsonb_build_object('outboxEventId', outbox_event_id, 'runId', id,
           'workspaceId', workspace_id),
         encode(sha256(convert_to(
           '{"outboxEventId":"' || outbox_event_id::text ||
           '","runId":"' || id::text ||
           '","workspaceId":"' || workspace_id::text || '"}',
           'UTF8')), 'hex')
    FROM events;
  GET DIAGNOSTICS claimed_count = ROW_COUNT;
  RETURN claimed_count;
END;
$function$
;
CREATE OR REPLACE FUNCTION app.fold_workflow_trigger_outcomes(p_limit integer)
 RETURNS TABLE(workspace_id uuid, workflow_id uuid, consecutive_failures integer, paused boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
 SET row_security TO 'on'
AS $function$
#variable_conflict use_column
DECLARE
  v_candidates uuid[]; v_group record; v_outcome record; v_batch jsonb;
  v_prior_workspace text; v_streak integer; v_resumed_after timestamptz;
  v_threshold integer; v_enabled boolean; v_lifecycle varchar; v_state varchar;
  v_workspace_status varchar; v_reached_run uuid; v_reached_count integer;
  v_last_run uuid; v_last_ended timestamptz;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
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
        UPDATE app.workflows SET trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
          trigger_pause_reason='consecutive_failures',trigger_pause_failures=v_reached_count,
          trigger_pause_last_run_id=v_reached_run,trigger_pause_revision=trigger_pause_revision+1
          WHERE workspace_id=v_group.workspace_id AND id=v_group.workflow_id;
        INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,metadata)
          VALUES(gen_random_uuid(),v_group.workspace_id,'workflow.triggers_paused','workflow',v_group.workflow_id,
            jsonb_build_object('reason','consecutive_failures','failures',v_reached_count,
              'threshold',v_threshold,'lastRunId',v_reached_run));
      workspace_id:=v_group.workspace_id; workflow_id:=v_group.workflow_id;
      consecutive_failures:=v_reached_count; paused:=true; RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $function$
;
CREATE OR REPLACE FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid)
 RETURNS TABLE(id uuid, workspace_id uuid, workflow_id uuid, version_number integer, checksum character varying, executable_json jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
 SET row_security TO 'on'
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_workflow_id IS NULL
     OR p_workflow_version_id IS NULL THEN
    RAISE EXCEPTION 'workflow replay version lock arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workflow replay workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT workflow_version.id,
           workflow_version.workspace_id,
           workflow_version.workflow_id,
           workflow_version.version_number,
           workflow_version.checksum,
           workflow_version.executable_json
      FROM app.workflow_versions AS workflow_version
     WHERE workflow_version.workspace_id = p_workspace_id
       AND workflow_version.workflow_id = p_workflow_id
       AND workflow_version.id = p_workflow_version_id
     FOR SHARE;
END;
$function$
;
CREATE OR REPLACE FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
 SET row_security TO 'on'
AS $function$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  IF p_old_outbox_event_id=p_new_outbox_event_id THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workflow_runs run
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id AND run.status='queued')
    OR NOT EXISTS(SELECT 1 FROM app.outbox_events old_event,app.outbox_events new_event
      WHERE old_event.workspace_id=p_workspace_id AND old_event.id=p_old_outbox_event_id
        AND new_event.workspace_id=p_workspace_id AND new_event.id=p_new_outbox_event_id
        AND old_event.aggregate_id=p_workflow_run_id AND new_event.aggregate_id=p_workflow_run_id
        AND old_event.aggregate_type='workflow-run' AND new_event.aggregate_type='workflow-run'
        AND old_event.job_name='advance-workflow-run' AND new_event.job_name='advance-workflow-run'

        AND old_event.payload->>'workspaceId'=p_workspace_id::text
        AND new_event.payload->>'workspaceId'=p_workspace_id::text
        AND old_event.payload->>'runId'=p_workflow_run_id::text
        AND new_event.payload->>'runId'=p_workflow_run_id::text
        AND old_event.payload->>'outboxEventId'=p_old_outbox_event_id::text
        AND new_event.payload->>'outboxEventId'=p_new_outbox_event_id::text
        AND new_event.published_at IS NULL AND new_event.failed_at IS NULL) THEN RETURN false;
  END IF;
  UPDATE app.workflow_run_active_admissions SET outbox_event_id=p_new_outbox_event_id,recover_after=NULL
    WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
      AND outbox_event_id=p_old_outbox_event_id;
  RETURN FOUND;
END $function$
;
CREATE OR REPLACE FUNCTION app.recover_due_run_failure_notifications(p_limit integer, p_max_attempts integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  recovered integer := 0;
  candidate record;
  terminal_status text;
  error_code text;
  delivery_id uuid;
  delivery_payload jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR
     p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 10 THEN
    RAISE EXCEPTION 'invalid failure notification recovery bounds' USING ERRCODE = '22023';
  END IF;
  FOR candidate IN
    SELECT id,workspace_id,status,delivery_attempts,side_effect_class,
           coalesce(possibly_dispatched,false) delivery_unresolved
      FROM app.run_failure_notification_intents
     WHERE status IN ('claimed','dispatching') AND recovery_at<=clock_timestamp()
     ORDER BY recovery_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    IF candidate.status='dispatching' AND candidate.side_effect_class='unsafe' THEN
      terminal_status := 'outcome_unknown';
      error_code := 'delivery.recovery_ambiguous';
    ELSIF candidate.delivery_attempts >= p_max_attempts THEN
      IF candidate.side_effect_class='idempotent_with_key' AND
         (candidate.delivery_unresolved OR candidate.status='dispatching') THEN
        terminal_status := 'outcome_unknown';
        error_code := 'delivery.attempts_exhausted_unknown';
      ELSE
        terminal_status := 'dead_letter';
        error_code := 'delivery.attempts_exhausted';
      END IF;
    ELSE
      terminal_status := NULL;
      error_code := CASE WHEN candidate.status='dispatching'
        THEN 'delivery.recovery_ambiguous' ELSE 'delivery.recovery_predispatch' END;
    END IF;

    IF terminal_status IS NOT NULL THEN
      UPDATE app.run_failure_notification_intents
         SET status=terminal_status,dispatch_marked_at=NULL,recovery_at=NULL,
             next_delivery_at=NULL,safe_error_code=error_code,
             possibly_dispatched=(candidate.delivery_unresolved OR candidate.status='dispatching'),
             completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE id=candidate.id;
      INSERT INTO app.run_failure_notification_audit_facts
        (id,workspace_id,notification_intent_id,fact_type,attempt_number,
         safe_error_code,possibly_dispatched)
      VALUES (gen_random_uuid(),candidate.workspace_id,candidate.id,
        CASE WHEN terminal_status='outcome_unknown' THEN 'outcome_unknown' ELSE 'dead_lettered' END,
        candidate.delivery_attempts,error_code,
        candidate.delivery_unresolved OR candidate.status='dispatching');
    ELSE
      UPDATE app.run_failure_notification_intents
         SET status='retry',dispatch_marked_at=NULL,recovery_at=NULL,
             next_delivery_at=clock_timestamp(),safe_error_code=error_code,
             possibly_dispatched=(candidate.delivery_unresolved OR candidate.status='dispatching'),
             updated_at=clock_timestamp()
       WHERE id=candidate.id;
      delivery_id := gen_random_uuid();
      delivery_payload := jsonb_build_object(
        'notificationIntentId',candidate.id,'outboxEventId',delivery_id,
        'workspaceId',candidate.workspace_id
      );
      INSERT INTO app.outbox_events (
        id,workspace_id,job_name,aggregate_type,aggregate_id,
        payload,payload_checksum
      ) VALUES (
        delivery_id,candidate.workspace_id,'deliver-run-failure-notification',
        'run-failure-notification',candidate.id,delivery_payload,
        encode(sha256(convert_to(
          '{"notificationIntentId":"' || candidate.id::text ||
          '","outboxEventId":"' || delivery_id::text ||
          '","workspaceId":"' ||
          candidate.workspace_id::text || '"}', 'UTF8')),'hex')
      );
      INSERT INTO app.run_failure_notification_audit_facts
        (id,workspace_id,notification_intent_id,fact_type,attempt_number,
         safe_error_code,possibly_dispatched)
      VALUES (gen_random_uuid(),candidate.workspace_id,candidate.id,
        'retry_scheduled',candidate.delivery_attempts,error_code,
        candidate.delivery_unresolved OR candidate.status='dispatching');
    END IF;
    recovered := recovered + 1;
  END LOOP;
  RETURN recovered;
END;
$function$
;
CREATE OR REPLACE FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
 SET row_security TO 'on'
AS $function$
DECLARE
  admission record;
  canonical_payload text;
  new_outbox_event_id uuid;
  new_payload jsonb;
  old_payload jsonb;
  prior_workspace text;
  recovered integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid active admission recovery limit' USING ERRCODE='22023';
  END IF;
  prior_workspace:=current_setting('app.workspace_id',true);
  FOR admission IN
    SELECT active.workspace_id,active.workflow_run_id,active.outbox_event_id
      FROM app.workflow_run_active_admissions active
     WHERE active.recover_after<=clock_timestamp()
     ORDER BY active.recover_after,active.outbox_event_id
     FOR UPDATE OF active SKIP LOCKED LIMIT p_limit
  LOOP
    PERFORM set_config('app.workspace_id',admission.workspace_id::text,true);
    PERFORM 1 FROM app.workflow_runs
     WHERE workspace_id=admission.workspace_id
       AND id=admission.workflow_run_id AND status='queued';
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT payload INTO old_payload FROM app.outbox_events
     WHERE workspace_id=admission.workspace_id
       AND id=admission.outbox_event_id
       AND published_at IS NOT NULL AND failed_at IS NULL;
    IF FOUND THEN
      new_outbox_event_id:=gen_random_uuid();
      new_payload:=old_payload||jsonb_build_object('outboxEventId',new_outbox_event_id);
      canonical_payload:='{"outboxEventId":"'||new_outbox_event_id::text||
        '","runId":"'||admission.workflow_run_id::text||
        '"'||
        CASE WHEN old_payload?'traceparent'
          THEN ',"traceparent":'||to_jsonb(old_payload->>'traceparent')::text
          ELSE '' END||
        ',"workspaceId":"'||admission.workspace_id::text||'"}';
      INSERT INTO app.outbox_events(
        id,workspace_id,job_name,aggregate_type,aggregate_id,
        payload,payload_checksum,available_at,last_error_code
      ) VALUES(
        new_outbox_event_id,admission.workspace_id,'advance-workflow-run',
        'workflow-run',admission.workflow_run_id,new_payload,
        encode(sha256(convert_to(canonical_payload,'UTF8')),'hex'),
        clock_timestamp(),'publish.delivery_recovery'
      );
      UPDATE app.workflow_run_active_admissions
         SET outbox_event_id=new_outbox_event_id,recover_after=NULL,
             recovery_count=recovery_count+1
       WHERE workflow_run_id=admission.workflow_run_id;
      recovered:=recovered+1;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN recovered;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $function$
;
CREATE OR REPLACE FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character)
 RETURNS TABLE(endpoint_id uuid, workspace_id uuid, trigger_id uuid, workflow_id uuid, workflow_version_id uuid, node_id character varying, current_secret_version_id uuid, current_kms_key_reference character varying, current_encrypted_data_key text, current_ciphertext text, current_nonce character varying, current_auth_tag character varying, previous_secret_version_id uuid, previous_secret_valid_until timestamp with time zone, previous_kms_key_reference character varying, previous_encrypted_data_key text, previous_ciphertext text, previous_nonce character varying, previous_auth_tag character varying, database_time timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
 SET row_security TO 'on'
AS $function$
DECLARE
  resolved_workspace uuid;
  prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  SELECT endpoint.workspace_id INTO resolved_workspace
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflow_triggers trigger
      ON trigger.workspace_id=endpoint.workspace_id AND trigger.id=endpoint.trigger_id
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash
     AND endpoint.status='active' AND trigger.kind='webhook' AND trigger.status='active';
  IF resolved_workspace IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.workspace_id',resolved_workspace::text,true);
  RETURN QUERY SELECT endpoint.id,endpoint.workspace_id,trigger.id,trigger.workflow_id,
         trigger.workflow_version_id,trigger.node_id,current_secret.id,
         current_secret.kms_key_reference,
         current_secret.encrypted_data_key,current_secret.ciphertext,current_secret.nonce,current_secret.auth_tag,
         previous_secret.id,endpoint.previous_secret_valid_until,
         previous_secret.kms_key_reference,
         previous_secret.encrypted_data_key,previous_secret.ciphertext,previous_secret.nonce,previous_secret.auth_tag,
         clock_timestamp()
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflow_triggers trigger ON trigger.workspace_id=endpoint.workspace_id AND trigger.id=endpoint.trigger_id
    JOIN app.workflows workflow ON workflow.workspace_id=trigger.workspace_id AND workflow.id=trigger.workflow_id
    JOIN app.workspaces workspace ON workspace.id=trigger.workspace_id
    JOIN app.webhook_trigger_secret_versions current_secret
      ON current_secret.workspace_id=endpoint.workspace_id AND current_secret.trigger_id=trigger.id
     AND current_secret.id=endpoint.current_secret_version_id
    LEFT JOIN app.webhook_trigger_secret_versions previous_secret
      ON previous_secret.workspace_id=endpoint.workspace_id AND previous_secret.trigger_id=trigger.id
     AND previous_secret.id=endpoint.previous_secret_version_id
     AND endpoint.previous_secret_valid_until>clock_timestamp()
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active'
     AND trigger.kind='webhook' AND trigger.status='active'
     AND workflow.lifecycle_status='active' AND workflow.activation_status IN ('active','degraded')
     AND workflow.published_version_id=trigger.workflow_version_id
     AND workspace.status='active';
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $function$
;

REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_version(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_public_webhook_endpoint(character) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fold_workflow_trigger_outcomes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_workflow_run_replay_version(uuid,uuid,uuid) TO {{app_role}};
GRANT EXECUTE ON FUNCTION app.resolve_public_webhook_endpoint(character) TO {{app_role}};
GRANT EXECUTE ON FUNCTION app.fold_workflow_trigger_outcomes(integer) TO {{app_role}};
