-- Forward-only Q10 integrity repair. Historical migrations remain immutable.
-- PostgreSQL accepts a CHECK result of NULL, so effective shape contracts must
-- explicitly require true. NOT VALID plus VALIDATE performs a fail-closed scan
-- of retained rows without fabricating missing identifiers, times, or leases.

ALTER TABLE app.node_compatibility_releases
  DROP CONSTRAINT node_compatibility_releases_catalog_object,
  ADD CONSTRAINT node_compatibility_releases_catalog_object CHECK ((
    jsonb_typeof(catalog_json)='object'
    AND catalog_json->>'domain'='pertexo.node-compatibility-release'
    AND catalog_json->>'schemaVersion'='1'
  ) IS TRUE) NOT VALID;

ALTER TABLE app.preview_runs
  DROP CONSTRAINT preview_runs_integration_identity_consistent,
  ADD CONSTRAINT preview_runs_integration_identity_consistent CHECK ((
    (provider_key IS NULL AND operation_key IS NULL)
    OR (provider_key IS NOT NULL AND operation_key IS NOT NULL
      AND provider_key~'^[a-z][a-z0-9._:-]{0,63}$'
      AND operation_key~'^[a-z][a-z0-9._:-]{0,127}$')
  ) IS TRUE) NOT VALID;

ALTER TABLE app.node_runs
  DROP CONSTRAINT node_runs_due_wakeup_consistent,
  ADD CONSTRAINT node_runs_due_wakeup_consistent CHECK ((
    due_wakeup_at IS NULL OR (
      status='waiting' AND coalesce(retry_due_at,resume_at) IS NOT NULL
      AND due_wakeup_at=coalesce(retry_due_at,resume_at)
    )
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT node_runs_wait_state_valid,
  ADD CONSTRAINT node_runs_wait_state_valid CHECK ((
    (status='waiting' AND control_kind='for_each_barrier'
      AND wait_kind IS NULL AND resume_at IS NULL AND retry_due_at IS NULL)
    OR (status='waiting' AND control_kind IS NULL
      AND ((wait_kind='node_wait' AND resume_at IS NOT NULL AND retry_due_at IS NULL)
        OR (wait_kind='retry_backoff' AND resume_at IS NULL AND retry_due_at IS NOT NULL)))
    OR (status<>'waiting' AND control_kind IS NULL AND wait_kind IS NULL
      AND resume_at IS NULL AND retry_due_at IS NULL)
  ) IS TRUE) NOT VALID;

ALTER TABLE app.workflow_runs
  DROP CONSTRAINT workflow_runs_deadline_wakeup_consistent,
  ADD CONSTRAINT workflow_runs_deadline_wakeup_consistent CHECK ((
    deadline_wakeup_at IS NULL
    OR (deadline_at IS NOT NULL AND deadline_wakeup_at=deadline_at)
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT workflow_runs_failure_notification_policy_complete,
  ADD CONSTRAINT workflow_runs_failure_notification_policy_complete CHECK ((
    (failure_notification_policy_version IS NULL
      AND failure_notification_destination_id IS NULL
      AND failure_notification_destination_config_version IS NULL
      AND failure_notification_side_effect_class IS NULL
      AND failure_notification_connection_secret_version_id IS NULL)
    OR (failure_notification_policy_version=1
      AND failure_notification_destination_id IS NOT NULL
      AND failure_notification_destination_config_version IS NOT NULL
      AND failure_notification_destination_config_version>0
      AND failure_notification_side_effect_class IS NOT NULL
      AND failure_notification_side_effect_class IN ('safe','idempotent_with_key','unsafe'))
  ) IS TRUE) NOT VALID;

ALTER TABLE app.failure_notification_destination_versions
  DROP CONSTRAINT failure_notification_destination_versions_config_strict,
  ADD CONSTRAINT failure_notification_destination_versions_config_strict CHECK ((
    jsonb_typeof(config)='object' AND (
      (kind='slack' AND jsonb_typeof(config->'connectionId')='string'
        AND jsonb_typeof(config->'channelId')='string'
        AND (config-'connectionId'-'channelId')='{}'::jsonb
        AND (config->>'connectionId')~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (config->>'channelId')~'^[CDGU][A-Z0-9]{1,79}$')
      OR (kind='email' AND jsonb_typeof(config->'connectionId')='string'
        AND jsonb_typeof(config->'toEmail')='string'
        AND (config-'connectionId'-'toEmail')='{}'::jsonb
        AND (config->>'connectionId')~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND length(config->>'toEmail') BETWEEN 3 AND 254
        AND (config->>'toEmail')~'^[!-~]+@[A-Za-z0-9.-]+$')
    )
  ) IS TRUE) NOT VALID;

ALTER TABLE app.trigger_schedules
  DROP CONSTRAINT trigger_schedules_recurrence_valid,
  ADD CONSTRAINT trigger_schedules_recurrence_valid CHECK ((
    (recurrence_kind='cron' AND cron_expression IS NOT NULL
      AND timezone IS NOT NULL AND interval_minutes IS NULL)
    OR (recurrence_kind='interval' AND cron_expression IS NULL
      AND timezone IS NULL AND interval_minutes IS NOT NULL
      AND interval_minutes BETWEEN 1 AND 43200)
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT trigger_schedules_lease_valid,
  ADD CONSTRAINT trigger_schedules_lease_valid CHECK ((
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL
      AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL
      AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ) IS TRUE) NOT VALID;

ALTER TABLE app.retention_batches
  DROP CONSTRAINT retention_batches_lease_valid,
  ADD CONSTRAINT retention_batches_lease_valid CHECK ((
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (status='running' AND lease_owner IS NOT NULL
      AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ) IS TRUE) NOT VALID;

ALTER TABLE app.workspace_lifecycle_operations
  DROP CONSTRAINT workspace_lifecycle_operations_lease_valid,
  ADD CONSTRAINT workspace_lifecycle_operations_lease_valid CHECK ((
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (status='running' AND lease_owner IS NOT NULL
      AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT workspace_lifecycle_operations_result_valid,
  ADD CONSTRAINT workspace_lifecycle_operations_result_valid CHECK ((
    (status='completed' AND control_sequence IS NOT NULL AND control_sequence>0
      AND control_record_hash IS NOT NULL
      AND control_record_hash~'^[0-9a-f]{64}$' AND completed_at IS NOT NULL
      AND error_code IS NULL AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR (status='failed' AND control_sequence IS NULL
      AND control_record_hash IS NULL AND error_code IS NOT NULL
      AND length(error_code) BETWEEN 1 AND 64 AND completed_at IS NOT NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR (status IN ('pending','running') AND control_sequence IS NULL
      AND control_record_hash IS NULL AND error_code IS NULL AND completed_at IS NULL)
  ) IS TRUE) NOT VALID;

ALTER TABLE app.workspace_purge_jobs
  DROP CONSTRAINT workspace_purge_jobs_lease_valid,
  ADD CONSTRAINT workspace_purge_jobs_lease_valid CHECK ((
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (status='running' AND lease_owner IS NOT NULL
      AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT workspace_purge_jobs_projection_valid,
  ADD CONSTRAINT workspace_purge_jobs_projection_valid CHECK ((
    (status IN ('ready','running') AND control_sequence IS NULL
      AND control_record_hash IS NULL AND completed_at IS NULL)
    OR (status='purging' AND control_sequence IS NOT NULL
      AND control_record_hash IS NOT NULL
      AND control_record_hash~'^[0-9a-f]{64}$' AND completed_at IS NULL)
    OR (status='completed' AND control_sequence IS NOT NULL
      AND control_record_hash IS NOT NULL
      AND control_record_hash~'^[0-9a-f]{64}$' AND completed_at IS NOT NULL)
  ) IS TRUE) NOT VALID;

ALTER TABLE app.workspace_purge_steps
  DROP CONSTRAINT workspace_purge_steps_lease_valid,
  ADD CONSTRAINT workspace_purge_steps_lease_valid CHECK ((
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (status='running' AND lease_owner IS NOT NULL
      AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT workspace_purge_steps_completion_valid,
  ADD CONSTRAINT workspace_purge_steps_completion_valid CHECK ((
    (status='completed' AND completed_at IS NOT NULL)
    OR (status<>'completed' AND completed_at IS NULL)
  ) IS TRUE) NOT VALID;

ALTER TABLE app.workspace_purge_completions
  DROP CONSTRAINT workspace_purge_completions_lease_valid,
  ADD CONSTRAINT workspace_purge_completions_lease_valid CHECK ((
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR (status='running' AND lease_owner IS NOT NULL
      AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT workspace_purge_completions_projection_valid,
  ADD CONSTRAINT workspace_purge_completions_projection_valid CHECK ((
    (status IN ('ready','running') AND projected_at IS NULL)
    OR (status='projected' AND projected_at IS NOT NULL)
  ) IS TRUE) NOT VALID;

ALTER TABLE app.operator_commands
  DROP CONSTRAINT operator_commands_completion_order,
  ADD CONSTRAINT operator_commands_completion_order CHECK ((
    (status='pending' AND completed_at IS NULL)
    OR (status IN ('completed','failed') AND completed_at IS NOT NULL
      AND completed_at>=created_at)
  ) IS TRUE) NOT VALID;

ALTER TABLE app.operator_maintenance_rerun_requests
  DROP CONSTRAINT operator_maintenance_rerun_outcome_valid,
  ADD CONSTRAINT operator_maintenance_rerun_outcome_valid CHECK ((
    (status='pending' AND outcome IS NULL AND completed_at IS NULL)
    OR (status='completed' AND outcome IS NOT NULL
      AND outcome~'^[a-z][a-z0-9_]{0,31}$' AND completed_at IS NOT NULL)
  ) IS TRUE) NOT VALID;

ALTER TABLE app.node_compatibility_releases VALIDATE CONSTRAINT node_compatibility_releases_catalog_object;
ALTER TABLE app.preview_runs VALIDATE CONSTRAINT preview_runs_integration_identity_consistent;
ALTER TABLE app.node_runs VALIDATE CONSTRAINT node_runs_due_wakeup_consistent;
ALTER TABLE app.node_runs VALIDATE CONSTRAINT node_runs_wait_state_valid;
ALTER TABLE app.workflow_runs VALIDATE CONSTRAINT workflow_runs_deadline_wakeup_consistent;
ALTER TABLE app.workflow_runs VALIDATE CONSTRAINT workflow_runs_failure_notification_policy_complete;
ALTER TABLE app.failure_notification_destination_versions VALIDATE CONSTRAINT failure_notification_destination_versions_config_strict;
ALTER TABLE app.trigger_schedules VALIDATE CONSTRAINT trigger_schedules_recurrence_valid;
ALTER TABLE app.trigger_schedules VALIDATE CONSTRAINT trigger_schedules_lease_valid;
ALTER TABLE app.retention_batches VALIDATE CONSTRAINT retention_batches_lease_valid;
ALTER TABLE app.workspace_lifecycle_operations VALIDATE CONSTRAINT workspace_lifecycle_operations_lease_valid;
ALTER TABLE app.workspace_lifecycle_operations VALIDATE CONSTRAINT workspace_lifecycle_operations_result_valid;
ALTER TABLE app.workspace_purge_jobs VALIDATE CONSTRAINT workspace_purge_jobs_lease_valid;
ALTER TABLE app.workspace_purge_jobs VALIDATE CONSTRAINT workspace_purge_jobs_projection_valid;
ALTER TABLE app.workspace_purge_steps VALIDATE CONSTRAINT workspace_purge_steps_lease_valid;
ALTER TABLE app.workspace_purge_steps VALIDATE CONSTRAINT workspace_purge_steps_completion_valid;
ALTER TABLE app.workspace_purge_completions VALIDATE CONSTRAINT workspace_purge_completions_lease_valid;
ALTER TABLE app.workspace_purge_completions VALIDATE CONSTRAINT workspace_purge_completions_projection_valid;
ALTER TABLE app.operator_commands VALIDATE CONSTRAINT operator_commands_completion_order;
ALTER TABLE app.operator_maintenance_rerun_requests VALIDATE CONSTRAINT operator_maintenance_rerun_outcome_valid;

-- Effective privileged boundaries are replaced below; their existing grants
-- remain unchanged.

CREATE OR REPLACE FUNCTION app.validate_workflow_run_failure_notification_pin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  configured_connection_id uuid;
  pin_valid boolean;
BEGIN
  IF NEW.failure_notification_policy_version IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(version.config)='object'
      AND version.config ? 'connectionId'
      AND (version.config->>'connectionId') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN (version.config->>'connectionId')::uuid
    ELSE NULL
  END
  INTO configured_connection_id
  FROM app.failure_notification_destinations destination
  JOIN app.failure_notification_destination_versions version
    ON version.workspace_id=destination.workspace_id
   AND version.destination_id=destination.id
   AND version.version=NEW.failure_notification_destination_config_version
  WHERE destination.workspace_id=NEW.workspace_id
    AND destination.id=NEW.failure_notification_destination_id
    AND destination.current_config_version=version.version
    AND destination.status='enabled'
    AND version.kind=destination.kind
    AND version.side_effect_class=NEW.failure_notification_side_effect_class
    AND ((version.kind='slack' AND version.side_effect_class='unsafe')
      OR (version.kind='email' AND version.side_effect_class='idempotent_with_key'))
  FOR SHARE OF destination;

  IF configured_connection_id IS NOT NULL THEN
    SELECT true INTO pin_valid
    FROM app.workspaces workspace
    JOIN app.connections connection
      ON connection.workspace_id=workspace.id
     AND connection.id=configured_connection_id
    JOIN app.connection_secret_versions secret
      ON secret.workspace_id=connection.workspace_id
     AND secret.connection_id=connection.id
     AND secret.id=NEW.failure_notification_connection_secret_version_id
    WHERE workspace.id=NEW.workspace_id
      AND workspace.status='active'
      AND connection.status='active'
      AND connection.current_secret_version_id=secret.id
      AND ((NEW.failure_notification_side_effect_class='unsafe'
            AND connection.provider_key='slack'
            AND connection.auth_type='slack_bot_token')
        OR (NEW.failure_notification_side_effect_class='idempotent_with_key'
            AND connection.provider_key='email'
            AND connection.auth_type='resend_api_key'))
    FOR SHARE OF workspace,connection;
  END IF;

  IF coalesce(pin_valid,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'new failure notification policy pin is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app.request_operator_maintenance_rerun(
  p_command_id uuid,
  p_workspace_id uuid,
  p_target_type varchar,
  p_target_id uuid,
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
  v_command_type varchar(64);
  v_existing app.operator_commands%ROWTYPE;
  v_fingerprint char(64);
  v_found boolean;
  v_material jsonb;
  v_outcome varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_result jsonb;
BEGIN
  IF p_command_id IS NULL OR p_workspace_id IS NULL OR p_target_id IS NULL
    OR p_target_type IS NULL OR p_target_type NOT IN ('retention_batch','workspace_purge_job')
    OR p_actor_ref IS NULL
    OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512
    OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'maintenance rerun command is invalid' USING ERRCODE='22023';
  END IF;
  v_command_type:=CASE p_target_type WHEN 'retention_batch'
    THEN 'retention.rerun' ELSE 'purge.rerun' END;
  v_material:=jsonb_build_object(
    'actorRef',p_actor_ref,'commandType',v_command_type,'dryRun',p_dry_run,
    'reason',p_reason,'targetId',p_target_id,'workspaceId',p_workspace_id
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
      gen_random_uuid(),p_workspace_id,'operator.maintenance_rerun',
      p_target_type,p_target_id,p_command_id::text,jsonb_build_object(
        'actorRef',p_actor_ref,'commandType',v_command_type,'dryRun',p_dry_run,
        'outcome',v_outcome,'reason',p_reason,'replayed',true,
        'requestFingerprint',v_fingerprint
      )
    );
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT p_command_id,v_existing.status,v_outcome,true,v_result;
    RETURN;
  END IF;

  IF p_target_type='retention_batch' THEN
    SELECT EXISTS(SELECT 1 FROM app.retention_batches batch
      WHERE batch.workspace_id=p_workspace_id AND batch.id=p_target_id)
      INTO v_found;
  ELSE
    SELECT EXISTS(SELECT 1 FROM app.workspace_purge_jobs job
      WHERE job.workspace_id=p_workspace_id AND job.id=p_target_id)
      INTO v_found;
  END IF;
  v_outcome:=CASE WHEN NOT v_found THEN 'not_found'
    WHEN p_dry_run THEN 'would_request' ELSE 'rerun_requested' END;
  v_result:=jsonb_build_object(
    'schemaVersion',1,'outcome',v_outcome,'targetId',p_target_id,
    'targetType',p_target_type
  );
  INSERT INTO app.operator_commands(
    id,command_type,dry_run,request_fingerprint,status,outcome,result,completed_at
  ) VALUES(
    p_command_id,v_command_type,p_dry_run,v_fingerprint,
    CASE WHEN v_outcome='rerun_requested' THEN 'pending' ELSE 'completed' END,
    v_outcome,v_result,
    CASE WHEN v_outcome='rerun_requested' THEN NULL ELSE clock_timestamp() END
  );
  IF v_outcome='rerun_requested' THEN
    INSERT INTO app.operator_maintenance_rerun_requests(
      command_id,workspace_id,target_type,target_id
    ) VALUES(p_command_id,p_workspace_id,p_target_type,p_target_id);
  END IF;
  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.maintenance_rerun',
    p_target_type,p_target_id,p_command_id::text,jsonb_build_object(
      'actorRef',p_actor_ref,'commandType',v_command_type,'dryRun',p_dry_run,
      'outcome',v_outcome,'reason',p_reason,'requestFingerprint',v_fingerprint
    )
  );
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT p_command_id,
    CASE WHEN v_outcome='rerun_requested' THEN 'pending' ELSE 'completed' END::varchar,
    v_outcome,false,v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.lock_workflow_failure_notification_policy(
  p_workspace_id uuid,p_workflow_id uuid
) RETURNS TABLE(
  destination_id uuid,current_config_version integer,destination_status varchar,
  kind varchar,side_effect_class varchar,connection_id uuid
) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
  SELECT destination.id,destination.current_config_version,destination.status,
         version.kind,version.side_effect_class,
         CASE WHEN jsonb_typeof(version.config)='object'
           AND version.config?'connectionId'
           AND (version.config->>'connectionId')~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           THEN (version.config->>'connectionId')::uuid ELSE NULL END
    FROM app.workflow_failure_notification_policies policy
    JOIN app.failure_notification_destinations destination
      ON destination.workspace_id=policy.workspace_id
     AND destination.id=policy.destination_id
    JOIN app.failure_notification_destination_versions version
      ON version.workspace_id=destination.workspace_id
     AND version.destination_id=destination.id
     AND version.version=destination.current_config_version
   WHERE policy.workspace_id=p_workspace_id AND policy.workflow_id=p_workflow_id
   FOR SHARE OF policy,destination
$$;

CREATE OR REPLACE FUNCTION app.lock_execution_artifact_references()
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
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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

CREATE OR REPLACE FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
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
        '","schemaVersion":1'||
        CASE WHEN old_payload?'traceparent'
          THEN ',"traceparent":'||to_jsonb(old_payload->>'traceparent')::text
          ELSE '' END||
        ',"workspaceId":"'||admission.workspace_id::text||'"}';
      INSERT INTO app.outbox_events(
        id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
        payload,payload_checksum,available_at,last_error_code
      ) VALUES(
        new_outbox_event_id,admission.workspace_id,'advance-workflow-run',1,
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
END $$;

CREATE OR REPLACE FUNCTION app.defer_trigger_schedule_claim(
  p_trigger_id uuid,p_lease_token uuid,p_retry_seconds integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace_id uuid;
BEGIN
  IF p_retry_seconds IS NULL OR p_retry_seconds<1 OR p_retry_seconds>300 THEN
    RAISE EXCEPTION 'invalid schedule admission backoff' USING ERRCODE='22023';
  END IF;
  UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
    lease_expires_at=NULL,admission_deferred_until=clock_timestamp()+make_interval(secs=>p_retry_seconds),
    health_status='degraded',last_error_code='schedule.admission_throttled',updated_at=clock_timestamp()
   WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token RETURNING workspace_id INTO v_workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.workflow_triggers SET health_status='degraded',last_error_code='schedule.admission_throttled',
    updated_at=clock_timestamp() WHERE id=p_trigger_id AND workspace_id=v_workspace_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.enumerate_committed_tenant_artifacts(
  p_after_workspace_id uuid,
  p_after_artifact_id uuid,
  p_limit integer
) RETURNS TABLE(
  workspace_id uuid,
  artifact_id uuid,
  byte_length bigint,
  media_type varchar,
  sha256 text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR
     ((p_after_workspace_id IS NULL)<>(p_after_artifact_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid restore artifact inventory cursor or bound'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT artifact.workspace_id,artifact.id,artifact.byte_length,
         artifact.media_type,artifact.sha256::text
    FROM app.artifacts artifact
   WHERE artifact.status='available'
     AND artifact.finalized_at IS NOT NULL
     AND artifact.deleted_at IS NULL
     AND (
       p_after_workspace_id IS NULL OR
       (artifact.workspace_id,artifact.id)>
         (p_after_workspace_id,p_after_artifact_id)
     )
   ORDER BY artifact.workspace_id,artifact.id
   LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION app.reap_transient_data(p_limit integer DEFAULT 100)
RETURNS TABLE (
  idempotency_records_deleted integer,
  workspace_creation_records_deleted integer,
  sessions_deleted integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_idempotency_records_deleted integer;
  v_workspace_creation_records_deleted integer;
  v_sessions_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'transient-data reaper limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT record.id
    FROM app.idempotency_records record
    WHERE record.status = 'completed'
      AND record.expires_at <= clock_timestamp()
      AND NOT EXISTS (
        SELECT 1
        FROM app.workspace_legal_holds hold
        WHERE hold.workspace_id = record.workspace_id
          AND hold.released_sequence IS NULL
      )
    ORDER BY record.expires_at, record.id
    LIMIT p_limit
    FOR UPDATE OF record SKIP LOCKED
  )
  DELETE FROM app.idempotency_records record
  USING candidates
  WHERE record.id = candidates.id;
  GET DIAGNOSTICS v_idempotency_records_deleted = ROW_COUNT;

  WITH candidates AS (
    SELECT record.id
    FROM app.workspace_creation_idempotency_records record
    WHERE record.status IN ('completed', 'failed')
      AND record.expires_at <= clock_timestamp()
      AND NOT EXISTS (
        SELECT 1
        FROM app.workspace_legal_holds hold
        WHERE hold.workspace_id = record.resource_id
          AND hold.released_sequence IS NULL
      )
    ORDER BY record.expires_at, record.id
    LIMIT p_limit
    FOR UPDATE OF record SKIP LOCKED
  )
  DELETE FROM app.workspace_creation_idempotency_records record
  USING candidates
  WHERE record.id = candidates.id;
  GET DIAGNOSTICS v_workspace_creation_records_deleted = ROW_COUNT;

  WITH candidates AS (
    SELECT session.id
    FROM app.sessions session
    WHERE coalesce(session.revoked_at, session.expires_at)
      <= clock_timestamp() - interval '30 days'
    ORDER BY coalesce(session.revoked_at, session.expires_at), session.id
    LIMIT p_limit
    FOR UPDATE OF session SKIP LOCKED
  )
  DELETE FROM app.sessions session
  USING candidates
  WHERE session.id = candidates.id;
  GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_idempotency_records_deleted,
    v_workspace_creation_records_deleted, v_sessions_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION app.claim_due_trigger_schedules(
  p_lease_owner varchar,p_limit integer,p_lease_seconds integer
) RETURNS TABLE(
  trigger_id uuid,workspace_id uuid,workflow_id uuid,workflow_version_id uuid,node_id varchar,
  recurrence_kind varchar,cron_expression varchar,timezone varchar,interval_minutes integer,
  misfire_policy varchar,config_fingerprint varchar,anchor_at timestamptz,next_fire_at timestamptz,
  lease_token uuid,observed_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_observed_at timestamptz := clock_timestamp();
BEGIN
  IF p_lease_owner IS NULL OR length(p_lease_owner)<1 OR length(p_lease_owner)>128
    OR p_limit IS NULL OR p_limit<1 OR p_limit>100
    OR p_lease_seconds IS NULL OR p_lease_seconds<1 OR p_lease_seconds>300 THEN
    RAISE EXCEPTION 'invalid schedule claim bounds' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH ranked AS (
    SELECT schedule.trigger_id,row_number() over (partition by schedule.workspace_id
      ORDER BY schedule.next_fire_at,schedule.trigger_id) AS workspace_rank
      FROM app.trigger_schedules schedule
      JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
     WHERE schedule.status='enabled' AND schedule.next_fire_at<=v_observed_at
       AND (schedule.admission_deferred_until IS NULL OR schedule.admission_deferred_until<=v_observed_at)
       AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at<=v_observed_at)
       AND trigger.status='active'
  ), due AS (
    SELECT schedule.trigger_id FROM app.trigger_schedules schedule
      JOIN ranked ON ranked.trigger_id=schedule.trigger_id AND ranked.workspace_rank=1
      JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
     WHERE schedule.status='enabled' AND schedule.next_fire_at<=v_observed_at
       AND (schedule.admission_deferred_until IS NULL OR schedule.admission_deferred_until<=v_observed_at)
       AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at<=v_observed_at)
       AND trigger.status='active'
     ORDER BY schedule.next_fire_at,schedule.workspace_id,schedule.trigger_id
     LIMIT p_limit FOR UPDATE OF schedule SKIP LOCKED
  ), claimed AS (
    UPDATE app.trigger_schedules schedule SET lease_owner=p_lease_owner,
      lease_token=gen_random_uuid(),lease_acquired_at=v_observed_at,
      lease_expires_at=v_observed_at+make_interval(secs=>p_lease_seconds),updated_at=v_observed_at
      FROM due WHERE schedule.trigger_id=due.trigger_id RETURNING schedule.*
  ) SELECT claimed.trigger_id,claimed.workspace_id,trigger.workflow_id,trigger.workflow_version_id,
      trigger.node_id,claimed.recurrence_kind,claimed.cron_expression,claimed.timezone,
      claimed.interval_minutes,claimed.misfire_policy,claimed.config_fingerprint,claimed.anchor_at,
      claimed.next_fire_at,claimed.lease_token,v_observed_at
    FROM claimed JOIN app.workflow_triggers trigger ON trigger.id=claimed.trigger_id
    ORDER BY claimed.next_fire_at,claimed.workspace_id,claimed.trigger_id;
END $$;

CREATE OR REPLACE FUNCTION app.lock_workspace_lifecycle_operation(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS TABLE(
  workspace_id uuid,command_type varchar,actor_ref varchar,reason varchar,
  occurred_at timestamptz,control_sequence bigint,control_hash char(64),
  append_authorized boolean
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
DECLARE v_workspace app.workspaces%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace lifecycle lease' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token IS DISTINCT FROM p_lease_token
    OR v_operation.lease_fence IS DISTINCT FROM p_lease_fence
    OR (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'workspace lifecycle lease is stale' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_workspace FROM app.workspaces
    WHERE id=v_operation.workspace_id FOR UPDATE;
  RETURN QUERY SELECT v_operation.workspace_id,v_operation.command_type,
    v_operation.actor_user_id::text::varchar,v_operation.reason,v_operation.occurred_at,
    v_workspace.retention_control_sequence,v_workspace.retention_control_hash,
    v_operation.append_authorized_at IS NOT NULL;
END $$;

CREATE OR REPLACE FUNCTION app.authorize_workspace_lifecycle_append(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
DECLARE v_workspace app.workspaces%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace lifecycle lease' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token IS DISTINCT FROM p_lease_token
    OR v_operation.lease_fence IS DISTINCT FROM p_lease_fence
    OR (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'workspace lifecycle lease is stale' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_workspace FROM app.workspaces
    WHERE id=v_operation.workspace_id FOR UPDATE;
  IF v_operation.append_authorized_at IS NOT NULL THEN RETURN true; END IF;
  PERFORM set_config('app.workspace_id',v_operation.workspace_id::text,true);
  IF NOT EXISTS (
    SELECT 1 FROM app.users user_record
    JOIN app.workspace_memberships membership ON membership.user_id=user_record.id
    WHERE user_record.id=v_operation.actor_user_id AND user_record.status='active'
      AND membership.workspace_id=v_operation.workspace_id
      AND membership.status='active' AND membership.role='owner'
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle authorization was lost' USING ERRCODE='42501';
  END IF;
  IF v_operation.command_type='deletion_requested'
    AND v_workspace.status NOT IN ('active','suspended') THEN
    RAISE EXCEPTION 'workspace lifecycle transition is no longer valid'
      USING ERRCODE='55000';
  ELSIF v_operation.command_type='deletion_restored'
    AND (v_workspace.status<>'pending_deletion'
      OR clock_timestamp()>=v_workspace.purge_after) THEN
    RAISE EXCEPTION 'workspace lifecycle transition is no longer valid'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  UPDATE app.workspace_lifecycle_operations
    SET append_authorized_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=v_operation.id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.read_workspace_lifecycle_control_command(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS SETOF app.workspace_control_ledger_projection
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace lifecycle lease' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token IS DISTINCT FROM p_lease_token
    OR v_operation.lease_fence IS DISTINCT FROM p_lease_fence
    OR (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'workspace lifecycle lease is stale' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT record.* FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=v_operation.workspace_id
      AND record.command_id=v_operation.id;
END $$;

CREATE OR REPLACE FUNCTION app.project_and_complete_workspace_lifecycle_operation(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint,p_sequence bigint,
  p_previous_hash char(64),p_record_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
DECLARE v_projected boolean;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace lifecycle lease' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token IS DISTINCT FROM p_lease_token
    OR v_operation.lease_fence IS DISTINCT FROM p_lease_fence
    OR (v_operation.lease_expires_at IS NULL OR v_operation.lease_expires_at<=clock_timestamp())
    OR v_operation.append_authorized_at IS NULL THEN
    RAISE EXCEPTION 'workspace lifecycle projection is not authorized'
      USING ERRCODE='42501';
  END IF;
  PERFORM set_config('app.workspace_id',v_operation.workspace_id::text,true);
  v_projected:=app.project_workspace_deletion(
    v_operation.workspace_id,p_sequence,v_operation.id,v_operation.command_type,
    v_operation.workspace_id,p_previous_hash,p_record_hash,
    v_operation.actor_user_id::text,NULL,v_operation.reason,
    v_operation.occurred_at,interval '30 days'
  );
  IF v_operation.command_type='deletion_requested' THEN
    UPDATE app.sessions session_record
      SET revoked_at=coalesce(session_record.revoked_at,clock_timestamp())
      WHERE session_record.revoked_at IS NULL AND EXISTS (
        SELECT 1 FROM app.workspace_memberships membership
        WHERE membership.workspace_id=v_operation.workspace_id
          AND membership.user_id=session_record.user_id
          AND membership.status<>'removed'
      );
  END IF;
  IF NOT app.complete_workspace_lifecycle_operation(
    v_operation.id,p_lease_token,p_lease_fence,p_sequence,p_record_hash
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle completion lease is stale'
      USING ERRCODE='55000';
  END IF;
  RETURN v_projected;
END $$;

CREATE OR REPLACE FUNCTION app.project_workspace_purge_started(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,p_sequence bigint,
  p_previous_hash char(64),p_record_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_projected boolean;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace purge lease' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'running' OR v_job.lease_token IS DISTINCT FROM p_lease_token
    OR v_job.lease_fence IS DISTINCT FROM p_lease_fence OR (v_job.lease_expires_at IS NULL OR v_job.lease_expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'workspace purge lease is stale' USING ERRCODE='55000';
  END IF;
  v_projected:=app.project_workspace_deletion(v_job.workspace_id,p_sequence,
    v_job.command_id,'purge_started',v_job.workspace_id,p_previous_hash,p_record_hash,
    v_job.actor_ref,NULL,v_job.reason,v_job.occurred_at,interval '30 days');
  PERFORM set_config('app.workspace_purge_transition','on',true);
  INSERT INTO app.workspace_purge_steps(job_id,step_name)
    SELECT v_job.id,step_name FROM unnest(ARRAY['object_versions','tenant_rows']) step_name
    ON CONFLICT DO NOTHING;
  UPDATE app.workspace_purge_jobs SET status='purging',control_sequence=p_sequence,
    control_record_hash=p_record_hash,lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=v_job.id;
  RETURN v_projected;
END $$;
