-- Pertexo schema baseline (ADR 069). It replaces migrations 0000-0137; every
-- existing database is recreated. New changes go in new numbered migrations.

SET LOCAL check_function_bodies = false;
SET LOCAL client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', true);

CREATE SCHEMA app;

CREATE FUNCTION app.admit_workflow_organization_batch(p_key_hash text, p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_request jsonb; v_replay jsonb;
BEGIN
  v_request:=app.workflow_organization_batch_body(p_body);
  v_workspace:=app.lock_workflow_organization_authority(CASE WHEN v_request->>'operation'='tag_cleanup'
    THEN ARRAY['owner','admin'] ELSE ARRAY['owner','admin','builder'] END);
  v_replay:=app.claim_workflow_organization_command('organization.batch.identity',v_workspace,p_key_hash,v_request);
  IF EXISTS(SELECT 1 FROM app.workflow_organization_receipts WHERE workspace_id=v_workspace
    AND actor_id::text=current_setting('app.actor_id') AND operation='organization.batch.identity'
    AND target_id=v_workspace AND key_hash=p_key_hash AND expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'organization batch recovery expired' USING ERRCODE='P7002'; END IF;
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  UPDATE app.workflow_organization_receipts SET admission_xid=pg_current_xact_id()
    WHERE workspace_id=v_workspace AND actor_id::text=current_setting('app.actor_id')
      AND operation='organization.batch.identity' AND target_id=v_workspace AND key_hash=p_key_hash AND result IS NULL;
  PERFORM app.complete_workflow_organization_command('organization.batch.identity',v_workspace,p_key_hash,'{"admitted":true}'::jsonb);
  RETURN '{"admitted":true}'::jsonb;
END $$;

CREATE FUNCTION app.apply_connection_health_observation(p_workspace uuid, p_observation uuid, p_mode text, p_outbox uuid, p_checksum text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_observation app.connection_health_observations%ROWTYPE;
  v_dispatch app.node_attempt_connection_dispatches%ROWTYPE; v_connection app.connections%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace
    OR p_mode NOT IN ('off','observe','enforce') THEN
    RAISE EXCEPTION 'connection health application tenant/mode mismatch' USING ERRCODE='PTH04';
  END IF;
  SELECT * INTO v_observation FROM app.connection_health_observations
    WHERE workspace_id=p_workspace AND id=p_observation FOR UPDATE;
  IF NOT FOUND OR v_observation.applied_at IS NOT NULL THEN RETURN false; END IF;
  IF v_observation.outbox_event_id<>p_outbox OR NOT EXISTS(
    SELECT 1 FROM app.outbox_events outbox JOIN app.inbox_receipts receipt
      ON receipt.workspace_id=outbox.workspace_id AND receipt.message_id=outbox.id
    WHERE outbox.workspace_id=p_workspace AND outbox.id=p_outbox
      AND outbox.job_name='apply-connection-health-observation' AND outbox.aggregate_type='connection-health-observation'
      AND outbox.aggregate_id=p_observation AND outbox.payload_checksum=p_checksum
      AND outbox.payload->>'workspaceId'=p_workspace::text AND outbox.payload->>'observationId'=p_observation::text
      AND outbox.payload->>'outboxEventId'=p_outbox::text AND outbox.schema_version=1
      AND receipt.consumer_name='connection-health-worker' AND receipt.payload_checksum=p_checksum AND receipt.completed_at IS NULL
  ) THEN RAISE EXCEPTION 'connection health authoritative delivery mismatch' USING ERRCODE='PTH04'; END IF;
  SELECT * INTO v_dispatch FROM app.node_attempt_connection_dispatches WHERE workspace_id=p_workspace AND attempt_id=v_observation.attempt_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.connection_health_observations SET applied_at=clock_timestamp() WHERE id=p_observation AND workspace_id=p_workspace;
  IF p_mode<>'enforce' OR v_observation.production_mode<>'enforce' THEN RETURN false; END IF;
  SELECT * INTO v_connection FROM app.connections WHERE workspace_id=p_workspace AND id=v_dispatch.connection_id FOR UPDATE;
  IF NOT FOUND OR v_connection.status='revoked' OR v_connection.current_secret_version_id<>v_dispatch.secret_version_id
    OR v_connection.health_revision<>v_dispatch.health_revision OR v_connection.provider_key<>'slack'
    OR v_connection.auth_type<>'slack_bot_token' THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.node_attempts WHERE workspace_id=p_workspace AND id=v_dispatch.attempt_id
      AND dispatch_marked_at IS NOT NULL AND status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')) THEN RETURN false; END IF;
  PERFORM set_config('app.connection_health_protocol','1',true);
  IF v_observation.kind='healthy' THEN
    IF v_connection.status<>'active' THEN RETURN false; END IF;
    UPDATE app.connections SET last_healthy_at=greatest(last_healthy_at,v_observation.observed_at),last_run_observed_at=greatest(last_run_observed_at,v_observation.observed_at),
      last_error_code=NULL,updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=v_connection.id;
  ELSE
    UPDATE app.connections SET status='reauthorization_required',health_revision=health_revision+1,
      last_error_code=v_observation.reason_code,last_run_observed_at=v_observation.observed_at,
      last_health_transition_at=clock_timestamp(),last_health_transition_source='run',updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace AND id=v_connection.id;
    INSERT INTO app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id,metadata)
      VALUES(p_observation,p_workspace,v_connection.id,'connection.reauthorization_required','worker','connection-health-worker',
        jsonb_build_object('source','run','status','reauthorization_required','reasonCode',v_observation.reason_code));
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION app.apply_workflow_organization_item(p_operation text, p_workflow uuid, p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_folder uuid; v_previous_folder uuid; v_tags uuid[];
  v_lifecycle text; v_role text; v_revision bigint; v_expected bigint; v_id uuid; v_result jsonb;
BEGIN
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_expected:=(p_body->>'expectedOrganizationRevision')::bigint;
  PERFORM app.lock_workflow_organization_coordination(true);
  IF p_operation='move' THEN
    v_folder:=(p_body->>'folderId')::uuid;
    SELECT folder_id INTO v_previous_folder FROM app.workflow_organization_state
      WHERE workspace_id=v_workspace AND workflow_id=p_workflow;
    PERFORM 1 FROM app.workflow_folders WHERE workspace_id=v_workspace
      AND id IN (v_folder,v_previous_folder) ORDER BY id FOR UPDATE;
    IF v_folder IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=v_folder) THEN
      RAISE EXCEPTION 'folder is not visible' USING ERRCODE='P7016'; END IF;
  ELSE
    SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_tags FROM (
      SELECT (value#>>'{}')::uuid id FROM jsonb_array_elements(CASE p_operation
        WHEN 'replace_tags' THEN p_body->'tagIds' ELSE jsonb_build_array(p_body->'tagId') END)) ids;
    PERFORM 1 FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=ANY(v_tags) ORDER BY id FOR UPDATE;
    IF (SELECT count(*) FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=ANY(v_tags))<>cardinality(v_tags) THEN
      RAISE EXCEPTION 'organization target is not visible' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT lifecycle_status INTO v_lifecycle FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  SELECT role INTO v_role FROM app.workspace_memberships WHERE workspace_id=v_workspace
    AND user_id::text=current_setting('app.actor_id') AND status='active';
  IF v_lifecycle<>'active' AND (p_operation='replace_tags' OR (p_operation='move' AND v_role NOT IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'workflow lifecycle conflict' USING ERRCODE='P7009'; END IF;
  SELECT revision INTO v_revision FROM app.workflow_organization_state WHERE workspace_id=v_workspace AND workflow_id=p_workflow;
  v_revision:=coalesce(v_revision,1);
  IF v_revision<>v_expected OR v_revision=9007199254740991 THEN
    RAISE EXCEPTION 'organization revision conflict' USING ERRCODE='P7008'; END IF;
  IF p_operation='move' THEN
    INSERT INTO app.workflow_organization_state(workspace_id,workflow_id,revision,folder_id)
      VALUES(v_workspace,p_workflow,v_revision+1,v_folder) ON CONFLICT(workspace_id,workflow_id)
      DO UPDATE SET revision=EXCLUDED.revision,folder_id=EXCLUDED.folder_id;
  ELSE
    IF p_operation='replace_tags' THEN
      DELETE FROM app.workflow_tag_assignments WHERE workspace_id=v_workspace AND workflow_id=p_workflow;
      FOREACH v_id IN ARRAY v_tags LOOP
        INSERT INTO app.workflow_tag_assignments(workspace_id,workflow_id,tag_id) VALUES(v_workspace,p_workflow,v_id);
      END LOOP;
    ELSE
      DELETE FROM app.workflow_tag_assignments WHERE workspace_id=v_workspace AND workflow_id=p_workflow AND tag_id=v_tags[1];
    END IF;
    INSERT INTO app.workflow_organization_state(workspace_id,workflow_id,revision)
      VALUES(v_workspace,p_workflow,v_revision+1) ON CONFLICT(workspace_id,workflow_id) DO UPDATE SET revision=EXCLUDED.revision;
  END IF;
  v_result:=jsonb_build_object('workflowId',p_workflow,'organizationRevision',v_revision+1);
  IF p_operation='move' THEN v_result:=v_result||jsonb_build_object('folderId',v_folder); END IF;
  PERFORM app.record_workflow_organization_audit('workflow.organization.'||p_operation,p_workflow,
    jsonb_build_object('organizationRevision',v_revision+1));
  RETURN v_result;
END $$;

CREATE FUNCTION app.apply_workspace_deletion_side_effects() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_prior_workspace text; v_prior_health_protocol text;
  v_canonical_payload text;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_next_sequence integer;
  v_outbox_id uuid;
  v_payload jsonb;
  v_run app.workflow_runs%ROWTYPE;
BEGIN
  IF NEW.status<>'pending_deletion' THEN
    RETURN NEW;
  END IF;
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);

  UPDATE app.sessions session_record
    SET revoked_at=coalesce(session_record.revoked_at,NEW.deletion_requested_at)
    WHERE session_record.revoked_at IS NULL AND EXISTS (
      SELECT 1 FROM app.workspace_memberships membership
      WHERE membership.workspace_id=NEW.id
        AND membership.user_id=session_record.user_id
        AND membership.status<>'removed'
    );

  v_prior_health_protocol:=current_setting('app.connection_health_protocol',true); PERFORM set_config('app.connection_health_protocol','1',true); UPDATE app.connections SET status='reauthorization_required', health_revision=health_revision+1,last_health_transition_at=NULL,last_health_transition_source=NULL,
    last_error_code='workspace.pending_deletion',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status='active'; PERFORM set_config('app.connection_health_protocol',coalesce(v_prior_health_protocol,''),true);

  UPDATE app.webhook_trigger_endpoints SET status='disabled',
    previous_secret_version_id=NULL,previous_secret_valid_until=NULL,
    updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status<>'disabled';

  UPDATE app.trigger_schedules SET status='disabled',health_status='disabled',
    last_error_code=NULL,lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id;

  UPDATE app.workflow_triggers SET status='disabled',health_status='disabled',
    last_error_code=NULL,reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id;

  UPDATE app.workflows SET activation_status='inactive',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND activation_status<>'inactive';

  UPDATE app.failure_notification_destinations
    SET status='disabled',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status='enabled';

  FOR v_run IN
    SELECT * FROM app.workflow_runs
    WHERE workspace_id=NEW.id AND status IN ('queued','running','waiting')
    ORDER BY id FOR UPDATE
  LOOP
    SELECT coalesce(max(event.sequence),0)+1 INTO v_next_sequence
      FROM app.run_events event WHERE event.workflow_run_id=v_run.id;
    IF v_run.cancel_requested_at IS NULL THEN
      INSERT INTO app.run_events(workspace_id,workflow_run_id,sequence,type,payload,created_at)
      VALUES (NEW.id,v_run.id,v_next_sequence,'run.cancel_requested',
        jsonb_build_object('actor',NEW.deletion_requested_by::text,
          'reason','Workspace deletion requested'),NEW.deletion_requested_at);
      v_next_sequence:=v_next_sequence+1;
    END IF;

    IF v_run.status='queued' THEN
      SELECT * INTO v_checkpoint FROM app.run_checkpoints
        WHERE workflow_run_id=v_run.id FOR UPDATE;
      IF NOT FOUND OR v_checkpoint.scheduler_state->>'runStatus'<>'queued'
        OR EXISTS (SELECT 1 FROM app.node_runs node WHERE node.workflow_run_id=v_run.id) THEN
        RAISE EXCEPTION 'queued workspace run cannot be canceled consistently'
          USING ERRCODE='55000';
      END IF;
      UPDATE app.workflow_runs SET status='canceled',
        cancel_requested_at=coalesce(cancel_requested_at,NEW.deletion_requested_at),
        cancel_requested_by=coalesce(cancel_requested_by,NEW.deletion_requested_by::text),
        cancel_reason=coalesce(cancel_reason,'Workspace deletion requested'),
        completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE id=v_run.id;
      INSERT INTO app.run_events(workspace_id,workflow_run_id,sequence,type,payload,created_at)
      VALUES (NEW.id,v_run.id,v_next_sequence,'run.canceled','{}'::jsonb,
        clock_timestamp());
      v_next_sequence:=v_next_sequence+1;
      UPDATE app.run_checkpoints SET revision=revision+1,
        scheduler_state=jsonb_set(jsonb_set(jsonb_set(jsonb_set(
          scheduler_state,'{revision}',to_jsonb(revision+1)),
          '{runStatus}',to_jsonb('canceled'::text)),
          '{nextEventSequence}',to_jsonb(v_next_sequence)),
          '{cancelRequested}','true'::jsonb),
        resume_at=NULL,resume_lease_owner=NULL,resume_lease_token=NULL,
        resume_lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE workflow_run_id=v_run.id;
    ELSE
      IF v_run.cancel_requested_at IS NULL THEN
        v_outbox_id:=gen_random_uuid();
        v_payload:=jsonb_build_object('outboxEventId',v_outbox_id,
          'runId',v_run.id,'schemaVersion',1,'workspaceId',NEW.id);
        v_canonical_payload:='{"outboxEventId":"' || v_outbox_id::text ||
          '","runId":"' || v_run.id::text ||
          '","schemaVersion":1,"workspaceId":"' || NEW.id::text || '"}';
        INSERT INTO app.outbox_events(id,workspace_id,job_name,schema_version,
          aggregate_type,aggregate_id,payload,payload_checksum)
        VALUES (v_outbox_id,NEW.id,'advance-workflow-run',1,'workflow-run',
          v_run.id,v_payload,
          encode(sha256(convert_to(v_canonical_payload,'UTF8')),'hex'));
      END IF;
      UPDATE app.workflow_runs SET
        cancel_requested_at=coalesce(cancel_requested_at,NEW.deletion_requested_at),
        cancel_requested_by=coalesce(cancel_requested_by,NEW.deletion_requested_by::text),
        cancel_reason=coalesce(cancel_reason,'Workspace deletion requested'),
        deadline_at=least(coalesce(deadline_at,clock_timestamp()+interval '5 minutes'),
          clock_timestamp()+interval '5 minutes'),updated_at=clock_timestamp()
        WHERE id=v_run.id;
      UPDATE app.run_checkpoints SET resume_at=clock_timestamp(),
        resume_lease_owner=NULL,resume_lease_token=NULL,resume_lease_expires_at=NULL,
        updated_at=clock_timestamp() WHERE workflow_run_id=v_run.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.apply_workspace_invitation_deletion_side_effects() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_prior_workspace text;
BEGIN
  IF NEW.status<>'pending_deletion' THEN RETURN NEW; END IF;
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  -- The workspace row is already locked by the triggering update. Keep the
  -- remaining order invitation -> delivery attempt -> acceptance intent.
  UPDATE app.workspace_invitations
    SET status='revoked',revision=revision+1,revoked_at=clock_timestamp(),
        delivery_status='canceled',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status='pending';
  UPDATE app.workspace_invitation_delivery_attempts
    SET status=CASE WHEN status IN ('queued','failed') THEN 'canceled' ELSE status END,
        token_ciphertext=NULL,token_nonce=NULL,token_tag=NULL,
        token_key_version=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status IN ('queued','failed','unknown');
  UPDATE app.workspace_invitation_acceptance_intents
    SET status='superseded',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status IN ('pending','verified','wrong_account');
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  UPDATE app.workflow_run_active_admissions
     SET recover_after=clock_timestamp()+interval '5 minutes'
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.arm_workspace_control_projection() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NEW.retention_control_sequence IS DISTINCT FROM OLD.retention_control_sequence
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.deletion_requested_at IS NOT DISTINCT FROM OLD.deletion_requested_at
    AND NEW.deletion_requested_by IS NOT DISTINCT FROM OLD.deletion_requested_by
    AND NEW.deletion_reason IS NOT DISTINCT FROM OLD.deletion_reason
    AND NEW.purge_after IS NOT DISTINCT FROM OLD.purge_after
    AND EXISTS (
      SELECT 1 FROM app.workspace_control_ledger_projection record
      WHERE record.workspace_id=OLD.id
        AND record.sequence=NEW.retention_control_sequence
        AND record.record_hash=NEW.retention_control_hash
    ) THEN
    PERFORM set_config('app.retention_control_transition','on',true);
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.artifact_capacity_purge_start() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NEW.status='purging' AND OLD.status IS DISTINCT FROM 'purging'
    AND NOT EXISTS (
      SELECT 1 FROM app.artifacts artifact
       WHERE artifact.workspace_id=NEW.id AND artifact.status<>'deleted'
    ) THEN
    DELETE FROM app.workspace_artifact_capacity
     WHERE workspace_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.artifact_capacity_transition() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_workspace_id uuid:=coalesce(NEW.workspace_id,OLD.workspace_id);
  v_context text:=nullif(current_setting('app.workspace_id',true),'');
  v_capacity app.workspace_artifact_capacity%ROWTYPE;
  v_purge boolean:=false;
  v_release boolean:=false;
BEGIN
  v_purge:=app.workspace_purge_immutable_delete_is_armed(v_workspace_id);
  IF v_workspace_id IS NULL OR (NOT v_purge AND v_context IS NULL)
    OR (NOT v_purge AND v_context<>v_workspace_id::text) THEN
    RAISE EXCEPTION 'artifact capacity tenant context is required'
      USING ERRCODE='42501';
  END IF;

  IF TG_OP='UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.byte_length IS DISTINCT FROM OLD.byte_length
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
      OR NEW.media_type IS DISTINCT FROM OLD.media_type
      OR NEW.sha256 IS DISTINCT FROM OLD.sha256
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'artifact immutable metadata cannot change'
        USING ERRCODE='P0002', DETAIL='artifact_metadata_immutable';
    END IF;
    IF OLD.status='deleted' AND NEW.status<>'deleted' THEN
      RAISE EXCEPTION 'deleted artifact cannot be revived'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
    IF NEW.status='deleted' AND OLD.status<>'deleted' THEN
      IF OLD.status<>'deleting' AND NOT v_purge THEN
        RAISE EXCEPTION 'artifact must be deleting before metadata deletion'
          USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
      END IF;
      v_release:=true;
    END IF;
  ELSIF TG_OP='INSERT' THEN
    IF NEW.status='deleted' THEN
      RAISE EXCEPTION 'artifact cannot be created as deleted'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.status NOT IN ('deleting','deleted') AND NOT v_purge THEN
      RAISE EXCEPTION 'artifact deletion requires completed physical removal'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
    v_release:=OLD.status<>'deleted';
  END IF;

  INSERT INTO app.workspace_artifact_capacity(workspace_id)
  VALUES(v_workspace_id) ON CONFLICT (workspace_id) DO NOTHING;
  SELECT * INTO v_capacity
    FROM app.workspace_artifact_capacity
   WHERE workspace_id=v_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artifact capacity record is unavailable'
      USING ERRCODE='P0004', DETAIL='artifact_capacity_unavailable';
  END IF;

  IF TG_OP='INSERT' THEN
    IF v_capacity.charged_count+1>v_capacity.artifact_count_limit
      OR v_capacity.charged_bytes+NEW.byte_length>v_capacity.byte_limit THEN
      RAISE EXCEPTION 'workspace artifact capacity exceeded'
        USING ERRCODE='P0001', DETAIL='artifact_capacity_exceeded';
    END IF;
    UPDATE app.workspace_artifact_capacity
       SET charged_bytes=charged_bytes+NEW.byte_length,
           charged_count=charged_count+1,updated_at=clock_timestamp()
     WHERE workspace_id=v_workspace_id;
  ELSIF v_release THEN
    IF v_capacity.charged_count<1
      OR v_capacity.charged_bytes<OLD.byte_length THEN
      RAISE EXCEPTION 'artifact capacity charge underflow'
        USING ERRCODE='P0004', DETAIL='artifact_capacity_underflow';
    END IF;
    UPDATE app.workspace_artifact_capacity
       SET charged_bytes=charged_bytes-OLD.byte_length,
           charged_count=charged_count-1,updated_at=clock_timestamp()
     WHERE workspace_id=v_workspace_id;
  END IF;

  -- The tenant-row purge function predates this table and fail-closes on
  -- residual workspace-owned relations. Remove an empty capacity row as soon
  -- as the last charged artifact is dismantled under its fenced purge token.
  IF v_purge AND TG_OP IN ('DELETE','UPDATE')
    AND NOT EXISTS (
      SELECT 1 FROM app.artifacts artifact
       WHERE artifact.workspace_id=v_workspace_id
         AND artifact.id<>coalesce(OLD.id,NEW.id)
         AND artifact.status<>'deleted'
    ) THEN
    DELETE FROM app.workspace_artifact_capacity
     WHERE workspace_id=v_workspace_id;
  END IF;

  RETURN case when TG_OP='DELETE' then OLD else NEW end;
END;
$$;

CREATE FUNCTION app.assert_workflow_input_cases_enabled() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NOT coalesce((SELECT enabled FROM app.workflow_input_case_rollout WHERE singleton),false)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app.workflow_runs'::regclass
      AND tgname='manual_start_writer_fence' AND tgenabled='O'
      AND tgfoid='app.enforce_manual_start_writer()'::regprocedure AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'workflow input cases unavailable' USING ERRCODE='55000';
  END IF;
END $$;

CREATE FUNCTION app.assert_workflow_organization_writes_enabled() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_enabled boolean;
BEGIN
  SELECT writes_enabled INTO v_enabled FROM app.workflow_organization_rollout WHERE singleton FOR SHARE;
  IF v_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow organization writes unavailable' USING ERRCODE='P7001'; END IF;
END $$;

CREATE FUNCTION app.audit_connection_secret_access(p_workspace uuid, p_connection uuid, p_secret uuid, p_actor text, p_request text, p_trace text, p_purpose text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $_$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace
    OR p_actor IS NULL OR length(p_actor)>128 OR p_purpose IS NULL OR p_purpose !~ '^[a-z][a-z0-9._:-]{0,127}$'
    OR NOT EXISTS(SELECT 1 FROM app.connections WHERE workspace_id=p_workspace AND id=p_connection
      AND current_secret_version_id=p_secret AND status='active') THEN
    RAISE EXCEPTION 'credential access audit scope mismatch' USING ERRCODE='PTH05';
  END IF;
  INSERT INTO app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id,request_id,trace_id,metadata)
    VALUES(gen_random_uuid(),p_workspace,p_connection,'connection.credential_accessed','worker',p_actor,p_request,p_trace,
      jsonb_build_object('purpose',p_purpose,'secretVersionId',p_secret));
END $_$;

CREATE FUNCTION app.authorize_workspace_lifecycle_append(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.authorize_workspace_purge_completion_append(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_projected_sequence bigint, p_projected_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_completion app.workspace_purge_completions%ROWTYPE;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace purge completion append authorization'
      USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id;
  SELECT * INTO v_completion FROM app.workspace_purge_completions WHERE job_id=p_job_id;
  IF v_job.id IS NULL OR v_job.status<>'purging' OR v_completion.job_id IS NULL
    OR v_completion.status<>'running'
    OR v_completion.lease_token IS DISTINCT FROM p_lease_token
    OR v_completion.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_completion.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace purge completion lease is stale' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_job.workspace_id
    AND workspace.status='purging'
    AND workspace.retention_control_sequence=p_projected_sequence
    AND workspace.retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace purge completion high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.status<>'completed')
    OR NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.step_name='object_versions' AND step.status='completed')
    OR NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.step_name='tenant_rows' AND step.status='completed') THEN
    RAISE EXCEPTION 'workspace purge steps are incomplete' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_job.workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks purge completion append'
      USING ERRCODE='55000';
  END IF;
  RETURN true;
END $_$;

CREATE FUNCTION app.bind_node_attempt_connection_dispatch(p_workspace uuid, p_attempt uuid, p_worker text, p_fence bigint, p_connection uuid, p_secret uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_revision bigint; v_node text; v_version uuid; v_existing app.node_attempt_connection_dispatches%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'connection dispatch tenant mismatch' USING ERRCODE='PTH02';
  END IF;
  SELECT connection.health_revision INTO v_revision FROM app.connections connection
    JOIN app.workspaces workspace ON workspace.id=connection.workspace_id
    WHERE connection.workspace_id=p_workspace AND connection.id=p_connection
      AND connection.provider_key='slack' AND connection.auth_type='slack_bot_token'
      AND connection.current_secret_version_id=p_secret AND connection.status='active' AND workspace.status='active'
    FOR SHARE OF connection;
  IF NOT FOUND THEN RAISE EXCEPTION 'connection dispatch fence mismatch' USING ERRCODE='PTH02'; END IF;
  SELECT node.node_id,run.workflow_version_id INTO v_node,v_version
    FROM app.node_attempts attempt JOIN app.node_runs node ON node.workspace_id=attempt.workspace_id AND node.id=attempt.node_run_id
    JOIN app.workflow_runs run ON run.workspace_id=node.workspace_id AND run.id=node.workflow_run_id
    WHERE attempt.workspace_id=p_workspace AND attempt.id=p_attempt AND attempt.status='running'
      AND attempt.lease_owner=p_worker AND attempt.fence_token=p_fence AND attempt.lease_expires_at>clock_timestamp()
      AND attempt.dispatch_marked_at IS NOT NULL AND node.current_attempt_id=attempt.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'connection dispatch lease mismatch' USING ERRCODE='PTH02'; END IF;
  IF NOT EXISTS (
    WITH RECURSIVE published_nodes(value) AS (
      SELECT value FROM app.workflow_versions version,
        jsonb_array_elements(version.executable_json->'graph'->'nodes') value
        WHERE version.workspace_id=p_workspace AND version.id=v_version
      UNION ALL SELECT child FROM published_nodes parent,
        jsonb_array_elements(parent.value->'structured'->'body'->'nodes') child
    ) SELECT 1 FROM published_nodes WHERE value->>'id'=v_node
      AND value->'definition'->>'key'='slack.send_message' AND value->'definition'->>'version'='1'
      AND value->'connectionRefs'->>'slack_bot_token'=p_connection::text
  ) THEN RAISE EXCEPTION 'connection dispatch published binding mismatch' USING ERRCODE='PTH02'; END IF;
  SELECT * INTO v_existing FROM app.node_attempt_connection_dispatches WHERE workspace_id=p_workspace AND attempt_id=p_attempt;
  IF FOUND THEN
    IF v_existing.connection_id<>p_connection OR v_existing.secret_version_id<>p_secret
      OR v_existing.worker_id<>p_worker OR v_existing.fence_token<>p_fence THEN
      RAISE EXCEPTION 'connection dispatch identity is immutable' USING ERRCODE='PTH02';
    END IF;
    RETURN;
  END IF;
  INSERT INTO app.node_attempt_connection_dispatches(workspace_id,attempt_id,connection_id,provider_key,auth_type,secret_version_id,health_revision,worker_id,fence_token)
    VALUES(p_workspace,p_attempt,p_connection,'slack','slack_bot_token',p_secret,v_revision,p_worker,p_fence);
END $$;

CREATE FUNCTION app.block_incomplete_workspace_deletion() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.workspace_purge_jobs job
      WHERE job.workspace_id=NEW.id AND job.status='completed'
        AND EXISTS (SELECT 1 FROM app.workspace_purge_steps step
          WHERE step.job_id=job.id AND step.step_name='tenant_rows'
            AND step.status='completed')
        AND EXISTS (SELECT 1 FROM app.workspace_purge_steps step
          WHERE step.job_id=job.id AND step.step_name='object_versions'
            AND step.status='completed')
        AND NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps incomplete
          WHERE incomplete.job_id=job.id AND incomplete.status<>'completed')
    ) THEN
      RAISE EXCEPTION 'workspace purge is incomplete' USING ERRCODE='55000';
    END IF;
    NEW.name:='Deleted workspace';
    NEW.slug:='deleted-'||NEW.id::text;
    NEW.created_by:=NULL;
    NEW.deletion_requested_by:=NULL;
    NEW.deletion_reason:='purged';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.cancel_operator_run(uuid, uuid, uuid, character varying, character varying, boolean) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean, result jsonb)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    AS $_$
  SELECT * FROM app.execute_operator_execution_command($1,'run.cancel',$2,$3,NULL,NULL,NULL,NULL,$4,$5,$6)
$_$;

CREATE FUNCTION app.canonicalize_workspace_lifecycle_operation_time() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  NEW.occurred_at:=date_trunc('milliseconds',NEW.occurred_at);
  RETURN NEW;
END $$;

CREATE FUNCTION app.checkpoint_retention_batch(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_cursor_expires_at timestamp with time zone, p_cursor_id uuid, p_examined_delta integer, p_eligible_delta integer, p_complete boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_batch app.retention_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_examined_delta IS NULL OR p_eligible_delta IS NULL
    OR p_examined_delta NOT BETWEEN 0 AND 1000 OR p_eligible_delta NOT BETWEEN 0 AND p_examined_delta
    OR (p_cursor_expires_at IS NULL) <> (p_cursor_id IS NULL) OR p_complete IS NULL THEN
    RAISE EXCEPTION 'invalid retention checkpoint' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM app.retention_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'running' OR v_batch.lease_token<>p_lease_token
    OR v_batch.lease_fence<>p_lease_fence OR v_batch.lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
  IF p_cursor_expires_at IS NOT NULL AND v_batch.cursor_expires_at IS NOT NULL
    AND (p_cursor_expires_at,p_cursor_id) <= (v_batch.cursor_expires_at,v_batch.cursor_id) THEN
    RAISE EXCEPTION 'retention cursor must advance monotonically' USING ERRCODE='22023';
  END IF;
  IF p_cursor_expires_at IS NOT NULL AND p_cursor_expires_at > v_batch.cutoff_at THEN
    RAISE EXCEPTION 'retention cursor cannot exceed its cutoff' USING ERRCODE='22023';
  END IF;
  IF NOT p_complete AND (p_examined_delta=0 OR p_cursor_expires_at IS NULL) THEN
    RAISE EXCEPTION 'nonterminal retention checkpoint must report bounded cursor progress' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.retention_batch_transition','on',true);
  UPDATE app.retention_batches SET cursor_expires_at=coalesce(p_cursor_expires_at,cursor_expires_at),
    cursor_id=coalesce(p_cursor_id,cursor_id),examined_count=examined_count+p_examined_delta,
    eligible_count=eligible_count+p_eligible_delta,status=CASE WHEN p_complete THEN 'completed' ELSE status END,
    completed_at=CASE WHEN p_complete THEN clock_timestamp() ELSE NULL END,
    lease_owner=CASE WHEN p_complete THEN NULL ELSE lease_owner END,
    lease_token=CASE WHEN p_complete THEN NULL ELSE lease_token END,
    lease_acquired_at=CASE WHEN p_complete THEN NULL ELSE lease_acquired_at END,
    lease_expires_at=CASE WHEN p_complete THEN NULL ELSE lease_expires_at END,updated_at=clock_timestamp()
  WHERE id=p_batch_id;
  RETURN true;
END $$;

CREATE FUNCTION app.checkpoint_workspace_object_versions_page(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_deleted_count integer, p_completed boolean, p_projected_sequence bigint, p_projected_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_step app.workspace_purge_steps%ROWTYPE;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_deleted_count IS NULL OR p_completed IS NULL
    OR (p_completed AND p_deleted_count<>0)
    OR (NOT p_completed AND p_deleted_count NOT BETWEEN 1 AND 500)
    OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace object purge checkpoint' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO v_step FROM app.workspace_purge_steps
    WHERE job_id=p_job_id AND step_name='object_versions' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running'
    OR v_step.lease_token<>p_lease_token OR v_step.lease_fence<>p_lease_fence
    OR v_step.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace object purge lease is stale' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_job.workspace_id
    AND workspace.status='purging'
    AND workspace.retention_control_sequence=p_projected_sequence
    AND workspace.retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace object purge high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_job.workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks object purge checkpoint'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_steps SET status=CASE WHEN p_completed THEN 'completed' ELSE 'pending' END,
    lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp(),completed_at=CASE WHEN p_completed THEN clock_timestamp() END
    WHERE job_id=p_job_id AND step_name='object_versions';
  RETURN p_completed;
END $_$;

CREATE FUNCTION app.claim_authentication_mail(p_worker_id text, p_limit integer, p_lease_token uuid) RETURNS TABLE(id uuid, purpose text, expires_at timestamp with time zone, attempt_count integer, lease_generation bigint, payload_ciphertext text, payload_nonce text, payload_tag text, payload_key_version text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'invalid authentication mail claim' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
      FROM app.authentication_mail_deliveries delivery
     WHERE delivery.status IN ('queued','outcome_unknown','retry')
       AND delivery.expires_at>clock_timestamp()
       AND delivery.created_at+interval '24 hours'>clock_timestamp()
       AND delivery.next_attempt_at<=clock_timestamp()
       AND (delivery.lease_expires_at IS NULL
            OR delivery.lease_expires_at<=clock_timestamp())
       AND delivery.attempt_count<12
     ORDER BY delivery.next_attempt_at,delivery.id
     LIMIT p_limit
     FOR UPDATE OF delivery SKIP LOCKED
  ), claimed AS (
    UPDATE app.authentication_mail_deliveries delivery
       SET status='outcome_unknown',lease_owner=p_worker_id,
           lease_token=p_lease_token,
           lease_generation=delivery.lease_generation+1,
           lease_expires_at=clock_timestamp()+interval '60 seconds',
           attempt_count=delivery.attempt_count+1,
           updated_at=clock_timestamp()
      FROM candidates WHERE delivery.id=candidates.id
    RETURNING delivery.*
  )
  SELECT claimed.id,claimed.purpose::text,claimed.expires_at,
         claimed.attempt_count,claimed.lease_generation,
         claimed.payload_ciphertext,claimed.payload_nonce::text,
         claimed.payload_tag::text,claimed.payload_key_version::text
    FROM claimed ORDER BY claimed.next_attempt_at,claimed.id;
END;
$_$;

CREATE FUNCTION app.claim_due_node_run_wakeups(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
    id, workspace_id, job_name, schema_version, aggregate_type,
    aggregate_id, payload, payload_checksum
  )
  SELECT event.outbox_event_id, event.workspace_id, 'advance-workflow-run', 1,
         'workflow-run', event.workflow_run_id,
         jsonb_build_object(
           'outboxEventId', event.outbox_event_id,
           'runId', event.workflow_run_id,
           'schemaVersion', 1,
           'workspaceId', event.workspace_id
         ),
         encode(sha256(convert_to(
           '{"outboxEventId":"' || event.outbox_event_id::text ||
           '","runId":"' || event.workflow_run_id::text ||
           '","schemaVersion":1,"workspaceId":"' || event.workspace_id::text || '"}',
           'UTF8'
         )), 'hex')
    FROM events event;

  GET DIAGNOSTICS claimed_count = ROW_COUNT;
  RETURN claimed_count;
END;
$$;

CREATE FUNCTION app.claim_due_trigger_schedules(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) RETURNS TABLE(trigger_id uuid, workspace_id uuid, workflow_id uuid, workflow_version_id uuid, node_id character varying, recurrence_kind character varying, cron_expression character varying, timezone character varying, interval_minutes integer, misfire_policy character varying, config_fingerprint character varying, anchor_at timestamp with time zone, next_fire_at timestamp with time zone, lease_token uuid, observed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
    id, workspace_id, job_name, schema_version, aggregate_type,
    aggregate_id, payload, payload_checksum
  )
  SELECT outbox_event_id, workspace_id, 'advance-workflow-run', 1,
         'workflow-run', id,
         jsonb_build_object('outboxEventId', outbox_event_id, 'runId', id,
           'schemaVersion', 1, 'workspaceId', workspace_id),
         encode(sha256(convert_to(
           '{"outboxEventId":"' || outbox_event_id::text ||
           '","runId":"' || id::text ||
           '","schemaVersion":1,"workspaceId":"' || workspace_id::text || '"}',
           'UTF8')), 'hex')
    FROM events;
  GET DIAGNOSTICS claimed_count = ROW_COUNT;
  RETURN claimed_count;
END;
$$;

CREATE FUNCTION app.claim_retention_batches(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) RETURNS TABLE(batch_id uuid, workspace_id uuid, retention_kind character varying, cutoff_at timestamp with time zone, dry_run boolean, requested_by character varying, reason character varying, cursor_expires_at timestamp with time zone, cursor_id uuid, lease_token uuid, lease_fence bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid retention batch claim bounds' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.retention_batch_transition','on',true);
  RETURN QUERY WITH candidates AS (
    SELECT batch.id FROM app.retention_batches batch
    WHERE batch.status='ready' OR (batch.status='running' AND batch.lease_expires_at<=v_now)
    ORDER BY batch.created_at,batch.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE app.retention_batches batch SET status='running',lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=batch.lease_fence+1,lease_acquired_at=v_now,
      lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),updated_at=v_now
    FROM candidates WHERE batch.id=candidates.id RETURNING batch.*
  ) SELECT claimed.id,claimed.workspace_id,claimed.retention_kind,claimed.cutoff_at,
      claimed.dry_run,claimed.requested_by,claimed.reason,claimed.cursor_expires_at,
      claimed.cursor_id,claimed.lease_token,claimed.lease_fence
    FROM claimed ORDER BY claimed.created_at,claimed.id;
END $$;

CREATE FUNCTION app.claim_retention_destructive_batches(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) RETURNS TABLE(batch_id uuid, workspace_id uuid, retention_kind character varying, cutoff_at timestamp with time zone, requested_by character varying, reason character varying, cursor_expires_at timestamp with time zone, cursor_id uuid, lease_token uuid, lease_fence bigint, lease_expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.claim_retention_dry_run_batches(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) RETURNS TABLE(batch_id uuid, workspace_id uuid, retention_kind character varying, cutoff_at timestamp with time zone, requested_by character varying, reason character varying, cursor_expires_at timestamp with time zone, cursor_id uuid, dry_run_cursor jsonb, dry_run_upper jsonb, lease_token uuid, lease_fence bigint, lease_expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.claim_workflow_organization_command(p_operation text, p_target uuid, p_key_hash text, p_request jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_workspace uuid; v_actor uuid; v_hash text; v_receipt app.workflow_organization_receipts%ROWTYPE;
BEGIN
  IF p_key_hash IS NULL OR octet_length(p_key_hash)<>64
    OR p_key_hash COLLATE "C" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'organization command identity invalid' USING ERRCODE='22023'; END IF;
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  v_hash:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex');
  INSERT INTO app.workflow_organization_receipts(workspace_id,actor_id,operation,target_id,key_hash,request_hash)
    VALUES(v_workspace,v_actor,p_operation,p_target,p_key_hash,v_hash)
    ON CONFLICT(workspace_id,actor_id,operation,target_id,key_hash) DO NOTHING;
  SELECT * INTO STRICT v_receipt FROM app.workflow_organization_receipts
    WHERE workspace_id=v_workspace AND actor_id=v_actor AND operation=p_operation
      AND target_id=p_target AND key_hash=p_key_hash FOR UPDATE;
  IF v_receipt.request_hash<>v_hash THEN
    RAISE EXCEPTION 'organization command identity conflict' USING ERRCODE='P7002'; END IF;
  RETURN v_receipt.result;
END $_$;

CREATE FUNCTION app.claim_workspace_lifecycle_operations(p_lease_owner character varying, p_limit integer, p_lease_interval interval) RETURNS TABLE(operation_id uuid, workspace_id uuid, command_type character varying, actor_user_id uuid, reason character varying, request_hash character, occurred_at timestamp with time zone, lease_token uuid, lease_fence bigint, attempt_count integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_now timestamptz;
BEGIN
  IF p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle claim' USING ERRCODE='22023';
  END IF;
  v_now:=clock_timestamp();
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  RETURN QUERY WITH claimable AS (
    SELECT operation.id FROM app.workspace_lifecycle_operations operation
    WHERE operation.status='pending'
      OR (operation.status='running' AND operation.lease_expires_at<=v_now)
    ORDER BY operation.created_at,operation.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE app.workspace_lifecycle_operations operation SET
      status='running',lease_owner=btrim(p_lease_owner),lease_token=gen_random_uuid(),
      lease_fence=operation.lease_fence+1,lease_acquired_at=v_now,
      lease_expires_at=v_now+p_lease_interval,
      attempt_count=operation.attempt_count+1,updated_at=v_now
    FROM claimable WHERE operation.id=claimable.id RETURNING operation.*
  ) SELECT claimed.id,claimed.workspace_id,claimed.command_type,
    claimed.actor_user_id,claimed.reason,claimed.request_hash,claimed.occurred_at,
    claimed.lease_token,claimed.lease_fence,claimed.attempt_count FROM claimed
  ORDER BY claimed.created_at,claimed.id;
END $$;

CREATE FUNCTION app.claim_workspace_purge_step(p_job_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) RETURNS TABLE(step_name character varying, lease_token uuid, lease_fence bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_workspace app.workspaces%ROWTYPE;
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$'
    OR p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace purge step claim' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' THEN
    RAISE EXCEPTION 'workspace purge is not in progress' USING ERRCODE='55000';
  END IF;
  SELECT * INTO STRICT v_workspace FROM app.workspaces
    WHERE id=v_job.workspace_id FOR UPDATE;
  IF v_workspace.status<>'purging'
    OR v_workspace.retention_control_sequence<>p_projected_sequence
    OR v_workspace.retention_control_hash<>p_projected_hash THEN
    RAISE EXCEPTION 'workspace purge destructive high water is not exact'
      USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
    WHERE hold.workspace_id=v_job.workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks destructive purge step'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  RETURN QUERY WITH candidate AS (
    SELECT step.ctid FROM app.workspace_purge_steps step
    WHERE step.job_id=v_job.id AND (step.status='pending'
        OR (step.status='running' AND step.lease_expires_at<=v_now))
      AND (step.step_name='object_versions' OR (step.step_name='tenant_rows' AND EXISTS (
        SELECT 1 FROM app.workspace_purge_steps object_step
        WHERE object_step.job_id=v_job.id AND object_step.step_name='object_versions'
          AND object_step.status='completed')))
    ORDER BY CASE step.step_name WHEN 'object_versions' THEN 0 ELSE 1 END
    LIMIT 1 FOR UPDATE
  ), claimed AS (
    UPDATE app.workspace_purge_steps step SET status='running',
      attempt_count=step.attempt_count+1,lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=step.lease_fence+1,
      lease_acquired_at=v_now,lease_expires_at=v_now+p_lease_interval,updated_at=v_now
    FROM candidate WHERE step.ctid=candidate.ctid RETURNING step.*
  ) SELECT claimed.step_name,claimed.lease_token,claimed.lease_fence FROM claimed;
END $_$;

CREATE FUNCTION app.cleanup_connection_health_command() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  DELETE FROM app.outbox_events WHERE workspace_id=OLD.workspace_id AND id=OLD.outbox_event_id
    AND job_name='apply-connection-health-observation';
  RETURN OLD;
END $$;

CREATE FUNCTION app.complete_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_result_run_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_updated integer;
BEGIN
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  UPDATE app.operator_run_replay_requests request SET
    status='completed',result_run_id=p_result_run_id,completed_at=clock_timestamp()
  WHERE request.command_id=p_command_id AND request.workspace_id=p_workspace_id
    AND request.status='pending' AND EXISTS(
      SELECT 1 FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace_id AND run.id=p_result_run_id
        AND run.replay_command_id=p_command_id
        AND run.replay_source_run_id=request.source_run_id
        AND run.workflow_version_id=request.workflow_version_id
    );
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>1 THEN
    RAISE EXCEPTION 'run replay completion does not match durable request'
      USING ERRCODE='P0001';
  END IF;
  UPDATE app.operator_commands command SET
    status='completed',outcome='replay_created',completed_at=clock_timestamp(),
    result=command.result||jsonb_build_object(
      'outcome','replay_created','resultRunId',p_result_run_id
    )
  WHERE command.id=p_command_id AND command.status='pending';
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>1 THEN
    RAISE EXCEPTION 'run replay command completion was lost' USING ERRCODE='P0001';
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.complete_preview_artifact_cleanup(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_completed boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_artifact_id IS NULL
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid preview artifact completion' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=p_workspace_id
      AND workspace.retention_control_sequence=p_expected_control_sequence
      AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preview control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO pertexo_internal.preview_retention_transition_capabilities
    (transaction_id,workspace_id,artifact_id,target_status)
  VALUES (pg_current_xact_id(),p_workspace_id,p_artifact_id,'deleted');
  UPDATE app.artifacts artifact SET status='deleted',deleted_at=clock_timestamp(),
    updated_at=clock_timestamp()
  WHERE artifact.workspace_id=p_workspace_id AND artifact.id=p_artifact_id
    AND artifact.status='deleting' AND EXISTS (
      SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=p_workspace_id AND link.artifact_id=p_artifact_id
        AND link.owner_kind='preview_run'
    );
  v_completed:=FOUND;
  DELETE FROM pertexo_internal.preview_retention_transition_capabilities capability
    WHERE capability.transaction_id=pg_current_xact_id()
      AND capability.workspace_id=p_workspace_id
      AND capability.artifact_id=p_artifact_id
      AND capability.target_status='deleted';
  RETURN v_completed;
END $_$;

CREATE FUNCTION app.complete_preview_cleanup(p_workspace_id uuid, p_preview_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  preview_expiry timestamptz;
  preview_status varchar(32);
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
     NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'preview cleanup workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT expires_at, status
    INTO preview_expiry, preview_status
    FROM app.preview_runs
   WHERE workspace_id = p_workspace_id
     AND id = p_preview_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN true;
  END IF;
  IF preview_expiry > clock_timestamp() OR preview_status NOT IN (
    'succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM app.preview_runs
     WHERE workspace_id = p_workspace_id
       AND prior_preview_run_id = p_preview_run_id
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM app.artifact_links link
      JOIN app.artifacts artifact
        ON artifact.workspace_id = link.workspace_id
       AND artifact.id = link.artifact_id
     WHERE link.workspace_id = p_workspace_id
       AND link.owner_kind = 'preview_run'
       AND link.owner_id = p_preview_run_id
       AND artifact.status <> 'deleted'
  ) THEN
    RETURN false;
  END IF;

  WITH removed_links AS (
    DELETE FROM app.artifact_links
     WHERE workspace_id = p_workspace_id
       AND owner_kind = 'preview_run'
       AND owner_id = p_preview_run_id
    RETURNING artifact_id
  )
  DELETE FROM app.artifacts artifact
   USING removed_links
   WHERE artifact.workspace_id = p_workspace_id
     AND artifact.id = removed_links.artifact_id
     AND artifact.status = 'deleted';

  DELETE FROM app.preview_attempts
   WHERE workspace_id = p_workspace_id
     AND preview_run_id = p_preview_run_id;
  DELETE FROM app.idempotency_records
   WHERE workspace_id = p_workspace_id
     AND operation = 'preview.execute'
     AND resource_id = p_preview_run_id
     AND expires_at <= clock_timestamp();
  DELETE FROM app.preview_runs
   WHERE workspace_id = p_workspace_id
     AND id = p_preview_run_id;
  RETURN true;
END;
$$;

CREATE FUNCTION app.complete_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.complete_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid, p_occurrence_id uuid, p_scheduled_at timestamp with time zone, p_disposition character varying, p_workflow_run_id uuid, p_next_fire_at timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_schedule app.trigger_schedules%ROWTYPE;
BEGIN
  SELECT * INTO v_schedule FROM app.trigger_schedules WHERE trigger_id=p_trigger_id
    AND lease_token=p_lease_token AND lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.trigger_schedule_occurrences
    (id,workspace_id,trigger_id,scheduled_at,disposition,workflow_run_id)
    VALUES(p_occurrence_id,v_schedule.workspace_id,p_trigger_id,p_scheduled_at,p_disposition,p_workflow_run_id)
    ON CONFLICT(trigger_id,scheduled_at) DO NOTHING;
  UPDATE app.trigger_schedules SET last_fire_at=p_scheduled_at,next_fire_at=p_next_fire_at,
    lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    admission_deferred_until=NULL,health_status='healthy',last_error_code=NULL,updated_at=clock_timestamp()
   WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token;
  UPDATE app.workflow_triggers SET health_status='healthy',last_error_code=NULL,updated_at=clock_timestamp()
   WHERE id=p_trigger_id AND workspace_id=v_schedule.workspace_id;
  RETURN true;
END $$;

CREATE FUNCTION app.complete_workflow_organization_command(p_operation text, p_target uuid, p_key_hash text, p_result jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  UPDATE app.workflow_organization_receipts SET result=p_result
    WHERE workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
      AND actor_id::text=nullif(current_setting('app.actor_id',true),'')
      AND operation=p_operation AND target_id=p_target AND key_hash=p_key_hash AND result IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization claim unavailable' USING ERRCODE='55000'; END IF;
END $$;

CREATE FUNCTION app.complete_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint, p_control_sequence bigint, p_control_record_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 OR p_control_sequence IS NULL OR p_control_sequence<1
    OR p_control_record_hash IS NULL
    OR p_control_record_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle completion' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token<>p_lease_token
    OR v_operation.lease_fence<>p_lease_fence
    OR v_operation.lease_expires_at<=clock_timestamp() THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=v_operation.workspace_id
      AND record.command_id=v_operation.id
      AND record.command_type=v_operation.command_type
      AND record.sequence=p_control_sequence
      AND record.record_hash=p_control_record_hash
      AND record.actor_ref=v_operation.actor_user_id::text
      AND record.reason=v_operation.reason
      AND record.occurred_at=v_operation.occurred_at
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle completion lacks exact projection'
      USING ERRCODE='23503';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  UPDATE app.workspace_lifecycle_operations SET status='completed',
    control_sequence=p_control_sequence,control_record_hash=p_control_record_hash,
    lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp(),completed_at=clock_timestamp()
  WHERE id=p_operation_id;
  RETURN true;
END $_$;

CREATE FUNCTION app.connection_dispatch_fence_current(p_workspace_id uuid, p_connection_id uuid, p_expected_provider_key text, p_expected_auth_type text, p_secret_version_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  fence_current boolean := false;
  workspace_active boolean := false;
BEGIN
  IF nullif(current_setting('app.workspace_id', true), '')::uuid
       IS DISTINCT FROM p_workspace_id THEN
    RETURN false;
  END IF;

  SELECT true INTO workspace_active
  FROM app.workspaces workspace
  WHERE workspace.id = p_workspace_id
    AND workspace.status = 'active'
  LIMIT 1
  FOR SHARE OF workspace;

  IF NOT coalesce(workspace_active, false) THEN
    RETURN false;
  END IF;

  SELECT true INTO fence_current
  FROM app.workspaces workspace
  JOIN app.connections connection_record
    ON connection_record.workspace_id = workspace.id
  WHERE workspace.id = p_workspace_id
    AND workspace.status = 'active'
    AND connection_record.id = p_connection_id
    AND connection_record.provider_key = p_expected_provider_key
    AND connection_record.auth_type = p_expected_auth_type
    AND connection_record.current_secret_version_id = p_secret_version_id
    AND connection_record.status = 'active'
  LIMIT 1
  FOR SHARE OF connection_record;

  RETURN coalesce(fence_current, false);
END;
$$;

CREATE FUNCTION app.consume_auth_email_proof(p_digest bytea, p_next_id uuid DEFAULT NULL::uuid, p_next_digest bytea DEFAULT NULL::bytea, p_next_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_mail_id uuid DEFAULT NULL::uuid, p_mail_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ciphertext text DEFAULT NULL::text, p_nonce text DEFAULT NULL::text, p_tag text DEFAULT NULL::text, p_key_version text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_user app.users%ROWTYPE;
        v_proof app.auth_email_proofs%ROWTYPE;
        v_user_id uuid;
BEGIN
  IF p_digest IS NULL OR octet_length(p_digest)<>32 THEN
    RETURN 'invalid';
  END IF;
  SELECT user_id INTO v_user_id FROM app.auth_email_proofs
    WHERE token_digest=p_digest;
  IF v_user_id IS NULL THEN RETURN 'invalid'; END IF;
  SELECT * INTO v_user FROM app.users WHERE id=v_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.status<>'active' THEN RETURN 'invalid'; END IF;
  SELECT * INTO v_proof FROM app.auth_email_proofs
    WHERE token_digest=p_digest FOR UPDATE;
  IF NOT FOUND OR v_proof.consumed_at IS NOT NULL
     OR v_proof.expires_at<=clock_timestamp()
     OR v_proof.user_id<>v_user.id
     OR lower(v_proof.email)<>lower(v_user.email) THEN
    RETURN 'invalid';
  END IF;
  IF v_proof.purpose='initial_verification' THEN
    IF v_user.email_verified THEN RETURN 'invalid'; END IF;
    UPDATE app.users SET email_verified=true,updated_at=clock_timestamp()
      WHERE id=v_user.id;
    DELETE FROM app.auth_sessions WHERE user_id=v_user.id;
    INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
      VALUES (gen_random_uuid(),v_user.id,'email.initial_verified');
  ELSIF v_proof.purpose='change_old' THEN
    IF NOT v_user.email_verified OR p_next_id IS NULL
       OR p_next_digest IS NULL OR octet_length(p_next_digest)<>32
       OR p_next_expires_at<=clock_timestamp()
       OR p_next_expires_at>clock_timestamp()+interval '1 hour'
       OR (p_mail_id IS NULL) IS DISTINCT FROM (p_ciphertext IS NULL)
       THEN RETURN 'invalid'; END IF;
    INSERT INTO app.auth_email_proofs
      (id,token_digest,user_id,purpose,email,new_email,expires_at)
    VALUES (p_next_id,p_next_digest,v_user.id,'change_new',
            v_proof.email,v_proof.new_email,p_next_expires_at);
    IF p_mail_id IS NOT NULL THEN
      PERFORM app.enqueue_authentication_mail(
        p_mail_id,'verification',p_mail_expires_at,
        p_ciphertext,p_nonce,p_tag,p_key_version);
    END IF;
    INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
      VALUES (gen_random_uuid(),v_user.id,'email.old_confirmed');
  ELSIF v_proof.purpose='change_new' THEN
    IF v_proof.new_email IS NULL OR NOT v_user.email_verified THEN
      RETURN 'invalid';
    END IF;
    UPDATE app.users
       SET email=v_proof.new_email,email_verified=true,
           updated_at=clock_timestamp()
     WHERE id=v_user.id;
    INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
      VALUES (gen_random_uuid(),v_user.id,'email.change_verified');
  ELSE
    RETURN 'invalid';
  END IF;
  UPDATE app.auth_email_proofs SET consumed_at=clock_timestamp()
    WHERE id=v_proof.id;
  RETURN v_proof.purpose;
END;
$$;

CREATE FUNCTION app.consume_webhook_ingress_limit(p_endpoint_key_hash character) RETURNS TABLE(allowed boolean, retry_after_seconds integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_endpoint_id uuid;
  v_workspace_id uuid;
  v_now timestamptz := clock_timestamp();
  v_started timestamptz;
  v_count integer;
BEGIN
  SELECT endpoint.id,endpoint.workspace_id INTO v_endpoint_id,v_workspace_id
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflow_triggers trigger ON trigger.id=endpoint.trigger_id
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash
     AND endpoint.status='active' AND trigger.status='active';
  IF v_endpoint_id IS NULL THEN RETURN QUERY SELECT false,1; RETURN; END IF;

  INSERT INTO app.webhook_endpoint_ingress_limits
    (endpoint_id,workspace_id,bucket_started_at,request_count)
    VALUES(v_endpoint_id,v_workspace_id,v_now,1)
    ON CONFLICT(endpoint_id) DO NOTHING;
  IF FOUND THEN RETURN QUERY SELECT true,0; RETURN; END IF;
  SELECT bucket_started_at,request_count INTO v_started,v_count
    FROM app.webhook_endpoint_ingress_limits WHERE endpoint_id=v_endpoint_id FOR UPDATE;
  IF v_started+interval '1 minute'<=v_now THEN
    UPDATE app.webhook_endpoint_ingress_limits SET bucket_started_at=v_now,
      request_count=1,updated_at=v_now WHERE endpoint_id=v_endpoint_id;
    RETURN QUERY SELECT true,0; RETURN;
  END IF;
  IF v_count>=60 THEN
    RETURN QUERY SELECT false,greatest(1,least(60,
      ceil(extract(epoch FROM (v_started+interval '1 minute'-v_now)))::integer));
    RETURN;
  END IF;
  UPDATE app.webhook_endpoint_ingress_limits SET request_count=request_count+1,
    updated_at=v_now WHERE endpoint_id=v_endpoint_id;
  RETURN QUERY SELECT true,0;
END $$;

CREATE FUNCTION app.create_workflow_duplicate_draft(p_destination uuid, p_workspace uuid, p_source uuid, p_actor uuid, p_name character varying, p_schema integer, p_graph jsonb, p_key_hash character, p_request_hash character, p_kind text, p_version uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_source_graph jsonb; v_claim record; v_reference record;
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')
    OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workflow context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspace_memberships membership
    JOIN app.users actor ON actor.id=membership.user_id
    JOIN app.workspaces workspace ON workspace.id=membership.workspace_id
    WHERE membership.workspace_id=p_workspace AND membership.user_id=p_actor
      AND membership.status='active' AND membership.role IN ('owner','admin','builder')
      AND actor.status='active' AND workspace.status='active'
    FOR SHARE OF membership,actor,workspace;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow author is not active' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workflows WHERE workspace_id=p_workspace AND id=p_source
    AND lifecycle_status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow source is not visible' USING ERRCODE='42501'; END IF;
  SELECT request_hash,status,resource_id INTO v_claim FROM app.idempotency_records
    WHERE workspace_id=p_workspace AND operation='workflow.duplicate'
      AND scope=p_actor::text||':'||p_source::text AND key_hash=p_key_hash FOR UPDATE;
  IF NOT FOUND OR v_claim.status<>'in_progress' OR v_claim.resource_id<>p_destination
    OR v_claim.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'workflow duplication claim mismatch' USING ERRCODE='42501';
  END IF;
  IF p_kind='draft' AND p_version IS NULL THEN
    SELECT graph_json INTO v_source_graph FROM app.workflow_drafts
      WHERE workspace_id=p_workspace AND workflow_id=p_source FOR UPDATE;
  ELSIF p_kind='version' AND p_version IS NOT NULL THEN
    SELECT graph_json INTO v_source_graph FROM app.workflow_versions
      WHERE workspace_id=p_workspace AND workflow_id=p_source AND id=p_version FOR SHARE;
  ELSE RAISE EXCEPTION 'workflow source selector invalid' USING ERRCODE='22023';
  END IF;
  IF v_source_graph IS NULL OR v_source_graph IS DISTINCT FROM p_graph OR p_schema<>1
    OR p_destination=p_source OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'workflow source content mismatch' USING ERRCODE='42501';
  END IF;
  -- Traverse only structured graph bodies, never similarly named user literals.
  FOR v_reference IN
    WITH RECURSIVE graphs(graph) AS (
      SELECT v_source_graph UNION ALL
      SELECT node.value->'structured'->'body' FROM graphs
        CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
        WHERE node.value->'structured'->>'kind'='for_each'
    ) SELECT DISTINCT reference.value::uuid AS id FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
      CROSS JOIN LATERAL jsonb_each_text(node.value->'connectionRefs') reference
      ORDER BY id
  LOOP
    PERFORM 1 FROM app.connections WHERE workspace_id=p_workspace AND id=v_reference.id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow connection is not visible' USING ERRCODE='42501'; END IF;
  END LOOP;
  INSERT INTO app.workflows(id,workspace_id,name,lifecycle_status,activation_status,created_by)
    VALUES(p_destination,p_workspace,p_name,'active','inactive',p_actor);
  INSERT INTO app.workflow_drafts(workflow_id,workspace_id,revision,schema_version,graph_json,updated_by)
    VALUES(p_destination,p_workspace,1,p_schema,v_source_graph,p_actor);
  -- Source workflow lock fences edits/purge; origin is immutable and inherited
  -- without any current writer gate, descriptor or graph-equivalence lookup.
  INSERT INTO app.workflow_template_origins(workspace_id,workflow_id,origin)
    SELECT p_workspace,p_destination,origin||jsonb_build_object('derivation','inherited')
      FROM app.workflow_template_origins WHERE workspace_id=p_workspace AND workflow_id=p_source;
  RETURN p_destination;
END $$;

CREATE FUNCTION app.create_workflow_import_draft(p_destination uuid, p_workspace uuid, p_actor uuid, p_graph jsonb, p_key_hash character, p_request_hash character, p_command text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_claim record; v_command jsonb; v_graph record; v_node record;
  v_nodes integer:=0; v_edges integer:=0;
  v_origin jsonb; v_expected_refs jsonb; v_connection record; v_workspace_status varchar;
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')
    OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workflow context mismatch' USING ERRCODE='42501';
  END IF;
  -- Explicit lock order: workspace, actor, membership, claim, gate, catalog, connections.
  SELECT app.lock_workspace_run_admission(p_workspace) INTO v_workspace_status;
  IF v_workspace_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'workspace is not active' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.users WHERE id=p_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'actor is not active' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=p_workspace AND user_id=p_actor
    AND status='active' AND role IN ('owner','admin','builder') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow author is not active' USING ERRCODE='42501'; END IF;
  SELECT request_hash,status,resource_id INTO v_claim FROM app.idempotency_records
    WHERE workspace_id=p_workspace AND operation='workflow.import'
      AND scope=p_actor::text AND key_hash=p_key_hash FOR UPDATE;
  IF NOT FOUND OR v_claim.status<>'in_progress' OR v_claim.resource_id<>p_destination
    OR v_claim.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'workflow import claim mismatch' USING ERRCODE='42501';
  END IF;
  IF octet_length(p_command)>2097152 OR p_command IS NULL
    OR encode(sha256(convert_to(p_command,'UTF8')),'hex') IS DISTINCT FROM p_request_hash::text THEN
    RAISE EXCEPTION 'workflow import command mismatch' USING ERRCODE='42501';
  END IF;
  v_command:=p_command::jsonb;
  IF jsonb_typeof(v_command) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_command) key)
      NOT IN (ARRAY['bindings','expectedCompatibilityFingerprint','manifest','name']::text[],
        ARRAY['bindings','expectedCompatibilityFingerprint','manifest','name','templateOrigin']::text[])
    OR jsonb_typeof(v_command->'name') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v_command->'expectedCompatibilityFingerprint') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v_command->'manifest') IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_command->'manifest') key)
      IS DISTINCT FROM ARRAY['connectionSlots','format','formatVersion','graph','requirements']::text[]
    OR jsonb_typeof(v_command->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_command->'manifest'->'connectionSlots') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_command->'manifest'->'requirements') IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_command->'manifest'->'requirements'->'definitions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_command->'manifest'->'requirements'->'selectionFingerprint') IS DISTINCT FROM 'string'
    OR jsonb_array_length(v_command->'manifest'->'requirements'->'definitions')>1000
    OR jsonb_array_length(v_command->'bindings')>1000
    OR jsonb_array_length(v_command->'manifest'->'connectionSlots')>1000 THEN
    RAISE EXCEPTION 'workflow import envelope invalid' USING ERRCODE='42501';
  END IF;
  IF v_command->>'name' IS NULL OR length(v_command->>'name') NOT BETWEEN 1 AND 128
    OR v_command->>'name'<>btrim(v_command->>'name')
    OR v_command->'manifest'->>'format' IS DISTINCT FROM 'pertexo.workflow'
    OR v_command->'manifest'->'formatVersion' IS DISTINCT FROM '1'::jsonb
    OR p_graph->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'workflow import command invalid' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workflow_portability_rollout WHERE singleton AND import_enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow import is disabled' USING ERRCODE='55000'; END IF;
  IF v_command ? 'templateOrigin' THEN
    PERFORM 1 FROM app.curated_template_rollout WHERE singleton AND import_enabled FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'curated template import is disabled' USING ERRCODE='55000'; END IF;
    v_origin:=app.verify_curated_template_origin(v_command->'manifest',v_command->'templateOrigin',p_request_hash::text);
  END IF;
  IF jsonb_typeof(v_command->'manifest'->'graph'->'nodes') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_graph->'nodes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'workflow import graph invalid' USING ERRCODE='42501';
  END IF;
  -- Compare graph pairs structurally, never traverse similarly named literal data.
  -- The only permitted transformation is replacing typed connectionRefs with the
  -- exact submitted bindings. The command text is ephemeral, not a receipt body.
  FOR v_graph IN
    WITH RECURSIVE graphs(source,destination,depth) AS (
      SELECT v_command->'manifest'->'graph',p_graph,0
      UNION ALL
      SELECT source_node.value->'structured'->'body',destination_node.value->'structured'->'body',depth+1
      FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(source->'nodes') WITH ORDINALITY source_node
      JOIN LATERAL jsonb_array_elements(destination->'nodes') WITH ORDINALITY destination_node
        ON destination_node.ordinality=source_node.ordinality
      WHERE source_node.value ? 'structured' AND depth<32
    ) SELECT * FROM graphs
  LOOP
    IF jsonb_typeof(v_graph.source) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_graph.destination) IS DISTINCT FROM 'object'
      OR v_graph.source->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR jsonb_typeof(v_graph.source->'nodes') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_graph.destination->'nodes') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_graph.source->'edges') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_graph.source->'settings') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'workflow import graph invalid' USING ERRCODE='42501';
    END IF;
    v_nodes:=v_nodes+jsonb_array_length(v_graph.source->'nodes');
    v_edges:=v_edges+jsonb_array_length(v_graph.source->'edges');
    IF v_nodes>1000 OR v_edges>4000 THEN
      RAISE EXCEPTION 'workflow import graph limit' USING ERRCODE='42501';
    END IF;
    IF v_graph.source-'nodes' IS DISTINCT FROM v_graph.destination-'nodes'
      OR jsonb_array_length(v_graph.source->'nodes')<>jsonb_array_length(v_graph.destination->'nodes') THEN
      RAISE EXCEPTION 'workflow import graph changed' USING ERRCODE='42501';
    END IF;
    FOR v_node IN SELECT source_node.value source,destination_node.value destination
      FROM jsonb_array_elements(v_graph.source->'nodes') WITH ORDINALITY source_node
      JOIN jsonb_array_elements(v_graph.destination->'nodes') WITH ORDINALITY destination_node
        ON destination_node.ordinality=source_node.ordinality
    LOOP
      IF jsonb_typeof(v_node.source) IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.source->'id') IS DISTINCT FROM 'string'
        OR length(v_node.source->>'id')=0
        OR jsonb_typeof(v_node.source->'definition') IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.source->'config') IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.source->'inputMappings') IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.destination->'connectionRefs') IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.source->'position') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'workflow import node invalid' USING ERRCODE='42501';
      END IF;
      IF v_node.source-'connectionRefs'-'structured' IS DISTINCT FROM v_node.destination-'connectionRefs'-'structured'
        OR (v_node.source->'structured')-'body' IS DISTINCT FROM (v_node.destination->'structured')-'body'
        OR v_node.source->'connectionRefs' IS DISTINCT FROM '{}'::jsonb
        OR (v_graph.depth=32 AND v_node.source ? 'structured') THEN
        RAISE EXCEPTION 'workflow import node changed' USING ERRCODE='42501';
      END IF;
      SELECT coalesce(jsonb_object_agg(binding->>'slot',binding->'connectionId'),'{}'::jsonb)
        INTO v_expected_refs FROM jsonb_array_elements(v_command->'bindings') binding
        WHERE binding->>'nodeId'=v_node.source->>'id';
      IF v_node.destination->'connectionRefs' IS DISTINCT FROM v_expected_refs THEN
        RAISE EXCEPTION 'workflow import binding changed' USING ERRCODE='42501';
      END IF;
    END LOOP;
  END LOOP;
  -- Slot declarations must match bindings exactly, including no duplicate/extra entries.
  IF jsonb_array_length(v_command->'bindings')<>jsonb_array_length(v_command->'manifest'->'connectionSlots')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_command->'bindings') b
      WHERE (SELECT count(*) FROM jsonb_array_elements(v_command->'bindings') d
        WHERE d->>'nodeId'=b->>'nodeId' AND d->>'slot'=b->>'slot')<>1
      OR (SELECT count(*) FROM jsonb_array_elements(v_command->'manifest'->'connectionSlots') s
        WHERE s->>'nodeId'=b->>'nodeId' AND s->>'slot'=b->>'slot')<>1) THEN
    RAISE EXCEPTION 'workflow import slots changed' USING ERRCODE='42501';
  END IF;
  FOR v_connection IN SELECT b->>'connectionId' id,s->>'providerKey' provider,s->>'authType' auth
    FROM jsonb_array_elements(v_command->'bindings') b
    JOIN jsonb_array_elements(v_command->'manifest'->'connectionSlots') s
      ON s->>'nodeId'=b->>'nodeId' AND s->>'slot'=b->>'slot'
    ORDER BY b->>'connectionId',b->>'nodeId',b->>'slot'
  LOOP
    PERFORM 1 FROM app.connections WHERE workspace_id=p_workspace AND id=v_connection.id::uuid
      AND provider_key=v_connection.provider AND auth_type=v_connection.auth AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow connection is not available' USING ERRCODE='42501'; END IF;
  END LOOP;
  INSERT INTO app.workflows(id,workspace_id,name,lifecycle_status,activation_status,created_by)
    VALUES(p_destination,p_workspace,v_command->>'name','active','inactive',p_actor);
  INSERT INTO app.workflow_drafts(workflow_id,workspace_id,revision,schema_version,graph_json,updated_by)
    VALUES(p_destination,p_workspace,1,1,p_graph,p_actor);
  IF v_origin IS NOT NULL THEN
    INSERT INTO app.workflow_template_origins(workspace_id,workflow_id,origin)
      VALUES(p_workspace,p_destination,v_origin);
  END IF;
  RETURN p_destination;
END $$;

CREATE FUNCTION app.create_workflow_with_draft(p_workflow_id uuid, p_workspace_id uuid, p_name character varying, p_actor_id uuid, p_schema_version integer, p_graph_json jsonb, p_key_hash character, p_request_hash character, p_request_id character varying, p_trace_id character varying) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  v_claim_id uuid;
  v_existing record;
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id', true), '')
     OR p_actor_id::text IS DISTINCT FROM NULLIF(current_setting('app.actor_id', true), '') THEN
    RAISE EXCEPTION 'workflow context mismatch' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships membership
    JOIN app.workspaces workspace ON workspace.id = membership.workspace_id
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = p_actor_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin', 'builder')
      AND workspace.status = 'active'
  ) THEN
    RAISE EXCEPTION 'workflow author is not active' USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.idempotency_records
    (id, workspace_id, operation, scope, key_hash, request_hash, status, resource_id, result_ref)
  VALUES
    (gen_random_uuid(), p_workspace_id, 'workflow.create', p_actor_id::text,
     p_key_hash, p_request_hash, 'in_progress', p_workflow_id, '{}'::jsonb)
  ON CONFLICT (workspace_id, operation, scope, key_hash) DO NOTHING
  RETURNING id INTO v_claim_id;

  IF v_claim_id IS NULL THEN
    SELECT request_hash, status, result_ref INTO v_existing
    FROM app.idempotency_records
    WHERE workspace_id = p_workspace_id AND operation = 'workflow.create'
      AND scope = p_actor_id::text AND key_hash = p_key_hash
    FOR UPDATE;
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'workflow create idempotency conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.status <> 'completed' THEN
      RAISE EXCEPTION 'workflow create idempotency record incomplete' USING ERRCODE = '55000';
    END IF;
    RETURN (v_existing.result_ref->>'workflowId')::uuid;
  END IF;

  INSERT INTO app.workflows (
    id, workspace_id, name, lifecycle_status, activation_status, created_by
  ) VALUES (p_workflow_id, p_workspace_id, p_name, 'active', 'inactive', p_actor_id);
  INSERT INTO app.workflow_drafts (
    workflow_id, workspace_id, revision, schema_version, graph_json, updated_by
  ) VALUES (p_workflow_id, p_workspace_id, 1, p_schema_version, p_graph_json, p_actor_id);
  INSERT INTO app.audit_events
    (id, workspace_id, actor_user_id, action, target_type, target_id,
     request_id, trace_id, metadata)
  VALUES
    (gen_random_uuid(), p_workspace_id, p_actor_id, 'workflow.created',
     'workflow', p_workflow_id, p_request_id, p_trace_id, '{"revision":1}'::jsonb);
  UPDATE app.idempotency_records
  SET status = 'completed', result_ref = jsonb_build_object('workflowId', p_workflow_id),
      updated_at = clock_timestamp()
  WHERE id = v_claim_id;
  RETURN p_workflow_id;
END;
$$;

CREATE FUNCTION app.curated_https_endpoint_valid(p_value text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE v_remainder text; v_host text; v_path text; v_query text;
  v_labels text[]; v_label text; v_segment text; v_pairs text[]; v_pair text;
  v_name text; v_value text; v_separator integer;
BEGIN
  IF p_value IS NULL OR octet_length(p_value) NOT BETWEEN 1 AND 2048
    OR p_value COLLATE "C" !~ '^[!-~]+$'
    OR strpos(p_value,chr(92))>0 OR strpos(p_value,'#')>0 OR strpos(p_value,'@')>0
    OR left(p_value,8)<>'https://' THEN RETURN false; END IF;
  v_remainder:=substring(p_value FROM 9);
  v_separator:=strpos(v_remainder,'/');
  IF v_separator=0 THEN RETURN false; END IF;
  v_host:=left(v_remainder,v_separator-1);
  IF octet_length(v_host) NOT BETWEEN 1 AND 253 THEN RETURN false; END IF;
  v_labels:=string_to_array(v_host,'.');
  IF cardinality(v_labels)<2 THEN RETURN false; END IF;
  FOREACH v_label IN ARRAY v_labels LOOP
    IF octet_length(v_label) NOT BETWEEN 1 AND 63
      OR v_label COLLATE "C" !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
      OR left(v_label,4)='xn--' THEN RETURN false; END IF;
  END LOOP;
  IF v_labels[cardinality(v_labels)] COLLATE "C" !~ '^[a-z]{2,63}$'
    THEN RETURN false; END IF;
  v_path:=substring(v_remainder FROM v_separator);
  v_separator:=strpos(v_path,'?');
  IF v_separator>0 THEN
    v_query:=substring(v_path FROM v_separator+1);
    v_path:=left(v_path,v_separator-1);
  END IF;
  IF v_path COLLATE "C" !~ '^/([A-Za-z0-9._~/-]|%[0-9A-F]{2})*$'
    THEN RETURN false; END IF;
  FOREACH v_segment IN ARRAY string_to_array(v_path,'/') LOOP
    IF replace(v_segment,'%2E','.') IN ('.','..') THEN RETURN false; END IF;
  END LOOP;
  IF v_query IS NULL THEN RETURN true; END IF;
  IF v_query='' THEN RETURN false; END IF;
  v_pairs:=string_to_array(v_query,'&');
  IF cardinality(v_pairs) NOT BETWEEN 1 AND 16 THEN RETURN false; END IF;
  FOREACH v_pair IN ARRAY v_pairs LOOP
    v_separator:=strpos(v_pair,'=');
    IF v_separator=0 THEN RETURN false; END IF;
    v_name:=left(v_pair,v_separator-1);
    v_value:=substring(v_pair FROM v_separator+1);
    IF v_name COLLATE "C" !~ '^[A-Za-z0-9._~-]{1,64}$'
      OR v_name COLLATE "C" ~* 'auth|credential|secret|token|api[-_]?key'
      OR v_value COLLATE "C" !~ '^([A-Za-z0-9._~-]|%[0-9A-F]{2})*$'
      THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $_$;

CREATE FUNCTION app.curated_template_inventory_matches(p_digest text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_descriptor record; v_target jsonb; v_field text;
  v_target_text text; v_targets text; v_row text; v_inventory text:='';
BEGIN
  IF p_digest IS NULL OR p_digest COLLATE "C" !~ '^[0-9a-f]{64}$'
    OR octet_length(p_digest)<>64 THEN RETURN false; END IF;
  IF (SELECT count(*) FROM app.curated_template_descriptors) NOT BETWEEN 1 AND 128
    THEN RETURN false; END IF;
  FOR v_descriptor IN SELECT * FROM app.curated_template_descriptors
    ORDER BY template_id COLLATE "C",template_version
  LOOP
    IF jsonb_typeof(v_descriptor.setup_targets) IS DISTINCT FROM 'array'
      THEN RETURN false; END IF;
    IF jsonb_array_length(v_descriptor.setup_targets)>16 THEN RETURN false; END IF;
    v_targets:=jsonb_array_length(v_descriptor.setup_targets)::text||':';
    FOR v_target IN SELECT value FROM jsonb_array_elements(v_descriptor.setup_targets)
    LOOP
      IF jsonb_typeof(v_target) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(v_target) key)
        IS DISTINCT FROM ARRAY['key','location','nodeId','valueKind']::text[]
        OR jsonb_typeof(v_target->'nodeId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_target->'location') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_target->'key') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_target->'valueKind') IS DISTINCT FROM 'string'
        THEN RETURN false; END IF;
      v_target_text:='';
      FOREACH v_field IN ARRAY ARRAY[v_target->>'nodeId',v_target->>'location',
        v_target->>'key',v_target->>'valueKind'] LOOP
        v_target_text:=v_target_text||octet_length(v_field)::text||':'||v_field;
      END LOOP;
      v_targets:=v_targets||octet_length(v_target_text)::text||':'||v_target_text;
    END LOOP;
    v_row:='';
    FOREACH v_field IN ARRAY ARRAY[v_descriptor.template_id,v_descriptor.template_version::text,
      v_descriptor.schema_version::text,v_descriptor.base_manifest,v_descriptor.base_manifest_digest::text,
      v_targets,v_descriptor.supported_profile] LOOP
      v_row:=v_row||octet_length(v_field)::text||':'||v_field;
    END LOOP;
    v_inventory:=v_inventory||octet_length(v_row)::text||':'||v_row;
  END LOOP;
  RETURN encode(sha256(convert_to('pertexo.workflow.curated-inventory.v1','UTF8')
    ||decode('00','hex')||convert_to(v_inventory,'UTF8')),'hex')=p_digest;
END $_$;

CREATE FUNCTION app.current_workflow_favorite_generation() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  SELECT g.generation FROM app.workflow_favorite_membership_generations g
  JOIN app.workspaces w ON w.id=g.workspace_id AND w.status='active'
  JOIN app.users u ON u.id=g.actor_id AND u.status='active'
  JOIN app.workspace_memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.actor_id AND m.status='active'
  WHERE g.workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND g.actor_id::text=nullif(current_setting('app.actor_id',true),'')
$$;

CREATE FUNCTION app.defer_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=p_workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  UPDATE app.artifacts SET retention_retry_at=clock_timestamp()+interval '1 minute',
    updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND id=p_artifact_id AND status='deleting';
  RETURN FOUND;
END $$;

CREATE FUNCTION app.defer_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid, p_retry_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.enforce_connection_health_protocol() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app'
    AS $$
BEGIN
  IF NEW.health_revision<OLD.health_revision OR (OLD.status='revoked' AND NEW.status<>'revoked') THEN
    RAISE EXCEPTION 'connection revision and revocation are monotonic' USING ERRCODE='PTH06';
  END IF;
  IF (NEW.status,NEW.current_secret_version_id,NEW.last_tested_at,NEW.last_healthy_at,NEW.last_error_code,
      NEW.health_revision,NEW.last_run_observed_at,NEW.last_health_transition_at,NEW.last_health_transition_source)
    IS DISTINCT FROM
     (OLD.status,OLD.current_secret_version_id,OLD.last_tested_at,OLD.last_healthy_at,OLD.last_error_code,
      OLD.health_revision,OLD.last_run_observed_at,OLD.last_health_transition_at,OLD.last_health_transition_source)
    AND current_setting('app.connection_health_protocol',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'connection health requires revision-aware writer' USING ERRCODE='PTH01';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.enforce_manual_start_writer() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  -- Privileged fixture/restore writes are not serving runtime admission. Runtime
  -- roles cannot inherit the owner role (startup readiness independently proves it).
  IF NEW.trigger_type='manual' AND NEW.status IN ('queued','running','waiting')
    AND NOT pg_has_role(current_user,
      (SELECT proowner FROM pg_proc WHERE oid='app.lock_manual_workflow_run_start(uuid,uuid,text,text)'::regprocedure),'USAGE')
    AND current_setting('app.manual_start_writer',true) IS DISTINCT FROM
      NEW.workspace_id::text||':'||NEW.workflow_id::text THEN
    RAISE EXCEPTION 'serialized manual start writer required' USING ERRCODE='PTM01';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.enforce_oidc_login_transaction_capacity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  admission_time timestamptz;
  active_count bigint;
  total_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7166118815);
  admission_time := clock_timestamp();

  DELETE FROM app.oidc_login_transactions AS transaction
  WHERE transaction.ctid IN (
    SELECT stale.ctid
    FROM app.oidc_login_transactions AS stale
    WHERE
      stale.expires_at <= admission_time - interval '15 minutes'
      OR stale.consumed_at <= admission_time - interval '15 minutes'
    ORDER BY coalesce(stale.consumed_at, stale.expires_at), stale.state_digest
    LIMIT 1000
  );

  SELECT count(*)
  INTO active_count
  FROM app.oidc_login_transactions AS transaction
  WHERE transaction.consumed_at IS NULL
    AND transaction.expires_at > admission_time;

  IF active_count >= 10000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'OIDC login transaction capacity is exhausted';
  END IF;

  SELECT count(*)
  INTO total_count
  FROM app.oidc_login_transactions;

  IF total_count >= 20000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'OIDC login transaction retention capacity is exhausted';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_preview_artifact_retention() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.artifacts artifact
    JOIN app.preview_runs preview
      ON preview.workspace_id = NEW.workspace_id
     AND preview.id = NEW.owner_id
    WHERE artifact.workspace_id = NEW.workspace_id
      AND artifact.id = NEW.artifact_id
      AND artifact.expires_at <= preview.expires_at
  ) THEN
    RAISE EXCEPTION 'preview artifact retention exceeds its owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.enforce_workflow_run_admission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  entitlement record;
  actual_queued integer;
  actual_active integer;
  reserved_active integer;
  next_queued integer;
  next_active integer;
  workspace_status text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.admission_ticket IS DISTINCT FROM OLD.admission_ticket THEN
    RAISE EXCEPTION 'admission ticket is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
    END IF;
    RAISE EXCEPTION 'capped production runs must enter the durable queue' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND (OLD.cancel_requested_at IS NOT NULL OR OLD.deadline_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'terminal control cannot start work' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL)
     AND current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  SELECT status INTO workspace_status FROM app.workspaces
   WHERE id=NEW.workspace_id FOR SHARE;
  IF TG_OP='INSERT' THEN
    SELECT version.version,version.status,version.active_run_limit,
           version.queued_run_limit,version.effective_at,version.expires_at
      INTO entitlement
      FROM app.workspace_execution_entitlements current
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=current.workspace_id
       AND version.version=current.current_version
     WHERE current.workspace_id=NEW.workspace_id
     FOR SHARE OF current,version;
  ELSE
    SELECT version.version,version.status,version.active_run_limit,
           version.queued_run_limit,version.effective_at,version.expires_at
      INTO entitlement
      FROM app.workspace_execution_entitlement_versions version
     WHERE version.workspace_id=OLD.workspace_id
       AND version.version=OLD.execution_entitlement_version
     FOR SHARE OF version;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  IF TG_OP='INSERT' AND (
       entitlement.status<>'active'
       OR entitlement.effective_at>clock_timestamp()
       OR (entitlement.expires_at IS NOT NULL AND entitlement.expires_at<=clock_timestamp())
       OR workspace_status IS DISTINCT FROM 'active'
     ) THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued'
     AND NEW.status IN ('running','waiting')
     AND workspace_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters
   WHERE workspace_id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  -- Re-read the policy after the workspace counter serializes settings writes.
  -- The early guard cannot see a cap committed while this INSERT waits.
  IF TG_OP='INSERT' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
    END IF;
    RAISE EXCEPTION 'capped production runs must enter the durable queue' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.admission_ticket:=nextval('app.workflow_run_admission_ticket_seq');
  END IF;
  SELECT count(*) FILTER(WHERE status='queued')::integer,
         count(*) FILTER(WHERE status IN ('running','waiting'))::integer
    INTO actual_queued,actual_active
    FROM app.workflow_runs WHERE workspace_id=NEW.workspace_id;
  IF TG_OP='INSERT' THEN
    SELECT count(*)::integer INTO reserved_active
      FROM app.workflow_run_active_admissions
     WHERE workspace_id=NEW.workspace_id;
  ELSE
    SELECT count(*)::integer INTO reserved_active
      FROM app.workflow_run_active_admissions
     WHERE workspace_id=NEW.workspace_id AND workflow_run_id<>OLD.id;
  END IF;
  next_queued:=actual_queued;
  next_active:=actual_active+reserved_active;
  IF TG_OP='INSERT' THEN
    NEW.execution_entitlement_version:=entitlement.version;
    IF NEW.status='queued' THEN next_queued:=next_queued+1;
    ELSIF NEW.status IN ('running','waiting') THEN next_active:=next_active+1;
    END IF;
  ELSE
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
       NEW.execution_entitlement_version IS DISTINCT FROM OLD.execution_entitlement_version THEN
      RAISE EXCEPTION 'workflow run admission identity is immutable' USING ERRCODE='55000';
    END IF;
    IF OLD.status='queued' THEN next_queued:=next_queued-1;
    ELSIF OLD.status IN ('running','waiting') THEN next_active:=next_active-1;
    END IF;
    IF NEW.status='queued' THEN next_queued:=next_queued+1;
    ELSIF NEW.status IN ('running','waiting') THEN next_active:=next_active+1;
    END IF;
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status='queued') OR
      (TG_OP='UPDATE' AND OLD.status<>'queued' AND NEW.status='queued')) AND
     next_queued>entitlement.queued_run_limit THEN
    RAISE EXCEPTION 'workspace.queued_run_limit_exceeded' USING ERRCODE='PTA02';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status IN ('running','waiting')) OR
      (TG_OP='UPDATE' AND OLD.status NOT IN ('running','waiting')
       AND NEW.status IN ('running','waiting'))) AND
     next_active>entitlement.active_run_limit THEN
    RAISE EXCEPTION 'workspace.active_run_limit_exceeded' USING ERRCODE='PTA03';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND NOT app.workflow_concurrency_admissible(NEW.workspace_id,NEW.id,false) THEN
    RAISE EXCEPTION 'workflow concurrency admission blocked' USING ERRCODE='PTC02';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.enforce_workspace_legal_hold_ledger_links() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=NEW.workspace_id AND record.sequence=NEW.placed_sequence
      AND record.subject_id=NEW.hold_id AND record.command_type='legal_hold_placed'
      AND record.record_hash=NEW.placed_record_hash
      AND record.legal_authority=NEW.legal_authority
      AND record.reason=NEW.placement_reason AND record.actor_ref=NEW.placed_by
      AND record.occurred_at=NEW.placed_at
  ) THEN
    RAISE EXCEPTION 'legal hold placement does not match its control record' USING ERRCODE='23503';
  END IF;
  IF NEW.released_sequence IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=NEW.workspace_id AND record.sequence=NEW.released_sequence
      AND record.subject_id=NEW.hold_id AND record.command_type='legal_hold_released'
      AND record.record_hash=NEW.released_record_hash
      AND record.legal_authority=NEW.release_authority
      AND record.reason=NEW.release_reason AND record.actor_ref=NEW.released_by
      AND record.occurred_at=NEW.released_at
  ) THEN
    RAISE EXCEPTION 'legal hold release does not match its control record' USING ERRCODE='23503';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app.enforce_workspace_retention_control_initial_state() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF NEW.retention_control_sequence IS DISTINCT FROM 0
    OR NEW.retention_control_hash IS DISTINCT FROM repeat('0',64) THEN
    RAISE EXCEPTION 'new workspace retention control high water must be empty'
      USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.enqueue_authentication_mail(p_id uuid, p_purpose text, p_expires_at timestamp with time zone, p_ciphertext text, p_nonce text, p_tag text, p_key_version text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
BEGIN
  IF p_id IS NULL OR p_purpose NOT IN
       ('verification','password_reset','email_change_confirmation')
     OR p_expires_at<=clock_timestamp()
     OR p_expires_at>clock_timestamp()+interval '7 days'
     OR length(p_ciphertext) NOT BETWEEN 1 AND 32768
     OR length(p_nonce) NOT BETWEEN 1 AND 128
     OR length(p_tag) NOT BETWEEN 1 AND 256
     OR p_key_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid authentication mail command' USING ERRCODE='22023';
  END IF;
  INSERT INTO app.authentication_mail_deliveries(
    id,purpose,expires_at,payload_ciphertext,payload_nonce,payload_tag,
    payload_key_version
  ) VALUES (
    p_id,p_purpose,p_expires_at,p_ciphertext,p_nonce,p_tag,p_key_version
  );
END;
$_$;

CREATE FUNCTION app.execute_operator_execution_command(p_command_id uuid, p_command_type character varying, p_workspace_id uuid, p_target_id uuid, p_expected_fence bigint, p_action character varying, p_evidence_kind character varying, p_evidence_ref jsonb, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean, result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
END $_$;

CREATE FUNCTION app.execute_standard_retention_dry_run_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer) RETURNS TABLE(outcome character varying, examined_delta integer, eligible_delta integer, retention_stage character varying, dry_run_cursor jsonb, dry_run_upper jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.execute_standard_retention_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer, p_expected_control_sequence bigint, p_expected_control_hash character) RETURNS TABLE(outcome character varying, examined_delta integer, eligible_delta integer, cursor_expires_at timestamp with time zone, cursor_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
END $_$;

CREATE FUNCTION app.execute_workflow_favorite_command(p_workflow_id uuid, p_key_hash text, p_body jsonb, p_verified_generation uuid, p_issued_seconds bigint, p_expires_seconds bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_claim jsonb; v_workspace uuid; v_actor uuid; v_generation uuid;
  v_request jsonb; v_expected text; v_now numeric; v_current app.workflow_favorites%ROWTYPE;
  v_revision uuid; v_result jsonb; v_favorite boolean;
BEGIN
  v_claim:=app.prepare_workflow_favorite_command(p_workflow_id,p_key_hash,p_body);
  IF v_claim->>'kind'='replay' THEN RETURN v_claim->'result'; END IF;
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  v_generation:=(v_claim->>'generation')::uuid;
  v_request:=app.workflow_favorite_command_body(p_body);
  v_expected:=v_request->>'expectedFavoriteRevision';
  v_favorite:=(v_request->>'favorite')::boolean;
  PERFORM app.assert_workflow_organization_writes_enabled();
  PERFORM app.lock_workflow_organization_coordination(false);
  PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_current FROM app.workflow_favorites
    WHERE workspace_id=v_workspace AND actor_id=v_actor AND workflow_id=p_workflow_id FOR UPDATE;
  IF left(v_expected,10)='absent.v1.' THEN
    v_now:=extract(epoch FROM clock_timestamp());
    IF p_verified_generation IS DISTINCT FROM v_generation
      OR (v_current.generation=v_generation)
      OR p_issued_seconds IS NULL OR p_expires_seconds IS NULL
      OR p_issued_seconds<0 OR p_expires_seconds>253402300799
      OR p_expires_seconds-p_issued_seconds<>86400
      OR p_issued_seconds>v_now+5 OR p_expires_seconds<=v_now
      OR split_part(v_expected,'.',3)<>p_issued_seconds::text
      OR split_part(v_expected,'.',4)<>p_expires_seconds::text THEN
      RAISE EXCEPTION 'favorite revision conflict' USING ERRCODE='P7010'; END IF;
  ELSE
    IF p_verified_generation IS NOT NULL OR p_issued_seconds IS NOT NULL OR p_expires_seconds IS NOT NULL
      OR v_current.generation IS DISTINCT FROM v_generation
      OR v_current.revision::text IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'favorite revision conflict' USING ERRCODE='P7010'; END IF;
  END IF;
  IF v_current.generation IS NOT NULL AND v_current.generation<>v_generation
    AND EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_workspace AND released_sequence IS NULL) THEN
    INSERT INTO app.workflow_favorite_held_evidence(workspace_id,actor_id,workflow_id,generation,favorite,revision,expires_at)
      VALUES(v_current.workspace_id,v_current.actor_id,v_current.workflow_id,v_current.generation,
        v_current.favorite,v_current.revision,v_current.expires_at);
  END IF;
  v_revision:=uuidv7();
  INSERT INTO app.workflow_favorites(workspace_id,actor_id,workflow_id,generation,favorite,revision,expires_at)
    VALUES(v_workspace,v_actor,p_workflow_id,v_generation,v_favorite,v_revision,
      CASE WHEN v_favorite THEN NULL ELSE clock_timestamp()+interval '24 hours' END)
    ON CONFLICT(workspace_id,actor_id,workflow_id) DO UPDATE SET generation=EXCLUDED.generation,
      favorite=EXCLUDED.favorite,revision=EXCLUDED.revision,expires_at=EXCLUDED.expires_at;
  v_result:=jsonb_build_object('isFavorite',v_favorite,'favoriteRevision',v_revision);
  UPDATE app.workflow_favorite_receipts SET result=v_result
    WHERE workspace_id=v_workspace AND actor_id=v_actor AND workflow_id=p_workflow_id
      AND key_hash=p_key_hash AND generation=v_generation AND result IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'favorite claim unavailable' USING ERRCODE='55000'; END IF;
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION app.execute_workflow_folder_command(p_operation text, p_folder uuid, p_key_hash text, p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_request jsonb; v_replay jsonb; v_target uuid; v_parent uuid;
  v_name text; v_name_key text; v_folder app.workflow_folders%ROWTYPE; v_depth integer;
  v_height integer; v_cycle boolean; v_result jsonb;
BEGIN
  IF (p_operation='folder.create' AND p_folder IS NOT NULL)
    OR (p_operation<>'folder.create' AND p_folder IS NULL) OR p_operation='folder.place' THEN
    RAISE EXCEPTION 'folder command invalid' USING ERRCODE='22023'; END IF;
  v_request:=app.workflow_folder_command_body(p_operation,p_body);
  v_workspace:=app.lock_workflow_organization_authority(ARRAY['owner','admin']);
  v_target:=coalesce(p_folder,'00000000-0000-0000-0000-000000000000'::uuid);
  v_replay:=app.claim_workflow_organization_command(p_operation,v_target,p_key_hash,v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay||jsonb_build_object('replayed',true); END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  PERFORM app.lock_workflow_organization_coordination(true);
  -- Hierarchy is bounded to 256; stable UUID order includes ancestors/descendants.
  PERFORM 1 FROM app.workflow_folders WHERE workspace_id=v_workspace ORDER BY id FOR UPDATE;
  IF p_operation IN ('folder.create','folder.move') THEN
    v_parent:=(v_request->>'parentId')::uuid;
    IF v_parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=v_parent) THEN
      RAISE EXCEPTION 'folder is not visible' USING ERRCODE='42501'; END IF;
  END IF;
  IF p_operation<>'folder.create' THEN
    SELECT * INTO v_folder FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=p_folder;
    IF NOT FOUND THEN RAISE EXCEPTION 'folder is not visible' USING ERRCODE='42501'; END IF;
    IF v_folder.revision<>(v_request->>'expectedFolderRevision')::bigint OR v_folder.revision=9007199254740991 THEN
      RAISE EXCEPTION 'folder revision conflict' USING ERRCODE='P7013'; END IF;
    IF p_operation NOT IN ('folder.move','folder.delete') THEN v_parent:=v_folder.parent_id; END IF;
  END IF;
  IF p_operation IN ('folder.create','folder.rename') THEN v_name:=v_request->>'name';
  ELSE v_name:=v_folder.name; END IF;
  v_name_key:=translate(v_name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
  IF p_operation<>'folder.delete' AND EXISTS(SELECT 1 FROM app.workflow_folders
    WHERE workspace_id=v_workspace AND parent_id IS NOT DISTINCT FROM v_parent
      AND name_key=v_name_key AND id IS DISTINCT FROM p_folder) THEN
    RAISE EXCEPTION 'folder name conflict' USING ERRCODE='P7011'; END IF;
  IF p_operation='folder.create' THEN
    IF (SELECT count(*) FROM (SELECT 1 FROM app.workflow_folders WHERE workspace_id=v_workspace LIMIT 257) bounded)>=256 THEN
      RAISE EXCEPTION 'workspace folder limit' USING ERRCODE='P7012'; END IF;
    v_depth:=app.workflow_folder_depth(v_workspace,v_parent)+1;
    IF v_depth>4 THEN RAISE EXCEPTION 'folder hierarchy conflict' USING ERRCODE='P7014'; END IF;
    INSERT INTO app.workflow_folders(workspace_id,id,parent_id,name,name_key)
      VALUES(v_workspace,uuidv7(),v_parent,v_name,v_name_key) RETURNING * INTO v_folder;
  ELSIF p_operation='folder.delete' THEN
    IF EXISTS(SELECT 1 FROM app.workflow_folders WHERE workspace_id=v_workspace AND parent_id=p_folder)
      OR EXISTS(SELECT 1 FROM app.workflow_organization_state WHERE workspace_id=v_workspace AND folder_id=p_folder) THEN
      RAISE EXCEPTION 'folder is not empty' USING ERRCODE='P7015'; END IF;
    DELETE FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=p_folder;
    v_result:=jsonb_build_object('folderId',p_folder,'deleted',true);
  ELSE
    IF p_operation='folder.move' THEN
      WITH RECURSIVE descendants AS (
        SELECT id,1 height FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=p_folder
        UNION ALL SELECT f.id,d.height+1 FROM descendants d JOIN app.workflow_folders f
          ON f.workspace_id=v_workspace AND f.parent_id=d.id WHERE d.height<5
      ) SELECT max(height),bool_or(id=v_parent) INTO v_height,v_cycle FROM descendants;
      v_depth:=app.workflow_folder_depth(v_workspace,v_parent)+1;
      IF v_cycle OR v_height+v_depth-1>4 THEN
        RAISE EXCEPTION 'folder hierarchy conflict' USING ERRCODE='P7014'; END IF;
    END IF;
    UPDATE app.workflow_folders SET name=v_name,name_key=v_name_key,parent_id=v_parent,revision=revision+1
      WHERE workspace_id=v_workspace AND id=p_folder RETURNING * INTO v_folder;
  END IF;
  IF p_operation<>'folder.delete' THEN
    v_result:=jsonb_build_object('folder',jsonb_build_object('id',v_folder.id,'name',v_folder.name,
      'parentId',v_folder.parent_id,'revision',v_folder.revision,'depth',app.workflow_folder_depth(v_workspace,v_folder.id)));
  END IF;
  PERFORM app.record_workflow_organization_audit('workflow.'||p_operation,v_folder.id,'{}'::jsonb);
  PERFORM app.complete_workflow_organization_command(p_operation,v_target,p_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION app.execute_workflow_folder_placement(p_workflow uuid, p_key_hash text, p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_request jsonb; v_replay jsonb; v_result jsonb; v_lifecycle text;
BEGIN
  IF p_workflow IS NULL THEN RAISE EXCEPTION 'workflow target invalid' USING ERRCODE='22023'; END IF;
  v_request:=app.workflow_folder_command_body('folder.place',p_body);
  v_workspace:=app.lock_workflow_organization_authority(ARRAY['owner','admin','builder']);
  v_replay:=app.claim_workflow_organization_command('folder.place',p_workflow,p_key_hash,v_request);
  IF v_replay IS NOT NULL THEN
    SELECT lifecycle_status INTO v_lifecycle FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
    IF v_lifecycle<>'active' AND NOT EXISTS(SELECT 1 FROM app.workspace_memberships WHERE workspace_id=v_workspace
      AND user_id::text=current_setting('app.actor_id') AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'workflow lifecycle conflict' USING ERRCODE='P7009'; END IF;
    RETURN v_replay||jsonb_build_object('replayed',true);
  END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  v_result:=app.apply_workflow_organization_item('move',p_workflow,v_request);
  PERFORM app.complete_workflow_organization_command('folder.place',p_workflow,p_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION app.execute_workflow_organization_batch_item(p_parent_key_hash text, p_body jsonb, p_workflow uuid, p_item_key_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_request jsonb; v_parent app.workflow_organization_receipts%ROWTYPE;
  v_hash text; v_item jsonb; v_body jsonb; v_replay jsonb; v_result jsonb; v_operation text; v_lifecycle text;
BEGIN
  IF p_workflow IS NULL THEN RAISE EXCEPTION 'batch item invalid' USING ERRCODE='22023'; END IF;
  v_request:=app.workflow_organization_batch_body(p_body); v_operation:=v_request->>'operation';
  v_workspace:=app.lock_workflow_organization_authority(CASE WHEN v_operation='tag_cleanup'
    THEN ARRAY['owner','admin'] ELSE ARRAY['owner','admin','builder'] END);
  v_hash:=encode(sha256(convert_to(v_request::text,'UTF8')),'hex');
  SELECT * INTO v_parent FROM app.workflow_organization_receipts r
    WHERE r.workspace_id=v_workspace AND r.actor_id::text=current_setting('app.actor_id')
      AND r.operation='organization.batch.identity' AND r.target_id=v_workspace AND r.key_hash=p_parent_key_hash FOR SHARE;
  -- Own-transaction creation is not committed admission. Concurrent uncommitted
  -- admissions are invisible under READ COMMITTED; the adapter must retry only
  -- the entire frozen request after committing its separate admission TX.
  IF NOT FOUND OR v_parent.result IS DISTINCT FROM '{"admitted":true}'::jsonb
    OR v_parent.request_hash<>v_hash OR v_parent.expires_at<=clock_timestamp()
    OR v_parent.admission_xid IS NULL OR v_parent.admission_xid=pg_current_xact_id()
    OR p_item_key_hash IS DISTINCT FROM encode(sha256(convert_to(
      '{"v":1,"p":"organization.batch.item","k":"'||p_parent_key_hash||'","id":"'||p_workflow::text||'"}','UTF8')),'hex') THEN
    RAISE EXCEPTION 'organization batch admission invalid' USING ERRCODE='P7002'; END IF;
  SELECT value INTO v_item FROM jsonb_array_elements(v_request->'items') WHERE value->>'workflowId'=p_workflow::text;
  IF v_item IS NULL THEN RAISE EXCEPTION 'organization batch item invalid' USING ERRCODE='22023'; END IF;
  v_body:=jsonb_build_object('expectedOrganizationRevision',v_item->'expectedOrganizationRevision')||CASE v_operation
    WHEN 'move' THEN jsonb_build_object('folderId',v_request->'target')
    WHEN 'replace_tags' THEN jsonb_build_object('tagIds',v_request->'target')
    ELSE jsonb_build_object('tagId',v_request->'target') END;
  v_replay:=app.claim_workflow_organization_command('organization.batch.item',p_workflow,p_item_key_hash,
    jsonb_build_object('parentHash',v_hash,'purpose',v_operation,'body',v_body));
  IF v_replay IS NOT NULL THEN
    SELECT lifecycle_status INTO v_lifecycle FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
    IF v_operation='move' AND v_lifecycle<>'active' AND NOT EXISTS(SELECT 1 FROM app.workspace_memberships
      WHERE workspace_id=v_workspace AND user_id::text=current_setting('app.actor_id') AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'workflow lifecycle conflict' USING ERRCODE='P7009'; END IF;
    RETURN v_replay||jsonb_build_object('replayed',true);
  END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  v_result:=app.apply_workflow_organization_item(v_operation,p_workflow,v_body);
  PERFORM app.complete_workflow_organization_command('organization.batch.item',p_workflow,p_item_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION app.execute_workflow_run_input_retention_dry_run_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer) RETURNS TABLE(examined_delta integer, eligible_delta integer, completed boolean, cursor_expires_at timestamp with time zone, cursor_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.execute_workflow_run_input_retention_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer, p_expected_control_sequence bigint, p_expected_control_hash character) RETURNS TABLE(outcome character varying, examined_delta integer, eligible_delta integer, cursor_expires_at timestamp with time zone, cursor_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
END $_$;

CREATE FUNCTION app.execute_workflow_tag_assignment_command(p_operation text, p_workflow_id uuid, p_key_hash text, p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_workspace uuid; v_roles text[]; v_ids uuid[]; v_expected bigint;
  v_lifecycle text; v_revision bigint; v_replay jsonb; v_result jsonb; v_request jsonb;
  v_input jsonb; v_id uuid; v_keys text[];
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('tags.replace','tag.detach') OR p_workflow_id IS NULL
    OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>2048 THEN
    RAISE EXCEPTION 'tag assignment command invalid' USING ERRCODE='22023'; END IF;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO v_keys FROM jsonb_object_keys(p_body) key;
  IF v_keys IS DISTINCT FROM (CASE p_operation WHEN 'tags.replace'
    THEN ARRAY['expectedOrganizationRevision','tagIds']::text[]
    ELSE ARRAY['expectedOrganizationRevision','tagId']::text[] END) THEN
    RAISE EXCEPTION 'tag assignment command invalid' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_body->'expectedOrganizationRevision') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'organization revision invalid' USING ERRCODE='22023'; END IF;
  IF (p_body->>'expectedOrganizationRevision')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR trunc((p_body->>'expectedOrganizationRevision')::numeric)<>(p_body->>'expectedOrganizationRevision')::numeric THEN
    RAISE EXCEPTION 'organization revision invalid' USING ERRCODE='22023'; END IF;
  v_expected:=(p_body->>'expectedOrganizationRevision')::bigint;
  IF p_operation='tags.replace' THEN
    IF jsonb_typeof(p_body->'tagIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'tag selection invalid' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(p_body->'tagIds')>16 THEN
      RAISE EXCEPTION 'tag selection invalid' USING ERRCODE='22023'; END IF;
    v_input:=p_body->'tagIds'; v_roles:=ARRAY['owner','admin','builder'];
  ELSE
    v_input:=jsonb_build_array(p_body->'tagId'); v_roles:=ARRAY['owner','admin'];
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_input) item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string' OR octet_length(item#>>'{}')<>36
      OR (item#>>'{}') COLLATE "C" !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$') THEN
    RAISE EXCEPTION 'tag selection invalid' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_ids
    FROM (SELECT (item#>>'{}')::uuid id FROM jsonb_array_elements(v_input) item) ids;
  IF cardinality(v_ids)<>(SELECT count(DISTINCT id) FROM unnest(v_ids) id) THEN
    RAISE EXCEPTION 'tag selection invalid' USING ERRCODE='22023'; END IF;
  v_request:=CASE p_operation WHEN 'tags.replace'
    THEN jsonb_build_object('tagIds',to_jsonb(v_ids),'expectedOrganizationRevision',v_expected)
    ELSE jsonb_build_object('tagId',v_ids[1],'expectedOrganizationRevision',v_expected) END;
  v_workspace:=app.lock_workflow_organization_authority(v_roles);
  v_replay:=app.claim_workflow_organization_command(p_operation,p_workflow_id,p_key_hash,v_request);
  IF v_replay IS NOT NULL THEN
    -- Current visibility without coordinator/tag locks or current selection.
    PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
    RETURN v_replay||jsonb_build_object('replayed',true);
  END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  PERFORM app.lock_workflow_organization_coordination(true);
  PERFORM 1 FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=ANY(v_ids) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=ANY(v_ids))<>cardinality(v_ids) THEN
    RAISE EXCEPTION 'tag is not visible' USING ERRCODE='P7005'; END IF;
  SELECT lifecycle_status INTO v_lifecycle FROM app.workflows
    WHERE workspace_id=v_workspace AND id=p_workflow_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  IF p_operation='tags.replace' AND v_lifecycle<>'active' THEN
    RAISE EXCEPTION 'workflow lifecycle conflict' USING ERRCODE='P7009'; END IF;
  SELECT revision INTO v_revision FROM app.workflow_organization_state
    WHERE workspace_id=v_workspace AND workflow_id=p_workflow_id;
  v_revision:=coalesce(v_revision,1);
  IF v_revision<>v_expected OR v_revision=9007199254740991 THEN
    RAISE EXCEPTION 'organization revision conflict' USING ERRCODE='P7008',DETAIL=v_revision::text; END IF;
  IF p_operation='tags.replace' THEN
    DELETE FROM app.workflow_tag_assignments WHERE workspace_id=v_workspace AND workflow_id=p_workflow_id;
    FOREACH v_id IN ARRAY v_ids LOOP
      INSERT INTO app.workflow_tag_assignments(workspace_id,workflow_id,tag_id) VALUES(v_workspace,p_workflow_id,v_id);
    END LOOP;
  ELSE
    DELETE FROM app.workflow_tag_assignments
      WHERE workspace_id=v_workspace AND workflow_id=p_workflow_id AND tag_id=v_ids[1];
  END IF;
  INSERT INTO app.workflow_organization_state(workspace_id,workflow_id,revision)
    VALUES(v_workspace,p_workflow_id,v_revision+1)
    ON CONFLICT(workspace_id,workflow_id) DO UPDATE SET revision=EXCLUDED.revision;
  v_result:=jsonb_build_object('workflowId',p_workflow_id,'organizationRevision',v_revision+1);
  IF p_operation='tags.replace' THEN v_result:=v_result||jsonb_build_object('tagIds',to_jsonb(v_ids)); END IF;
  PERFORM app.record_workflow_organization_audit('workflow.'||p_operation,p_workflow_id,
    jsonb_build_object('organizationRevision',v_revision+1));
  PERFORM app.complete_workflow_organization_command(p_operation,p_workflow_id,p_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $_$;

CREATE FUNCTION app.execute_workflow_tag_command(p_operation text, p_tag_id uuid, p_key_hash text, p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_workspace uuid; v_key text; v_expected bigint; v_request jsonb;
  v_target uuid; v_replay jsonb; v_result jsonb; v_tag app.workflow_tags%ROWTYPE;
  v_workflows uuid[]; v_workflow uuid; v_revision bigint;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('tag.create','tag.rename','tag.delete')
    OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>256
    OR (p_operation='tag.create' AND p_tag_id IS NOT NULL)
    OR (p_operation<>'tag.create' AND p_tag_id IS NULL) THEN
    RAISE EXCEPTION 'tag command invalid' USING ERRCODE='22023'; END IF;
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(p_body) key)
    IS DISTINCT FROM (CASE p_operation WHEN 'tag.create' THEN ARRAY['key']::text[]
      WHEN 'tag.rename' THEN ARRAY['expectedTagRevision','key']::text[]
      ELSE ARRAY['expectedTagRevision']::text[] END) THEN
    RAISE EXCEPTION 'tag command invalid' USING ERRCODE='22023'; END IF;
  IF p_operation<>'tag.delete' THEN
    IF jsonb_typeof(p_body->'key') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'tag key invalid' USING ERRCODE='22023'; END IF;
    v_key:=translate(btrim(p_body->>'key',' '),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
    IF octet_length(v_key) NOT BETWEEN 1 AND 32 OR v_key COLLATE "C" !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      OR v_key COLLATE "C" ~ '[^a-z0-9-]' THEN
      RAISE EXCEPTION 'tag key invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_operation<>'tag.create' THEN
    IF jsonb_typeof(p_body->'expectedTagRevision') IS DISTINCT FROM 'number'
      OR (p_body->>'expectedTagRevision')::numeric NOT BETWEEN 1 AND 9007199254740991
      OR trunc((p_body->>'expectedTagRevision')::numeric)<>(p_body->>'expectedTagRevision')::numeric THEN
      RAISE EXCEPTION 'tag revision invalid' USING ERRCODE='22023'; END IF;
    v_expected:=(p_body->>'expectedTagRevision')::bigint;
  END IF;
  v_request:=CASE p_operation WHEN 'tag.create' THEN jsonb_build_object('key',v_key)
    WHEN 'tag.rename' THEN jsonb_build_object('key',v_key,'expectedTagRevision',v_expected)
    ELSE jsonb_build_object('expectedTagRevision',v_expected) END;
  v_target:=coalesce(p_tag_id,'00000000-0000-0000-0000-000000000000'::uuid);
  v_workspace:=app.lock_workflow_organization_authority(ARRAY['owner','admin']);
  v_replay:=app.claim_workflow_organization_command(p_operation,v_target,p_key_hash,v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay||jsonb_build_object('replayed',true); END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  PERFORM app.lock_workflow_organization_coordination(true);

  IF p_operation='tag.create' THEN
    IF EXISTS(SELECT 1 FROM app.workflow_tags WHERE workspace_id=v_workspace AND key=v_key) THEN
      RAISE EXCEPTION 'tag key conflict' USING ERRCODE='P7003'; END IF;
    IF (SELECT count(*) FROM app.workflow_tags WHERE workspace_id=v_workspace)>=256 THEN
      RAISE EXCEPTION 'workspace tag limit' USING ERRCODE='P7004'; END IF;
    INSERT INTO app.workflow_tags(workspace_id,id,key) VALUES(v_workspace,uuidv7(),v_key)
      RETURNING * INTO v_tag;
    v_result:=jsonb_build_object('tag',jsonb_build_object('id',v_tag.id,'key',v_tag.key,'revision',v_tag.revision));
  ELSE
    SELECT * INTO v_tag FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=p_tag_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'tag is not visible' USING ERRCODE='P7005'; END IF;
    IF v_tag.revision<>v_expected THEN
      RAISE EXCEPTION 'tag revision conflict' USING ERRCODE='P7006',DETAIL=v_tag.revision::text; END IF;
    IF p_operation='tag.rename' THEN
      IF EXISTS(SELECT 1 FROM app.workflow_tags WHERE workspace_id=v_workspace AND key=v_key AND id<>p_tag_id) THEN
        RAISE EXCEPTION 'tag key conflict' USING ERRCODE='P7003'; END IF;
      IF v_tag.revision=9007199254740991 THEN
        RAISE EXCEPTION 'tag revision exhausted' USING ERRCODE='P7006',DETAIL=v_tag.revision::text; END IF;
      UPDATE app.workflow_tags SET key=v_key,revision=revision+1
        WHERE workspace_id=v_workspace AND id=p_tag_id RETURNING * INTO v_tag;
      v_result:=jsonb_build_object('tag',jsonb_build_object('id',v_tag.id,'key',v_tag.key,'revision',v_tag.revision));
    ELSE
      SELECT coalesce(array_agg(workflow_id ORDER BY workflow_id),ARRAY[]::uuid[]) INTO v_workflows
        FROM (SELECT workflow_id FROM app.workflow_tag_assignments
          WHERE workspace_id=v_workspace AND tag_id=p_tag_id ORDER BY workflow_id LIMIT 51) bounded;
      IF cardinality(v_workflows)>50 THEN
        RAISE EXCEPTION 'tag deletion requires bounded cleanup' USING ERRCODE='P7007'; END IF;
      -- Every workflow lock is later than the coordinator/tag/51-row preflight.
      PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=ANY(v_workflows) ORDER BY id FOR UPDATE;
      FOREACH v_workflow IN ARRAY v_workflows LOOP
        SELECT revision INTO v_revision FROM app.workflow_organization_state
          WHERE workspace_id=v_workspace AND workflow_id=v_workflow;
        IF v_revision=9007199254740991 THEN
          RAISE EXCEPTION 'organization revision exhausted' USING ERRCODE='P7008'; END IF;
        INSERT INTO app.workflow_organization_state(workspace_id,workflow_id,revision) VALUES(v_workspace,v_workflow,2)
          ON CONFLICT(workspace_id,workflow_id) DO UPDATE SET revision=app.workflow_organization_state.revision+1;
      END LOOP;
      DELETE FROM app.workflow_tag_assignments WHERE workspace_id=v_workspace AND tag_id=p_tag_id;
      DELETE FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=p_tag_id;
      v_result:=jsonb_build_object('tagId',p_tag_id,'deleted',true,'detachedWorkflowCount',cardinality(v_workflows));
    END IF;
  END IF;
  PERFORM app.record_workflow_organization_audit('workflow.'||p_operation,
    CASE WHEN p_operation='tag.create' THEN v_tag.id ELSE p_tag_id END,
    CASE WHEN p_operation='tag.delete' THEN jsonb_build_object('detachedWorkflowCount',cardinality(v_workflows))
      ELSE jsonb_build_object('revision',v_tag.revision) END);
  PERFORM app.complete_workflow_organization_command(p_operation,v_target,p_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $_$;

CREATE FUNCTION app.execute_workspace_tenant_rows_page(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) RETURNS TABLE(surface character varying, affected_count integer, completed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE; v_step app.workspace_purge_steps%ROWTYPE;
  v_count integer:=0; v_table text;
BEGIN
  IF p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid purge page' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge job missing' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_step FROM app.workspace_purge_steps WHERE job_id=p_job_id AND step_name='tenant_rows' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running'
    OR v_step.lease_token IS DISTINCT FROM p_lease_token OR v_step.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_step.lease_expires_at IS NULL OR v_step.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'purge lease stale' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_job.workspace_id AND status='purging'
    AND retention_control_sequence=p_projected_sequence AND retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge high water changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_job.workspace_id AND released_sequence IS NULL) THEN
    RAISE EXCEPTION 'legal hold blocks purge' USING ERRCODE='55000'; END IF;
  FOREACH v_table IN ARRAY ARRAY['workflow_favorite_receipts','workflow_favorite_held_evidence',
    'workflow_favorites','workflow_organization_receipts','workflow_tag_assignments',
    'workflow_organization_state','workflow_folders'] LOOP
    IF v_table='workflow_folders' THEN
      WITH candidates AS (SELECT f.ctid FROM app.workflow_folders f WHERE f.workspace_id=v_job.workspace_id
        AND NOT EXISTS(SELECT 1 FROM app.workflow_folders child WHERE child.workspace_id=f.workspace_id AND child.parent_id=f.id)
        ORDER BY f.id LIMIT p_page_size FOR UPDATE)
      DELETE FROM app.workflow_folders f USING candidates c WHERE f.ctid=c.ctid;
    ELSE
      EXECUTE format('WITH candidates AS(SELECT ctid FROM app.%I WHERE workspace_id=$1 LIMIT $2 FOR UPDATE)
        DELETE FROM app.%I r USING candidates c WHERE r.ctid=c.ctid',v_table,v_table)
        USING v_job.workspace_id,p_page_size;
    END IF;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN
      PERFORM set_config('app.workspace_purge_transition','on',true);
      UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
        lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE job_id=p_job_id AND step_name='tenant_rows';
      RETURN QUERY SELECT v_table::varchar,v_count,false; RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT * FROM app.execute_workspace_tenant_rows_page_before_folders(
    p_job_id,p_lease_token,p_lease_fence,p_page_size,p_projected_sequence,p_projected_hash);
END $_$;

CREATE FUNCTION app.execute_workspace_tenant_rows_page_before_folders(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) RETURNS TABLE(surface character varying, affected_count integer, completed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE; v_step app.workspace_purge_steps%ROWTYPE;
  v_count integer:=0; v_table text;
BEGIN
  IF p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid purge page' USING ERRCODE='22023'; END IF;
  -- The canonical purge coordinator owns the existing destructive SESSION lock
  -- before this transaction. Never reacquire it here on another connection.
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge job missing' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_step FROM app.workspace_purge_steps WHERE job_id=p_job_id AND step_name='tenant_rows' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running'
    OR v_step.lease_token IS DISTINCT FROM p_lease_token OR v_step.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_step.lease_expires_at IS NULL OR v_step.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'purge lease stale' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_job.workspace_id AND status='purging'
    AND retention_control_sequence=p_projected_sequence AND retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge high water changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_job.workspace_id AND released_sequence IS NULL) THEN
    RAISE EXCEPTION 'legal hold blocks purge' USING ERRCODE='55000'; END IF;
  -- Exactly one confined relation/page per call; no caller-chosen relation and
  -- no FK cascade bypass of the shared page budget or current hold check.
  FOREACH v_table IN ARRAY ARRAY['workflow_favorite_receipts','workflow_favorite_held_evidence',
    'workflow_favorites','workflow_organization_receipts','workflow_tag_assignments',
    'workflow_organization_state','workflow_tags','workflow_favorite_membership_generations',
    'workflow_organization_coordination'] LOOP
    EXECUTE format('WITH candidates AS(SELECT ctid FROM app.%I WHERE workspace_id=$1 LIMIT $2 FOR UPDATE)
      DELETE FROM app.%I r USING candidates c WHERE r.ctid=c.ctid',v_table,v_table)
      USING v_job.workspace_id,p_page_size;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN
      PERFORM set_config('app.workspace_purge_transition','on',true);
      UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
        lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE job_id=p_job_id AND step_name='tenant_rows';
      RETURN QUERY SELECT v_table::varchar,v_count,false; RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT * FROM app.execute_workspace_tenant_rows_page_before_organization(
    p_job_id,p_lease_token,p_lease_fence,p_page_size,p_projected_sequence,p_projected_hash);
END $_$;

CREATE FUNCTION app.execute_workspace_tenant_rows_page_before_input_cases(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) RETURNS TABLE(surface character varying, affected_count integer, completed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE
  v_job app.workspace_purge_jobs%ROWTYPE;
  v_step app.workspace_purge_steps%ROWTYPE;
  v_workspace_id uuid;
  v_surface text;
  v_count integer:=0;
  v_table text;
  v_invitation_claim_scan record;
  v_tables constant text[]:=ARRAY[
    'operator_maintenance_rerun_requests',
    'webhook_trigger_replay_records','webhook_trigger_deliveries',
    'run_failure_notification_audit_facts','run_failure_notification_intents',
    'workflow_run_active_admissions','connection_health_observations', 'node_attempt_connection_dispatches', 'node_attempts','node_runs','run_events',
    'run_checkpoints','artifact_links','preview_attempts',
    'webhook_endpoint_ingress_limits','trigger_schedule_occurrences',
    'trigger_schedules','webhook_trigger_endpoints','webhook_trigger_secret_versions',
    'workflow_triggers','workflow_failure_notification_policies',
    'workspace_inbox_reads', 'workspace_inbox_threads', 'workspace_inbox_events', 'workflow_concurrency_policies', 'workflow_concurrency_command_receipts', 'workflow_auto_pause_command_receipts', 'workflow_trigger_pause_periods', 'workflow_failure_streaks', 'workflow_trigger_outcomes', 'workflow_manual_start_rejections','workflow_runs','workflow_integration_usage','workflow_drafts',
    'connection_events','artifacts','outbox_events','inbox_receipts','idempotency_records',
    'retention_batches','retention_schedule_state','workspace_execution_entitlements',
    'workspace_execution_entitlement_versions','workspace_execution_admission_counters',
    'workspace_lifecycle_operations','workspace_invitation_acceptance_intents', 'workspace_invitation_delivery_attempts', 'workspace_invitation_command_receipts', 'workspace_invitations', 'workspace_rename_command_receipts', 'workspace_member_departure_command_receipts', 'workspace_member_suspension_command_receipts', 'workspace_ownership_transfer_command_receipts', 'workspace_member_removal_command_receipts', 'workspace_member_role_command_receipts', 'workspace_memberships','rls_probe_records'
  ];
  v_preserved constant text[]:=ARRAY[
    'workspaces','workspace_purge_jobs','workspace_control_ledger_projection',
    'workspace_legal_holds','retention_control_audit_facts','audit_events','usage_events',
    'transport_security_audit_facts',
    'workspace_invitation_claim_cleanup_cursors'
  ];
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1
    OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 500
    OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace tenant-row purge page' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO v_step FROM app.workspace_purge_steps
    WHERE job_id=p_job_id AND step_name='tenant_rows' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running'
    OR v_step.lease_token IS DISTINCT FROM p_lease_token
    OR v_step.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_step.lease_expires_at IS NULL
    OR v_step.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace tenant-row purge lease is stale' USING ERRCODE='55000';
  END IF;
  v_workspace_id:=v_job.workspace_id;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_workspace_id
    AND workspace.status='purging'
    AND workspace.retention_control_sequence=p_projected_sequence
    AND workspace.retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace tenant-row purge high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks tenant-row purge page'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_delete_token',p_lease_token::text,true);
  SET CONSTRAINTS ALL DEFERRED;

  -- Remove mutable pointers before their immutable rows. These updates are
  -- bounded independently and contain no retained fact material.
  WITH candidates AS (SELECT ctid FROM app.node_runs WHERE workspace_id=v_workspace_id
      AND current_attempt_id IS NOT NULL ORDER BY id LIMIT p_page_size FOR UPDATE)
  UPDATE app.node_runs row
    SET current_attempt_id=NULL,current_attempt_number=NULL FROM candidates
    WHERE row.ctid=candidates.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN v_surface:='node_run_current_attempts'; END IF;

  -- Audit and metering facts survive only as non-sensitive aggregate evidence.
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.audit_events WHERE workspace_id=v_workspace_id
        AND (actor_user_id IS NOT NULL OR request_id IS NOT NULL OR trace_id IS NOT NULL OR metadata<>'{}'::jsonb
          OR target_id IS DISTINCT FROM v_workspace_id) ORDER BY occurred_at,id LIMIT p_page_size FOR UPDATE)
    UPDATE app.audit_events row SET actor_user_id=NULL,request_id=NULL,trace_id=NULL,metadata='{}'::jsonb,
      target_id=v_workspace_id FROM candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='audit_events_minimized'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.usage_events WHERE workspace_id=v_workspace_id
        AND (metadata<>'{}'::jsonb OR resource_id<>v_workspace_id
          OR resource_type<>'workspace-tombstone' OR idempotency_key<>id::text)
        ORDER BY occurred_at,id LIMIT p_page_size FOR UPDATE)
    UPDATE app.usage_events row SET metadata='{}'::jsonb,resource_id=v_workspace_id,
      resource_type='workspace-tombstone',idempotency_key=id::text
      FROM candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='usage_events_minimized'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.transport_security_audit_facts
        WHERE workspace_id=v_workspace_id
          AND (consumer_name<>'purged' OR message_id<>id)
        ORDER BY occurred_at,id LIMIT p_page_size FOR UPDATE)
    UPDATE app.transport_security_audit_facts row SET consumer_name='purged',message_id=id
      FROM candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='transport_security_audit_facts_minimized'; END IF;
  END IF;

  -- Creation idempotency uses resource_id rather than workspace_id.
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.workspace_creation_idempotency_records
        WHERE resource_id=v_workspace_id ORDER BY id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.workspace_creation_idempotency_records row USING candidates
      WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='workspace_creation_idempotency_records'; END IF;
  END IF;

  IF v_count=0 THEN
    SELECT * INTO v_invitation_claim_scan
      FROM app.scan_workspace_invitation_replacement_claims(
        'workspace_purge',p_job_id,v_workspace_id,p_page_size);
    v_count:=v_invitation_claim_scan.deleted_count;
    IF v_count>0 THEN
      v_surface:='workspace_invitation_binding_replacement_claims';
    ELSIF v_invitation_claim_scan.scanned_count>0
      AND NOT v_invitation_claim_scan.cycle_completed THEN
      PERFORM set_config('app.workspace_purge_transition','on',true);
      UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,
        lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
        updated_at=clock_timestamp()
        WHERE job_id=p_job_id AND step_name='tenant_rows';
      RETURN QUERY SELECT 'workspace_invitation_binding_replacement_claim_scan'::varchar,
        v_invitation_claim_scan.scanned_count,false;
      RETURN;
    END IF;
  END IF;

  IF v_count=0 THEN
    FOREACH v_table IN ARRAY v_tables LOOP
      IF to_regclass('app.'||v_table) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('WITH candidates AS (SELECT ctid FROM app.%I WHERE workspace_id=$1 ORDER BY ctid LIMIT $2 FOR UPDATE) DELETE FROM app.%I row USING candidates WHERE row.ctid=candidates.ctid',v_table,v_table)
        USING v_workspace_id,p_page_size;
      GET DIAGNOSTICS v_count=ROW_COUNT;
      IF v_count>0 THEN v_surface:=v_table; EXIT; END IF;
    END LOOP;
  END IF;

  -- Self-referencing previews are removed from leaves toward roots.
  IF v_count=0 THEN
    WITH candidates AS (SELECT preview.ctid FROM app.preview_runs preview
        WHERE preview.workspace_id=v_workspace_id AND NOT EXISTS (
          SELECT 1 FROM app.preview_runs child
          WHERE child.workspace_id=v_workspace_id AND child.prior_preview_run_id=preview.id)
        ORDER BY preview.id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.preview_runs row USING candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='preview_runs'; END IF;
  END IF;

  -- Workflow publication FKs are immediate in both directions. Clear the
  -- mutable parent pointer before deleting version children on later pages.
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.workflows
        WHERE workspace_id=v_workspace_id AND published_version_id IS NOT NULL
        ORDER BY id LIMIT p_page_size FOR UPDATE)
    UPDATE app.workflows row SET published_version_id=NULL
      FROM candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='workflow_published_versions'; END IF;
  END IF;

  -- Deferred current-version relationships are deleted as bounded units after
  -- all external references and non-current versions have gone.
  IF v_count=0 THEN
    WITH candidates AS (SELECT version.ctid FROM app.workflow_versions version
        JOIN app.workflows workflow ON workflow.id=version.workflow_id
        WHERE version.workspace_id=v_workspace_id
          AND version.id IS DISTINCT FROM workflow.published_version_id
        ORDER BY version.id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.workflow_versions row USING candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='workflow_versions'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT workflow.ctid FROM app.workflows workflow
        WHERE workflow.workspace_id=v_workspace_id
          AND workflow.published_version_id IS NULL
        ORDER BY workflow.id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.workflows row USING candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='unpublished_workflows'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT version.ctid FROM app.connection_secret_versions version
        JOIN app.connections connection ON connection.id=version.connection_id
        WHERE version.workspace_id=v_workspace_id
          AND version.id<>connection.current_secret_version_id
        ORDER BY version.id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.connection_secret_versions row USING candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='connection_secret_versions'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT connection.id,connection.current_secret_version_id
        FROM app.connections connection WHERE connection.workspace_id=v_workspace_id
        ORDER BY connection.id LIMIT greatest(1,p_page_size/2) FOR UPDATE),
      deleted_versions AS (
        DELETE FROM app.connection_secret_versions version USING candidates
        WHERE version.id=candidates.current_secret_version_id
        RETURNING version.connection_id
      )
    DELETE FROM app.connections connection USING candidates
      WHERE connection.id=candidates.id
        AND EXISTS (SELECT 1 FROM deleted_versions
          WHERE deleted_versions.connection_id=connection.id);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='connections_with_current_secrets'; v_count:=v_count*2; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT version.ctid
        FROM app.failure_notification_destination_versions version
        JOIN app.failure_notification_destinations destination
          ON destination.id=version.destination_id
        WHERE version.workspace_id=v_workspace_id
          AND version.version<>destination.current_config_version
        ORDER BY version.destination_id,version.version LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.failure_notification_destination_versions row USING candidates
      WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='failure_notification_destination_versions'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT destination.id,destination.current_config_version
        FROM app.failure_notification_destinations destination
        WHERE destination.workspace_id=v_workspace_id
        ORDER BY destination.id LIMIT greatest(1,p_page_size/2) FOR UPDATE),
      deleted_versions AS (
        DELETE FROM app.failure_notification_destination_versions version
        USING candidates WHERE version.destination_id=candidates.id
          AND version.version=candidates.current_config_version
        RETURNING version.destination_id
      )
    DELETE FROM app.failure_notification_destinations destination
      USING candidates WHERE destination.id=candidates.id
        AND EXISTS (SELECT 1 FROM deleted_versions
          WHERE deleted_versions.destination_id=destination.id);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='destinations_with_current_versions'; v_count:=v_count*2; END IF;
  END IF;

  PERFORM set_config('app.workspace_purge_transition','on',true);
  IF v_count>0 THEN
    UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
      lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE job_id=p_job_id AND step_name='tenant_rows';
    RETURN QUERY SELECT v_surface::varchar,v_count,false;
    RETURN;
  END IF;

  -- Fail closed when a new persisted tenant surface was not explicitly added
  -- to the dependency order above. Preserved facts are separately minimized.
  FOR v_table IN
    SELECT table_record.table_name FROM information_schema.columns table_record
    WHERE table_record.table_schema='app' AND table_record.column_name='workspace_id'
      AND table_record.table_name<>ALL(v_preserved)
    GROUP BY table_record.table_name ORDER BY table_record.table_name
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM app.%I WHERE workspace_id=$1)',v_table)
      INTO completed USING v_workspace_id;
    IF completed THEN
      RAISE EXCEPTION 'workspace tenant-row purge has residual rows in %',v_table
        USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM app.workspace_creation_idempotency_records
      WHERE resource_id=v_workspace_id) THEN
    RAISE EXCEPTION 'workspace tenant-row purge has residual workspace creation rows'
      USING ERRCODE='55000';
  END IF;
  DELETE FROM app.workspace_invitation_claim_cleanup_cursors
    WHERE scan_kind='workspace_purge' AND scan_id=p_job_id;
  UPDATE app.workspace_purge_steps SET status='completed',lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),
    completed_at=clock_timestamp() WHERE job_id=p_job_id AND step_name='tenant_rows';
  RETURN QUERY SELECT 'tenant_rows'::varchar,0,true;
END $_$;

CREATE FUNCTION app.execute_workspace_tenant_rows_page_before_organization(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) RETURNS TABLE(surface character varying, affected_count integer, completed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE; v_step app.workspace_purge_steps%ROWTYPE; v_count integer:=0; v_surface varchar;
BEGIN
  IF p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid purge page'; END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge job missing' USING ERRCODE='55000'; END IF;
  -- The existing purge coordinator holds the destruction SESSION lock on a
  -- dedicated client before opening this transaction. Reacquiring it here on
  -- another client would self-deadlock; preserve that maintenance contract.
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO v_step FROM app.workspace_purge_steps WHERE job_id=p_job_id AND step_name='tenant_rows' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running' OR v_step.lease_token IS DISTINCT FROM p_lease_token OR v_step.lease_fence IS DISTINCT FROM p_lease_fence OR v_step.lease_expires_at IS NULL OR v_step.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'purge lease stale' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_job.workspace_id AND status='purging' AND retention_control_sequence=p_projected_sequence AND retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge high water changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_job.workspace_id AND released_sequence IS NULL) THEN RAISE EXCEPTION 'legal hold blocks purge' USING ERRCODE='55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workflow-input-case-quota:'||v_job.workspace_id::text,0));
  WITH candidates AS(SELECT ctid FROM app.workflow_input_case_receipts WHERE workspace_id=v_job.workspace_id LIMIT least(p_page_size,100) FOR UPDATE)
  DELETE FROM app.workflow_input_case_receipts r USING candidates c WHERE r.ctid=c.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT; v_surface:='workflow_input_case_receipts';
  IF v_count=0 THEN
    WITH candidates AS(SELECT case_id,revision,canonical_bytes FROM app.workflow_input_case_payloads WHERE workspace_id=v_job.workspace_id ORDER BY case_id,revision LIMIT least(p_page_size,100) FOR UPDATE),bounded AS(SELECT *,sum(canonical_bytes) OVER(ORDER BY case_id,revision) bytes FROM candidates)
    DELETE FROM app.workflow_input_case_payloads p USING bounded b WHERE p.workspace_id=v_job.workspace_id AND p.case_id=b.case_id AND p.revision=b.revision AND b.bytes<=1048576;
    GET DIAGNOSTICS v_count=ROW_COUNT; v_surface:='workflow_input_case_payloads';
  END IF;
  IF v_count=0 THEN
    WITH candidates AS(SELECT id FROM app.workflow_input_cases WHERE workspace_id=v_job.workspace_id ORDER BY id LIMIT least(p_page_size,100) FOR UPDATE)
    DELETE FROM app.workflow_input_cases c USING candidates x WHERE c.workspace_id=v_job.workspace_id AND c.id=x.id;
    GET DIAGNOSTICS v_count=ROW_COUNT; v_surface:='workflow_input_cases';
  END IF;
  IF v_count>0 THEN
    PERFORM set_config('app.workspace_purge_transition','on',true);
    UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
      lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE job_id=p_job_id AND step_name='tenant_rows';
    RETURN QUERY SELECT v_surface,v_count,false; RETURN;
  END IF;
  RETURN QUERY SELECT * FROM app.execute_workspace_tenant_rows_page_before_input_cases(p_job_id,p_lease_token,p_lease_fence,p_page_size,p_projected_sequence,p_projected_hash);
END $$;

CREATE FUNCTION app.expire_workspace_inbox_threads(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'inbox expiry limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  WITH expired AS MATERIALIZED (
    SELECT thread.workspace_id,thread.workflow_id
      FROM app.workspace_inbox_threads thread
     WHERE thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
       AND NOT EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
         WHERE hold.workspace_id=thread.workspace_id AND hold.released_sequence IS NULL)
     ORDER BY thread.latest_occurred_at,thread.workspace_id,thread.workflow_id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.workspace_inbox_threads thread USING expired
   WHERE thread.workspace_id=expired.workspace_id
     AND thread.workflow_id=expired.workflow_id;
  GET DIAGNOSTICS v_removed=ROW_COUNT;
  RETURN v_removed;
END $$;

CREATE FUNCTION app.fail_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_safe_error_code character varying) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE
  v_prior_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  IF p_safe_error_code IS NULL OR
    p_safe_error_code!~'^[a-z][a-z0-9_.-]{0,63}$' THEN
    RAISE EXCEPTION 'run replay failure code is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  UPDATE app.operator_run_replay_requests SET
    status='failed',safe_error_code=p_safe_error_code,completed_at=clock_timestamp()
  WHERE command_id=p_command_id AND workspace_id=p_workspace_id AND status='pending';
  IF FOUND THEN
    UPDATE app.operator_commands SET
      status='failed',outcome='replay_failed',completed_at=clock_timestamp(),
      result=result||jsonb_build_object(
        'outcome','replay_failed','safeErrorCode',p_safe_error_code
      )
    WHERE id=p_command_id AND status='pending';
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $_$;

CREATE FUNCTION app.fail_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace_id uuid;
BEGIN
  UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
    lease_expires_at=NULL,health_status='degraded',last_error_code='schedule.scan_failed',
    updated_at=clock_timestamp() WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token
    RETURNING workspace_id INTO v_workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.workflow_triggers SET health_status='degraded',last_error_code='schedule.scan_failed',
    updated_at=clock_timestamp() WHERE id=p_trigger_id AND workspace_id=v_workspace_id;
  RETURN true;
END $$;

CREATE FUNCTION app.fail_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint, p_error_code character varying) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_updated integer;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 OR p_error_code IS NULL
    OR p_error_code!~'^[a-z][a-z0-9_.:-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle failure' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  UPDATE app.workspace_lifecycle_operations SET status='failed',
    error_code=p_error_code,lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),
    completed_at=clock_timestamp()
  WHERE id=p_operation_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN v_updated=1;
END $_$;

CREATE FUNCTION app.find_due_preview_cleanup(p_limit integer) RETURNS TABLE(workspace_id uuid, preview_run_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid preview cleanup discovery limit' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    SELECT preview.workspace_id,preview.id
    FROM app.preview_runs preview
    WHERE preview.expires_at<=clock_timestamp()
      AND preview.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
      AND NOT EXISTS (
        SELECT 1 FROM app.preview_runs child
        WHERE child.workspace_id=preview.workspace_id
          AND child.prior_preview_run_id=preview.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.workspace_legal_holds hold
        WHERE hold.workspace_id=preview.workspace_id AND hold.released_at IS NULL
      )
    ORDER BY preview.expires_at,preview.id LIMIT p_limit;
END $$;

CREATE FUNCTION app.find_due_run_artifact_retention(p_limit integer) RETURNS TABLE(workspace_id uuid, artifact_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid run artifact retention discovery limit'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT artifact.workspace_id,artifact.id
  FROM app.artifacts artifact
  WHERE (
      (artifact.status='pending' AND artifact.purpose='user-upload'
        AND artifact.expires_at<=clock_timestamp())
      OR (artifact.status='available' AND artifact.expires_at<=clock_timestamp())
      OR artifact.status='deleting'
    )
    AND (artifact.retention_retry_at IS NULL
      OR artifact.retention_retry_at<=clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=artifact.workspace_id
        AND link.artifact_id=artifact.id)
  ORDER BY artifact.expires_at,artifact.id LIMIT p_limit;
END $$;

CREATE FUNCTION app.find_due_workspace_purge() RETURNS TABLE(workspace_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  SELECT workspace.id FROM app.workspaces workspace
  LEFT JOIN app.workspace_purge_jobs job ON job.workspace_id=workspace.id
  WHERE (workspace.status='pending_deletion' AND workspace.purge_after<=clock_timestamp()
      AND job.id IS NULL)
    OR (job.status='ready' OR (job.status='running' AND job.lease_expires_at<=clock_timestamp()))
  ORDER BY coalesce(job.created_at,workspace.purge_after),workspace.id LIMIT 1
$$;

CREATE FUNCTION app.find_due_workspace_purge_completion() RETURNS TABLE(job_id uuid, workspace_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  SELECT job.id,job.workspace_id FROM app.workspace_purge_jobs job
  LEFT JOIN app.workspace_purge_completions completion ON completion.job_id=job.id
  WHERE job.status='purging'
    AND EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=job.id AND step.step_name='object_versions'
        AND step.status='completed')
    AND EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=job.id AND step.step_name='tenant_rows'
        AND step.status='completed')
    AND NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=job.id AND step.status<>'completed')
    AND (completion.job_id IS NULL OR completion.status='ready'
      OR (completion.status='running' AND completion.lease_expires_at<=clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=job.workspace_id AND hold.released_sequence IS NULL)
  ORDER BY coalesce(completion.updated_at,job.updated_at),job.id LIMIT 1
$$;

CREATE FUNCTION app.find_due_workspace_purge_step() RETURNS TABLE(job_id uuid, workspace_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  SELECT job.id,job.workspace_id FROM app.workspace_purge_jobs job
  JOIN app.workspace_purge_steps step ON step.job_id=job.id
  WHERE job.status='purging' AND (step.status='pending'
      OR (step.status='running' AND step.lease_expires_at<=clock_timestamp()))
    AND (step.step_name='object_versions' OR (step.step_name='tenant_rows' AND EXISTS (
      SELECT 1 FROM app.workspace_purge_steps object_step
      WHERE object_step.job_id=job.id AND object_step.step_name='object_versions'
        AND object_step.status='completed')))
    AND NOT EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=job.workspace_id AND hold.released_sequence IS NULL)
  ORDER BY CASE step.step_name WHEN 'object_versions' THEN 0 ELSE 1 END,
    step.updated_at,job.id LIMIT 1
$$;

CREATE FUNCTION app.finish_preview_cleanup(p_workspace_id uuid, p_preview_run_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_preview app.preview_runs%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_preview_run_id IS NULL
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid preview cleanup completion' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=p_workspace_id
      AND workspace.retention_control_sequence=p_expected_control_sequence
      AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preview control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_preview FROM app.preview_runs preview
    WHERE preview.workspace_id=p_workspace_id AND preview.id=p_preview_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN true; END IF;
  IF v_preview.expires_at>clock_timestamp()
    OR v_preview.status NOT IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
    OR EXISTS (SELECT 1 FROM app.preview_runs child
      WHERE child.workspace_id=p_workspace_id AND child.prior_preview_run_id=p_preview_run_id)
    OR EXISTS (SELECT 1 FROM app.artifact_links link JOIN app.artifacts artifact
      ON artifact.workspace_id=link.workspace_id AND artifact.id=link.artifact_id
      WHERE link.workspace_id=p_workspace_id AND link.owner_kind='preview_run'
        AND link.owner_id=p_preview_run_id AND artifact.status<>'deleted') THEN
    RETURN false;
  END IF;
  WITH removed_links AS (
    DELETE FROM app.artifact_links WHERE workspace_id=p_workspace_id
      AND owner_kind='preview_run' AND owner_id=p_preview_run_id RETURNING artifact_id
  ) DELETE FROM app.artifacts artifact USING removed_links
    WHERE artifact.workspace_id=p_workspace_id AND artifact.id=removed_links.artifact_id
      AND artifact.status='deleted';
  DELETE FROM app.preview_attempts WHERE workspace_id=p_workspace_id
    AND preview_run_id=p_preview_run_id;
  DELETE FROM app.idempotency_records WHERE workspace_id=p_workspace_id
    AND operation='preview.execute' AND resource_id=p_preview_run_id
    AND expires_at<=clock_timestamp();
  DELETE FROM app.preview_runs WHERE workspace_id=p_workspace_id AND id=p_preview_run_id;
  RETURN true;
END $_$;

CREATE FUNCTION app.fold_workflow_trigger_outcomes(p_limit integer, p_enforce boolean) RETURNS TABLE(workspace_id uuid, workflow_id uuid, consecutive_failures integer, paused boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.fold_workspace_inbox_events(p_limit integer) RETURNS TABLE(workspace_id uuid, revision bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'inbox fold limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH picked AS MATERIALIZED (
    SELECT event.id,event.workspace_id,event.workflow_id,event.run_id,
           event.kind,event.occurred_at
      FROM app.workspace_inbox_events event
     ORDER BY event.created_at,event.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), grouped AS (
    SELECT picked.workspace_id,picked.workflow_id,count(*) AS occurrences,
           min(picked.occurred_at) AS first_at,max(picked.occurred_at) AS latest_at,
           (array_agg(picked.run_id ORDER BY picked.occurred_at DESC,picked.id DESC))[1] AS latest_run,
           (array_agg(picked.kind ORDER BY picked.occurred_at DESC,picked.id DESC))[1] AS latest_kind
      FROM picked JOIN app.workspaces workspace ON workspace.id=picked.workspace_id
     WHERE workspace.status IN ('active','suspended','pending_deletion')
     GROUP BY picked.workspace_id,picked.workflow_id
  ), folded AS (
    INSERT INTO app.workspace_inbox_threads AS thread (
      workspace_id,workflow_id,revision,occurrence_count,first_occurred_at,
      latest_occurred_at,latest_run_id,latest_kind)
    SELECT grouped.workspace_id,grouped.workflow_id,
           nextval('app.workspace_inbox_revision_seq'),grouped.occurrences,
           grouped.first_at,grouped.latest_at,grouped.latest_run,grouped.latest_kind
      FROM grouped ORDER BY grouped.workspace_id,grouped.workflow_id
    ON CONFLICT ON CONSTRAINT workspace_inbox_threads_pkey DO UPDATE SET
      revision=excluded.revision,
      occurrence_count=CASE
        WHEN thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
        THEN excluded.occurrence_count
        ELSE thread.occurrence_count+excluded.occurrence_count END,
      first_occurred_at=CASE
        WHEN thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
        THEN excluded.first_occurred_at
        ELSE least(thread.first_occurred_at,excluded.first_occurred_at) END,
      latest_occurred_at=greatest(thread.latest_occurred_at,excluded.latest_occurred_at),
      latest_run_id=CASE WHEN excluded.latest_occurred_at>=thread.latest_occurred_at
        THEN excluded.latest_run_id ELSE thread.latest_run_id END,
      latest_kind=CASE WHEN excluded.latest_occurred_at>=thread.latest_occurred_at
        THEN excluded.latest_kind ELSE thread.latest_kind END,
      updated_at=clock_timestamp()
    RETURNING thread.workspace_id,thread.revision
  ), consumed AS (
    DELETE FROM app.workspace_inbox_events event USING picked
     WHERE event.id=picked.id
  )
  SELECT folded.workspace_id,max(folded.revision)::bigint
    FROM folded GROUP BY folded.workspace_id;
END $$;

CREATE FUNCTION app.get_operator_command(p_command_id uuid, p_workspace_id uuid, p_actor_ref character varying, p_reason character varying) RETURNS TABLE(command_id uuid, command_type character varying, dry_run boolean, request_fingerprint character, command_status character varying, command_outcome character varying, result jsonb, created_at timestamp with time zone, completed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $_$
DECLARE
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_found boolean;
BEGIN
  IF p_actor_ref IS NULL OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' THEN
    RAISE EXCEPTION 'operator actor reference is invalid' USING ERRCODE='22023';
  END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'operator reason is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT EXISTS(
    SELECT 1 FROM app.operator_commands command
    WHERE command.id=p_command_id AND EXISTS(
      SELECT 1 FROM app.audit_events audit
      WHERE audit.workspace_id=p_workspace_id
        AND audit.request_id=p_command_id::text
        AND audit.action LIKE 'operator.%'
        AND audit.action<>'operator.command_status'
        AND NOT (audit.metadata?'replayed')
    )
  ) INTO v_found;
  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.command_status','operator-command',
    p_command_id,gen_random_uuid()::text,jsonb_build_object(
      'actorRef',p_actor_ref,'found',v_found,'reason',p_reason
    )
  );
  RETURN QUERY SELECT command.id,command.command_type,command.dry_run,
    command.request_fingerprint,command.status,command.outcome,command.result,
    command.created_at,command.completed_at
    FROM app.operator_commands command
    WHERE command.id=p_command_id AND v_found;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END;
$_$;

CREATE FUNCTION app.guard_curated_template_descriptor() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'selection_enabled') IS DISTINCT FROM (to_jsonb(OLD)-'selection_enabled') THEN
    RAISE EXCEPTION 'curated descriptor content is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.guard_preview_artifact_destruction() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pertexo_internal', 'pg_temp'
    AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status IN ('deleting','deleted')
    AND EXISTS (
      SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=OLD.workspace_id AND link.artifact_id=OLD.id
        AND link.owner_kind='preview_run'
    ) AND NOT EXISTS (
      SELECT 1 FROM pertexo_internal.preview_retention_transition_capabilities capability
      WHERE capability.transaction_id=pg_current_xact_id()
        AND capability.workspace_id=OLD.workspace_id
        AND capability.artifact_id=OLD.id
        AND capability.target_status=NEW.status
    ) THEN
    RAISE EXCEPTION 'preview artifact destruction requires maintenance authority'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.guard_workflow_input_case_write() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_actor uuid; v_workflow uuid; v_count bigint; v_bytes bigint; v_depth integer; v_members bigint;
BEGIN
  -- Compatible writers set this transaction marker only after authority,
  -- command-key, workflow and quota locks. Reject raw UPDATE before waiting
  -- for those locks: PostgreSQL has already acquired its target row lock.
  IF TG_TABLE_NAME='workflow_input_case_payloads' THEN
    SELECT workflow_id INTO v_workflow FROM app.workflow_input_cases WHERE workspace_id=NEW.workspace_id AND id=NEW.case_id AND deleted_at IS NULL;
  ELSE v_workflow:=NEW.workflow_id; END IF;
  IF nullif(current_setting('app.workflow_input_case_writer',true),'') IS DISTINCT FROM NEW.workspace_id::text||':'||v_workflow::text THEN
    RAISE EXCEPTION 'case writer protocol required' USING ERRCODE='55000'; END IF;
  PERFORM app.assert_workflow_input_cases_enabled();
  IF NEW.workspace_id::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'case workspace mismatch' USING ERRCODE='42501'; END IF;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  PERFORM 1 FROM app.workspaces WHERE id=NEW.workspace_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case workspace inactive' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.users WHERE id=v_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case actor inactive' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=v_actor
    AND status='active' AND role IN ('owner','admin','builder') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case author inactive' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workflows WHERE workspace_id=NEW.workspace_id AND id=v_workflow AND lifecycle_status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case workflow inactive' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workflow-input-case-quota:'||NEW.workspace_id::text,0));
  IF TG_TABLE_NAME='workflow_input_cases' THEN
    IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.workflow_id<>OLD.workflow_id
      OR NEW.workflow_version_id<>OLD.workflow_version_id OR NEW.version_checksum<>OLD.version_checksum
      OR OLD.deleted_at IS NOT NULL OR NEW.revision<>OLD.revision+1) THEN
      RAISE EXCEPTION 'case immutable context or revision invalid' USING ERRCODE='23514'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.revision<>1 OR NEW.deleted_at IS NOT NULL OR length(btrim(NEW.name)) NOT BETWEEN 1 AND 128 THEN
        RAISE EXCEPTION 'case initial representation invalid' USING ERRCODE='23514'; END IF;
      SELECT count(*) INTO v_count FROM app.workflow_input_cases WHERE workspace_id=NEW.workspace_id AND deleted_at IS NULL;
      IF v_count>=200 THEN RAISE EXCEPTION 'workspace case count limit' USING ERRCODE='23514'; END IF;
      SELECT count(*) INTO v_count FROM app.workflow_input_cases WHERE workspace_id=NEW.workspace_id AND workflow_id=NEW.workflow_id AND deleted_at IS NULL;
      IF v_count>=20 THEN RAISE EXCEPTION 'workflow case count limit' USING ERRCODE='23514'; END IF;
      PERFORM 1 FROM app.workflow_versions WHERE workspace_id=NEW.workspace_id AND workflow_id=NEW.workflow_id
        AND id=NEW.workflow_version_id AND checksum=NEW.version_checksum;
      IF NOT FOUND THEN RAISE EXCEPTION 'case version mismatch' USING ERRCODE='23514'; END IF;
    END IF;
    v_workflow:=NEW.workflow_id;
  ELSIF TG_TABLE_NAME='workflow_input_case_payloads' THEN
    IF NEW.canonical_bytes NOT BETWEEN 1 AND 65536 OR octet_length(NEW.input)<>NEW.canonical_bytes THEN
      RAISE EXCEPTION 'case canonical byte charge invalid' USING ERRCODE='23514'; END IF;
    SELECT workflow_id INTO v_workflow FROM app.workflow_input_cases WHERE workspace_id=NEW.workspace_id AND id=NEW.case_id AND deleted_at IS NULL;
    SELECT coalesce(sum(canonical_bytes),0) INTO v_bytes FROM app.workflow_input_case_payloads WHERE workspace_id=NEW.workspace_id;
    IF v_bytes+NEW.canonical_bytes>4194304 THEN RAISE EXCEPTION 'retained case byte limit' USING ERRCODE='23514'; END IF;
    WITH RECURSIVE nodes(value,depth) AS (
      SELECT NEW.input::jsonb,0 UNION ALL
      SELECT child.value,parent.depth+1 FROM nodes parent CROSS JOIN LATERAL (
        SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.value)='array' THEN parent.value ELSE '[]'::jsonb END)
        UNION ALL SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(parent.value)='object' THEN parent.value ELSE '{}'::jsonb END)
      ) child WHERE parent.depth<=64
    ) SELECT max(depth+CASE WHEN jsonb_typeof(value) IN ('object','array') THEN 1 ELSE 0 END),count(*)-1 INTO v_depth,v_members FROM nodes;
    IF v_depth>64 OR v_members>10000 THEN RAISE EXCEPTION 'case JSON structure limit' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.actor_id<>v_actor THEN RAISE EXCEPTION 'case receipt actor mismatch' USING ERRCODE='42501'; END IF;
    v_workflow:=NEW.workflow_id;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.inspect_auth_email_proof(p_digest bytea) RETURNS TABLE(purpose text, new_email text, display_name text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  SELECT proof.purpose::text,proof.new_email::text,users.display_name::text
    FROM app.auth_email_proofs proof
    JOIN app.users users ON users.id=proof.user_id
   WHERE proof.token_digest=p_digest
     AND proof.consumed_at IS NULL
     AND proof.expires_at>clock_timestamp()
     AND users.status='active'
     AND lower(users.email)=lower(proof.email)
   LIMIT 1;
$$;

CREATE FUNCTION app.invalidate_workflow_favorite_membership() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NEW.status='removed' AND OLD.status IS DISTINCT FROM 'removed' THEN
    INSERT INTO app.workflow_favorite_membership_generations(workspace_id,actor_id,generation,retired_at)
      VALUES(NEW.workspace_id,NEW.user_id,uuidv7(),clock_timestamp())
      ON CONFLICT(workspace_id,actor_id) DO UPDATE SET generation=EXCLUDED.generation,retired_at=EXCLUDED.retired_at;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.issue_auth_email_proof(p_id uuid, p_digest bytea, p_user_id uuid, p_purpose text, p_email text, p_new_email text, p_expires_at timestamp with time zone, p_mail_id uuid, p_mail_purpose text, p_mail_expires_at timestamp with time zone, p_ciphertext text, p_nonce text, p_tag text, p_key_version text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_user app.users%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_user_id IS NULL OR octet_length(p_digest)<>32
     OR p_purpose NOT IN ('initial_verification','change_old')
     OR p_email IS NULL OR length(p_email)>320
     OR p_expires_at<=clock_timestamp()
     OR p_expires_at>clock_timestamp()+interval '1 hour'
     OR (p_purpose='initial_verification' AND p_new_email IS NOT NULL)
     OR (p_purpose='change_old' AND
         (p_new_email IS NULL OR length(p_new_email)>320
          OR lower(p_new_email)=lower(p_email)))
     OR ((p_mail_id IS NULL) IS DISTINCT FROM (p_ciphertext IS NULL))
     OR (p_mail_id IS NOT NULL AND p_mail_purpose<>
         CASE WHEN p_purpose='change_old' THEN 'email_change_confirmation'
              ELSE 'verification' END) THEN
    RAISE EXCEPTION 'invalid email proof issuance' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_user FROM app.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.status<>'active'
     OR lower(v_user.email)<>lower(p_email)
     OR (p_purpose='initial_verification' AND v_user.email_verified)
     OR (p_purpose='change_old' AND NOT v_user.email_verified) THEN
    RETURN false;
  END IF;
  INSERT INTO app.auth_email_proofs
    (id,token_digest,user_id,purpose,email,new_email,expires_at)
  VALUES (p_id,p_digest,p_user_id,p_purpose,p_email,p_new_email,p_expires_at);
  IF p_mail_id IS NOT NULL THEN
    PERFORM app.enqueue_authentication_mail(
      p_mail_id,p_mail_purpose,p_mail_expires_at,
      p_ciphertext,p_nonce,p_tag,p_key_version);
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION app.jsonb_references_artifact(p_value jsonb, p_artifact_id uuid) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
  SELECT coalesce(EXISTS (
    SELECT 1 FROM jsonb_path_query(p_value,'lax $.**.artifactId') reference
    WHERE reference=to_jsonb(p_artifact_id::text)
  ),false)
$_$;

CREATE FUNCTION app.lock_curated_template_descriptor(p_id text, p_version integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_descriptor app.curated_template_descriptors%ROWTYPE;
  v_workspace uuid; v_actor uuid;
BEGIN
  IF p_id IS NULL OR octet_length(p_id) NOT BETWEEN 1 AND 64
    OR p_id !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR p_version IS NULL OR p_version<1 THEN
    RAISE EXCEPTION 'curated descriptor identity invalid' USING ERRCODE='22023';
  END IF;
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  IF NOT EXISTS(SELECT 1 FROM app.workspaces WHERE id=v_workspace AND status='active')
    OR NOT EXISTS(SELECT 1 FROM app.users WHERE id=v_actor AND status='active')
    OR NOT EXISTS(SELECT 1 FROM app.workspace_memberships WHERE workspace_id=v_workspace
      AND user_id=v_actor AND status='active' AND role IN ('owner','admin','builder')) THEN
    RAISE EXCEPTION 'workflow author is not active' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_descriptor FROM app.curated_template_descriptors
    WHERE template_id=p_id AND template_version=p_version FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('schemaVersion',v_descriptor.schema_version,
    'templateId',v_descriptor.template_id,'templateVersion',v_descriptor.template_version,
    'baseManifestDigest',v_descriptor.base_manifest_digest,'manifest',v_descriptor.base_manifest::jsonb,
    'setupTargets',v_descriptor.setup_targets,'supportedProfile',v_descriptor.supported_profile,
    'selectionEnabled',v_descriptor.selection_enabled);
END $_$;

CREATE FUNCTION app.lock_execution_artifact_references() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
END $_$;

CREATE FUNCTION app.lock_failure_notification_dispatch_destination(p_workspace_id uuid, p_intent_id uuid, p_attempt_number integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  workspace_active boolean := false;
  destination_enabled boolean := false;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid
       IS DISTINCT FROM p_workspace_id THEN
    RETURN false;
  END IF;
  SELECT true INTO workspace_active
    FROM app.workspaces workspace
   WHERE workspace.id=p_workspace_id AND workspace.status='active'
   FOR SHARE OF workspace;
  IF NOT coalesce(workspace_active,false) THEN RETURN false; END IF;
  SELECT destination.status='enabled' INTO destination_enabled
    FROM app.run_failure_notification_intents intent
    JOIN app.failure_notification_destinations destination
      ON destination.workspace_id=intent.workspace_id
     AND destination.id=intent.destination_id
   WHERE intent.workspace_id=p_workspace_id
     AND intent.id=p_intent_id
     AND intent.status='claimed'
     AND intent.delivery_attempts=p_attempt_number
   FOR SHARE OF destination;
  RETURN coalesce(destination_enabled,false);
END $$;

CREATE FUNCTION app.lock_manual_workflow_run_start(p_actor uuid, p_workflow uuid, p_scope text, p_key_hash text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
  IF v_workspace IS NULL OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')
    OR p_scope IS DISTINCT FROM 'workflow:'||p_workflow::text||':manual'
    OR p_key_hash IS NULL OR p_key_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'manual start context denied' USING ERRCODE='PT404';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual start authority denied' USING ERRCODE='PT404'; END IF;
  PERFORM 1 FROM app.users WHERE id=p_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual start authority denied' USING ERRCODE='PT404'; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=v_workspace AND user_id=p_actor
    AND status='active' AND role IN ('owner','admin','builder','operator') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual start authority denied' USING ERRCODE='PT404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'pertexo.manual-start.v1:'||v_workspace::text||':workflow.run.accept:'||p_scope||':'||p_key_hash,1934781131));
  PERFORM set_config('app.manual_start_writer',v_workspace::text||':'||p_workflow::text,true);
END $_$;

CREATE FUNCTION app.lock_notification_connection(p_workspace uuid, p_connection uuid) RETURNS TABLE(auth_type character varying, current_secret_version_id uuid, provider_key character varying, status character varying)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
  SELECT connection.auth_type,connection.current_secret_version_id,connection.provider_key,connection.status
  FROM app.connections connection
  WHERE connection.workspace_id=p_workspace AND connection.id=p_connection
    AND nullif(current_setting('app.workspace_id',true),'')::uuid=p_workspace
  FOR SHARE OF connection
$$;

CREATE FUNCTION app.lock_workflow_failure_notification_policy(p_workspace_id uuid, p_workflow_id uuid) RETURNS TABLE(destination_id uuid, current_config_version integer, destination_status character varying, kind character varying, side_effect_class character varying, connection_id uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
$_$;

CREATE FUNCTION app.lock_workflow_favorite_generation(p_update boolean) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_actor uuid; v_generation uuid;
BEGIN
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  INSERT INTO app.workflow_favorite_membership_generations(workspace_id,actor_id,generation)
    VALUES(v_workspace,v_actor,uuidv7()) ON CONFLICT(workspace_id,actor_id) DO NOTHING;
  IF p_update THEN
    SELECT generation INTO STRICT v_generation FROM app.workflow_favorite_membership_generations
      WHERE workspace_id=v_workspace AND actor_id=v_actor FOR UPDATE;
  ELSE
    SELECT generation INTO STRICT v_generation FROM app.workflow_favorite_membership_generations
      WHERE workspace_id=v_workspace AND actor_id=v_actor FOR SHARE;
  END IF;
  RETURN v_generation;
END $$;

CREATE FUNCTION app.lock_workflow_organization_authority(p_roles text[]) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_actor uuid;
BEGIN
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  IF v_workspace IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.users WHERE id=v_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=v_workspace AND user_id=v_actor
    AND status='active' AND role=ANY(p_roles) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  RETURN v_workspace;
END $$;

CREATE FUNCTION app.lock_workflow_organization_coordination(p_exclusive boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid;
BEGIN
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  IF v_workspace IS NULL OR p_exclusive IS NULL THEN
    RAISE EXCEPTION 'organization scope invalid' USING ERRCODE='22023'; END IF;
  INSERT INTO app.workflow_organization_coordination(workspace_id) VALUES(v_workspace)
    ON CONFLICT(workspace_id) DO NOTHING;
  IF p_exclusive THEN
    PERFORM 1 FROM app.workflow_organization_coordination WHERE workspace_id=v_workspace FOR UPDATE;
  ELSE
    PERFORM 1 FROM app.workflow_organization_coordination WHERE workspace_id=v_workspace FOR SHARE;
  END IF;
END $$;

CREATE FUNCTION app.lock_workflow_organization_for_lifecycle() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  PERFORM app.lock_workflow_organization_authority(ARRAY['owner','admin','builder']);
  PERFORM app.lock_workflow_organization_coordination(false);
END $$;

CREATE FUNCTION app.lock_workflow_portable_version(p_workspace uuid, p_workflow uuid, p_version uuid, p_actor uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_graph jsonb; v_workspace_status varchar;
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')
    OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workflow context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT app.lock_workspace_run_admission(p_workspace) INTO v_workspace_status;
  IF v_workspace_status IS DISTINCT FROM 'active' THEN RETURN NULL; END IF;
  PERFORM 1 FROM app.users WHERE id=p_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=p_workspace AND user_id=p_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM app.workflows WHERE workspace_id=p_workspace AND id=p_workflow AND lifecycle_status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT graph_json INTO v_graph FROM app.workflow_versions
    WHERE workspace_id=p_workspace AND workflow_id=p_workflow AND id=p_version FOR SHARE;
  RETURN v_graph;
END $$;

CREATE FUNCTION app.lock_workflow_run_replay_source(p_workspace_id uuid, p_source_run_id uuid) RETURNS TABLE(workflow_id uuid, lifecycle_status character varying)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_source_run_id IS NULL THEN
    RAISE EXCEPTION 'workflow replay source lock arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workflow replay workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT run.workflow_id, workflow.lifecycle_status
      FROM app.workflow_runs AS run
      JOIN app.workflows AS workflow
        ON workflow.workspace_id = run.workspace_id
       AND workflow.id = run.workflow_id
     WHERE run.workspace_id = p_workspace_id
       AND run.id = p_source_run_id
     FOR SHARE OF run, workflow;
END;
$$;

CREATE FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) RETURNS TABLE(id uuid, workspace_id uuid, workflow_id uuid, version_number integer, schema_version integer, checksum character varying, executable_schema_version integer, executable_json jsonb, compatibility_release_epoch integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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
           workflow_version.schema_version,
           workflow_version.checksum,
           workflow_version.executable_schema_version,
           workflow_version.executable_json,
           workflow_version.compatibility_release_epoch
      FROM app.workflow_versions AS workflow_version
     WHERE workflow_version.workspace_id = p_workspace_id
       AND workflow_version.workflow_id = p_workflow_id
       AND workflow_version.id = p_workflow_version_id
     FOR SHARE;
END;
$$;

CREATE FUNCTION app.lock_workspace_control_ledger(p_workspace_id uuid) RETURNS TABLE(retention_control_sequence bigint, retention_control_hash character)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace id is required' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
    SELECT workspace.retention_control_sequence, workspace.retention_control_hash
    FROM app.workspaces workspace
    WHERE workspace.id=p_workspace_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace does not exist' USING ERRCODE='23503';
  END IF;
END $$;

CREATE FUNCTION app.lock_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) RETURNS TABLE(workspace_id uuid, command_type character varying, actor_ref character varying, reason character varying, occurred_at timestamp with time zone, control_sequence bigint, control_hash character, append_authorized boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) RETURNS character varying
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  SELECT workspace.status
    FROM app.workspaces workspace
   WHERE workspace.id=p_workspace_id
   FOR SHARE
$$;

CREATE FUNCTION app.minimize_terminal_workspace_invitation_pii(p_limit integer DEFAULT 100) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_ids uuid[];
  v_count integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invitation PII minimization limit must be between 1 and 1000'
      USING ERRCODE='22023';
  END IF;

  SELECT array_agg(candidate.id ORDER BY candidate.terminal_at,candidate.id)
    INTO v_ids
    FROM (
      SELECT invitation.id,
             coalesce(invitation.accepted_at,invitation.revoked_at,invitation.updated_at) terminal_at
        FROM app.workspace_invitations invitation
       WHERE invitation.status IN ('accepted','revoked','expired')
         AND invitation.recipient_email NOT LIKE 'minimized+%@invalid.pertexo'
         AND coalesce(invitation.accepted_at,invitation.revoked_at,invitation.updated_at)
             <= clock_timestamp()-interval '90 days'
         AND NOT EXISTS (
           SELECT 1 FROM app.workspace_legal_holds hold
            WHERE hold.workspace_id=invitation.workspace_id
              AND hold.released_sequence IS NULL
         )
       ORDER BY terminal_at,invitation.id
       LIMIT p_limit
       FOR UPDATE OF invitation SKIP LOCKED
    ) candidate;

  IF v_ids IS NULL THEN RETURN 0; END IF;

  UPDATE app.workspace_invitation_acceptance_intents intent
     SET verified_user_id=NULL,verified_email=NULL,verified_at=NULL,
         updated_at=clock_timestamp()
   WHERE intent.invitation_id=ANY(v_ids)
     AND intent.verified_email IS NOT NULL;

  UPDATE app.workspace_invitation_command_receipts receipt
     SET result_ref=jsonb_set(
           receipt.result_ref,
           '{invitation,email}',
           to_jsonb(('minimized+'||(receipt.result_ref->'invitation'->>'id')||'@invalid.pertexo')::text),
           false
         ),
         updated_at=clock_timestamp()
   WHERE receipt.result_ref->'invitation' ? 'email'
     AND (receipt.result_ref->'invitation'->>'id')::uuid=ANY(v_ids);

  UPDATE app.workspace_invitations invitation
     SET recipient_email='minimized+'||invitation.id::text||'@invalid.pertexo',
         normalized_email='minimized+'||invitation.id::text||'@invalid.pertexo',
         updated_at=clock_timestamp()
   WHERE invitation.id=ANY(v_ids);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END $$;

CREATE FUNCTION app.populate_operator_command_result() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    AS $$
BEGIN
  IF NEW.result IS NULL AND NEW.command_type='outbox.redispatch' THEN
    NEW.result:=jsonb_build_object(
      'schemaVersion',1,
      'outcome',NEW.outcome,
      'priorErrorCode',NEW.prior_error_code,
      'priorFailedAt',NEW.prior_failed_at,
      'priorPublishAttempts',NEW.prior_publish_attempts
    );
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.prepare_preview_cleanup_step(p_workspace_id uuid, p_preview_run_id uuid, p_quiescence_seconds integer, p_expected_control_sequence bigint, p_expected_control_hash character) RETURNS TABLE(outcome character varying, artifact_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE
  v_artifact app.artifacts%ROWTYPE;
  v_preview app.preview_runs%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_preview_run_id IS NULL
    OR p_quiescence_seconds IS NULL OR p_quiescence_seconds NOT BETWEEN 1 AND 120
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid preview cleanup preparation' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=p_workspace_id
      AND workspace.retention_control_sequence=p_expected_control_sequence
      AND workspace.retention_control_hash=p_expected_control_hash
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preview control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    RETURN QUERY SELECT 'held'::varchar,NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO v_preview FROM app.preview_runs preview
    WHERE preview.workspace_id=p_workspace_id AND preview.id=p_preview_run_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'completed'::varchar,NULL::uuid;
    RETURN;
  END IF;
  IF v_preview.expires_at>clock_timestamp()
    OR v_preview.status NOT IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
    OR EXISTS (SELECT 1 FROM app.preview_runs child
      WHERE child.workspace_id=p_workspace_id
        AND child.prior_preview_run_id=p_preview_run_id) THEN
    RETURN QUERY SELECT 'blocked'::varchar,NULL::uuid;
    RETURN;
  END IF;
  SELECT artifact.* INTO v_artifact
    FROM app.artifact_links link JOIN app.artifacts artifact
      ON artifact.workspace_id=link.workspace_id AND artifact.id=link.artifact_id
    WHERE link.workspace_id=p_workspace_id AND link.owner_kind='preview_run'
      AND link.owner_id=p_preview_run_id AND artifact.status<>'deleted'
    ORDER BY artifact.id LIMIT 1 FOR UPDATE OF artifact;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'finish'::varchar,NULL::uuid;
    RETURN;
  END IF;
  IF v_artifact.status IN ('pending','available') THEN
    INSERT INTO pertexo_internal.preview_retention_transition_capabilities
      (transaction_id,workspace_id,artifact_id,target_status)
    VALUES (pg_current_xact_id(),p_workspace_id,v_artifact.id,'deleting');
    UPDATE app.artifacts SET status='deleting',updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace_id AND id=v_artifact.id;
    DELETE FROM pertexo_internal.preview_retention_transition_capabilities capability
      WHERE capability.transaction_id=pg_current_xact_id()
        AND capability.workspace_id=p_workspace_id
        AND capability.artifact_id=v_artifact.id
        AND capability.target_status='deleting';
    RETURN QUERY SELECT 'waiting'::varchar,NULL::uuid;
    RETURN;
  END IF;
  IF v_artifact.updated_at>clock_timestamp()
      -make_interval(secs=>p_quiescence_seconds) THEN
    RETURN QUERY SELECT 'waiting'::varchar,NULL::uuid;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'artifact'::varchar,v_artifact.id;
END $_$;

CREATE FUNCTION app.prepare_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) RETURNS character varying
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF v_artifact.status='pending' THEN
    IF v_artifact.purpose<>'user-upload'
      OR v_artifact.expires_at>clock_timestamp() THEN RETURN 'stale'; END IF;
  ELSIF v_artifact.status='available' THEN
    IF v_artifact.expires_at>clock_timestamp() THEN RETURN 'stale'; END IF;
  ELSIF v_artifact.status<>'deleting' THEN
    RETURN 'stale';
  ELSIF v_artifact.retention_retry_at IS NOT NULL
    AND v_artifact.retention_retry_at>clock_timestamp() THEN
    RETURN 'stale';
  END IF;
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
  UPDATE app.artifacts SET status='deleting',
    retention_retry_at=clock_timestamp()+interval '1 minute',
    updated_at=clock_timestamp() WHERE id=p_artifact_id;
  RETURN 'artifact';
END $_$;

CREATE FUNCTION app.prepare_workflow_favorite_command(p_workflow_id uuid, p_key_hash text, p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_workspace uuid; v_actor uuid; v_generation uuid; v_request jsonb;
  v_hash text; v_receipt app.workflow_favorite_receipts%ROWTYPE;
BEGIN
  IF p_workflow_id IS NULL OR p_key_hash IS NULL OR octet_length(p_key_hash)<>64
    OR p_key_hash COLLATE "C" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'favorite command identity invalid' USING ERRCODE='22023'; END IF;
  v_request:=app.workflow_favorite_command_body(p_body);
  v_workspace:=app.lock_workflow_organization_authority(ARRAY['owner','admin','builder','operator','viewer']);
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  v_generation:=app.lock_workflow_favorite_generation(true);
  -- A visibility read need not take a workflow lock before the coordinator.
  PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  v_hash:=encode(sha256(convert_to(v_request::text,'UTF8')),'hex');
  INSERT INTO app.workflow_favorite_receipts(workspace_id,actor_id,generation,workflow_id,key_hash,request_hash)
    VALUES(v_workspace,v_actor,v_generation,p_workflow_id,p_key_hash,v_hash)
    ON CONFLICT(workspace_id,actor_id,workflow_id,key_hash) DO NOTHING;
  SELECT * INTO STRICT v_receipt FROM app.workflow_favorite_receipts
    WHERE workspace_id=v_workspace AND actor_id=v_actor AND workflow_id=p_workflow_id AND key_hash=p_key_hash FOR UPDATE;
  IF v_receipt.generation<>v_generation THEN
    RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  IF v_receipt.request_hash<>v_hash THEN
    RAISE EXCEPTION 'favorite command identity conflict' USING ERRCODE='P7002'; END IF;
  IF v_receipt.result IS NOT NULL THEN
    PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('kind','replay','result',v_receipt.result||jsonb_build_object('replayed',true));
  END IF;
  RETURN jsonb_build_object('kind','new','generation',v_generation);
END $_$;

CREATE FUNCTION app.prepare_workspace_purge_completion(p_job_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) RETURNS TABLE(command_id uuid, actor_ref character varying, reason character varying, occurred_at timestamp with time zone, lease_token uuid, lease_fence bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_now timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
  IF p_job_id IS NULL OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$'
    OR p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace purge completion claim' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' THEN
    RAISE EXCEPTION 'workspace purge is not ready for completion' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_job.workspace_id
    AND workspace.status='purging'
    AND workspace.retention_control_sequence=p_projected_sequence
    AND workspace.retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace purge completion high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.status<>'completed')
    OR NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.step_name='object_versions' AND step.status='completed')
    OR NOT EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.step_name='tenant_rows' AND step.status='completed') THEN
    RAISE EXCEPTION 'workspace purge steps are incomplete' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_job.workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks purge completion'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  INSERT INTO app.workspace_purge_completions(job_id,command_id,occurred_at)
    VALUES (v_job.id,gen_random_uuid(),v_now) ON CONFLICT DO NOTHING;
  RETURN QUERY WITH claimed AS (
    UPDATE app.workspace_purge_completions completion SET status='running',
      attempt_count=completion.attempt_count+1,lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=completion.lease_fence+1,
      lease_acquired_at=v_now,lease_expires_at=v_now+p_lease_interval,updated_at=v_now
    WHERE completion.job_id=v_job.id AND (completion.status='ready'
      OR (completion.status='running' AND completion.lease_expires_at<=v_now))
    RETURNING completion.*
  ) SELECT claimed.command_id,claimed.actor_ref,claimed.reason,claimed.occurred_at,
      claimed.lease_token,claimed.lease_fence FROM claimed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace purge completion is not claimable' USING ERRCODE='55P03';
  END IF;
END $_$;

CREATE FUNCTION app.prepare_workspace_purge_job(p_workspace_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) RETURNS TABLE(job_id uuid, command_id uuid, actor_ref character varying, reason character varying, occurred_at timestamp with time zone, lease_token uuid, lease_fence bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_workspace app.workspaces%ROWTYPE;
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_now timestamptz:=date_trunc('milliseconds',clock_timestamp());
DECLARE v_existing boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_projected_sequence IS NULL OR p_projected_sequence<0
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$'
    OR p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace purge preparation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_workspace FROM app.workspaces WHERE id=p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_workspace.status<>'pending_deletion'
    OR v_workspace.purge_after>v_now THEN
    RAISE EXCEPTION 'workspace is not ready for purge' USING ERRCODE='55P03';
  END IF;
  IF v_workspace.retention_control_sequence<>p_projected_sequence
    OR v_workspace.retention_control_hash<>p_projected_hash THEN
    RAISE EXCEPTION 'workspace purge control high water changed' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs
    WHERE workspace_id=p_workspace_id FOR UPDATE;
  v_existing:=FOUND;
  IF NOT v_existing THEN
    PERFORM set_config('app.workspace_purge_transition','on',true);
    INSERT INTO app.workspace_purge_jobs
      (id,workspace_id,command_id,actor_ref,reason,occurred_at)
    VALUES (gen_random_uuid(),p_workspace_id,gen_random_uuid(),
      'maintenance:workspace-purge','Authoritative workspace purge started',v_now);
  ELSIF v_job.status NOT IN ('ready','running')
    OR (v_job.status='running' AND v_job.lease_expires_at>v_now) THEN
    RAISE EXCEPTION 'workspace purge job is not claimable' USING ERRCODE='55P03';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  RETURN QUERY WITH claimed AS (
    UPDATE app.workspace_purge_jobs job SET status='running',lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=job.lease_fence+1,lease_acquired_at=v_now,
      lease_expires_at=v_now+p_lease_interval,updated_at=v_now
    WHERE job.workspace_id=p_workspace_id RETURNING job.*
  ) SELECT claimed.id,claimed.command_id,claimed.actor_ref,claimed.reason,
      claimed.occurred_at,claimed.lease_token,claimed.lease_fence FROM claimed;
END $_$;

CREATE FUNCTION app.preserve_workspace_inbox_read_revision() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app'
    AS $$
BEGIN
  IF NEW.read_revision<OLD.read_revision THEN
    NEW.read_revision:=OLD.read_revision;
    NEW.read_at:=OLD.read_at;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.process_operator_maintenance_rerun() RETURNS TABLE(command_id uuid, workspace_id uuid, target_type character varying, target_id uuid, outcome character varying)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_request app.operator_maintenance_rerun_requests%ROWTYPE;
  v_outcome varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_status varchar(16);
  v_lease_expires_at timestamptz;
  v_hold boolean;
  v_dry_run boolean;
BEGIN
  SELECT * INTO v_request FROM app.operator_maintenance_rerun_requests request
  WHERE request.status='pending' ORDER BY request.created_at,request.command_id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM set_config('app.workspace_id',v_request.workspace_id::text,true);
  SELECT EXISTS(SELECT 1 FROM app.workspace_legal_holds hold
    WHERE hold.workspace_id=v_request.workspace_id AND hold.released_at IS NULL)
    INTO v_hold;
  IF v_request.target_type='retention_batch' THEN
    SELECT batch.status,batch.lease_expires_at,batch.dry_run
      INTO v_status,v_lease_expires_at,v_dry_run
    FROM app.retention_batches batch WHERE batch.id=v_request.target_id
      AND batch.workspace_id=v_request.workspace_id FOR UPDATE;
    v_outcome:=CASE
      WHEN NOT FOUND THEN 'not_found'
      WHEN v_status='completed' THEN 'already_completed'
      WHEN v_hold AND NOT v_dry_run THEN 'legal_hold'
      WHEN v_status='running' AND v_lease_expires_at>clock_timestamp()
        THEN 'lease_active'
      ELSE 'rerun_accepted' END;
  ELSE
    SELECT job.status,job.lease_expires_at INTO v_status,v_lease_expires_at
    FROM app.workspace_purge_jobs job WHERE job.id=v_request.target_id
      AND job.workspace_id=v_request.workspace_id FOR UPDATE;
    v_outcome:=CASE
      WHEN NOT FOUND THEN 'not_found'
      WHEN v_status='completed' THEN 'already_completed'
      WHEN v_hold THEN 'legal_hold'
      WHEN v_status='running' AND v_lease_expires_at>clock_timestamp()
        THEN 'lease_active'
      ELSE 'rerun_accepted' END;
  END IF;
  UPDATE app.operator_maintenance_rerun_requests request SET
    status='completed',outcome=v_outcome,completed_at=clock_timestamp()
  WHERE request.command_id=v_request.command_id AND request.status='pending';
  UPDATE app.operator_commands command SET
    status='completed',outcome=v_outcome,completed_at=clock_timestamp(),
    result=command.result||jsonb_build_object('outcome',v_outcome)
  WHERE command.id=v_request.command_id AND command.status='pending';
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT v_request.command_id,v_request.workspace_id,
    v_request.target_type,v_request.target_id,v_outcome;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.project_and_complete_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.project_workspace_deletion(p_workspace_id uuid, p_sequence bigint, p_command_id uuid, p_command_type character varying, p_subject_id uuid, p_previous_hash character, p_record_hash character, p_actor_ref character varying, p_legal_authority character varying, p_reason character varying, p_occurred_at timestamp with time zone, p_recovery_interval interval DEFAULT '30 days'::interval) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE
  v_workspace app.workspaces%ROWTYPE;
  v_existing app.workspace_control_ledger_projection%ROWTYPE;
  v_actor_ref varchar(128);
  v_actor_id uuid;
  v_reason varchar(512);
  v_latest_lifecycle_at timestamptz;
  v_purge_started_at timestamptz;
BEGIN
  IF p_workspace_id IS NULL OR p_sequence IS NULL OR p_sequence<1
    OR p_command_id IS NULL OR p_subject_id IS DISTINCT FROM p_workspace_id
    OR p_command_type NOT IN ('deletion_requested','deletion_restored','purge_started','deletion_completed')
    OR p_previous_hash IS NULL OR p_record_hash IS NULL
    OR p_previous_hash !~ '^[0-9a-f]{64}$' OR p_record_hash !~ '^[0-9a-f]{64}$'
    OR p_previous_hash=p_record_hash OR p_actor_ref IS NULL OR p_reason IS NULL
    OR length(btrim(p_actor_ref)) NOT BETWEEN 1 AND 128
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 512 OR p_occurred_at IS NULL
    OR p_legal_authority IS NOT NULL
    OR p_recovery_interval IS NULL OR p_recovery_interval<>interval '30 days' THEN
    RAISE EXCEPTION 'invalid retention control record' USING ERRCODE='22023';
  END IF;
  v_actor_ref := btrim(p_actor_ref);
  v_reason := btrim(p_reason);

  SELECT * INTO STRICT v_workspace FROM app.workspaces WHERE id=p_workspace_id FOR UPDATE;
  SELECT * INTO v_existing FROM app.workspace_control_ledger_projection
    WHERE workspace_id=p_workspace_id AND command_id=p_command_id;
  IF FOUND THEN
    IF v_existing.sequence=p_sequence AND v_existing.command_type=p_command_type
      AND v_existing.subject_id=p_subject_id AND v_existing.previous_hash=p_previous_hash
      AND v_existing.record_hash=p_record_hash AND v_existing.actor_ref=v_actor_ref
      AND v_existing.legal_authority IS NULL AND v_existing.reason=v_reason
      AND v_existing.occurred_at=p_occurred_at THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'retention control command replay conflicts with projection' USING ERRCODE='23505';
  END IF;
  IF p_sequence<>v_workspace.retention_control_sequence+1 THEN
    RAISE EXCEPTION 'retention control sequence mismatch' USING ERRCODE='40001';
  END IF;
  IF p_previous_hash<>v_workspace.retention_control_hash THEN
    RAISE EXCEPTION 'retention control previous hash mismatch' USING ERRCODE='40001';
  END IF;
  SELECT record.occurred_at INTO v_latest_lifecycle_at
  FROM app.workspace_control_ledger_projection record
  WHERE record.workspace_id=p_workspace_id
    AND record.command_type IN (
      'deletion_requested','deletion_restored','purge_started','deletion_completed'
    )
  ORDER BY record.sequence DESC LIMIT 1;
  IF v_latest_lifecycle_at IS NOT NULL AND p_occurred_at<v_latest_lifecycle_at THEN
    RAISE EXCEPTION 'workspace deletion lifecycle event predates its predecessor'
      USING ERRCODE='55000';
  END IF;

  IF p_command_type='deletion_requested' THEN
    IF v_workspace.status NOT IN ('active','suspended') THEN
      RAISE EXCEPTION 'workspace is not deletable' USING ERRCODE='55000';
    END IF;
    BEGIN
      v_actor_id := v_actor_ref::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'deletion request actor must be a user UUID' USING ERRCODE='22023';
    END;
    IF NOT EXISTS (SELECT 1 FROM app.users WHERE id=v_actor_id) THEN
      RAISE EXCEPTION 'deletion request actor does not exist' USING ERRCODE='23503';
    END IF;
  ELSIF p_command_type='deletion_restored' THEN
    IF v_workspace.status<>'pending_deletion'
      OR p_occurred_at<v_workspace.deletion_requested_at
      OR p_occurred_at>=v_workspace.purge_after THEN
      RAISE EXCEPTION 'workspace is not restorable' USING ERRCODE='55000';
    END IF;
  ELSIF p_command_type='purge_started' THEN
    IF v_workspace.status<>'pending_deletion' OR p_occurred_at<v_workspace.purge_after THEN
      RAISE EXCEPTION 'workspace is not ready for purge' USING ERRCODE='55000';
    END IF;
  ELSE
    IF v_workspace.status<>'purging' THEN
      RAISE EXCEPTION 'workspace purge is not in progress' USING ERRCODE='55000';
    END IF;
    SELECT record.occurred_at INTO v_purge_started_at
    FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=p_workspace_id AND record.command_type='purge_started'
    ORDER BY record.sequence DESC LIMIT 1;
    IF v_purge_started_at IS NULL OR p_occurred_at<v_purge_started_at THEN
      RAISE EXCEPTION 'deletion completion predates purge start' USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_sequence IS NULL
    ) THEN
      RAISE EXCEPTION 'active workspace legal hold blocks deletion completion' USING ERRCODE='55000';
    END IF;
  END IF;

  INSERT INTO app.workspace_control_ledger_projection
    (workspace_id,sequence,command_id,command_type,subject_id,previous_hash,record_hash,
     actor_ref,legal_authority,reason,occurred_at)
  VALUES (p_workspace_id,p_sequence,p_command_id,p_command_type,p_subject_id,p_previous_hash,
    p_record_hash,v_actor_ref,NULL,v_reason,p_occurred_at);
  INSERT INTO app.retention_control_audit_facts
    (id,workspace_id,command_id,fact_type,subject_id,control_sequence,
     control_record_hash,actor_ref,occurred_at)
  VALUES (gen_random_uuid(),p_workspace_id,p_command_id,p_command_type,p_subject_id,
    p_sequence,p_record_hash,v_actor_ref,p_occurred_at);

  PERFORM set_config('app.workspace_deletion_projection','on',true);
  UPDATE app.workspaces SET
    status=CASE p_command_type
      WHEN 'deletion_requested' THEN 'pending_deletion'
      WHEN 'deletion_restored' THEN 'suspended'
      WHEN 'purge_started' THEN 'purging'
      ELSE 'deleted' END,
    deletion_requested_at=CASE WHEN p_command_type='deletion_requested'
      THEN p_occurred_at WHEN p_command_type='deletion_restored' THEN NULL
      ELSE deletion_requested_at END,
    deletion_requested_by=CASE WHEN p_command_type='deletion_requested'
      THEN v_actor_id WHEN p_command_type='deletion_restored' THEN NULL
      ELSE deletion_requested_by END,
    deletion_reason=CASE WHEN p_command_type='deletion_requested'
      THEN v_reason WHEN p_command_type='deletion_restored' THEN NULL
      ELSE deletion_reason END,
    purge_after=CASE WHEN p_command_type='deletion_requested'
      THEN p_occurred_at+p_recovery_interval WHEN p_command_type='deletion_restored' THEN NULL
      ELSE purge_after END,
    retention_control_sequence=p_sequence,retention_control_hash=p_record_hash,
    updated_at=clock_timestamp()
  WHERE id=p_workspace_id;
  RETURN true;
END $_$;

CREATE FUNCTION app.project_workspace_purge_completion(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE;
DECLARE v_completion app.workspace_purge_completions%ROWTYPE;
DECLARE v_projected boolean;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_sequence IS NULL OR p_sequence<1 OR p_previous_hash IS NULL
    OR p_previous_hash!~'^[0-9a-f]{64}$' OR p_record_hash IS NULL
    OR p_record_hash!~'^[0-9a-f]{64}$' OR p_previous_hash=p_record_hash THEN
    RAISE EXCEPTION 'invalid workspace purge completion projection' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO v_completion FROM app.workspace_purge_completions
    WHERE job_id=p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.status<>'purging' OR v_completion.job_id IS NULL
    OR v_completion.status<>'running'
    OR v_completion.lease_token IS DISTINCT FROM p_lease_token
    OR v_completion.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_completion.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace purge completion lease is stale' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_purge_steps step
      WHERE step.job_id=v_job.id AND step.status<>'completed') THEN
    RAISE EXCEPTION 'workspace purge steps are incomplete' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_jobs SET status='completed',control_sequence=p_sequence,
    control_record_hash=p_record_hash,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=v_job.id;
  v_projected:=app.project_workspace_deletion(v_job.workspace_id,p_sequence,
    v_completion.command_id,'deletion_completed',v_job.workspace_id,p_previous_hash,
    p_record_hash,v_completion.actor_ref,NULL,v_completion.reason,
    v_completion.occurred_at,interval '30 days');
  UPDATE app.workspace_purge_completions SET status='projected',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    projected_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE job_id=v_job.id;
  RETURN v_projected;
END $_$;

CREATE FUNCTION app.project_workspace_purge_started(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.provision_retention_schedule_state() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  INSERT INTO app.retention_schedule_state(workspace_id,retention_kind)
  SELECT NEW.id,kind FROM (VALUES ('workflow_run_input'),('execution_detail'),
    ('run_summary'),('trigger_summary'),('audit_security')) kinds(kind)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE FUNCTION app.provision_workspace_execution_admission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  INSERT INTO app.workspace_execution_entitlement_versions (
    workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
  ) VALUES (NEW.id,1,'active',5,100,'-infinity'::timestamptz);
  INSERT INTO app.workspace_execution_entitlements(workspace_id,current_version)
    VALUES (NEW.id,1);
  INSERT INTO app.workspace_execution_admission_counters(workspace_id)
    VALUES (NEW.id);
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN NEW;
END $$;

CREATE FUNCTION app.prune_auth_email_evidence(p_limit integer) RETURNS TABLE(proofs_deleted integer, audit_deleted integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_proofs integer; v_audit integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid email evidence prune limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT id FROM app.auth_email_proofs
     WHERE expires_at<=clock_timestamp()-interval '30 days'
     ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.auth_email_proofs proof USING candidates
    WHERE proof.id=candidates.id;
  GET DIAGNOSTICS v_proofs=ROW_COUNT;
  WITH candidates AS (
    SELECT id FROM app.identity_security_audit_facts
     WHERE occurred_at<=clock_timestamp()-interval '365 days'
       AND (legal_hold_until IS NULL OR legal_hold_until<=clock_timestamp())
     ORDER BY occurred_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.identity_security_audit_facts audit USING candidates
    WHERE audit.id=candidates.id;
  GET DIAGNOSTICS v_audit=ROW_COUNT;
  RETURN QUERY SELECT v_proofs,v_audit;
END;
$$;

CREATE FUNCTION app.prune_auth_legacy_method_migration_attempts(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN
    RAISE EXCEPTION 'invalid legacy-migration cleanup limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT id FROM app.auth_legacy_method_migration_attempts
     WHERE expires_at<=clock_timestamp()-interval '30 days'
     ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.auth_legacy_method_migration_attempts attempt USING candidates
    WHERE attempt.id=candidates.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE FUNCTION app.prune_auth_method_link_attempts(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN
    RAISE EXCEPTION 'invalid link-attempt cleanup limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT id FROM app.auth_method_link_attempts
     WHERE expires_at<=clock_timestamp()-interval '30 days'
     ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.auth_method_link_attempts attempt USING candidates
    WHERE attempt.id=candidates.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE FUNCTION app.prune_authentication_mail(p_limit integer) RETURNS TABLE(expired integer, deleted integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_expired integer; v_deleted integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid authentication mail prune limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT id FROM app.authentication_mail_deliveries
     WHERE status IN ('queued','outcome_unknown','retry')
       AND (expires_at<=clock_timestamp()
            OR created_at+interval '24 hours'<=clock_timestamp()
            OR attempt_count>=12)
       AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
     ORDER BY created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE app.authentication_mail_deliveries delivery
     SET status=CASE WHEN delivery.expires_at<=clock_timestamp()
                     THEN 'expired' ELSE 'reconciliation_required' END,
         payload_ciphertext=NULL,payload_nonce=NULL,
         payload_tag=NULL,payload_key_version=NULL,lease_owner=NULL,
         lease_token=NULL,lease_expires_at=NULL,
         completed_at=clock_timestamp(),updated_at=clock_timestamp()
    FROM candidates WHERE delivery.id=candidates.id;
  GET DIAGNOSTICS v_expired=ROW_COUNT;
  WITH candidates AS (
    SELECT id FROM app.authentication_mail_deliveries
     WHERE status IN ('submitted','failed','reconciliation_required','expired')
       AND completed_at<=clock_timestamp()-interval '30 days'
     ORDER BY completed_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.authentication_mail_deliveries delivery
   USING candidates WHERE delivery.id=candidates.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  RETURN QUERY SELECT v_expired,v_deleted;
END;
$$;

CREATE FUNCTION app.prune_expired_auth_sessions(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>10000 THEN
    RAISE EXCEPTION 'invalid auth session prune limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT session.id
      FROM app.auth_sessions session
     WHERE session.expires_at<=clock_timestamp()-interval '30 days'
     ORDER BY session.expires_at,session.id
     LIMIT p_limit
     FOR UPDATE OF session SKIP LOCKED
  )
  DELETE FROM app.auth_sessions session
  USING candidates
  WHERE session.id=candidates.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE FUNCTION app.prune_manual_start_rejections(p_limit integer DEFAULT 100) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_count integer; v_total integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid manual receipt cleanup page' USING ERRCODE='22023';
  END IF;
  FOR v_workspace IN SELECT DISTINCT workspace_id FROM app.workflow_manual_start_rejections
    WHERE expires_at<=clock_timestamp() ORDER BY workspace_id LIMIT least(p_limit,100)
  LOOP
    -- Never wait for a destruction lock while already holding another tenant's rows.
    IF NOT pg_try_advisory_xact_lock(hashtextextended(v_workspace::text,1934781127)) THEN CONTINUE; END IF;
    PERFORM 1 FROM app.workspaces WHERE id=v_workspace FOR UPDATE;
    IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_workspace AND released_sequence IS NULL) THEN CONTINUE; END IF;
    WITH candidates AS (SELECT workspace_id,scope,key_hash FROM app.workflow_manual_start_rejections
      WHERE workspace_id=v_workspace AND expires_at<=clock_timestamp()
      ORDER BY expires_at,scope,key_hash LIMIT least(p_limit,100)-v_total FOR UPDATE SKIP LOCKED)
    DELETE FROM app.workflow_manual_start_rejections receipt USING candidates candidate
      WHERE (receipt.workspace_id,receipt.scope,receipt.key_hash)=(candidate.workspace_id,candidate.scope,candidate.key_hash);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
    IF v_total>=least(p_limit,100) THEN EXIT; END IF;
  END LOOP;
  RETURN v_total;
END $$;

CREATE FUNCTION app.read_workflow_favorite_generation() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_generation uuid;
BEGIN
  PERFORM app.lock_workflow_organization_authority(ARRAY['owner','admin','builder','operator','viewer']);
  v_generation:=app.lock_workflow_favorite_generation(false);
  RETURN jsonb_build_object('generation',v_generation,
    'readAtSeconds',floor(extract(epoch FROM clock_timestamp()))::bigint);
END $$;

CREATE FUNCTION app.read_workspace_lifecycle_operation(p_workspace_id uuid, p_operation_id uuid, p_actor_user_id uuid) RETURNS TABLE(operation_id uuid, workspace_id uuid, command_type character varying, status character varying, occurred_at timestamp with time zone, control_sequence bigint, control_record_hash character, error_code character varying, created_at timestamp with time zone, updated_at timestamp with time zone, completed_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id',true),'')
    OR p_actor_user_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workspace lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid workspace lifecycle operation lookup' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.users user_record
    JOIN app.workspace_memberships membership ON membership.user_id=user_record.id
    WHERE user_record.id=p_actor_user_id AND user_record.status='active'
      AND membership.workspace_id=p_workspace_id AND membership.status='active'
      AND membership.role='owner'
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT operation.id,operation.workspace_id,operation.command_type,
    operation.status,operation.occurred_at,operation.control_sequence,
    operation.control_record_hash,operation.error_code,operation.created_at,
    operation.updated_at,operation.completed_at
  FROM app.workspace_lifecycle_operations operation
  WHERE operation.workspace_id=p_workspace_id AND operation.id=p_operation_id;
END $$;

CREATE FUNCTION app.reap_transient_data(p_limit integer DEFAULT 100) RETURNS TABLE(idempotency_records_deleted integer, workspace_creation_records_deleted integer, sessions_deleted integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    AS $$
DECLARE
  v_idempotency_records_deleted integer;
  v_manual_start_rejections_deleted integer;
  v_workspace_creation_records_deleted integer;
  v_sessions_deleted integer;
BEGIN
  v_manual_start_rejections_deleted:=app.prune_manual_start_rejections(p_limit);
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
  v_idempotency_records_deleted:=v_idempotency_records_deleted+v_manual_start_rejections_deleted;
  WITH candidates AS (
    SELECT receipt.workspace_id,receipt.actor_id,receipt.workflow_id,receipt.key_hash
      FROM app.workflow_concurrency_command_receipts receipt WHERE receipt.result IS NOT NULL
        AND receipt.expires_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds hold
          WHERE hold.workspace_id=receipt.workspace_id AND hold.released_sequence IS NULL)
      ORDER BY receipt.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM app.workflow_concurrency_command_receipts receipt USING candidates
      WHERE receipt.workspace_id=candidates.workspace_id AND receipt.actor_id=candidates.actor_id
        AND receipt.workflow_id=candidates.workflow_id AND receipt.key_hash=candidates.key_hash RETURNING 1
  ) SELECT v_idempotency_records_deleted+count(*)::integer INTO v_idempotency_records_deleted FROM deleted;
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
  ) SELECT v_idempotency_records_deleted+count(*)::integer INTO v_idempotency_records_deleted FROM deleted;

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

CREATE FUNCTION app.reap_workflow_input_cases(p_limit integer DEFAULT 100) RETURNS TABLE(payloads_deleted integer, receipts_deleted integer, cases_deleted integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_payload integer:=0; v_receipts integer:=0; v_cases integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'case cleanup limit invalid' USING ERRCODE='22023'; END IF;
  SELECT workspace_id INTO v_workspace FROM (
    SELECT p.workspace_id FROM app.workflow_input_case_payloads p JOIN app.workflow_input_cases c ON c.workspace_id=p.workspace_id AND c.id=p.case_id WHERE c.deleted_at IS NOT NULL OR p.revision<c.revision
    UNION SELECT workspace_id FROM app.workflow_input_case_receipts WHERE expires_at<=clock_timestamp()
    UNION SELECT workspace_id FROM app.workflow_input_cases WHERE deleted_at IS NOT NULL
  ) candidate WHERE NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds hold WHERE hold.workspace_id=candidate.workspace_id AND hold.released_sequence IS NULL) ORDER BY workspace_id LIMIT 1;
  IF v_workspace IS NULL THEN RETURN QUERY SELECT 0,0,0; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_workspace::text,1934781127));
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_workspace AND released_sequence IS NULL) THEN RETURN QUERY SELECT 0,0,0; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workflow-input-case-quota:'||v_workspace::text,0));
  WITH candidates AS (
    SELECT p.case_id,p.revision,p.canonical_bytes FROM app.workflow_input_case_payloads p JOIN app.workflow_input_cases c ON c.workspace_id=p.workspace_id AND c.id=p.case_id
    WHERE p.workspace_id=v_workspace AND (c.deleted_at IS NOT NULL OR p.revision<c.revision) ORDER BY p.case_id,p.revision LIMIT p_limit FOR UPDATE OF p SKIP LOCKED
  ), bounded AS (SELECT *,sum(canonical_bytes) OVER(ORDER BY case_id,revision) bytes FROM candidates)
  DELETE FROM app.workflow_input_case_payloads p USING bounded b WHERE p.workspace_id=v_workspace AND p.case_id=b.case_id AND p.revision=b.revision AND b.bytes<=1048576;
  GET DIAGNOSTICS v_payload=ROW_COUNT;
  WITH candidates AS (SELECT ctid FROM app.workflow_input_case_receipts WHERE workspace_id=v_workspace AND expires_at<=clock_timestamp() LIMIT p_limit-v_payload FOR UPDATE SKIP LOCKED)
  DELETE FROM app.workflow_input_case_receipts r USING candidates c WHERE r.ctid=c.ctid;
  GET DIAGNOSTICS v_receipts=ROW_COUNT;
  WITH candidates AS (SELECT c.id FROM app.workflow_input_cases c WHERE c.workspace_id=v_workspace AND c.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.workflow_input_case_payloads p WHERE p.workspace_id=c.workspace_id AND p.case_id=c.id) ORDER BY c.id LIMIT p_limit-v_payload-v_receipts FOR UPDATE SKIP LOCKED)
  DELETE FROM app.workflow_input_cases c USING candidates x WHERE c.workspace_id=v_workspace AND c.id=x.id;
  GET DIAGNOSTICS v_cases=ROW_COUNT;
  RETURN QUERY SELECT v_payload,v_receipts,v_cases;
END $$;

CREATE FUNCTION app.reap_workflow_organization(p_limit integer DEFAULT 100) RETURNS TABLE(favorites_deleted integer, evidence_deleted integer, private_receipts_deleted integer, shared_receipts_deleted integer, generations_cleared integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace uuid; v_favorites integer:=0; v_evidence integer:=0;
  v_private integer:=0; v_shared integer:=0; v_generations integer:=0;
  v_retired_actor uuid; v_retired_generation uuid; v_expired integer:=0;
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'organization cleanup limit invalid' USING ERRCODE='22023'; END IF;
  SELECT workspace_id INTO v_workspace FROM (
    (SELECT f.workspace_id FROM app.workflow_favorites f WHERE NOT f.favorite AND f.expires_at<=v_now
      AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds h WHERE h.workspace_id=f.workspace_id AND h.released_sequence IS NULL)
      ORDER BY f.expires_at,f.workspace_id,f.actor_id,f.workflow_id LIMIT 1)
    UNION ALL
    (SELECT r.workspace_id FROM app.workflow_favorite_receipts r WHERE r.expires_at<=v_now
      AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds h WHERE h.workspace_id=r.workspace_id AND h.released_sequence IS NULL)
      ORDER BY r.expires_at,r.workspace_id LIMIT 1)
    UNION ALL
    (SELECT r.workspace_id FROM app.workflow_organization_receipts r WHERE r.expires_at<=v_now
      AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds h WHERE h.workspace_id=r.workspace_id AND h.released_sequence IS NULL)
      ORDER BY r.expires_at,r.workspace_id LIMIT 1)
    UNION ALL
    (SELECT g.workspace_id FROM app.workflow_favorite_membership_generations g WHERE g.retired_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds h WHERE h.workspace_id=g.workspace_id AND h.released_sequence IS NULL)
      ORDER BY g.retired_at,g.workspace_id,g.actor_id LIMIT 1)
  ) candidates ORDER BY workspace_id LIMIT 1;
  IF v_workspace IS NULL THEN RETURN QUERY SELECT 0,0,0,0,0; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_workspace::text,1934781127));
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_workspace AND released_sequence IS NULL) THEN
    RETURN QUERY SELECT 0,0,0,0,0; RETURN; END IF;
  v_now:=clock_timestamp();
  -- Expired false state is sought directly by the workspace/expiry index.
  -- Never filter every current true bookmark to discover a small expired batch.
  WITH candidates AS (
    SELECT ctid FROM app.workflow_favorites WHERE workspace_id=v_workspace
      AND NOT favorite AND expires_at<=v_now
    ORDER BY expires_at,actor_id,workflow_id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.workflow_favorites f USING candidates c WHERE f.ctid=c.ctid;
  GET DIAGNOSTICS v_expired=ROW_COUNT;
  v_favorites:=v_expired;
  -- One indexed retirement marker; generation range seeks exclude the entire
  -- current generation rather than testing every current bookmark with <>.
  SELECT actor_id,generation INTO v_retired_actor,v_retired_generation
    FROM app.workflow_favorite_membership_generations
    WHERE workspace_id=v_workspace AND retired_at IS NOT NULL
    ORDER BY retired_at,actor_id LIMIT 1 FOR UPDATE;
  IF v_retired_actor IS NOT NULL THEN
    WITH below AS MATERIALIZED (
      SELECT ctid FROM app.workflow_favorites WHERE workspace_id=v_workspace
        AND actor_id=v_retired_actor AND generation<v_retired_generation
        ORDER BY generation,workflow_id LIMIT p_limit-v_favorites
    ), above AS MATERIALIZED (
      SELECT ctid FROM app.workflow_favorites WHERE workspace_id=v_workspace
        AND actor_id=v_retired_actor AND generation>v_retired_generation
        ORDER BY generation,workflow_id LIMIT p_limit-v_favorites
    ), candidates AS (SELECT ctid FROM below UNION ALL SELECT ctid FROM above),
    bounded AS (SELECT f.ctid FROM app.workflow_favorites f JOIN candidates c ON f.ctid=c.ctid
      LIMIT p_limit-v_favorites FOR UPDATE OF f SKIP LOCKED)
    DELETE FROM app.workflow_favorites f USING bounded c WHERE f.ctid=c.ctid;
    GET DIAGNOSTICS v_expired=ROW_COUNT;
    v_favorites:=v_favorites+v_expired;
  END IF;
  WITH candidates AS (
    SELECT ctid FROM app.workflow_favorite_held_evidence WHERE workspace_id=v_workspace
      ORDER BY actor_id,workflow_id,generation LIMIT p_limit-v_favorites FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.workflow_favorite_held_evidence e USING candidates c WHERE e.ctid=c.ctid;
  GET DIAGNOSTICS v_evidence=ROW_COUNT;
  WITH candidates AS (
    SELECT ctid FROM app.workflow_favorite_receipts WHERE workspace_id=v_workspace AND expires_at<=v_now
    ORDER BY expires_at,actor_id,workflow_id,key_hash LIMIT p_limit-v_favorites-v_evidence FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.workflow_favorite_receipts r USING candidates c WHERE r.ctid=c.ctid;
  GET DIAGNOSTICS v_private=ROW_COUNT;
  WITH candidates AS (
    SELECT ctid FROM app.workflow_organization_receipts WHERE workspace_id=v_workspace AND expires_at<=v_now
      ORDER BY expires_at,actor_id,operation,target_id,key_hash LIMIT p_limit-v_favorites-v_evidence-v_private FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.workflow_organization_receipts r USING candidates c WHERE r.ctid=c.ctid;
  GET DIAGNOSTICS v_shared=ROW_COUNT;
  -- The marker tracks old state/evidence, not receipts. Unexpired private
  -- receipts retain their generation/key fence and own expiry index regardless
  -- of marker clearing; the current generation itself is never deleted/reset.
  IF v_retired_actor IS NOT NULL AND p_limit-v_favorites-v_evidence-v_private-v_shared>0
    AND NOT EXISTS(SELECT 1 FROM app.workflow_favorites WHERE workspace_id=v_workspace
      AND actor_id=v_retired_actor AND generation<v_retired_generation)
    AND NOT EXISTS(SELECT 1 FROM app.workflow_favorites WHERE workspace_id=v_workspace
      AND actor_id=v_retired_actor AND generation>v_retired_generation)
    AND NOT EXISTS(SELECT 1 FROM app.workflow_favorite_held_evidence WHERE workspace_id=v_workspace AND actor_id=v_retired_actor) THEN
    UPDATE app.workflow_favorite_membership_generations SET retired_at=NULL
      WHERE workspace_id=v_workspace AND actor_id=v_retired_actor;
    GET DIAGNOSTICS v_generations=ROW_COUNT;
  END IF;
  RETURN QUERY SELECT v_favorites,v_evidence,v_private,v_shared,v_generations;
END $$;

CREATE FUNCTION app.reap_workspace_invitation_transients(p_limit integer DEFAULT 100) RETURNS TABLE(invitations_expired integer, acceptance_intents_deleted integer, replacement_claims_deleted integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_candidate record;
  v_claim_scan record;
  v_expired integer:=0;
  v_deleted integer:=0;
  v_claims_deleted integer:=0;
  v_row_count integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invitation transient cleanup limit must be between 1 and 1000'
      USING ERRCODE='22023';
  END IF;

  FOR v_candidate IN
    SELECT invitation.workspace_id,invitation.id
      FROM app.workspace_invitations invitation
     WHERE invitation.status='pending' AND invitation.expires_at<=clock_timestamp()
     ORDER BY invitation.expires_at,invitation.id
     LIMIT p_limit
  LOOP
    PERFORM 1 FROM app.workspaces WHERE id=v_candidate.workspace_id FOR UPDATE;
    PERFORM 1 FROM app.workspace_invitations
      WHERE workspace_id=v_candidate.workspace_id AND id=v_candidate.id FOR UPDATE;
    UPDATE app.workspace_invitations
       SET status='expired',delivery_status='canceled',updated_at=clock_timestamp()
     WHERE workspace_id=v_candidate.workspace_id AND id=v_candidate.id
       AND status='pending' AND expires_at<=clock_timestamp();
    IF FOUND THEN
      v_expired:=v_expired+1;
      UPDATE app.workspace_invitation_delivery_attempts
         SET status=CASE WHEN status IN ('queued','failed') THEN 'canceled' ELSE status END,
             token_ciphertext=NULL,token_nonce=NULL,token_tag=NULL,
             token_key_version=NULL,updated_at=clock_timestamp()
       WHERE workspace_id=v_candidate.workspace_id
         AND invitation_id=v_candidate.id
         AND status IN ('queued','failed','unknown');
      UPDATE app.workspace_invitation_acceptance_intents
         SET status='superseded',updated_at=clock_timestamp()
       WHERE workspace_id=v_candidate.workspace_id
         AND invitation_id=v_candidate.id
         AND status IN ('pending','verified','wrong_account');
    END IF;
  END LOOP;

  FOR v_candidate IN
    SELECT intent.workspace_id,intent.invitation_id,intent.id
      FROM app.workspace_invitation_acceptance_intents intent
     WHERE (intent.expires_at<=clock_timestamp() OR intent.status='abandoned')
       AND NOT EXISTS (
         SELECT 1 FROM app.workspace_legal_holds hold
          WHERE hold.workspace_id=intent.workspace_id
            AND hold.released_sequence IS NULL
       )
     ORDER BY intent.expires_at,intent.id
     LIMIT p_limit
  LOOP
    PERFORM 1 FROM app.workspaces WHERE id=v_candidate.workspace_id FOR UPDATE;
    PERFORM 1 FROM app.workspace_invitations
      WHERE workspace_id=v_candidate.workspace_id AND id=v_candidate.invitation_id FOR UPDATE;
    DELETE FROM app.workspace_invitation_acceptance_intents
     WHERE workspace_id=v_candidate.workspace_id AND id=v_candidate.id
       AND (expires_at<=clock_timestamp() OR status='abandoned');
    GET DIAGNOSTICS v_row_count=ROW_COUNT;
    v_deleted:=v_deleted+v_row_count;
  END LOOP;

  SELECT * INTO v_claim_scan
    FROM app.scan_workspace_invitation_replacement_claims(
      'transient','00000000-0000-0000-0000-000000000000'::uuid,NULL,p_limit);
  v_claims_deleted:=v_claim_scan.deleted_count;

  invitations_expired:=v_expired;
  acceptance_intents_deleted:=v_deleted;
  replacement_claims_deleted:=v_claims_deleted;
  RETURN NEXT;
END $$;

CREATE FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
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
        AND old_event.schema_version=1 AND new_event.schema_version=1
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
END $$;

CREATE FUNCTION app.reconcile_operator_attempt(p_command_id uuid, p_workspace_id uuid, p_attempt_id uuid, p_expected_fence bigint, p_action character varying, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean, result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_command record;
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_updated integer;
BEGIN
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);

  SELECT * INTO v_command
  FROM app.execute_operator_execution_command(
    p_command_id,'attempt.reconcile',p_workspace_id,p_attempt_id,
    p_expected_fence,p_action,NULL,NULL,p_actor_ref,p_reason,p_dry_run
  );

  IF v_command.command_outcome='reclaimed' AND NOT v_command.replayed THEN
    UPDATE app.node_runs node
       SET status='ready',updated_at=clock_timestamp()
      FROM app.node_attempts attempt
     WHERE attempt.workspace_id=p_workspace_id
       AND attempt.id=p_attempt_id
       AND attempt.status='ready'
       AND node.workspace_id=attempt.workspace_id
       AND node.id=attempt.node_run_id
       AND node.current_attempt_id=attempt.id
       AND node.status='running';
    GET DIAGNOSTICS v_updated=ROW_COUNT;
    IF v_updated<>1 THEN
      RAISE EXCEPTION 'reclaimed attempt owning node state is invalid'
        USING ERRCODE='P0001';
    END IF;
  END IF;

  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT v_command.command_id,v_command.command_status,
    v_command.command_outcome,v_command.replayed,v_command.result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.reconcile_workspace_execution_admission(p_workspace_id uuid) RETURNS TABLE(queued_runs integer, active_runs integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters
   WHERE workspace_id=p_workspace_id FOR UPDATE;
  UPDATE app.workspace_execution_admission_counters counter
     SET queued_runs=(SELECT count(*)::integer FROM app.workflow_runs
                       WHERE workspace_id=p_workspace_id AND status='queued'),
         active_runs=(SELECT count(*)::integer FROM app.workflow_runs
                       WHERE workspace_id=p_workspace_id AND status IN ('running','waiting')),
         reconciled_at=clock_timestamp()
   WHERE counter.workspace_id=p_workspace_id
   RETURNING counter.queued_runs,counter.active_runs INTO queued_runs,active_runs;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  RETURN NEXT;
END $$;

CREATE FUNCTION app.record_identity_method_audit_fact(p_user_id uuid, p_event_type text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_user_id IS NULL OR p_event_type NOT IN
    ('method.linked','method.unlinked','legacy.method_migrated',
     'password.changed','password.configured','password.reset')
     OR NOT EXISTS (SELECT 1 FROM app.users WHERE id=p_user_id) THEN
    RAISE EXCEPTION 'invalid identity audit fact' USING ERRCODE='22023';
  END IF;
  INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
  VALUES (gen_random_uuid(),p_user_id,p_event_type);
END;
$$;

CREATE FUNCTION app.record_identity_profile_audit_fact(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM app.users WHERE id=p_user_id) THEN
    RAISE EXCEPTION 'invalid identity audit fact' USING ERRCODE='22023';
  END IF;
  INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
  VALUES (gen_random_uuid(),p_user_id,'profile.display_name_changed');
END;
$$;

CREATE FUNCTION app.record_node_attempt_connection_health(p_workspace uuid, p_attempt uuid, p_worker text, p_fence bigint, p_kind text, p_reason text, p_mode text, p_observation uuid, p_outbox uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace
    OR p_mode NOT IN ('observe','enforce') OR NOT EXISTS(
      SELECT 1 FROM app.node_attempts attempt JOIN app.node_attempt_connection_dispatches dispatch
        ON dispatch.workspace_id=attempt.workspace_id AND dispatch.attempt_id=attempt.id
      WHERE attempt.workspace_id=p_workspace AND attempt.id=p_attempt
        AND dispatch.worker_id=p_worker AND dispatch.fence_token=p_fence AND attempt.fence_token=p_fence
        AND attempt.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')) THEN
    RAISE EXCEPTION 'connection health lacks accepted dispatch completion' USING ERRCODE='PTH03';
  END IF;
  INSERT INTO app.connection_health_observations(id,workspace_id,attempt_id,kind,reason_code,production_mode,outbox_event_id)
    VALUES(p_observation,p_workspace,p_attempt,p_kind,p_reason,p_mode,p_outbox);
END $$;

CREATE FUNCTION app.record_operator_unknown_outcome_evidence(uuid, uuid, uuid, character varying, jsonb, character varying, character varying) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean, result jsonb)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    AS $_$
  SELECT * FROM app.execute_operator_execution_command($1,'unknown-outcome.record-evidence',$2,$3,NULL,NULL,$4,$5,$6,$7,false)
$_$;

CREATE FUNCTION app.record_workflow_organization_audit(p_action text, p_target uuid, p_metadata jsonb) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  INSERT INTO app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(uuidv7(),nullif(current_setting('app.workspace_id',true),'')::uuid,
    nullif(current_setting('app.actor_id',true),'')::uuid,p_action,'workflow_organization',p_target,p_metadata)
$$;

CREATE FUNCTION app.recover_due_run_failure_notifications(p_limit integer, p_max_attempts integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
        'schemaVersion',1,'workspaceId',candidate.workspace_id
      );
      INSERT INTO app.outbox_events (
        id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
        payload,payload_checksum
      ) VALUES (
        delivery_id,candidate.workspace_id,'deliver-run-failure-notification',1,
        'run-failure-notification',candidate.id,delivery_payload,
        encode(sha256(convert_to(
          '{"notificationIntentId":"' || candidate.id::text ||
          '","outboxEventId":"' || delivery_id::text ||
          '","schemaVersion":1,"workspaceId":"' ||
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
$$;

CREATE FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.redispatch_failed_outbox_event(p_command_id uuid, p_workspace_id uuid, p_outbox_event_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $_$
DECLARE
  v_existing app.operator_commands%ROWTYPE;
  v_fingerprint char(64);
  v_outbox app.outbox_events%ROWTYPE;
  v_outcome varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  IF p_actor_ref IS NULL OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' THEN
    RAISE EXCEPTION 'operator actor reference is invalid' USING ERRCODE='22023';
  END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'operator reason is invalid' USING ERRCODE='22023';
  END IF;

  v_fingerprint:=encode(sha256(convert_to(jsonb_build_object(
    'actorRef',p_actor_ref,
    'commandType','outbox.redispatch',
    'dryRun',p_dry_run,
    'outboxEventId',p_outbox_event_id,
    'reason',p_reason,
    'workspaceId',p_workspace_id
  )::text,'UTF8')),'hex');

  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_command_id::text,7166118813));
  SELECT * INTO v_existing FROM app.operator_commands WHERE id=p_command_id;
  IF FOUND THEN
    v_outcome:=CASE WHEN v_existing.request_fingerprint=v_fingerprint
      THEN v_existing.outcome ELSE 'conflict' END;
    INSERT INTO app.audit_events(
      id,workspace_id,action,target_type,target_id,request_id,metadata
    ) VALUES(
      gen_random_uuid(),p_workspace_id,'operator.outbox_redispatch',
      'outbox-event',p_outbox_event_id,p_command_id::text,
      jsonb_build_object(
        'actorRef',p_actor_ref,'dryRun',p_dry_run,'outcome',v_outcome,
        'reason',p_reason,'replayed',true,'requestFingerprint',v_fingerprint
      )
    );
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT v_existing.id,v_existing.status,v_outcome,true;
    RETURN;
  END IF;

  SELECT * INTO v_outbox FROM app.outbox_events
    WHERE id=p_outbox_event_id AND workspace_id=p_workspace_id FOR UPDATE;

  v_outcome:=CASE
    WHEN NOT FOUND THEN 'not_found'
    WHEN v_outbox.published_at IS NOT NULL THEN 'already_published'
    WHEN v_outbox.failed_at IS NULL THEN 'not_failed'
    WHEN p_dry_run THEN 'would_redispatch'
    ELSE 'redispatched'
  END;

  IF v_outcome='redispatched' THEN
    UPDATE app.outbox_events SET
      available_at=clock_timestamp(),
      lease_owner=NULL,
      lease_token=NULL,
      lease_expires_at=NULL,
      publish_attempts=0,
      failed_at=NULL,
      last_error_code=NULL,
      updated_at=clock_timestamp()
    WHERE id=p_outbox_event_id AND workspace_id=p_workspace_id;
  END IF;

  INSERT INTO app.operator_commands(
    id,command_type,dry_run,request_fingerprint,status,outcome,
    prior_publish_attempts,prior_failed_at,prior_error_code
  ) VALUES(
    p_command_id,'outbox.redispatch',p_dry_run,v_fingerprint,'completed',v_outcome,
    v_outbox.publish_attempts,v_outbox.failed_at,v_outbox.last_error_code
  );

  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.outbox_redispatch',
    'outbox-event',p_outbox_event_id,p_command_id::text,
    jsonb_build_object(
      'actorRef',p_actor_ref,
      'dryRun',p_dry_run,
      'outcome',v_outcome,
      'priorErrorCode',v_outbox.last_error_code,
      'priorFailedAt',v_outbox.failed_at,
      'priorPublishAttempts',v_outbox.publish_attempts,
      'reason',p_reason,
      'requestFingerprint',v_fingerprint
    )
  );

  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT p_command_id,'completed'::varchar,v_outcome,false;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $_$;

CREATE FUNCTION app.refresh_workflow_run_admission_counters() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NEW.status<>'queued' THEN
    DELETE FROM app.workflow_run_active_admissions
     WHERE workspace_id=NEW.workspace_id AND workflow_run_id=NEW.id;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
     SET queued_runs=(SELECT count(*)::integer FROM app.workflow_runs
                       WHERE workspace_id=NEW.workspace_id AND status='queued'),
         active_runs=(SELECT count(*)::integer FROM app.workflow_runs
                       WHERE workspace_id=NEW.workspace_id
                         AND status IN ('running','waiting')),
         reconciled_at=clock_timestamp()
   WHERE counter.workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.reject_connection_history_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app'
    AS $$
BEGIN
  IF TG_OP='DELETE' AND app.workspace_purge_immutable_delete_is_armed(OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'connection history is immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION app.reject_execution_entitlement_version_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP='DELETE' AND app.workspace_purge_immutable_delete_is_armed(OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'workspace execution entitlement versions are immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION app.reject_failure_notification_destination_version_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP='DELETE' AND app.workspace_purge_immutable_delete_is_armed(OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'failure notification destination versions are immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION app.reject_preview_run_pin_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(
    OLD.workspace_id, OLD.workflow_id, OLD.draft_revision,
    OLD.draft_fingerprint, OLD.node_id, OLD.definition_key,
    OLD.definition_version, OLD.executor_key, OLD.executor_version,
    OLD.compatibility_release_epoch, OLD.compatibility_release_fingerprint,
    OLD.actor_user_id, OLD.idempotency_key_hash, OLD.request_hash,
    OLD.request_id, OLD.trace_id, OLD.provider_key, OLD.operation_key,
    OLD.executable_node_json, OLD.input_ref,
    OLD.prior_preview_run_id, OLD.side_effect_class, OLD.may_contact_provider,
    OLD.may_cause_external_side_effect, OLD.dry_run, OLD.traceparent,
    OLD.created_at, OLD.execution_deadline_at, OLD.expires_at
  ) IS DISTINCT FROM ROW(
    NEW.workspace_id, NEW.workflow_id, NEW.draft_revision,
    NEW.draft_fingerprint, NEW.node_id, NEW.definition_key,
    NEW.definition_version, NEW.executor_key, NEW.executor_version,
    NEW.compatibility_release_epoch, NEW.compatibility_release_fingerprint,
    NEW.actor_user_id, NEW.idempotency_key_hash, NEW.request_hash,
    NEW.request_id, NEW.trace_id, NEW.provider_key, NEW.operation_key,
    NEW.executable_node_json, NEW.input_ref,
    NEW.prior_preview_run_id, NEW.side_effect_class, NEW.may_contact_provider,
    NEW.may_cause_external_side_effect, NEW.dry_run, NEW.traceparent,
    NEW.created_at, NEW.execution_deadline_at, NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'preview run identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_retention_batch_direct_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP='DELETE' AND app.workspace_purge_immutable_delete_is_armed(OLD.workspace_id) THEN RETURN OLD; END IF; IF TG_OP = 'DELETE' OR current_setting('app.retention_batch_transition', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'retention batches change only through maintenance functions' USING ERRCODE='55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.retention_kind <> OLD.retention_kind
    OR NEW.cutoff_at <> OLD.cutoff_at OR NEW.dry_run <> OLD.dry_run
    OR NEW.requested_by <> OLD.requested_by OR NEW.reason <> OLD.reason
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'retention batch identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.reject_retention_control_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION 'retention control facts are immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION app.reject_trigger_schedule_config_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF NEW.trigger_id<>OLD.trigger_id OR NEW.workspace_id<>OLD.workspace_id
    OR NEW.recurrence_kind<>OLD.recurrence_kind
    OR NEW.cron_expression IS DISTINCT FROM OLD.cron_expression
    OR NEW.timezone IS DISTINCT FROM OLD.timezone
    OR NEW.interval_minutes IS DISTINCT FROM OLD.interval_minutes
    OR NEW.misfire_policy<>OLD.misfire_policy
    OR NEW.config_fingerprint<>OLD.config_fingerprint OR NEW.anchor_at<>OLD.anchor_at THEN
    RAISE EXCEPTION 'trigger schedule configuration is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.reject_webhook_trigger_secret_version_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP='DELETE' AND app.workspace_purge_immutable_delete_is_armed(OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'webhook trigger secret versions are immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION app.reject_workflow_version_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP='DELETE' AND app.workspace_purge_immutable_delete_is_armed(OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'workflow versions are immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION app.reject_workspace_control_direct_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF current_setting('app.workspace_deletion_projection',true) IS DISTINCT FROM 'on'
    AND current_setting('app.retention_control_transition',true) IS DISTINCT FROM 'on'
    AND (NEW.retention_control_sequence IS DISTINCT FROM OLD.retention_control_sequence
      OR NEW.retention_control_hash IS DISTINCT FROM OLD.retention_control_hash) THEN
    RAISE EXCEPTION 'workspace control anchors change only through control projection'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.reject_workspace_legal_hold_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' OR current_setting('app.retention_control_transition', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'workspace legal holds change only through control projection' USING ERRCODE='55000';
  END IF;
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.hold_id <> OLD.hold_id
    OR NEW.placed_sequence <> OLD.placed_sequence OR NEW.placed_record_hash <> OLD.placed_record_hash
    OR NEW.legal_authority <> OLD.legal_authority OR NEW.placement_reason <> OLD.placement_reason
    OR NEW.placed_by <> OLD.placed_by OR NEW.placed_at <> OLD.placed_at
    OR OLD.released_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'workspace legal hold placement is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.reject_workspace_lifecycle_operation_direct_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP='DELETE' AND app.workspace_purge_immutable_delete_is_armed(OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP='DELETE'
    OR current_setting('app.workspace_lifecycle_operation_transition',true)
      IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'workspace lifecycle operations change only through command functions'
      USING ERRCODE='55000';
  END IF;
  IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id
    OR NEW.idempotency_key_hash<>OLD.idempotency_key_hash
    OR NEW.command_type<>OLD.command_type OR NEW.actor_user_id<>OLD.actor_user_id
    OR NEW.reason<>OLD.reason OR NEW.request_hash<>OLD.request_hash
    OR NEW.occurred_at<>OLD.occurred_at OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'workspace lifecycle operation identity is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.reject_workspace_purge_direct_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF current_setting('app.workspace_purge_transition',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'workspace purge state changes only through maintenance functions'
      USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE FUNCTION app.release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.release_retention_batch(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
    lease_expires_at=NULL,updated_at=clock_timestamp()
   WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token RETURNING true
$$;

CREATE FUNCTION app.release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.release_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_updated integer;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace lifecycle release' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  UPDATE app.workspace_lifecycle_operations SET status='pending',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp()
  WHERE id=p_operation_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN v_updated=1;
END $$;

CREATE FUNCTION app.release_workspace_purge_completion(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_changed integer;
BEGIN
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_completions SET status='ready',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp()
  WHERE job_id=p_job_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END $$;

CREATE FUNCTION app.release_workspace_purge_job(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_changed integer;
BEGIN
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_jobs SET status='ready',lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=p_job_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END $$;

CREATE FUNCTION app.release_workspace_purge_step(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_changed integer;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace purge step release' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp()
  WHERE job_id=p_job_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END $$;

CREATE FUNCTION app.request_operator_maintenance_rerun(p_command_id uuid, p_workspace_id uuid, p_target_type character varying, p_target_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean, result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
END $_$;

CREATE FUNCTION app.request_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_source_run_id uuid, p_workflow_version_id uuid, p_run_input jsonb, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean, result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE
  v_existing app.operator_commands%ROWTYPE;
  v_fingerprint char(64);
  v_material jsonb;
  v_outbox_id uuid;
  v_outcome varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_result jsonb;
  v_source_workflow_id uuid;
  v_target_workflow_id uuid;
BEGIN
  IF p_command_id IS NULL OR p_workspace_id IS NULL OR p_source_run_id IS NULL
    OR p_workflow_version_id IS NULL OR p_run_input IS NULL
    OR octet_length(p_run_input::text)>65536 OR p_actor_ref IS NULL
    OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512
    OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'run replay command is invalid' USING ERRCODE='22023';
  END IF;

  v_material:=jsonb_build_object(
    'actorRef',p_actor_ref,'commandType','run.replay','dryRun',p_dry_run,
    'reason',p_reason,'runInput',p_run_input,'sourceRunId',p_source_run_id,
    'workflowVersionId',p_workflow_version_id,'workspaceId',p_workspace_id
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
      gen_random_uuid(),p_workspace_id,'operator.run_replay','workflow-run',
      p_source_run_id,p_command_id::text,jsonb_build_object(
        'actorRef',p_actor_ref,'dryRun',p_dry_run,'outcome',v_outcome,
        'reason',p_reason,'replayed',true,'requestFingerprint',v_fingerprint,
        'workflowVersionId',p_workflow_version_id
      )
    );
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT p_command_id,v_existing.status,v_outcome,true,v_result;
    RETURN;
  END IF;

  SELECT run.workflow_id INTO v_source_workflow_id
  FROM app.workflow_runs run
  WHERE run.workspace_id=p_workspace_id AND run.id=p_source_run_id
  FOR SHARE;
  IF FOUND THEN
    SELECT version.workflow_id INTO v_target_workflow_id
    FROM app.workflow_versions version
    WHERE version.workspace_id=p_workspace_id AND version.id=p_workflow_version_id
      AND version.executable_schema_version=2 AND version.executable_json IS NOT NULL
    FOR SHARE;
  END IF;
  v_outcome:=CASE
    WHEN v_source_workflow_id IS NULL THEN 'source_not_found'
    WHEN v_target_workflow_id IS NULL THEN 'version_not_executable'
    WHEN v_target_workflow_id<>v_source_workflow_id THEN 'workflow_mismatch'
    WHEN p_dry_run THEN 'would_request'
    ELSE 'replay_requested' END;

  IF v_outcome='replay_requested' THEN
    v_outbox_id:=gen_random_uuid();
    INSERT INTO app.operator_run_replay_requests(
      command_id,workspace_id,source_run_id,workflow_id,workflow_version_id,
      run_input,request_fingerprint
    ) VALUES(
      p_command_id,p_workspace_id,p_source_run_id,v_source_workflow_id,
      p_workflow_version_id,p_run_input,v_fingerprint
    );
    INSERT INTO app.outbox_events(
      id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
      payload,payload_checksum
    ) SELECT v_outbox_id,p_workspace_id,'replay-workflow-run',1,
      'operator-command',p_command_id,payload,
      encode(sha256(convert_to(
        '{"commandId":"'||p_command_id::text||
        '","outboxEventId":"'||v_outbox_id::text||
        '","schemaVersion":1,"workspaceId":"'||p_workspace_id::text||'"}',
        'UTF8')),'hex')
    FROM (SELECT jsonb_build_object(
      'commandId',p_command_id,'outboxEventId',v_outbox_id,
      'schemaVersion',1,'workspaceId',p_workspace_id
    ) payload) encoded;
  END IF;

  v_result:=jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion',1,'outboxEventId',v_outbox_id,'outcome',v_outcome,
    'sourceRunId',p_source_run_id,'workflowVersionId',p_workflow_version_id
  ));
  INSERT INTO app.operator_commands(
    id,command_type,dry_run,request_fingerprint,status,outcome,result,completed_at
  ) VALUES(
    p_command_id,'run.replay',p_dry_run,v_fingerprint,
    CASE WHEN v_outcome='replay_requested' THEN 'pending' ELSE 'completed' END,
    v_outcome,v_result,
    CASE WHEN v_outcome='replay_requested' THEN NULL ELSE clock_timestamp() END
  );
  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.run_replay','workflow-run',
    p_source_run_id,p_command_id::text,jsonb_build_object(
      'actorRef',p_actor_ref,'dryRun',p_dry_run,'outcome',v_outcome,
      'reason',p_reason,'requestFingerprint',v_fingerprint,
      'workflowVersionId',p_workflow_version_id
    )
  );
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT p_command_id,
    CASE WHEN v_outcome='replay_requested' THEN 'pending' ELSE 'completed' END::varchar,
    v_outcome,false,v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $_$;

CREATE FUNCTION app.request_workspace_lifecycle_operation(p_id uuid, p_workspace_id uuid, p_idempotency_key_hash character, p_command_type character varying, p_actor_user_id uuid, p_reason character varying, p_request_hash character) RETURNS TABLE(operation_id uuid, workspace_id uuid, command_type character varying, status character varying, occurred_at timestamp with time zone, control_sequence bigint, control_record_hash character, error_code character varying, created_at timestamp with time zone, updated_at timestamp with time zone, completed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE
  v_existing app.workspace_lifecycle_operations%ROWTYPE;
  v_workspace app.workspaces%ROWTYPE;
  v_reason varchar(512);
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id',true),'')
    OR p_actor_user_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workspace lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  IF p_id IS NULL OR p_workspace_id IS NULL OR p_actor_user_id IS NULL
    OR p_idempotency_key_hash IS NULL OR p_command_type IS NULL OR p_reason IS NULL
    OR p_request_hash IS NULL
    OR p_command_type NOT IN ('deletion_requested','deletion_restored')
    OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 512
    OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle operation' USING ERRCODE='22023';
  END IF;
  v_reason:=btrim(p_reason);

  SELECT * INTO v_workspace FROM app.workspaces
    WHERE id=p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace does not exist' USING ERRCODE='23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.users user_record
    JOIN app.workspace_memberships membership ON membership.user_id=user_record.id
    WHERE user_record.id=p_actor_user_id AND user_record.status='active'
      AND membership.workspace_id=p_workspace_id AND membership.status='active'
      AND membership.role='owner'
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_existing FROM app.workspace_lifecycle_operations operation
    WHERE operation.workspace_id=p_workspace_id
      AND operation.idempotency_key_hash=p_idempotency_key_hash;
  IF FOUND THEN
    IF v_existing.command_type<>p_command_type
      OR v_existing.actor_user_id<>p_actor_user_id
      OR v_existing.reason<>v_reason OR v_existing.request_hash<>p_request_hash THEN
      RAISE EXCEPTION 'workspace lifecycle idempotency key conflicts'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.workspace_id,v_existing.command_type,
      v_existing.status,v_existing.occurred_at,v_existing.control_sequence,
      v_existing.control_record_hash,v_existing.error_code,v_existing.created_at,
      v_existing.updated_at,v_existing.completed_at;
    RETURN;
  END IF;
  IF p_command_type='deletion_requested'
    AND v_workspace.status NOT IN ('active','suspended') THEN
    RAISE EXCEPTION 'workspace is not deletable' USING ERRCODE='55000';
  ELSIF p_command_type='deletion_restored'
    AND (v_workspace.status<>'pending_deletion'
      OR clock_timestamp()>=v_workspace.purge_after) THEN
    RAISE EXCEPTION 'workspace is not restorable' USING ERRCODE='55000';
  END IF;

  INSERT INTO app.workspace_lifecycle_operations
    (id,workspace_id,idempotency_key_hash,command_type,actor_user_id,reason,
     request_hash,occurred_at)
  VALUES (p_id,p_workspace_id,p_idempotency_key_hash,p_command_type,p_actor_user_id,
    v_reason,p_request_hash,clock_timestamp());
  RETURN QUERY SELECT operation.id,operation.workspace_id,operation.command_type,
    operation.status,operation.occurred_at,operation.control_sequence,
    operation.control_record_hash,operation.error_code,operation.created_at,
    operation.updated_at,operation.completed_at
  FROM app.workspace_lifecycle_operations operation WHERE operation.id=p_id;
END $_$;

CREATE FUNCTION app.require_active_workspace_integration() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=NEW.workspace_id AND workspace.status='active'
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace integration is disabled' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.require_new_failure_notification_intent_pin() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF NEW.connection_secret_version_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.workflow_runs run
     WHERE run.workspace_id=NEW.workspace_id
       AND run.id=NEW.workflow_run_id
       AND run.failure_notification_policy_version=NEW.policy_version
       AND run.failure_notification_destination_id=NEW.destination_id
       AND run.failure_notification_destination_config_version=NEW.destination_config_version
       AND run.failure_notification_side_effect_class=NEW.side_effect_class
       AND run.failure_notification_connection_secret_version_id=NEW.connection_secret_version_id
  ) THEN
    RAISE EXCEPTION 'new failure notification intent must exactly match its run pin'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.reserve_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_prior text; v_result boolean:=false; v_limit integer;
BEGIN
  v_prior:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  -- Before the counter: never wait for the FK run lock with the counter held.
  -- The reservation also references workspace; take that FK lock first, so
  -- workspace-first lifecycle/purge cannot invert workspace and run locks.
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace_id FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN
    PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN false;
  END IF;
  SELECT run.* INTO v_run FROM app.workflow_runs run JOIN app.outbox_events event
    ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
      AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id AND event.job_name='advance-workflow-run'
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id FOR KEY SHARE OF run SKIP LOCKED;
  IF FOUND THEN
    IF v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at<=clock_timestamp() THEN
      v_result:=true;
    ELSE
      IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,true) THEN
        PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN false;
      END IF;
      PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace_id FOR UPDATE;
      IF FOUND AND app.workflow_run_active_admission_eligible(p_workspace_id,p_outbox_event_id,p_workflow_run_id) THEN
        INSERT INTO app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id,workflow_concurrency_order_exempt)
          SELECT p_workspace_id,p_workflow_run_id,p_outbox_event_id,
            NOT EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=p_workspace_id
              AND workflow_id=v_run.workflow_id AND active_run_limit IS NOT NULL)
          WHERE NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id);
        v_result:=true;
      END IF;
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN v_result;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;

CREATE FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) RETURNS TABLE(endpoint_id uuid, workspace_id uuid, trigger_id uuid, workflow_id uuid, workflow_version_id uuid, node_id character varying, current_secret_version_id uuid, current_schema_version smallint, current_kms_key_reference character varying, current_encrypted_data_key text, current_ciphertext text, current_nonce character varying, current_auth_tag character varying, previous_secret_version_id uuid, previous_secret_valid_until timestamp with time zone, previous_schema_version smallint, previous_kms_key_reference character varying, previous_encrypted_data_key text, previous_ciphertext text, previous_nonce character varying, previous_auth_tag character varying, database_time timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
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
         current_secret.schema_version,current_secret.kms_key_reference,
         current_secret.encrypted_data_key,current_secret.ciphertext,current_secret.nonce,current_secret.auth_tag,
         previous_secret.id,endpoint.previous_secret_valid_until,
         previous_secret.schema_version,previous_secret.kms_key_reference,
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
END $$;

CREATE FUNCTION app.resume_operator_due_work(uuid, uuid, uuid, character varying, character varying, boolean) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean, result jsonb)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    AS $_$
  SELECT * FROM app.execute_operator_execution_command($1,'due-work.resume',$2,$3,NULL,NULL,NULL,NULL,$4,$5,$6)
$_$;

CREATE FUNCTION app.retry_operator_trigger_reconciliation(p_command_id uuid, p_workspace_id uuid, p_workflow_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) RETURNS TABLE(command_id uuid, command_status character varying, command_outcome character varying, replayed boolean, result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
END $_$;

CREATE FUNCTION app.revoke_auth_sessions_for_email_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  DELETE FROM app.auth_sessions WHERE user_id=NEW.id;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.revoke_auth_sessions_for_inactive_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF OLD.status='active' AND NEW.status<>'active' THEN
    DELETE FROM app.auth_sessions WHERE user_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.revoke_auth_sessions_for_workspace_unavailability() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_prior_workspace text;
BEGIN
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  DELETE FROM app.auth_sessions
   WHERE user_id IN (
     SELECT membership.user_id
       FROM app.workspace_memberships membership
      WHERE membership.workspace_id=NEW.id
        AND membership.status<>'removed'
   );
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END;
$$;

CREATE FUNCTION app.scan_workspace_invitation_replacement_claims(p_scan_kind character varying, p_scan_id uuid, p_workspace_id uuid, p_limit integer) RETURNS TABLE(deleted_count integer, scanned_count integer, cycle_completed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_state app.workspace_invitation_claim_cleanup_cursors%ROWTYPE;
  v_candidate record;
  v_deleted integer:=0;
  v_scanned integer:=0;
  v_cycle_completed boolean:=false;
  v_last_updated_at timestamptz;
  v_last_workspace_id uuid;
  v_last_intent_id uuid;
  v_last_binding_digest char(64);
  v_next_high_water_updated_at timestamptz;
  v_next_high_water_workspace_id uuid;
  v_next_high_water_intent_id uuid;
  v_next_high_water_binding_digest char(64);
BEGIN
  IF p_scan_kind NOT IN ('transient','workspace_purge')
    OR p_scan_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
    OR (p_scan_kind='transient' AND (
      p_scan_id<>'00000000-0000-0000-0000-000000000000'::uuid
      OR p_workspace_id IS NOT NULL))
    OR (p_scan_kind='workspace_purge' AND p_workspace_id IS NULL) THEN
    RAISE EXCEPTION 'invalid invitation replacement claim scan'
      USING ERRCODE='22023';
  END IF;

  INSERT INTO app.workspace_invitation_claim_cleanup_cursors
    (scan_kind,scan_id,workspace_id,purge_job_id)
  VALUES(
    p_scan_kind,p_scan_id,p_workspace_id,
    CASE WHEN p_scan_kind='workspace_purge' THEN p_scan_id ELSE NULL END)
  ON CONFLICT(scan_kind,scan_id) DO NOTHING;

  SELECT * INTO STRICT v_state
    FROM app.workspace_invitation_claim_cleanup_cursors
   WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id FOR UPDATE;
  IF v_state.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'invitation replacement claim scan scope changed'
      USING ERRCODE='22023';
  END IF;

  IF v_state.cycle_completed THEN
    IF p_scan_kind='transient' THEN
      UPDATE app.workspace_invitation_claim_cleanup_cursors
         SET cursor_updated_at=NULL,cursor_prior_workspace_id=NULL,
             cursor_prior_intent_id=NULL,cursor_prior_binding_digest=NULL,
             high_water_updated_at=NULL,high_water_prior_workspace_id=NULL,
             high_water_prior_intent_id=NULL,high_water_prior_binding_digest=NULL,
             cycle_completed=false,updated_at=clock_timestamp()
       WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id
       RETURNING * INTO v_state;
    ELSE
      SELECT claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
             claim.prior_binding_digest
        INTO v_next_high_water_updated_at,v_next_high_water_workspace_id,
             v_next_high_water_intent_id,v_next_high_water_binding_digest
        FROM app.workspace_invitation_binding_replacement_claims claim
       WHERE (claim.prior_workspace_id=p_workspace_id
          OR claim.successor_workspace_id=p_workspace_id)
         AND (v_state.high_water_updated_at IS NULL OR
           (claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
            claim.prior_binding_digest)>
           (v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
            v_state.high_water_prior_intent_id,
            v_state.high_water_prior_binding_digest))
       ORDER BY claim.updated_at DESC,claim.prior_workspace_id DESC,
                claim.prior_intent_id DESC,claim.prior_binding_digest DESC
       LIMIT 1;
      IF v_next_high_water_updated_at IS NULL THEN
        RETURN QUERY SELECT 0,0,true;
        RETURN;
      END IF;
      UPDATE app.workspace_invitation_claim_cleanup_cursors
         SET cursor_updated_at=v_state.high_water_updated_at,
             cursor_prior_workspace_id=v_state.high_water_prior_workspace_id,
             cursor_prior_intent_id=v_state.high_water_prior_intent_id,
             cursor_prior_binding_digest=v_state.high_water_prior_binding_digest,
             high_water_updated_at=v_next_high_water_updated_at,
             high_water_prior_workspace_id=v_next_high_water_workspace_id,
             high_water_prior_intent_id=v_next_high_water_intent_id,
             high_water_prior_binding_digest=v_next_high_water_binding_digest,
             cycle_completed=false,updated_at=clock_timestamp()
       WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id
       RETURNING * INTO v_state;
    END IF;
  END IF;

  IF v_state.high_water_updated_at IS NULL THEN
    SELECT claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest
      INTO v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
           v_state.high_water_prior_intent_id,
           v_state.high_water_prior_binding_digest
      FROM app.workspace_invitation_binding_replacement_claims claim
     WHERE p_scan_kind='transient'
        OR claim.prior_workspace_id=p_workspace_id
        OR claim.successor_workspace_id=p_workspace_id
     ORDER BY claim.updated_at DESC,claim.prior_workspace_id DESC,
              claim.prior_intent_id DESC,claim.prior_binding_digest DESC
     LIMIT 1;
    IF v_state.high_water_updated_at IS NULL THEN
      UPDATE app.workspace_invitation_claim_cleanup_cursors
         SET cycle_completed=true,updated_at=clock_timestamp()
       WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id;
      RETURN QUERY SELECT 0,0,true;
      RETURN;
    END IF;
    UPDATE app.workspace_invitation_claim_cleanup_cursors
       SET high_water_updated_at=v_state.high_water_updated_at,
           high_water_prior_workspace_id=v_state.high_water_prior_workspace_id,
           high_water_prior_intent_id=v_state.high_water_prior_intent_id,
           high_water_prior_binding_digest=v_state.high_water_prior_binding_digest,
           updated_at=clock_timestamp()
     WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id;
  END IF;

  FOR v_candidate IN
    SELECT claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest
      FROM app.workspace_invitation_binding_replacement_claims claim
     WHERE (p_scan_kind='transient'
        OR claim.prior_workspace_id=p_workspace_id
        OR claim.successor_workspace_id=p_workspace_id)
       AND (v_state.cursor_updated_at IS NULL OR
         (claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
          claim.prior_binding_digest)>
         (v_state.cursor_updated_at,v_state.cursor_prior_workspace_id,
          v_state.cursor_prior_intent_id,v_state.cursor_prior_binding_digest))
       AND (claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
            claim.prior_binding_digest)<=
           (v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
            v_state.high_water_prior_intent_id,
            v_state.high_water_prior_binding_digest)
     ORDER BY claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
              claim.prior_binding_digest
     LIMIT p_limit
  LOOP
    v_scanned:=v_scanned+1;
    v_last_updated_at:=v_candidate.updated_at;
    v_last_workspace_id:=v_candidate.prior_workspace_id;
    v_last_intent_id:=v_candidate.prior_intent_id;
    v_last_binding_digest:=v_candidate.prior_binding_digest;
    IF app.workspace_invitation_replacement_claim_is_reapable(
      v_candidate.prior_workspace_id,v_candidate.prior_intent_id,
      v_candidate.prior_binding_digest
    ) THEN
      DELETE FROM app.workspace_invitation_binding_replacement_claims
       WHERE prior_workspace_id=v_candidate.prior_workspace_id
         AND prior_intent_id=v_candidate.prior_intent_id
         AND prior_binding_digest=v_candidate.prior_binding_digest;
      IF FOUND THEN v_deleted:=v_deleted+1; END IF;
    END IF;
  END LOOP;

  v_cycle_completed:=v_scanned=0 OR
    (v_last_updated_at,v_last_workspace_id,v_last_intent_id,v_last_binding_digest)>=
    (v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
     v_state.high_water_prior_intent_id,v_state.high_water_prior_binding_digest);
  UPDATE app.workspace_invitation_claim_cleanup_cursors
     SET cursor_updated_at=coalesce(v_last_updated_at,cursor_updated_at),
         cursor_prior_workspace_id=coalesce(v_last_workspace_id,cursor_prior_workspace_id),
         cursor_prior_intent_id=coalesce(v_last_intent_id,cursor_prior_intent_id),
         cursor_prior_binding_digest=coalesce(v_last_binding_digest,cursor_prior_binding_digest),
         cycle_completed=v_cycle_completed,updated_at=clock_timestamp()
   WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id;
  RETURN QUERY SELECT v_deleted,v_scanned,v_cycle_completed;
END $$;

CREATE FUNCTION app.schedule_claim_is_eligible(p_trigger_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace_id uuid; v_eligible boolean; v_prior_workspace text;
BEGIN
  v_prior_workspace := current_setting('app.workspace_id',true);
  SELECT trigger.workspace_id INTO v_workspace_id
    FROM app.workflow_triggers trigger WHERE trigger.id=p_trigger_id;
  IF v_workspace_id IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.workspace_id',v_workspace_id::text,true);
  SELECT EXISTS(SELECT 1 FROM app.trigger_schedules schedule
    JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
    JOIN app.workflows workflow ON workflow.id=trigger.workflow_id
    JOIN app.workspaces workspace ON workspace.id=trigger.workspace_id
    WHERE schedule.trigger_id=p_trigger_id AND schedule.lease_token=p_lease_token
      AND schedule.lease_expires_at>clock_timestamp() AND schedule.status='enabled'
      AND trigger.status='active' AND workflow.lifecycle_status='active'
      AND workflow.activation_status IN ('active','degraded')
      AND workflow.published_version_id=trigger.workflow_version_id AND workspace.status='active'
  ) INTO v_eligible;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN v_eligible;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END
$$;

CREATE FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace_id uuid; v_state varchar; v_prior_workspace text;
BEGIN
  v_prior_workspace:=current_setting('app.workspace_id',true);
  SELECT trigger.workspace_id INTO v_workspace_id
    FROM app.workflow_triggers trigger WHERE trigger.id=p_trigger_id;
  IF v_workspace_id IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.workspace_id',v_workspace_id::text,true);
  SELECT workflow.trigger_pause_state INTO v_state
    FROM app.trigger_schedules schedule
    JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
    JOIN app.workflows workflow ON workflow.workspace_id=trigger.workspace_id
     AND workflow.id=trigger.workflow_id
   WHERE schedule.trigger_id=p_trigger_id AND schedule.lease_token=p_lease_token
     AND schedule.lease_expires_at>clock_timestamp()
   FOR SHARE OF workflow;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN coalesce(v_state='paused',false);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid, p_lease_token uuid, p_scheduled_at timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.schedule_workflow_run_input_retention(p_limit integer) RETURNS TABLE(scanned_count integer, scheduled_count integer, cutoff_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.settle_authentication_mail(p_id uuid, p_lease_token uuid, p_lease_generation bigint, p_outcome text, p_provider_reference text DEFAULT NULL::text, p_failure_code text DEFAULT NULL::text, p_retry_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_changed integer;
BEGIN
  IF p_outcome NOT IN ('submitted','failed','retry','reconciliation_required')
     OR (p_outcome='retry' AND p_retry_at IS NULL) THEN
    RAISE EXCEPTION 'invalid authentication mail settlement' USING ERRCODE='22023';
  END IF;
  UPDATE app.authentication_mail_deliveries delivery
     SET status=CASE
           WHEN p_outcome='retry' AND
                (delivery.attempt_count>=12 OR p_retry_at>=delivery.expires_at
                 OR p_retry_at>=delivery.created_at+interval '24 hours')
             THEN 'reconciliation_required'
           ELSE p_outcome
         END,
         next_attempt_at=CASE WHEN p_outcome='retry' THEN p_retry_at
                              ELSE delivery.next_attempt_at END,
         provider_reference=left(p_provider_reference,512),
         failure_code=left(p_failure_code,128),
         payload_ciphertext=CASE
           WHEN p_outcome='retry' AND delivery.attempt_count<12
                AND p_retry_at<delivery.expires_at
                AND p_retry_at<delivery.created_at+interval '24 hours'
             THEN delivery.payload_ciphertext ELSE NULL END,
         payload_nonce=CASE
           WHEN p_outcome='retry' AND delivery.attempt_count<12
                AND p_retry_at<delivery.expires_at
                AND p_retry_at<delivery.created_at+interval '24 hours'
             THEN delivery.payload_nonce ELSE NULL END,
         payload_tag=CASE
           WHEN p_outcome='retry' AND delivery.attempt_count<12
                AND p_retry_at<delivery.expires_at
                AND p_retry_at<delivery.created_at+interval '24 hours'
             THEN delivery.payload_tag ELSE NULL END,
         payload_key_version=CASE
           WHEN p_outcome='retry' AND delivery.attempt_count<12
                AND p_retry_at<delivery.expires_at
                AND p_retry_at<delivery.created_at+interval '24 hours'
             THEN delivery.payload_key_version ELSE NULL END,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
         completed_at=CASE WHEN p_outcome='retry' AND delivery.attempt_count<12
                                AND p_retry_at<delivery.expires_at
                                AND p_retry_at<delivery.created_at+interval '24 hours'
                           THEN NULL ELSE clock_timestamp() END,
         updated_at=clock_timestamp()
   WHERE delivery.id=p_id AND delivery.status='outcome_unknown'
     AND delivery.lease_token=p_lease_token
     AND delivery.lease_generation=p_lease_generation;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END;
$$;

CREATE FUNCTION app.standard_retention_dry_run_stage_keys(p_workspace_id uuid, p_retention_kind character varying, p_retention_stage character varying, p_cutoff_at timestamp with time zone, p_cursor jsonb, p_upper jsonb, p_descending boolean, p_limit integer) RETURNS SETOF jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
END $_$;

CREATE FUNCTION app.start_retention_batch(p_id uuid, p_workspace_id uuid, p_idempotency_key character varying, p_retention_kind character varying, p_cutoff_at timestamp with time zone, p_dry_run boolean, p_requested_by character varying, p_reason character varying) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
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

CREATE FUNCTION app.validate_workflow_run_failure_notification_pin() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
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
END $_$;

CREATE FUNCTION app.verify_curated_template_origin(p_manifest jsonb, p_origin jsonb, p_digest text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_descriptor jsonb; v_comparison jsonb:=p_manifest; v_target jsonb;
  v_path text[]; v_matches integer; v_value jsonb; v_base jsonb; v_origin jsonb;
BEGIN
  IF jsonb_typeof(p_origin) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'curated origin invalid' USING ERRCODE='42501';
  END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_origin) key)
      IS DISTINCT FROM ARRAY['baseManifestDigest','schemaVersion','templateId','templateVersion']::text[]
    OR p_origin->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_origin->'templateId') IS DISTINCT FROM 'string'
    OR octet_length(p_origin->>'templateId') NOT BETWEEN 1 AND 64
    OR p_origin->>'templateId' !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    OR jsonb_typeof(p_origin->'templateVersion') IS DISTINCT FROM 'number'
    OR p_origin->>'templateVersion' !~ '^[1-9][0-9]{0,9}$'
    OR (p_origin->>'templateVersion')::numeric>2147483647
    OR jsonb_typeof(p_origin->'baseManifestDigest') IS DISTINCT FROM 'string'
    OR p_origin->>'baseManifestDigest' !~ '^[0-9a-f]{64}$'
    OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'curated origin invalid' USING ERRCODE='42501';
  END IF;
  v_descriptor:=app.lock_curated_template_descriptor(p_origin->>'templateId',(p_origin->>'templateVersion')::integer);
  IF v_descriptor IS NULL OR v_descriptor->'selectionEnabled' IS DISTINCT FROM 'true'::jsonb
    OR v_descriptor->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR v_descriptor->'baseManifestDigest' IS DISTINCT FROM p_origin->'baseManifestDigest' THEN
    RAISE EXCEPTION 'curated descriptor unavailable' USING ERRCODE='42501';
  END IF;
  FOR v_target IN SELECT value FROM jsonb_array_elements(v_descriptor->'setupTargets')
  LOOP
    -- Traverse graph structure only. Never search similarly named literal data.
    WITH RECURSIVE graphs(graph,path,depth) AS (
      SELECT p_manifest->'graph',ARRAY['graph']::text[],0
      UNION ALL
      SELECT node.value->'structured'->'body',path||ARRAY['nodes',(node.ordinality-1)::text,'structured','body'],depth+1
      FROM graphs CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(graph->'nodes')='array' THEN graph->'nodes' ELSE '[]'::jsonb END
      ) WITH ORDINALITY node
      WHERE node.value->'structured'->>'kind'='for_each' AND depth<32
    ), targets AS (
      SELECT path||ARRAY['nodes',(node.ordinality-1)::text] path FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(graph->'nodes')='array' THEN graph->'nodes' ELSE '[]'::jsonb END
      ) WITH ORDINALITY node WHERE node.value->>'id'=v_target->>'nodeId'
    ) SELECT count(*),(SELECT path FROM targets LIMIT 1) INTO v_matches,v_path FROM targets;
    IF v_matches<>1 THEN RAISE EXCEPTION 'curated setup target invalid' USING ERRCODE='42501'; END IF;
    IF v_target->>'location'='config' THEN
      v_path:=v_path||ARRAY['config',v_target->>'key'];
    ELSIF v_target->>'location'='literalInput' THEN
      IF p_manifest#>(v_path||ARRAY['inputMappings',v_target->>'key','kind']) IS DISTINCT FROM '"literal"'::jsonb THEN
        RAISE EXCEPTION 'curated setup mapping invalid' USING ERRCODE='42501';
      END IF;
      v_path:=v_path||ARRAY['inputMappings',v_target->>'key','value'];
    ELSE RAISE EXCEPTION 'curated setup location invalid' USING ERRCODE='42501';
    END IF;
    v_value:=p_manifest#>v_path; v_base:=v_descriptor->'manifest'#>v_path;
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'string' OR v_base IS NULL THEN
      RAISE EXCEPTION 'curated setup value invalid' USING ERRCODE='42501';
    END IF;
    IF v_target->>'valueKind'='slack_channel_id' THEN
      IF octet_length(v_value#>>'{}') NOT BETWEEN 2 AND 128 OR (v_value#>>'{}') !~ '^[CDGU][A-Z0-9]+$' THEN
        RAISE EXCEPTION 'curated setup value invalid' USING ERRCODE='42501';
      END IF;
    ELSIF v_target->>'valueKind'='curated_https_endpoint_v1' THEN
      IF NOT app.curated_https_endpoint_valid(v_value#>>'{}') THEN
        RAISE EXCEPTION 'curated setup value invalid' USING ERRCODE='42501';
      END IF;
    ELSE RAISE EXCEPTION 'curated setup kind invalid' USING ERRCODE='42501';
    END IF;
    v_comparison:=jsonb_set(v_comparison,v_path,v_base,false);
  END LOOP;
  IF v_comparison IS DISTINCT FROM v_descriptor->'manifest' THEN
    RAISE EXCEPTION 'curated manifest changed' USING ERRCODE='42501';
  END IF;
  v_origin:=p_origin||jsonb_build_object('creationCommandDigest',p_digest,'derivation','direct');
  IF octet_length(v_origin::text)>512 THEN RAISE EXCEPTION 'curated origin limit' USING ERRCODE='42501'; END IF;
  RETURN v_origin;
END $_$;

CREATE FUNCTION app.workflow_auto_pause_control(p_workspace uuid, p_actor uuid, p_workflow uuid, p_operation text, p_request jsonb, p_key_hash text, p_request_hash text, p_request_id text, p_trace_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
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
END $_$;

CREATE FUNCTION app.workflow_concurrency_admissible(p_workspace uuid, p_run uuid, p_grant boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_limit integer; v_reserved boolean; v_exempt boolean;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_run;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_run.status<>'queued' THEN RETURN true; END IF;
  SELECT active_run_limit INTO v_limit FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=v_run.workflow_id;
  IF v_limit IS NULL THEN RETURN true; END IF;
  IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    IF p_grant THEN RETURN false; END IF;
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  SELECT true,workflow_concurrency_order_exempt INTO v_reserved,v_exempt
    FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace AND workflow_run_id=p_run;
  -- A committed slot survives lowering/enabling; an order-exempt slot predates
  -- ordered grants. Controls cannot use this predicate to start node work.
  IF v_reserved AND (p_grant OR v_exempt) THEN RETURN true; END IF;
  IF NOT coalesce(v_reserved,false) AND
    (SELECT count(*) FROM app.workflow_runs WHERE workspace_id=p_workspace
      AND workflow_id=v_run.workflow_id AND status IN ('running','waiting'))+
    (SELECT count(*) FROM app.workflow_run_active_admissions admission
      JOIN app.workflow_runs run ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
      WHERE admission.workspace_id=p_workspace AND run.workflow_id=v_run.workflow_id)>=v_limit THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS(SELECT 1 FROM app.workflow_runs earlier
    WHERE earlier.workspace_id=p_workspace AND earlier.workflow_id=v_run.workflow_id
      AND earlier.status='queued' AND earlier.admission_ticket<v_run.admission_ticket
      AND earlier.cancel_requested_at IS NULL AND (earlier.deadline_at IS NULL OR earlier.deadline_at>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
        WHERE admission.workspace_id=p_workspace AND admission.workflow_run_id=earlier.id
          AND (p_grant OR admission.workflow_concurrency_order_exempt)));
END $$;

CREATE FUNCTION app.workflow_concurrency_control(p_workspace uuid, p_actor uuid, p_workflow uuid, p_operation text, p_request jsonb, p_key_hash text, p_request_hash text, p_request_id text, p_trace_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_role text; v_limit integer; v_revision integer; v_maximum integer; v_state text;
  v_entitlement record; v_receipt app.workflow_concurrency_command_receipts%ROWTYPE; v_settings jsonb;
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')
    OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'concurrency context denied' USING ERRCODE='PT404';
  END IF;
  IF p_operation NOT IN ('read','update') OR p_request IS NULL OR jsonb_typeof(p_request)<>'object'
    OR (p_operation='read' AND p_request<>'{}'::jsonb)
    OR (p_operation='update' AND (NOT p_request ? 'limit'
      OR (p_request->>'expectedRevision') IS NULL OR (p_request->>'expectedRevision')::integer<1
      OR (p_request->>'limit' IS NOT NULL AND (p_request->>'limit')::integer NOT BETWEEN 1 AND 10000)
      OR p_request-ARRAY['limit','expectedRevision']<>'{}'::jsonb)) THEN
    RAISE EXCEPTION 'invalid concurrency command' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace not visible' USING ERRCODE='PT404'; END IF;
  SELECT membership.role INTO v_role FROM app.workspace_memberships membership
    JOIN app.users actor ON actor.id=membership.user_id
    WHERE membership.workspace_id=p_workspace AND membership.user_id=p_actor
      AND membership.status='active' AND actor.status='active' FOR SHARE OF membership,actor;
  IF NOT FOUND OR (p_operation='update' AND v_role NOT IN ('owner','admin','builder')) THEN
    RAISE EXCEPTION 'workflow not visible' USING ERRCODE='PT404';
  END IF;
  PERFORM 1 FROM app.workflows WHERE workspace_id=p_workspace AND id=p_workflow FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow not visible' USING ERRCODE='PT404'; END IF;
  IF p_operation='update' THEN
    IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'command hashes required' USING ERRCODE='22023';
    END IF;
    INSERT INTO app.workflow_concurrency_command_receipts(workspace_id,actor_id,workflow_id,key_hash,request_hash)
      VALUES(p_workspace,p_actor,p_workflow,p_key_hash,p_request_hash) ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT v_receipt FROM app.workflow_concurrency_command_receipts
      WHERE workspace_id=p_workspace AND actor_id=p_actor AND workflow_id=p_workflow AND key_hash=p_key_hash FOR UPDATE;
    IF v_receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'concurrency idempotency conflict' USING ERRCODE='PT409'; END IF;
    IF v_receipt.result IS NOT NULL THEN RETURN jsonb_build_object('settings',v_receipt.result,'replayed',true); END IF;
    PERFORM 1 FROM app.workspace_execution_entitlements current
      JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=current.workspace_id
        AND version.version=current.current_version WHERE current.workspace_id=p_workspace FOR SHARE OF current,version;
    PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission unavailable' USING ERRCODE='PTA01'; END IF;
  END IF;
  SELECT version.* INTO v_entitlement FROM app.workspace_execution_entitlements current
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=current.workspace_id AND version.version=current.current_version
    WHERE current.workspace_id=p_workspace;
  v_state:=CASE WHEN NOT FOUND THEN 'unavailable' WHEN v_entitlement.status='suspended' THEN 'suspended'
    WHEN v_entitlement.effective_at>clock_timestamp() THEN 'not_yet_effective'
    WHEN v_entitlement.expires_at IS NOT NULL AND v_entitlement.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END;
  v_maximum:=CASE WHEN v_state='active' THEN v_entitlement.active_run_limit ELSE NULL END;
  SELECT active_run_limit,revision INTO v_limit,v_revision FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=p_workflow;
  v_revision:=coalesce(v_revision,1);
  IF p_operation='update' THEN
    IF v_revision<>(p_request->>'expectedRevision')::integer THEN
      RAISE EXCEPTION 'concurrency revision conflict' USING ERRCODE='PTC09',DETAIL=v_revision::text;
    END IF;
    IF p_request->>'limit' IS NOT NULL AND v_maximum IS NULL THEN
      RAISE EXCEPTION 'active workspace entitlement required' USING ERRCODE='PTC10';
    END IF;
    IF (p_request->>'limit')::integer>v_maximum THEN
      RAISE EXCEPTION 'workflow limit exceeds workspace limit' USING ERRCODE='PTC11',DETAIL=v_maximum::text;
    END IF;
    IF v_limit IS DISTINCT FROM (p_request->>'limit')::integer THEN
      v_limit:=(p_request->>'limit')::integer; v_revision:=v_revision+1;
      INSERT INTO app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,revision)
        VALUES(p_workspace,p_workflow,v_limit,v_revision)
        ON CONFLICT(workspace_id,workflow_id) DO UPDATE SET active_run_limit=excluded.active_run_limit,revision=excluded.revision;
      INSERT INTO app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
        VALUES(gen_random_uuid(),p_workspace,p_actor,'workflow.concurrency_settings_changed','workflow',p_workflow,p_request_id,p_trace_id,
          jsonb_build_object('limit',v_limit,'revision',v_revision,'overflow','queue'));
    END IF;
  END IF;
  v_settings:=jsonb_build_object('asOf',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'limit',v_limit,'revision',v_revision,'workspaceActiveRunLimit',v_maximum,'workspacePolicyState',v_state,'overflow','queue');
  IF p_operation='read' THEN RETURN v_settings; END IF;
  UPDATE app.workflow_concurrency_command_receipts SET result=v_settings
    WHERE workspace_id=p_workspace AND actor_id=p_actor AND workflow_id=p_workflow AND key_hash=p_key_hash;
  RETURN jsonb_build_object('settings',v_settings,'replayed',false);
END $_$;

CREATE FUNCTION app.workflow_favorite_command_body(p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE v_expected text;
BEGIN
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>256 THEN
    RAISE EXCEPTION 'favorite command invalid' USING ERRCODE='22023'; END IF;
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(p_body) key)
    IS DISTINCT FROM ARRAY['expectedFavoriteRevision','favorite']::text[]
    OR jsonb_typeof(p_body->'favorite') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_body->'expectedFavoriteRevision') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'favorite command invalid' USING ERRCODE='22023'; END IF;
  v_expected:=p_body->>'expectedFavoriteRevision';
  IF octet_length(v_expected)=36 AND v_expected COLLATE "C" ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN
    v_expected:=v_expected::uuid::text;
  ELSIF octet_length(v_expected)>128 OR v_expected COLLATE "C" !~ '^absent[.]v1[.](0|[1-9][0-9]{0,11})[.](0|[1-9][0-9]{0,11})[.][A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    OR v_expected COLLATE "C" ~ '[^A-Za-z0-9_.-]' THEN
    RAISE EXCEPTION 'favorite precondition invalid' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('favorite',p_body->'favorite','expectedFavoriteRevision',v_expected);
END $_$;

CREATE FUNCTION app.workflow_folder_command_body(p_operation text, p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE v_keys text[]; v_name text; v_parent uuid; v_revision bigint;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('folder.create','folder.rename','folder.move','folder.delete','folder.place')
    OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>2048 THEN
    RAISE EXCEPTION 'folder command invalid' USING ERRCODE='22023'; END IF;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO v_keys FROM jsonb_object_keys(p_body) key;
  IF v_keys IS DISTINCT FROM (CASE p_operation
    WHEN 'folder.create' THEN ARRAY['name','parentId']::text[]
    WHEN 'folder.rename' THEN ARRAY['expectedFolderRevision','name']::text[]
    WHEN 'folder.move' THEN ARRAY['expectedFolderRevision','parentId']::text[]
    WHEN 'folder.delete' THEN ARRAY['expectedFolderRevision']::text[]
    ELSE ARRAY['expectedOrganizationRevision','folderId']::text[] END) THEN
    RAISE EXCEPTION 'folder command invalid' USING ERRCODE='22023'; END IF;
  IF p_operation IN ('folder.create','folder.rename') THEN
    IF jsonb_typeof(p_body->'name') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'folder name invalid' USING ERRCODE='22023'; END IF;
    v_name:=btrim(p_body->>'name',' ');
    IF octet_length(v_name) NOT BETWEEN 1 AND 128 OR v_name COLLATE "C" ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'folder name invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_operation IN ('folder.create','folder.move') THEN
    v_parent:=app.workflow_organization_uuid(p_body->'parentId',true);
  ELSIF p_operation='folder.place' THEN
    v_parent:=app.workflow_organization_uuid(p_body->'folderId',true);
  END IF;
  IF p_operation<>'folder.create' THEN
    v_revision:=app.workflow_organization_revision(p_body->(CASE WHEN p_operation='folder.place'
      THEN 'expectedOrganizationRevision' ELSE 'expectedFolderRevision' END));
  END IF;
  RETURN CASE p_operation
    WHEN 'folder.create' THEN jsonb_build_object('name',v_name,'parentId',v_parent)
    WHEN 'folder.rename' THEN jsonb_build_object('name',v_name,'expectedFolderRevision',v_revision)
    WHEN 'folder.move' THEN jsonb_build_object('parentId',v_parent,'expectedFolderRevision',v_revision)
    WHEN 'folder.delete' THEN jsonb_build_object('expectedFolderRevision',v_revision)
    ELSE jsonb_build_object('folderId',v_parent,'expectedOrganizationRevision',v_revision) END;
END $$;

CREATE FUNCTION app.workflow_folder_depth(p_workspace uuid, p_folder uuid) RETURNS integer
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_depth integer;
BEGIN
  IF p_folder IS NULL THEN RETURN 0; END IF;
  WITH RECURSIVE ancestors AS (
    SELECT id,parent_id,1 depth,ARRAY[id] path FROM app.workflow_folders WHERE workspace_id=p_workspace AND id=p_folder
    UNION ALL SELECT f.id,f.parent_id,a.depth+1,a.path||f.id
      FROM ancestors a JOIN app.workflow_folders f ON f.workspace_id=p_workspace AND f.id=a.parent_id
      WHERE a.depth<5 AND NOT f.id=ANY(a.path)
  ) SELECT depth INTO v_depth FROM ancestors WHERE parent_id IS NULL;
  IF v_depth IS NULL OR v_depth>4 THEN
    RAISE EXCEPTION 'folder hierarchy conflict' USING ERRCODE='P7014'; END IF;
  RETURN v_depth;
END $$;

CREATE FUNCTION app.workflow_organization_batch_body(p_body jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE v_operation text; v_keys text[]; v_items jsonb:='[]'::jsonb; v_item jsonb;
  v_ids uuid[]:=ARRAY[]::uuid[]; v_id uuid; v_revision bigint; v_target jsonb; v_tags uuid[];
BEGIN
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>8192 THEN
    RAISE EXCEPTION 'organization batch invalid' USING ERRCODE='22023'; END IF;
  v_operation:=p_body->>'operation';
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO v_keys FROM jsonb_object_keys(p_body) key;
  IF v_operation IS NULL OR v_operation NOT IN ('move','replace_tags','tag_cleanup') OR v_keys IS DISTINCT FROM
    (CASE v_operation WHEN 'move' THEN ARRAY['folderId','items','operation']::text[]
      WHEN 'replace_tags' THEN ARRAY['items','operation','tagIds']::text[]
      ELSE ARRAY['items','operation','tagId']::text[] END) THEN
    RAISE EXCEPTION 'organization batch invalid' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_body->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'organization batch selection invalid' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_body->'items') NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'organization batch selection invalid' USING ERRCODE='22023'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_body->'items') LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'organization batch item invalid' USING ERRCODE='22023'; END IF;
    IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(v_item) key)
      IS DISTINCT FROM ARRAY['expectedOrganizationRevision','workflowId']::text[] THEN
      RAISE EXCEPTION 'organization batch item invalid' USING ERRCODE='22023'; END IF;
    v_id:=app.workflow_organization_uuid(v_item->'workflowId',false);
    v_revision:=app.workflow_organization_revision(v_item->'expectedOrganizationRevision');
    IF v_id=ANY(v_ids) THEN RAISE EXCEPTION 'organization batch selection invalid' USING ERRCODE='22023'; END IF;
    v_ids:=v_ids||v_id;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('workflowId',v_id,'expectedOrganizationRevision',v_revision));
  END LOOP;
  IF v_operation='move' THEN
    v_target:=to_jsonb(app.workflow_organization_uuid(p_body->'folderId',true));
  ELSIF v_operation='tag_cleanup' THEN
    v_target:=to_jsonb(app.workflow_organization_uuid(p_body->'tagId',false));
  ELSE
    IF jsonb_typeof(p_body->'tagIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'organization batch target invalid' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(p_body->'tagIds')>16 THEN
      RAISE EXCEPTION 'organization batch target invalid' USING ERRCODE='22023'; END IF;
    SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_tags FROM (
      SELECT app.workflow_organization_uuid(value,false) id FROM jsonb_array_elements(p_body->'tagIds')) ids;
    IF cardinality(v_tags)<>(SELECT count(DISTINCT id) FROM unnest(v_tags) id) THEN
      RAISE EXCEPTION 'organization batch target invalid' USING ERRCODE='22023'; END IF;
    v_target:=to_jsonb(v_tags);
  END IF;
  RETURN jsonb_build_object('v',1,'purpose','organization.batch','operation',v_operation,
    'target',coalesce(v_target,'null'::jsonb),'items',v_items);
END $$;

CREATE FUNCTION app.workflow_organization_revision(p_value jsonb) RETURNS bigint
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'number'
    OR (p_value#>>'{}')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR trunc((p_value#>>'{}')::numeric)<>(p_value#>>'{}')::numeric THEN
    RAISE EXCEPTION 'organization revision invalid' USING ERRCODE='22023'; END IF;
  RETURN (p_value#>>'{}')::bigint;
END $$;

CREATE FUNCTION app.workflow_organization_uuid(p_value jsonb, p_nullable boolean) RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
BEGIN
  IF p_nullable AND p_value='null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' OR octet_length(p_value#>>'{}')<>36
    OR (p_value#>>'{}') COLLATE "C" !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN
    RAISE EXCEPTION 'organization identifier invalid' USING ERRCODE='22023'; END IF;
  RETURN (p_value#>>'{}')::uuid;
END $_$;

CREATE FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_prior text; v_status text; v_limit integer; v_result boolean:=false;
BEGIN
  v_prior:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.* INTO v_run FROM app.workflow_runs run JOIN app.outbox_events event
    ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
      AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id AND event.job_name='advance-workflow-run'
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF FOUND THEN
    IF v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at<=clock_timestamp() THEN
      v_result:=true;
    ELSE
      SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace_id;
      SELECT active_run_limit INTO v_limit FROM app.workspace_execution_entitlement_versions
        WHERE workspace_id=p_workspace_id AND version=v_run.execution_entitlement_version;
      v_result:=v_status='active' AND app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,true)
        AND (EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id
          AND workflow_run_id=p_workflow_run_id AND outbox_event_id=p_outbox_event_id)
        OR (NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id)
          AND (SELECT count(*) FROM app.workflow_runs WHERE workspace_id=p_workspace_id AND status IN ('running','waiting'))+
            (SELECT count(*) FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id)<v_limit));
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN coalesce(v_result,false);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;

CREATE FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE active_limit integer; active_count integer; reserved_count integer; workspace_status text;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  -- Protocol rejection precedes the counter, including for old lock-owning workers.
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  SELECT version.active_run_limit INTO active_limit
    FROM app.workspace_execution_admission_counters counter
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=counter.workspace_id
      AND version.version=p_entitlement_version
    WHERE counter.workspace_id=p_workspace_id FOR UPDATE OF counter;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  SELECT count(*)::integer INTO active_count FROM app.workflow_runs
    WHERE workspace_id=p_workspace_id AND status IN ('running','waiting');
  SELECT count(*)::integer INTO reserved_count FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace_id AND workflow_run_id<>p_workflow_run_id;
  SELECT status INTO workspace_status FROM app.workspaces WHERE id=p_workspace_id;
  RETURN workspace_status='active' AND active_count+reserved_count<active_limit;
END $$;

CREATE FUNCTION app.workflow_run_admission_blockers(p_workspace uuid, p_run uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_limit integer; v_workspace_limit integer;
  v_reserved boolean; v_exempt boolean; v_reasons text[]:=ARRAY[]::text[];
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_run;
  IF NOT FOUND OR v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL
    OR v_run.deadline_at<=statement_timestamp() THEN RETURN NULL; END IF;
  SELECT true,workflow_concurrency_order_exempt INTO v_reserved,v_exempt
    FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace AND workflow_run_id=p_run;
  SELECT active_run_limit INTO v_workspace_limit FROM app.workspace_execution_entitlement_versions
    WHERE workspace_id=p_workspace AND version=v_run.execution_entitlement_version;
  IF NOT coalesce(v_reserved,false) AND (SELECT count(*) FROM app.workflow_runs
      WHERE workspace_id=p_workspace AND status IN ('running','waiting'))+
    (SELECT count(*) FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace)>=v_workspace_limit THEN
    v_reasons:=array_append(v_reasons,'workspace_capacity');
  END IF;
  SELECT active_run_limit INTO v_limit FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=v_run.workflow_id;
  IF v_limit IS NOT NULL THEN
    IF NOT coalesce(v_reserved,false) AND (SELECT count(*) FROM app.workflow_runs
        WHERE workspace_id=p_workspace AND workflow_id=v_run.workflow_id AND status IN ('running','waiting'))+
      (SELECT count(*) FROM app.workflow_run_active_admissions admission JOIN app.workflow_runs run
        ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
        WHERE admission.workspace_id=p_workspace AND run.workflow_id=v_run.workflow_id)>=v_limit THEN
      v_reasons:=array_append(v_reasons,'workflow_capacity');
    END IF;
    IF NOT coalesce(v_exempt,false) AND EXISTS(SELECT 1 FROM app.workflow_runs earlier
      WHERE earlier.workspace_id=p_workspace AND earlier.workflow_id=v_run.workflow_id
        AND earlier.status='queued' AND earlier.admission_ticket<v_run.admission_ticket
        AND earlier.cancel_requested_at IS NULL AND (earlier.deadline_at IS NULL OR earlier.deadline_at>statement_timestamp())
        AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
          WHERE admission.workspace_id=p_workspace AND admission.workflow_run_id=earlier.id
            AND admission.workflow_concurrency_order_exempt)) THEN
      v_reasons:=array_append(v_reasons,'workflow_order');
    END IF;
  END IF;
  RETURN jsonb_build_object('asOf',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'reasons',to_jsonb(v_reasons));
END $$;

CREATE FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'app'
    AS $$
  SELECT p_workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')
    AND p_user_id::text=NULLIF(current_setting('app.actor_id',true),'')
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships membership
      JOIN app.workspaces workspace ON workspace.id=membership.workspace_id
      JOIN app.users recipient ON recipient.id=membership.user_id
      WHERE membership.workspace_id=p_workspace_id AND membership.user_id=p_user_id
        AND workspace.status='active' AND recipient.status='active'
        AND membership.status='active' AND membership.role IN ('owner','admin','operator')
    );
$$;

CREATE FUNCTION app.workspace_invitation_replacement_claim_is_reapable(p_prior_workspace_id uuid, p_prior_intent_id uuid, p_prior_binding_digest character) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_binding_digests text[];
  v_unsafe boolean;
BEGIN
  WITH RECURSIVE lineage AS (
    SELECT claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest,claim.successor_workspace_id,
           claim.successor_intent_id,claim.successor_binding_digest,
           1 depth,
           ARRAY[(claim.prior_workspace_id::text||':'||claim.prior_intent_id::text||':'||claim.prior_binding_digest::text)] path,
           false cycle
      FROM app.workspace_invitation_binding_replacement_claims claim
     WHERE claim.prior_workspace_id=p_prior_workspace_id
       AND claim.prior_intent_id=p_prior_intent_id
       AND claim.prior_binding_digest=p_prior_binding_digest
    UNION ALL
    SELECT next.prior_workspace_id,next.prior_intent_id,
           next.prior_binding_digest,next.successor_workspace_id,
           next.successor_intent_id,next.successor_binding_digest,
           lineage.depth+1,
           lineage.path||(next.prior_workspace_id::text||':'||next.prior_intent_id::text||':'||next.prior_binding_digest::text),
           (next.prior_workspace_id::text||':'||next.prior_intent_id::text||':'||next.prior_binding_digest::text)=ANY(lineage.path)
      FROM lineage
      JOIN app.workspace_invitation_binding_replacement_claims next
        ON next.prior_workspace_id=lineage.successor_workspace_id
       AND next.prior_intent_id=lineage.successor_intent_id
       AND next.prior_binding_digest=lineage.successor_binding_digest
     WHERE lineage.depth<32 AND NOT lineage.cycle
  ), binding_digests AS (
    SELECT prior_binding_digest::text binding_digest FROM lineage
    UNION
    SELECT successor_binding_digest::text FROM lineage
  )
  SELECT array_agg(binding_digest ORDER BY binding_digest)
    INTO v_binding_digests FROM binding_digests;
  IF v_binding_digests IS NULL THEN RETURN false; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(binding_digest,0))
    FROM unnest(v_binding_digests) binding_digest ORDER BY binding_digest;

  WITH RECURSIVE lineage AS (
    SELECT claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest,claim.successor_workspace_id,
           claim.successor_intent_id,claim.successor_binding_digest,
           1 depth,
           ARRAY[(claim.prior_workspace_id::text||':'||claim.prior_intent_id::text||':'||claim.prior_binding_digest::text)] path,
           false cycle
      FROM app.workspace_invitation_binding_replacement_claims claim
     WHERE claim.prior_workspace_id=p_prior_workspace_id
       AND claim.prior_intent_id=p_prior_intent_id
       AND claim.prior_binding_digest=p_prior_binding_digest
    UNION ALL
    SELECT next.prior_workspace_id,next.prior_intent_id,
           next.prior_binding_digest,next.successor_workspace_id,
           next.successor_intent_id,next.successor_binding_digest,
           lineage.depth+1,
           lineage.path||(next.prior_workspace_id::text||':'||next.prior_intent_id::text||':'||next.prior_binding_digest::text),
           (next.prior_workspace_id::text||':'||next.prior_intent_id::text||':'||next.prior_binding_digest::text)=ANY(lineage.path)
      FROM lineage
      JOIN app.workspace_invitation_binding_replacement_claims next
        ON next.prior_workspace_id=lineage.successor_workspace_id
       AND next.prior_intent_id=lineage.successor_intent_id
       AND next.prior_binding_digest=lineage.successor_binding_digest
     WHERE lineage.depth<32 AND NOT lineage.cycle
  )
  SELECT EXISTS (
    SELECT 1 FROM lineage WHERE cycle
    UNION ALL
    SELECT 1 FROM lineage tail
     WHERE tail.depth=32 AND EXISTS (
       SELECT 1 FROM app.workspace_invitation_binding_replacement_claims next
        WHERE next.prior_workspace_id=tail.successor_workspace_id
          AND next.prior_intent_id=tail.successor_intent_id
          AND next.prior_binding_digest=tail.successor_binding_digest)
    UNION ALL
    SELECT 1 FROM lineage
     JOIN app.workspace_invitation_acceptance_intents intent
       ON intent.workspace_id=lineage.successor_workspace_id
      AND intent.id=lineage.successor_intent_id
      AND intent.binding_digest=lineage.successor_binding_digest
     WHERE intent.status NOT IN ('abandoned','superseded')
       AND intent.expires_at>clock_timestamp()
    UNION ALL
    SELECT 1 FROM app.workspace_legal_holds hold
     WHERE hold.released_sequence IS NULL AND (
       hold.workspace_id=p_prior_workspace_id OR EXISTS (
         SELECT 1 FROM lineage
          WHERE lineage.successor_workspace_id=hold.workspace_id))
  ) INTO v_unsafe;
  RETURN NOT coalesce(v_unsafe,true);
END $$;

CREATE FUNCTION app.workspace_purge_immutable_delete_is_armed(p_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.workspace_purge_steps step
    JOIN app.workspace_purge_jobs job ON job.id=step.job_id
    WHERE job.workspace_id=p_workspace_id AND job.status='purging'
      AND step.step_name='tenant_rows' AND step.status='running'
      AND step.lease_token::text=nullif(current_setting('app.workspace_purge_delete_token',true),'')
      AND step.lease_expires_at>clock_timestamp()
  )
$$;

CREATE FUNCTION app.workspace_reserved_active_slot_count(p_workspace_id uuid) RETURNS integer
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id IS NULL OR
    nullif(current_setting('app.workspace_id',true),'')::uuid
      IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  RETURN (SELECT count(*)::integer FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace_id);
END $$;

CREATE TABLE app.artifact_links (
    workspace_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    owner_kind character varying(32) NOT NULL,
    owner_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT artifact_links_owner_kind_valid CHECK (((owner_kind)::text = 'preview_run'::text))
);

ALTER TABLE ONLY app.artifact_links FORCE ROW LEVEL SECURITY;

CREATE TABLE app.artifacts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    purpose character varying(64) NOT NULL,
    storage_key character varying(512) NOT NULL,
    media_type character varying(255) NOT NULL,
    byte_length bigint NOT NULL,
    sha256 character(64) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    finalized_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    retention_retry_at timestamp with time zone,
    CONSTRAINT artifacts_byte_length_bounded CHECK (((byte_length >= 0) AND (byte_length <= '5368709120'::bigint))),
    CONSTRAINT artifacts_lifecycle_timestamps CHECK (((((status)::text = 'pending'::text) AND (finalized_at IS NULL) AND (deleted_at IS NULL)) OR (((status)::text = 'available'::text) AND (finalized_at IS NOT NULL) AND (deleted_at IS NULL)) OR (((status)::text = 'deleting'::text) AND (deleted_at IS NULL)) OR (((status)::text = 'deleted'::text) AND (deleted_at IS NOT NULL)))),
    CONSTRAINT artifacts_media_type_format CHECK ((((length((media_type)::text) >= 3) AND (length((media_type)::text) <= 255)) AND ((media_type)::text ~ '^[^[:space:]/;]+/[^\r\n]+$'::text) AND ((media_type)::text !~ '[^	 -~-ÿ]'::text))),
    CONSTRAINT artifacts_purpose_format CHECK (((purpose)::text ~ '^[a-z][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT artifacts_sha256_format CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT artifacts_status_value CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'available'::character varying, 'deleting'::character varying, 'deleted'::character varying])::text[]))),
    CONSTRAINT artifacts_storage_key_scope CHECK (((storage_key)::text = ((('workspaces/'::text || (workspace_id)::text) || '/artifacts/'::text) || (id)::text)))
);

ALTER TABLE ONLY app.artifacts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.audit_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid,
    action character varying(128) NOT NULL,
    target_type character varying(64) NOT NULL,
    target_id uuid,
    request_id character varying(128),
    trace_id character varying(128),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT audit_events_action_format CHECK (((action)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT audit_events_metadata_bounded CHECK ((octet_length((metadata)::text) <= 8192)),
    CONSTRAINT audit_events_request_id_bounded CHECK (((request_id IS NULL) OR ((length((request_id)::text) >= 1) AND (length((request_id)::text) <= 128)))),
    CONSTRAINT audit_events_target_type_format CHECK (((target_type)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)),
    CONSTRAINT audit_events_trace_id_bounded CHECK (((trace_id IS NULL) OR ((length((trace_id)::text) >= 1) AND (length((trace_id)::text) <= 128))))
);

ALTER TABLE ONLY app.audit_events FORCE ROW LEVEL SECURITY;

CREATE TABLE app.auth_accounts (
    id uuid NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE app.auth_email_proofs (
    id uuid NOT NULL,
    token_digest bytea NOT NULL,
    user_id uuid NOT NULL,
    purpose character varying(32) NOT NULL,
    email character varying(320) NOT NULL,
    new_email character varying(320),
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_email_proof_digest_valid CHECK ((octet_length(token_digest) = 32)),
    CONSTRAINT auth_email_proof_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT auth_email_proof_new_email_valid CHECK (((((purpose)::text = 'initial_verification'::text) AND (new_email IS NULL)) OR (((purpose)::text = ANY ((ARRAY['change_old'::character varying, 'change_new'::character varying])::text[])) AND (new_email IS NOT NULL)))),
    CONSTRAINT auth_email_proof_purpose_valid CHECK (((purpose)::text = ANY ((ARRAY['initial_verification'::character varying, 'change_old'::character varying, 'change_new'::character varying])::text[])))
);

CREATE TABLE app.auth_identities (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    issuer character varying(2048) NOT NULL,
    provider_subject character varying(255) NOT NULL,
    profile_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    native_method_verified_at timestamp with time zone,
    CONSTRAINT auth_identities_issuer_format CHECK (((length((issuer)::text) >= 1) AND (length((issuer)::text) <= 2048))),
    CONSTRAINT auth_identities_metadata_bounded CHECK ((octet_length((profile_metadata)::text) <= 8192)),
    CONSTRAINT auth_identities_subject_nonempty CHECK (((length((provider_subject)::text) >= 1) AND (length((provider_subject)::text) <= 255)))
);

CREATE TABLE app.auth_legacy_method_migration_attempts (
    id uuid NOT NULL,
    browser_digest bytea NOT NULL,
    oidc_state_digest bytea CONSTRAINT auth_legacy_method_migration_attempt_oidc_state_digest_not_null NOT NULL,
    target_state_digest bytea,
    target_provider character varying(32) NOT NULL,
    legacy_identity_id uuid,
    user_id uuid,
    phase character varying(16) DEFAULT 'legacy'::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_legacy_migration_completion_valid CHECK ((((phase)::text = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT auth_legacy_migration_digest_valid CHECK (((octet_length(browser_digest) = 32) AND (octet_length(oidc_state_digest) = 32) AND ((target_state_digest IS NULL) OR (octet_length(target_state_digest) = 32)))),
    CONSTRAINT auth_legacy_migration_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT auth_legacy_migration_phase_valid CHECK (((phase)::text = ANY ((ARRAY['legacy'::character varying, 'target'::character varying, 'completed'::character varying, 'abandoned'::character varying])::text[]))),
    CONSTRAINT auth_legacy_migration_proof_valid CHECK (((((phase)::text = 'legacy'::text) AND (user_id IS NULL) AND (legacy_identity_id IS NULL) AND (target_state_digest IS NULL)) OR (((phase)::text <> 'legacy'::text) AND (user_id IS NOT NULL) AND (legacy_identity_id IS NOT NULL)))),
    CONSTRAINT auth_legacy_migration_provider_valid CHECK (((target_provider)::text = ANY ((ARRAY['google'::character varying, 'github'::character varying, 'microsoft'::character varying, 'apple'::character varying])::text[])))
);

CREATE TABLE app.auth_method_link_attempts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    browser_digest bytea NOT NULL,
    source_provider character varying(32) NOT NULL,
    target_provider character varying(32) NOT NULL,
    phase character varying(16) NOT NULL,
    state_digest bytea,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_method_link_browser_digest_valid CHECK ((octet_length(browser_digest) = 32)),
    CONSTRAINT auth_method_link_completion_valid CHECK ((((phase)::text = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT auth_method_link_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT auth_method_link_phase_valid CHECK (((phase)::text = ANY ((ARRAY['source'::character varying, 'target'::character varying, 'completed'::character varying, 'abandoned'::character varying])::text[]))),
    CONSTRAINT auth_method_link_provider_valid CHECK ((((source_provider)::text = ANY ((ARRAY['credential'::character varying, 'google'::character varying, 'github'::character varying, 'microsoft'::character varying, 'apple'::character varying])::text[])) AND ((target_provider)::text = ANY ((ARRAY['google'::character varying, 'github'::character varying, 'microsoft'::character varying, 'apple'::character varying])::text[])) AND ((source_provider)::text <> (target_provider)::text))),
    CONSTRAINT auth_method_link_state_digest_valid CHECK (((state_digest IS NULL) OR (octet_length(state_digest) = 32)))
);

CREATE TABLE app.auth_sessions (
    id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ip_address text,
    user_agent text,
    user_id uuid NOT NULL,
    CONSTRAINT auth_sessions_expiry_after_creation CHECK ((expires_at > created_at))
);

CREATE TABLE app.auth_verifications (
    id uuid NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE app.authentication_mail_deliveries (
    id uuid NOT NULL,
    purpose character varying(32) NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    lease_owner character varying(128),
    lease_token uuid,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    payload_ciphertext text,
    payload_nonce character varying(128),
    payload_tag character varying(256),
    payload_key_version character varying(64),
    provider_reference character varying(512),
    failure_code character varying(128),
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT authentication_mail_active_has_payload CHECK ((((status)::text <> ALL ((ARRAY['queued'::character varying, 'outcome_unknown'::character varying, 'retry'::character varying])::text[])) OR (payload_ciphertext IS NOT NULL))),
    CONSTRAINT authentication_mail_attempts_bounded CHECK (((attempt_count >= 0) AND (attempt_count <= 12))),
    CONSTRAINT authentication_mail_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT authentication_mail_lease_complete CHECK ((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT authentication_mail_payload_complete CHECK ((((payload_ciphertext IS NULL) AND (payload_nonce IS NULL) AND (payload_tag IS NULL) AND (payload_key_version IS NULL)) OR ((payload_ciphertext IS NOT NULL) AND (payload_nonce IS NOT NULL) AND (payload_tag IS NOT NULL) AND (payload_key_version IS NOT NULL)))),
    CONSTRAINT authentication_mail_purpose_valid CHECK (((purpose)::text = ANY ((ARRAY['verification'::character varying, 'password_reset'::character varying, 'email_change_confirmation'::character varying])::text[]))),
    CONSTRAINT authentication_mail_status_valid CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'outcome_unknown'::character varying, 'retry'::character varying, 'submitted'::character varying, 'failed'::character varying, 'reconciliation_required'::character varying, 'expired'::character varying])::text[])))
);

CREATE TABLE app.connection_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    event_type character varying(64) NOT NULL,
    actor_kind character varying(32) NOT NULL,
    actor_id character varying(128) NOT NULL,
    request_id character varying(128),
    trace_id character varying(128),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT connection_events_actor_id_format CHECK (((actor_id)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'::text)),
    CONSTRAINT connection_events_actor_kind_valid CHECK (((actor_kind)::text = ANY ((ARRAY['user'::character varying, 'worker'::character varying, 'system'::character varying])::text[]))),
    CONSTRAINT connection_events_metadata_bounded CHECK ((octet_length((metadata)::text) <= 4096)),
    CONSTRAINT connection_events_request_id_bounded CHECK (((request_id IS NULL) OR ((length((request_id)::text) >= 1) AND (length((request_id)::text) <= 128)))),
    CONSTRAINT connection_events_trace_id_bounded CHECK (((trace_id IS NULL) OR ((length((trace_id)::text) >= 1) AND (length((trace_id)::text) <= 128)))),
    CONSTRAINT connection_events_type_valid CHECK (((event_type)::text = ANY ((ARRAY['connection.created'::character varying, 'connection.secret_rotated'::character varying, 'connection.test_succeeded'::character varying, 'connection.test_failed'::character varying, 'connection.reauthorization_required'::character varying, 'connection.revoked'::character varying, 'connection.credential_accessed'::character varying, 'connection.health_changed'::character varying])::text[])))
);

ALTER TABLE ONLY app.connection_events FORCE ROW LEVEL SECURITY;

CREATE TABLE app.connection_health_observations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    kind character varying(32) NOT NULL,
    reason_code character varying(128),
    production_mode character varying(16) NOT NULL,
    outbox_event_id uuid NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT connection_health_observations_production_mode_check CHECK (((production_mode)::text = ANY ((ARRAY['observe'::character varying, 'enforce'::character varying])::text[]))),
    CONSTRAINT connection_health_observations_signal_valid CHECK (((((kind)::text = 'healthy'::text) AND (reason_code IS NULL)) OR (((kind)::text = 'reauthorization_required'::text) AND (reason_code IS NOT NULL) AND ((reason_code)::text = ANY ((ARRAY['connection.slack_account_inactive'::character varying, 'connection.slack_token_expired'::character varying, 'connection.slack_token_revoked'::character varying])::text[])))))
);

ALTER TABLE ONLY app.connection_health_observations FORCE ROW LEVEL SECURITY;

CREATE TABLE app.connection_secret_versions (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    schema_version smallint NOT NULL,
    kms_key_reference character varying(2048) NOT NULL,
    encrypted_data_key text NOT NULL,
    ciphertext text NOT NULL,
    nonce character varying(64) NOT NULL,
    auth_tag character varying(64) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT connection_secret_versions_ciphertext_bounded CHECK ((((length(ciphertext) >= 1) AND (length(ciphertext) <= 87382)) AND (ciphertext ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_secret_versions_encrypted_key_bounded CHECK ((((length(encrypted_data_key) >= 1) AND (length(encrypted_data_key) <= 10923)) AND (encrypted_data_key ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_secret_versions_kms_reference_bounded CHECK (((length((kms_key_reference)::text) >= 1) AND (length((kms_key_reference)::text) <= 2048))),
    CONSTRAINT connection_secret_versions_nonce_valid CHECK (((length((nonce)::text) = 16) AND ((nonce)::text ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_secret_versions_schema_valid CHECK ((schema_version = 1)),
    CONSTRAINT connection_secret_versions_tag_valid CHECK (((length((auth_tag)::text) = 22) AND ((auth_tag)::text ~ '^[A-Za-z0-9_-]+$'::text)))
);

ALTER TABLE ONLY app.connection_secret_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE app.connections (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    provider_key character varying(64) NOT NULL,
    name character varying(128) NOT NULL,
    auth_type character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    current_secret_version_id uuid NOT NULL,
    last_tested_at timestamp with time zone,
    last_healthy_at timestamp with time zone,
    last_error_code character varying(128),
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    health_revision bigint DEFAULT 1 NOT NULL,
    last_run_observed_at timestamp with time zone,
    last_health_transition_at timestamp with time zone,
    last_health_transition_source character varying(16),
    CONSTRAINT connections_auth_type_valid CHECK (((auth_type)::text = ANY ((ARRAY['http_headers'::character varying, 'slack_bot_token'::character varying, 'resend_api_key'::character varying])::text[]))),
    CONSTRAINT connections_error_code_format CHECK (((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT connections_health_revision_positive CHECK ((health_revision > 0)),
    CONSTRAINT connections_health_transition_source_valid CHECK (((((last_health_transition_at IS NULL) AND (last_health_transition_source IS NULL)) OR ((last_health_transition_at IS NOT NULL) AND ((last_health_transition_source)::text = ANY ((ARRAY['run'::character varying, 'test'::character varying, 'rotation'::character varying, 'revoke'::character varying])::text[])))) IS TRUE)),
    CONSTRAINT connections_name_bounded CHECK ((((name)::text = btrim((name)::text)) AND ((length((name)::text) >= 1) AND (length((name)::text) <= 128)))),
    CONSTRAINT connections_provider_key_format CHECK (((provider_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text)),
    CONSTRAINT connections_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'reauthorization_required'::character varying, 'revoked'::character varying])::text[])))
);

ALTER TABLE ONLY app.connections FORCE ROW LEVEL SECURITY;

CREATE TABLE app.curated_template_descriptors (
    template_id text NOT NULL,
    template_version integer NOT NULL,
    schema_version integer NOT NULL,
    base_manifest text NOT NULL,
    base_manifest_digest character(64) NOT NULL,
    setup_targets jsonb NOT NULL,
    supported_profile text NOT NULL,
    selection_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT curated_template_descriptors_base_manifest_check CHECK ((((octet_length(base_manifest) >= 1) AND (octet_length(base_manifest) <= 2097152)) AND (jsonb_typeof((base_manifest)::jsonb) = 'object'::text))),
    CONSTRAINT curated_template_descriptors_check CHECK (((base_manifest_digest ~ '^[0-9a-f]{64}$'::text) AND ((base_manifest_digest)::text = encode(sha256(((convert_to('pertexo.workflow.portable.manifest.v1'::text, 'UTF8'::name) || decode('00'::text, 'hex'::text)) || convert_to(base_manifest, 'UTF8'::name))), 'hex'::text)))),
    CONSTRAINT curated_template_descriptors_schema_version_check CHECK ((schema_version = 1)),
    CONSTRAINT curated_template_descriptors_setup_targets_check CHECK (((jsonb_typeof(setup_targets) = 'array'::text) AND (jsonb_array_length(setup_targets) <= 16))),
    CONSTRAINT curated_template_descriptors_supported_profile_check CHECK ((supported_profile = 'validate_activation'::text)),
    CONSTRAINT curated_template_descriptors_template_id_check CHECK (((template_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND ((octet_length(template_id) >= 1) AND (octet_length(template_id) <= 64)))),
    CONSTRAINT curated_template_descriptors_template_version_check CHECK ((template_version > 0))
);

CREATE TABLE app.curated_template_rollout (
    singleton boolean DEFAULT true NOT NULL,
    import_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT curated_template_rollout_singleton_check CHECK (singleton)
);

CREATE TABLE app.failure_notification_destination_versions (
    workspace_id uuid NOT NULL,
    destination_id uuid CONSTRAINT failure_notification_destination_versio_destination_id_not_null NOT NULL,
    version integer NOT NULL,
    kind character varying(16) NOT NULL,
    side_effect_class character varying(32) CONSTRAINT failure_notification_destination_ver_side_effect_class_not_null NOT NULL,
    config jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT failure_notification_destination_versions_config_strict CHECK ((((jsonb_typeof(config) = 'object'::text) AND ((((kind)::text = 'slack'::text) AND (jsonb_typeof((config -> 'connectionId'::text)) = 'string'::text) AND (jsonb_typeof((config -> 'channelId'::text)) = 'string'::text) AND (((config - 'connectionId'::text) - 'channelId'::text) = '{}'::jsonb) AND ((config ->> 'connectionId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((config ->> 'channelId'::text) ~ '^[CDGU][A-Z0-9]{1,79}$'::text)) OR (((kind)::text = 'email'::text) AND (jsonb_typeof((config -> 'connectionId'::text)) = 'string'::text) AND (jsonb_typeof((config -> 'toEmail'::text)) = 'string'::text) AND (((config - 'connectionId'::text) - 'toEmail'::text) = '{}'::jsonb) AND ((config ->> 'connectionId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((length((config ->> 'toEmail'::text)) >= 3) AND (length((config ->> 'toEmail'::text)) <= 254)) AND ((config ->> 'toEmail'::text) ~ '^[!-~]+@[A-Za-z0-9.-]+$'::text)))) IS TRUE)),
    CONSTRAINT failure_notification_destination_versions_kind_valid CHECK (((kind)::text = ANY ((ARRAY['slack'::character varying, 'email'::character varying])::text[]))),
    CONSTRAINT failure_notification_destination_versions_side_effect_valid CHECK (((((kind)::text = 'slack'::text) AND ((side_effect_class)::text = 'unsafe'::text)) OR (((kind)::text = 'email'::text) AND ((side_effect_class)::text = 'idempotent_with_key'::text)))),
    CONSTRAINT failure_notification_destination_versions_version_positive CHECK ((version > 0))
);

ALTER TABLE ONLY app.failure_notification_destination_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE app.failure_notification_destinations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind character varying(16) NOT NULL,
    status character varying(16) DEFAULT 'enabled'::character varying NOT NULL,
    current_config_version integer DEFAULT 1 CONSTRAINT failure_notification_destinatio_current_config_version_not_null NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT failure_notification_destinations_kind_valid CHECK (((kind)::text = ANY ((ARRAY['slack'::character varying, 'email'::character varying])::text[]))),
    CONSTRAINT failure_notification_destinations_status_valid CHECK (((status)::text = ANY ((ARRAY['enabled'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT failure_notification_destinations_version_positive CHECK ((current_config_version > 0))
);

ALTER TABLE ONLY app.failure_notification_destinations FORCE ROW LEVEL SECURITY;

CREATE TABLE app.idempotency_records (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    operation character varying(64) NOT NULL,
    scope character varying(128) NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(16) NOT NULL,
    resource_id uuid NOT NULL,
    result_ref jsonb NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idempotency_records_expiry_valid CHECK (((expires_at IS NULL) OR (expires_at > created_at))),
    CONSTRAINT idempotency_records_key_hash_format CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT idempotency_records_operation_format CHECK (((operation)::text ~ '^[a-z][a-z0-9.]{0,63}$'::text)),
    CONSTRAINT idempotency_records_request_hash_format CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT idempotency_records_result_ref_bounded CHECK ((octet_length((result_ref)::text) <= 4096)),
    CONSTRAINT idempotency_records_scope_format CHECK (((scope)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT idempotency_records_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);

ALTER TABLE ONLY app.idempotency_records FORCE ROW LEVEL SECURITY;

CREATE TABLE app.identity_security_audit_facts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    event_type character varying(64) NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    legal_hold_until timestamp with time zone,
    CONSTRAINT identity_security_audit_event_valid CHECK (((event_type)::text = ANY ((ARRAY['email.initial_verified'::character varying, 'email.old_confirmed'::character varying, 'email.change_verified'::character varying, 'method.linked'::character varying, 'method.unlinked'::character varying, 'legacy.method_migrated'::character varying, 'password.changed'::character varying, 'password.configured'::character varying, 'password.reset'::character varying, 'profile.display_name_changed'::character varying])::text[])))
);

CREATE TABLE app.inbox_receipts (
    consumer_name character varying(128) NOT NULL,
    message_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    payload_checksum character(64) NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT inbox_receipts_checksum_format CHECK ((payload_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT inbox_receipts_completion_order CHECK (((completed_at IS NULL) OR (completed_at >= received_at))),
    CONSTRAINT inbox_receipts_consumer_name_format CHECK (((consumer_name)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))
);

ALTER TABLE ONLY app.inbox_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.node_attempt_connection_dispatches (
    workspace_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider_key character varying(64) NOT NULL,
    auth_type character varying(64) NOT NULL,
    secret_version_id uuid NOT NULL,
    health_revision bigint NOT NULL,
    worker_id character varying(128) NOT NULL,
    fence_token bigint NOT NULL,
    CONSTRAINT node_attempt_connection_dispatches_auth_type_check CHECK (((auth_type)::text = 'slack_bot_token'::text)),
    CONSTRAINT node_attempt_connection_dispatches_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT node_attempt_connection_dispatches_health_revision_check CHECK ((health_revision > 0)),
    CONSTRAINT node_attempt_connection_dispatches_provider_key_check CHECK (((provider_key)::text = 'slack'::text))
);

ALTER TABLE ONLY app.node_attempt_connection_dispatches FORCE ROW LEVEL SECURITY;

CREATE TABLE app.node_attempts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    node_run_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    status character varying(32) NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    provider_idempotency_key character varying(256),
    lease_owner character varying(128),
    lease_expires_at timestamp with time zone,
    fence_token bigint DEFAULT 0 NOT NULL,
    dispatch_marked_at timestamp with time zone,
    output_ref jsonb,
    safe_error_code character varying(128),
    error_summary character varying(2048),
    reconciliation_ref jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    executor_failure_kind character varying(32),
    executor_error_kind character varying(32),
    executor_possibly_dispatched boolean,
    retry_decision character varying(32),
    admission_kind character varying(32) DEFAULT 'execute'::character varying NOT NULL,
    CONSTRAINT node_attempts_admission_kind_valid CHECK (((admission_kind)::text = ANY ((ARRAY['execute'::character varying, 'retry'::character varying, 'wait_resume'::character varying])::text[]))),
    CONSTRAINT node_attempts_executor_error_kind_valid CHECK (((executor_error_kind IS NULL) OR ((executor_error_kind)::text = ANY ((ARRAY['authentication'::character varying, 'canceled'::character varying, 'configuration'::character varying, 'internal'::character varying, 'network'::character varying, 'provider'::character varying, 'rate_limit'::character varying, 'timeout'::character varying])::text[])))),
    CONSTRAINT node_attempts_executor_failure_complete CHECK ((((executor_failure_kind IS NULL) AND (executor_error_kind IS NULL) AND (executor_possibly_dispatched IS NULL) AND (retry_decision IS NULL)) OR ((executor_failure_kind IS NOT NULL) AND (executor_error_kind IS NOT NULL) AND (executor_possibly_dispatched IS NOT NULL) AND (retry_decision IS NOT NULL)))),
    CONSTRAINT node_attempts_executor_failure_kind_valid CHECK (((executor_failure_kind IS NULL) OR ((executor_failure_kind)::text = ANY ((ARRAY['failed'::character varying, 'canceled'::character varying, 'retry'::character varying, 'outcome_unknown'::character varying])::text[])))),
    CONSTRAINT node_attempts_executor_failure_only_failed CHECK (((executor_failure_kind IS NULL) OR ((status)::text = 'failed'::text))),
    CONSTRAINT node_attempts_fence_nonnegative CHECK ((fence_token >= 0)),
    CONSTRAINT node_attempts_lease_complete CHECK ((((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND ((status)::text = 'running'::text)))),
    CONSTRAINT node_attempts_number_positive CHECK ((attempt_number > 0)),
    CONSTRAINT node_attempts_output_ref_bounded CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))),
    CONSTRAINT node_attempts_provider_key_valid CHECK ((((side_effect_class)::text = 'idempotent_with_key'::text) = (provider_idempotency_key IS NOT NULL))),
    CONSTRAINT node_attempts_reconciliation_ref_bounded CHECK (((reconciliation_ref IS NULL) OR (octet_length((reconciliation_ref)::text) <= 4096))),
    CONSTRAINT node_attempts_retry_decision_valid CHECK (((retry_decision IS NULL) OR ((retry_decision)::text = ANY ((ARRAY['pending'::character varying, 'retry'::character varying, 'failed'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[])))),
    CONSTRAINT node_attempts_side_effect_class_valid CHECK (((side_effect_class)::text = ANY ((ARRAY['safe'::character varying, 'idempotent_with_key'::character varying, 'unsafe'::character varying])::text[]))),
    CONSTRAINT node_attempts_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'ready'::character varying, 'running'::character varying, 'waiting'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'skipped'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[])))
);

ALTER TABLE ONLY app.node_attempts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.node_runs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    invocation_key character varying(256) NOT NULL,
    branch_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(32) NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    provider_idempotency_key character varying(256),
    input_ref jsonb,
    output_ref jsonb,
    current_attempt_id uuid,
    current_attempt_number integer,
    resume_at timestamp with time zone,
    retry_due_at timestamp with time zone,
    safe_error_code character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    due_wakeup_at timestamp with time zone,
    control_kind character varying(32),
    wait_kind character varying(32),
    provider_dispatch_binding character varying(128),
    CONSTRAINT node_runs_attempt_pointer_complete CHECK ((((current_attempt_id IS NULL) AND (current_attempt_number IS NULL)) OR ((current_attempt_id IS NOT NULL) AND (current_attempt_number IS NOT NULL) AND (current_attempt_number > 0)))),
    CONSTRAINT node_runs_branch_context_bounded CHECK ((octet_length((branch_context)::text) <= 4096)),
    CONSTRAINT node_runs_control_kind_valid CHECK (((control_kind IS NULL) OR ((control_kind)::text = 'for_each_barrier'::text))),
    CONSTRAINT node_runs_due_wakeup_consistent CHECK ((((due_wakeup_at IS NULL) OR (((status)::text = 'waiting'::text) AND (COALESCE(retry_due_at, resume_at) IS NOT NULL) AND (due_wakeup_at = COALESCE(retry_due_at, resume_at)))) IS TRUE)),
    CONSTRAINT node_runs_input_ref_bounded CHECK (((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304))),
    CONSTRAINT node_runs_invocation_key_format CHECK ((((invocation_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'::text) OR ((invocation_key)::text ~ '^([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\|([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\|b:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*\|i:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*$'::text))),
    CONSTRAINT node_runs_node_id_format CHECK (((node_id)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT node_runs_output_ref_bounded CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))),
    CONSTRAINT node_runs_provider_dispatch_binding_format CHECK (((provider_dispatch_binding IS NULL) OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:v[1-9][0-9]{0,2}:sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT node_runs_provider_key_bounded CHECK (((provider_idempotency_key IS NULL) OR (length((provider_idempotency_key)::text) <= 256))),
    CONSTRAINT node_runs_provider_key_valid CHECK ((((side_effect_class)::text = 'idempotent_with_key'::text) = (provider_idempotency_key IS NOT NULL))),
    CONSTRAINT node_runs_side_effect_class_valid CHECK (((side_effect_class)::text = ANY ((ARRAY['safe'::character varying, 'idempotent_with_key'::character varying, 'unsafe'::character varying])::text[]))),
    CONSTRAINT node_runs_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'ready'::character varying, 'running'::character varying, 'waiting'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'skipped'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[]))),
    CONSTRAINT node_runs_wait_kind_valid CHECK (((wait_kind IS NULL) OR ((wait_kind)::text = ANY ((ARRAY['node_wait'::character varying, 'retry_backoff'::character varying])::text[])))),
    CONSTRAINT node_runs_wait_state_valid CHECK ((((((status)::text = 'waiting'::text) AND ((control_kind)::text = 'for_each_barrier'::text) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL)) OR (((status)::text = 'waiting'::text) AND (control_kind IS NULL) AND ((((wait_kind)::text = 'node_wait'::text) AND (resume_at IS NOT NULL) AND (retry_due_at IS NULL)) OR (((wait_kind)::text = 'retry_backoff'::text) AND (resume_at IS NULL) AND (retry_due_at IS NOT NULL)))) OR (((status)::text <> 'waiting'::text) AND (control_kind IS NULL) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL))) IS TRUE))
);

ALTER TABLE ONLY app.node_runs FORCE ROW LEVEL SECURITY;

CREATE TABLE app.oidc_login_transactions (
    state_digest character(64) NOT NULL,
    code_verifier_ciphertext text NOT NULL,
    code_verifier_nonce character varying(128) NOT NULL,
    code_verifier_tag character varying(256) NOT NULL,
    code_verifier_key_version character varying(64) NOT NULL,
    nonce_ciphertext text NOT NULL,
    nonce_nonce character varying(128) NOT NULL,
    nonce_tag character varying(256) NOT NULL,
    nonce_key_version character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    browser_binding_digest character(64) NOT NULL,
    continuation_kind character varying(32),
    continuation_ref jsonb,
    CONSTRAINT oidc_login_transactions_browser_binding_digest_format CHECK ((browser_binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT oidc_login_transactions_ciphertext_bounded CHECK ((((length(code_verifier_ciphertext) >= 1) AND (length(code_verifier_ciphertext) <= 16384)) AND ((length(nonce_ciphertext) >= 1) AND (length(nonce_ciphertext) <= 16384)))),
    CONSTRAINT oidc_login_transactions_consumed_at_valid CHECK (((consumed_at IS NULL) OR (consumed_at >= created_at))),
    CONSTRAINT oidc_login_transactions_continuation_shape CHECK ((((continuation_kind IS NULL) AND (continuation_ref IS NULL)) OR (((continuation_kind)::text = 'invitation_acceptance'::text) AND (continuation_ref IS NOT NULL) AND (jsonb_typeof(continuation_ref) = 'object'::text) AND (continuation_ref ?& ARRAY['workspaceId'::text, 'intentId'::text, 'bindingDigest'::text])))),
    CONSTRAINT oidc_login_transactions_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT oidc_login_transactions_seal_metadata_bounded CHECK ((((length((code_verifier_nonce)::text) >= 1) AND (length((code_verifier_nonce)::text) <= 128)) AND ((length((code_verifier_tag)::text) >= 1) AND (length((code_verifier_tag)::text) <= 256)) AND ((length((code_verifier_key_version)::text) >= 1) AND (length((code_verifier_key_version)::text) <= 64)) AND ((length((nonce_nonce)::text) >= 1) AND (length((nonce_nonce)::text) <= 128)) AND ((length((nonce_tag)::text) >= 1) AND (length((nonce_tag)::text) <= 256)) AND ((length((nonce_key_version)::text) >= 1) AND (length((nonce_key_version)::text) <= 64)))),
    CONSTRAINT oidc_login_transactions_state_digest_format CHECK ((state_digest ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE app.operator_commands (
    id uuid NOT NULL,
    command_type character varying(64) NOT NULL,
    dry_run boolean NOT NULL,
    request_fingerprint character(64) NOT NULL,
    status character varying(16) NOT NULL,
    outcome character varying(32) NOT NULL,
    prior_publish_attempts integer,
    prior_failed_at timestamp with time zone,
    prior_error_code character varying(128),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone DEFAULT clock_timestamp(),
    result jsonb NOT NULL,
    CONSTRAINT operator_commands_completion_order CHECK ((((((status)::text = 'pending'::text) AND (completed_at IS NULL)) OR (((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying])::text[])) AND (completed_at IS NOT NULL) AND (completed_at >= created_at))) IS TRUE)),
    CONSTRAINT operator_commands_fingerprint_valid CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT operator_commands_outcome_valid CHECK (((outcome)::text ~ '^[a-z][a-z0-9_]{0,31}$'::text)),
    CONSTRAINT operator_commands_prior_attempts_valid CHECK (((prior_publish_attempts IS NULL) OR (prior_publish_attempts >= 0))),
    CONSTRAINT operator_commands_result_valid CHECK (((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 16384))),
    CONSTRAINT operator_commands_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT operator_commands_type_valid CHECK (((command_type)::text = ANY ((ARRAY['outbox.redispatch'::character varying, 'attempt.reconcile'::character varying, 'due-work.resume'::character varying, 'unknown-outcome.record-evidence'::character varying, 'run.cancel'::character varying, 'run.replay'::character varying, 'trigger.reconcile'::character varying, 'retention.rerun'::character varying, 'purge.rerun'::character varying])::text[])))
);

CREATE TABLE app.operator_maintenance_rerun_requests (
    command_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    target_type character varying(32) NOT NULL,
    target_id uuid NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    outcome character varying(32),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT operator_maintenance_rerun_outcome_valid CHECK ((((((status)::text = 'pending'::text) AND (outcome IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'completed'::text) AND (outcome IS NOT NULL) AND ((outcome)::text ~ '^[a-z][a-z0-9_]{0,31}$'::text) AND (completed_at IS NOT NULL))) IS TRUE)),
    CONSTRAINT operator_maintenance_rerun_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying])::text[]))),
    CONSTRAINT operator_maintenance_rerun_target_valid CHECK (((target_type)::text = ANY ((ARRAY['retention_batch'::character varying, 'workspace_purge_job'::character varying])::text[])))
);

ALTER TABLE ONLY app.operator_maintenance_rerun_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE app.operator_run_replay_requests (
    command_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    run_input jsonb NOT NULL,
    request_fingerprint character(64) NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    result_run_id uuid,
    safe_error_code character varying(64),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT operator_run_replay_completion_valid CHECK (((((status)::text = 'pending'::text) AND (result_run_id IS NULL) AND (safe_error_code IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'completed'::text) AND (result_run_id IS NOT NULL) AND (safe_error_code IS NULL) AND (completed_at IS NOT NULL)) OR (((status)::text = 'failed'::text) AND (result_run_id IS NULL) AND (safe_error_code IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT operator_run_replay_fingerprint_valid CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT operator_run_replay_input_bounded CHECK ((octet_length((run_input)::text) <= 65536)),
    CONSTRAINT operator_run_replay_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);

ALTER TABLE ONLY app.operator_run_replay_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE app.operator_unknown_outcome_evidence (
    command_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    evidence_kind character varying(64) NOT NULL,
    evidence_ref jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT operator_unknown_evidence_kind_valid CHECK (((evidence_kind)::text ~ '^[a-z][a-z0-9_.-]{0,63}$'::text)),
    CONSTRAINT operator_unknown_evidence_ref_valid CHECK (((jsonb_typeof(evidence_ref) = 'object'::text) AND (octet_length((evidence_ref)::text) <= 4096)))
);

ALTER TABLE ONLY app.operator_unknown_outcome_evidence FORCE ROW LEVEL SECURITY;

CREATE TABLE app.outbox_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    job_name character varying(128) NOT NULL,
    schema_version smallint NOT NULL,
    aggregate_type character varying(64) NOT NULL,
    aggregate_id uuid NOT NULL,
    payload jsonb NOT NULL,
    payload_checksum character(64) NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(128),
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    publish_attempts integer DEFAULT 0 NOT NULL,
    published_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error_code character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_events_aggregate_type_format CHECK (((aggregate_type)::text ~ '^[a-z][a-z0-9.-]{0,63}$'::text)),
    CONSTRAINT outbox_events_attempts_nonnegative CHECK ((publish_attempts >= 0)),
    CONSTRAINT outbox_events_checksum_format CHECK ((payload_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT outbox_events_error_code_format CHECK (((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT outbox_events_job_name_format CHECK (((job_name)::text ~ '^[a-z][a-z0-9-]{0,127}$'::text)),
    CONSTRAINT outbox_events_lease_complete CHECK ((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT outbox_events_lease_owner_format CHECK (((lease_owner IS NULL) OR ((lease_owner)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))),
    CONSTRAINT outbox_events_payload_bounded CHECK ((octet_length((payload)::text) <= 4096)),
    CONSTRAINT outbox_events_schema_version_positive CHECK ((schema_version > 0)),
    CONSTRAINT outbox_events_terminal_state_exclusive CHECK ((NOT ((published_at IS NOT NULL) AND (failed_at IS NOT NULL))))
);

ALTER TABLE ONLY app.outbox_events FORCE ROW LEVEL SECURITY;

CREATE TABLE app.outbox_fair_dispatch_cursor (
    singleton boolean DEFAULT true NOT NULL,
    last_workspace_id uuid,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT outbox_fair_dispatch_cursor_singleton_check CHECK (singleton)
);

CREATE TABLE app.preview_attempts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    preview_run_id uuid NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    provider_idempotency_key character varying(256),
    lease_owner character varying(128),
    lease_expires_at timestamp with time zone,
    fence_token bigint DEFAULT 0 NOT NULL,
    dispatch_marked_at timestamp with time zone,
    output_ref jsonb,
    safe_error_code character varying(128),
    reconciliation_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    provider_dispatch_binding character varying(128),
    CONSTRAINT preview_attempts_error_code_format CHECK (((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT preview_attempts_fence_nonnegative CHECK ((fence_token >= 0)),
    CONSTRAINT preview_attempts_lease_complete CHECK ((((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT preview_attempts_lease_owner_format CHECK (((lease_owner IS NULL) OR ((lease_owner)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))),
    CONSTRAINT preview_attempts_output_bounded CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))),
    CONSTRAINT preview_attempts_output_truth CHECK (((((status)::text = 'succeeded'::text) AND (output_ref IS NOT NULL) AND (safe_error_code IS NULL)) OR (((status)::text <> 'succeeded'::text) AND (output_ref IS NULL)))),
    CONSTRAINT preview_attempts_provider_dispatch_binding_format CHECK (((provider_dispatch_binding IS NULL) OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:v[1-9][0-9]{0,2}:sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT preview_attempts_provider_key_bounded CHECK (((provider_idempotency_key IS NULL) OR ((length((provider_idempotency_key)::text) >= 1) AND (length((provider_idempotency_key)::text) <= 256)))),
    CONSTRAINT preview_attempts_reconciliation_bounded CHECK (((reconciliation_ref IS NULL) OR (octet_length((reconciliation_ref)::text) <= 4096))),
    CONSTRAINT preview_attempts_side_effect_class_valid CHECK (((side_effect_class)::text = ANY ((ARRAY['safe'::character varying, 'idempotent_with_key'::character varying, 'unsafe'::character varying])::text[]))),
    CONSTRAINT preview_attempts_status_valid CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[]))),
    CONSTRAINT preview_attempts_terminal_shape CHECK (((((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[])) AND (completed_at IS NULL)) OR (((status)::text = ANY ((ARRAY['succeeded'::character varying, 'failed'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[])) AND (completed_at IS NOT NULL)))),
    CONSTRAINT preview_attempts_time_order CHECK ((((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL)) AND ((dispatch_marked_at IS NULL) OR (started_at IS NOT NULL))))
);

ALTER TABLE ONLY app.preview_attempts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.preview_runs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    draft_revision integer NOT NULL,
    draft_fingerprint character(64) NOT NULL,
    node_id character varying(256) NOT NULL,
    definition_key character varying(128) NOT NULL,
    definition_version integer NOT NULL,
    executor_key character varying(128) NOT NULL,
    executor_version integer NOT NULL,
    compatibility_release_epoch integer NOT NULL,
    compatibility_release_fingerprint character varying(128) NOT NULL,
    actor_user_id uuid NOT NULL,
    idempotency_key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    executable_node_json jsonb NOT NULL,
    input_ref jsonb NOT NULL,
    prior_preview_run_id uuid,
    side_effect_class character varying(32) NOT NULL,
    may_contact_provider boolean NOT NULL,
    may_cause_external_side_effect boolean NOT NULL,
    dry_run character varying(32) NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    output_ref jsonb,
    safe_error_code character varying(128),
    traceparent character varying(55),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    request_id character varying(128),
    trace_id character varying(128),
    provider_key character varying(64),
    operation_key character varying(128),
    execution_deadline_at timestamp with time zone NOT NULL,
    CONSTRAINT preview_runs_definition_key_format CHECK (((definition_key)::text ~ '^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$'::text)),
    CONSTRAINT preview_runs_disclosure_consistent CHECK (((may_cause_external_side_effect IS FALSE) OR (may_contact_provider IS TRUE))),
    CONSTRAINT preview_runs_draft_fingerprint_format CHECK ((draft_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT preview_runs_dry_run_valid CHECK (((dry_run)::text = ANY ((ARRAY['not_supported'::character varying, 'provider_supported'::character varying])::text[]))),
    CONSTRAINT preview_runs_execution_deadline_order CHECK (((execution_deadline_at > created_at) AND (execution_deadline_at <= expires_at))),
    CONSTRAINT preview_runs_executor_key_format CHECK (((executor_key)::text ~ '^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$'::text)),
    CONSTRAINT preview_runs_idempotency_hashes_format CHECK (((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT preview_runs_input_bounded CHECK ((octet_length((input_ref)::text) <= 4194304)),
    CONSTRAINT preview_runs_integration_identity_consistent CHECK (((((provider_key IS NULL) AND (operation_key IS NULL)) OR ((provider_key IS NOT NULL) AND (operation_key IS NOT NULL) AND ((provider_key)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text) AND ((operation_key)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))) IS TRUE)),
    CONSTRAINT preview_runs_node_bounded CHECK ((octet_length((executable_node_json)::text) <= 2097152)),
    CONSTRAINT preview_runs_node_id_bounded CHECK (((length((node_id)::text) >= 1) AND (length((node_id)::text) <= 256))),
    CONSTRAINT preview_runs_node_object CHECK ((jsonb_typeof(executable_node_json) = 'object'::text)),
    CONSTRAINT preview_runs_output_bounded CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))),
    CONSTRAINT preview_runs_output_truth CHECK (((((status)::text = 'succeeded'::text) AND (output_ref IS NOT NULL) AND (safe_error_code IS NULL)) OR (((status)::text <> 'succeeded'::text) AND (output_ref IS NULL)))),
    CONSTRAINT preview_runs_release_fingerprint_format CHECK (((compatibility_release_fingerprint)::text ~ '^node-compat:v1:sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT preview_runs_release_positive CHECK ((compatibility_release_epoch > 0)),
    CONSTRAINT preview_runs_retention_future CHECK ((expires_at > created_at)),
    CONSTRAINT preview_runs_revision_positive CHECK ((draft_revision > 0)),
    CONSTRAINT preview_runs_safe_error_code_format CHECK (((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT preview_runs_side_effect_class_valid CHECK (((side_effect_class)::text = ANY ((ARRAY['safe'::character varying, 'idempotent_with_key'::character varying, 'unsafe'::character varying])::text[]))),
    CONSTRAINT preview_runs_status_valid CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[]))),
    CONSTRAINT preview_runs_terminal_shape CHECK (((((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[])) AND (completed_at IS NULL)) OR (((status)::text = ANY ((ARRAY['succeeded'::character varying, 'failed'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[])) AND (completed_at IS NOT NULL)))),
    CONSTRAINT preview_runs_time_order CHECK ((((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL)))),
    CONSTRAINT preview_runs_traceparent_format CHECK (((traceparent IS NULL) OR ((traceparent)::text ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'::text))),
    CONSTRAINT preview_runs_versions_positive CHECK (((definition_version > 0) AND (executor_version > 0)))
);

ALTER TABLE ONLY app.preview_runs FORCE ROW LEVEL SECURITY;

CREATE TABLE app.retention_batches (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    retention_kind character varying(32) NOT NULL,
    cutoff_at timestamp with time zone NOT NULL,
    dry_run boolean DEFAULT true NOT NULL,
    requested_by character varying(128) NOT NULL,
    reason character varying(512) NOT NULL,
    status character varying(16) DEFAULT 'ready'::character varying NOT NULL,
    cursor_expires_at timestamp with time zone,
    cursor_id uuid,
    examined_count bigint DEFAULT 0 NOT NULL,
    eligible_count bigint DEFAULT 0 NOT NULL,
    lease_owner character varying(128),
    lease_token uuid,
    lease_fence bigint DEFAULT 0 NOT NULL,
    lease_acquired_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    pause_reason character varying(32),
    paused_at timestamp with time zone,
    retention_stage character varying(32) DEFAULT 'records'::character varying NOT NULL,
    dry_run_cursor jsonb,
    dry_run_upper jsonb,
    CONSTRAINT retention_batches_completion_valid CHECK (((((status)::text = 'completed'::text) AND (completed_at IS NOT NULL) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text <> 'completed'::text) AND (completed_at IS NULL)))),
    CONSTRAINT retention_batches_counts_nonnegative CHECK (((examined_count >= 0) AND (eligible_count >= 0))),
    CONSTRAINT retention_batches_cursor_paired CHECK (((cursor_expires_at IS NULL) = (cursor_id IS NULL))),
    CONSTRAINT retention_batches_dry_run_cursor_object CHECK (((dry_run_cursor IS NULL) OR (jsonb_typeof(dry_run_cursor) = 'object'::text))),
    CONSTRAINT retention_batches_dry_run_upper_object CHECK (((dry_run_upper IS NULL) OR (jsonb_typeof(dry_run_upper) = 'object'::text))),
    CONSTRAINT retention_batches_eligible_bounded CHECK ((eligible_count <= examined_count)),
    CONSTRAINT retention_batches_fence_nonnegative CHECK ((lease_fence >= 0)),
    CONSTRAINT retention_batches_idempotency_bounded CHECK (((length(btrim((idempotency_key)::text)) >= 1) AND (length(btrim((idempotency_key)::text)) <= 128))),
    CONSTRAINT retention_batches_kind_valid CHECK (((retention_kind)::text = ANY ((ARRAY['workflow_run_input'::character varying, 'execution_detail'::character varying, 'run_summary'::character varying, 'trigger_summary'::character varying, 'audit_security'::character varying])::text[]))),
    CONSTRAINT retention_batches_lease_valid CHECK (((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text = 'running'::text) AND (lease_owner IS NOT NULL) AND ((length(btrim((lease_owner)::text)) >= 1) AND (length(btrim((lease_owner)::text)) <= 128)) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)),
    CONSTRAINT retention_batches_pause_valid CHECK (((((status)::text = 'paused'::text) AND ((pause_reason)::text = 'legal_hold'::text) AND (paused_at IS NOT NULL) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text <> 'paused'::text) AND (pause_reason IS NULL) AND (paused_at IS NULL)))),
    CONSTRAINT retention_batches_reason_bounded CHECK (((length(btrim((reason)::text)) >= 1) AND (length(btrim((reason)::text)) <= 512))),
    CONSTRAINT retention_batches_requested_by_bounded CHECK (((length(btrim((requested_by)::text)) >= 1) AND (length(btrim((requested_by)::text)) <= 128))),
    CONSTRAINT retention_batches_status_valid CHECK (((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying, 'paused'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.retention_batches FORCE ROW LEVEL SECURITY;

CREATE TABLE app.retention_control_audit_facts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    command_id uuid NOT NULL,
    fact_type character varying(32) NOT NULL,
    subject_id uuid NOT NULL,
    control_sequence bigint NOT NULL,
    control_record_hash character(64) NOT NULL,
    actor_ref character varying(128) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT retention_control_audit_facts_actor_bounded CHECK (((length(btrim((actor_ref)::text)) >= 1) AND (length(btrim((actor_ref)::text)) <= 128))),
    CONSTRAINT retention_control_audit_facts_hash_valid CHECK ((control_record_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT retention_control_audit_facts_type_valid CHECK (((fact_type)::text = ANY ((ARRAY['legal_hold_placed'::character varying, 'legal_hold_released'::character varying, 'deletion_requested'::character varying, 'deletion_restored'::character varying, 'purge_started'::character varying, 'deletion_completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.retention_control_audit_facts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.retention_schedule_state (
    workspace_id uuid NOT NULL,
    retention_kind character varying(32) NOT NULL,
    next_scan_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_scanned_at timestamp with time zone,
    last_cutoff_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT retention_schedule_state_kind_valid CHECK (((retention_kind)::text = ANY ((ARRAY['workflow_run_input'::character varying, 'execution_detail'::character varying, 'run_summary'::character varying, 'trigger_summary'::character varying, 'audit_security'::character varying])::text[])))
);

ALTER TABLE ONLY app.retention_schedule_state FORCE ROW LEVEL SECURITY;

CREATE TABLE app.rls_probe_records (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.rls_probe_records FORCE ROW LEVEL SECURITY;

CREATE TABLE app.run_checkpoints (
    workflow_run_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision integer NOT NULL,
    engine_version character varying(64) NOT NULL,
    scheduler_state jsonb NOT NULL,
    resume_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resume_lease_owner character varying(128),
    resume_lease_token uuid,
    resume_lease_expires_at timestamp with time zone,
    workflow_version_id uuid NOT NULL,
    last_transition_fingerprint character varying(64),
    CONSTRAINT run_checkpoints_engine_version_format CHECK (((engine_version)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'::text)),
    CONSTRAINT run_checkpoints_resume_lease_complete CHECK ((((resume_lease_owner IS NULL) AND (resume_lease_token IS NULL) AND (resume_lease_expires_at IS NULL)) OR ((resume_lease_owner IS NOT NULL) AND (resume_lease_token IS NOT NULL) AND (resume_lease_expires_at IS NOT NULL)))),
    CONSTRAINT run_checkpoints_revision_nonnegative CHECK ((revision >= 0)),
    CONSTRAINT run_checkpoints_scheduler_state_bounded CHECK ((octet_length((scheduler_state)::text) <= 4194304)),
    CONSTRAINT run_checkpoints_transition_fingerprint_valid CHECK (((last_transition_fingerprint IS NULL) OR ((last_transition_fingerprint)::text ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY app.run_checkpoints FORCE ROW LEVEL SECURITY;

CREATE TABLE app.run_events (
    workspace_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    sequence integer NOT NULL,
    type character varying(64) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_events_payload_bounded CHECK ((octet_length((payload)::text) <= 524288)),
    CONSTRAINT run_events_sequence_positive CHECK ((sequence > 0)),
    CONSTRAINT run_events_type_catalog CHECK (((type)::text = ANY ((ARRAY['run.queued'::character varying, 'run.started'::character varying, 'run.waiting'::character varying, 'run.cancel_requested'::character varying, 'run.succeeded'::character varying, 'run.failed'::character varying, 'run.canceled'::character varying, 'run.timed_out'::character varying, 'run.outcome_unknown'::character varying, 'node.ready'::character varying, 'node.started'::character varying, 'node.progress'::character varying, 'node.waiting'::character varying, 'node.retry_scheduled'::character varying, 'node.succeeded'::character varying, 'node.failed'::character varying, 'node.skipped'::character varying, 'node.canceled'::character varying, 'node.timed_out'::character varying, 'node.outcome_unknown'::character varying])::text[])))
);

ALTER TABLE ONLY app.run_events FORCE ROW LEVEL SECURITY;

CREATE TABLE app.run_failure_notification_audit_facts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    notification_intent_id uuid CONSTRAINT run_failure_notification_audit__notification_intent_id_not_null NOT NULL,
    fact_type character varying(64) NOT NULL,
    attempt_number integer NOT NULL,
    safe_error_code character varying(128),
    possibly_dispatched boolean CONSTRAINT run_failure_notification_audit_fac_possibly_dispatched_not_null NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT run_failure_notification_audit_attempt_nonnegative CHECK ((attempt_number >= 0)),
    CONSTRAINT run_failure_notification_audit_fact_type_valid CHECK (((fact_type)::text = ANY ((ARRAY['intent_created'::character varying, 'dispatch_marked'::character varying, 'delivered'::character varying, 'retry_scheduled'::character varying, 'dead_lettered'::character varying, 'outcome_unknown'::character varying])::text[]))),
    CONSTRAINT run_failure_notification_audit_safe_error_code_format CHECK (((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)))
);

ALTER TABLE ONLY app.run_failure_notification_audit_facts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.run_failure_notification_intents (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    terminal_event_sequence integer CONSTRAINT run_failure_notification_inten_terminal_event_sequence_not_null NOT NULL,
    policy_version smallint NOT NULL,
    destination_id uuid NOT NULL,
    destination_config_version integer CONSTRAINT run_failure_notification_in_destination_config_version_not_null NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    context jsonb NOT NULL,
    context_checksum character(64) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    dispatch_marked_at timestamp with time zone,
    recovery_at timestamp with time zone,
    next_delivery_at timestamp with time zone,
    safe_error_code character varying(128),
    possibly_dispatched boolean,
    provider_reference character varying(256),
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    connection_secret_version_id uuid,
    delivery_binding character varying(128),
    CONSTRAINT run_failure_notification_intents_attempts_bounded CHECK (((delivery_attempts >= 0) AND (delivery_attempts <= 10))),
    CONSTRAINT run_failure_notification_intents_checksum_format CHECK ((context_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT run_failure_notification_intents_context_bounded CHECK ((octet_length((context)::text) <= 4096)),
    CONSTRAINT run_failure_notification_intents_context_object CHECK ((jsonb_typeof(context) = 'object'::text)),
    CONSTRAINT run_failure_notification_intents_delivery_binding_format CHECK (((delivery_binding IS NULL) OR ((delivery_binding)::text ~ '^email:v1:sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT run_failure_notification_intents_destination_version_positive CHECK ((destination_config_version > 0)),
    CONSTRAINT run_failure_notification_intents_lifecycle_valid CHECK (((((status)::text = 'pending'::text) AND (delivery_attempts = 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'claimed'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NOT NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'dispatching'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NOT NULL) AND (recovery_at IS NOT NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'retry'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NOT NULL) AND (completed_at IS NULL)) OR (((status)::text = ANY ((ARRAY['delivered'::character varying, 'dead_letter'::character varying, 'outcome_unknown'::character varying])::text[])) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT run_failure_notification_intents_policy_supported CHECK ((policy_version = 1)),
    CONSTRAINT run_failure_notification_intents_safe_error_code_format CHECK (((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT run_failure_notification_intents_sequence_positive CHECK ((terminal_event_sequence > 0)),
    CONSTRAINT run_failure_notification_intents_side_effect_class_valid CHECK (((side_effect_class)::text = ANY ((ARRAY['safe'::character varying, 'idempotent_with_key'::character varying, 'unsafe'::character varying])::text[]))),
    CONSTRAINT run_failure_notification_intents_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'claimed'::character varying, 'dispatching'::character varying, 'retry'::character varying, 'delivered'::character varying, 'dead_letter'::character varying, 'outcome_unknown'::character varying])::text[])))
);

ALTER TABLE ONLY app.run_failure_notification_intents FORCE ROW LEVEL SECURITY;

CREATE TABLE app.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_digest character(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    user_agent character varying(512),
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sessions_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT sessions_revocation_after_creation CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at))),
    CONSTRAINT sessions_token_digest_format CHECK ((token_digest ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE app.transport_security_audit_facts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    fact_type character varying(64) NOT NULL,
    consumer_name character varying(128) NOT NULL,
    message_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT transport_security_audit_consumer_name_format CHECK (((consumer_name)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT transport_security_audit_fact_type CHECK (((fact_type)::text = 'inbox_checksum_mismatch'::text))
);

ALTER TABLE ONLY app.transport_security_audit_facts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.trigger_schedule_occurrences (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    trigger_id uuid NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    disposition character varying(16) NOT NULL,
    workflow_run_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT trigger_schedule_occurrences_disposition_valid CHECK (((((disposition)::text = 'accepted'::text) AND (workflow_run_id IS NOT NULL)) OR (((disposition)::text = ANY ((ARRAY['skipped'::character varying, 'paused'::character varying])::text[])) AND (workflow_run_id IS NULL))))
);

ALTER TABLE ONLY app.trigger_schedule_occurrences FORCE ROW LEVEL SECURITY;

CREATE TABLE app.trigger_schedules (
    trigger_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recurrence_kind character varying(16) NOT NULL,
    cron_expression character varying(256),
    timezone character varying(128),
    interval_minutes integer,
    misfire_policy character varying(32) NOT NULL,
    config_fingerprint character varying(82) NOT NULL,
    anchor_at timestamp with time zone NOT NULL,
    next_fire_at timestamp with time zone NOT NULL,
    last_fire_at timestamp with time zone,
    status character varying(16) DEFAULT 'enabled'::character varying NOT NULL,
    health_status character varying(32) DEFAULT 'healthy'::character varying NOT NULL,
    last_error_code character varying(128),
    lease_owner character varying(128),
    lease_token uuid,
    lease_acquired_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    admission_deferred_until timestamp with time zone,
    CONSTRAINT trigger_schedules_cursor_valid CHECK (((last_fire_at IS NULL) OR (last_fire_at < next_fire_at))),
    CONSTRAINT trigger_schedules_fingerprint_valid CHECK (((config_fingerprint)::text ~ '^trigger:v1:sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT trigger_schedules_health_valid CHECK (((health_status)::text = ANY ((ARRAY['healthy'::character varying, 'degraded'::character varying, 'unhealthy'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT trigger_schedules_lease_valid CHECK (((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)),
    CONSTRAINT trigger_schedules_misfire_valid CHECK (((misfire_policy)::text = ANY ((ARRAY['catch_up_once'::character varying, 'skip'::character varying])::text[]))),
    CONSTRAINT trigger_schedules_recurrence_valid CHECK ((((((recurrence_kind)::text = 'cron'::text) AND (cron_expression IS NOT NULL) AND (timezone IS NOT NULL) AND (interval_minutes IS NULL)) OR (((recurrence_kind)::text = 'interval'::text) AND (cron_expression IS NULL) AND (timezone IS NULL) AND (interval_minutes IS NOT NULL) AND ((interval_minutes >= 1) AND (interval_minutes <= 43200)))) IS TRUE)),
    CONSTRAINT trigger_schedules_status_valid CHECK (((status)::text = ANY ((ARRAY['enabled'::character varying, 'disabled'::character varying])::text[])))
);

ALTER TABLE ONLY app.trigger_schedules FORCE ROW LEVEL SECURITY;

CREATE TABLE app.usage_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    category character varying(64) NOT NULL,
    quantity bigint NOT NULL,
    resource_type character varying(64) NOT NULL,
    resource_id uuid NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT usage_events_category_format CHECK (((category)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)),
    CONSTRAINT usage_events_idempotency_key_format CHECK (((idempotency_key)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text)),
    CONSTRAINT usage_events_metadata_bounded CHECK ((octet_length((metadata)::text) <= 4096)),
    CONSTRAINT usage_events_quantity_positive CHECK ((quantity > 0)),
    CONSTRAINT usage_events_resource_type_format CHECK (((resource_type)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text))
);

ALTER TABLE ONLY app.usage_events FORCE ROW LEVEL SECURITY;

CREATE TABLE app.user_profile_command_receipts (
    id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT user_profile_command_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT user_profile_command_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT user_profile_command_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);

CREATE TABLE app.users (
    id uuid NOT NULL,
    email character varying(320) NOT NULL,
    display_name character varying(256) NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    profile_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT users_email_format CHECK ((((email)::text = btrim((email)::text)) AND ((length((email)::text) >= 3) AND (length((email)::text) <= 320)))),
    CONSTRAINT users_profile_revision_positive CHECK ((profile_revision > 0)),
    CONSTRAINT users_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'deleted'::character varying])::text[])))
);

CREATE TABLE app.webhook_endpoint_ingress_limits (
    endpoint_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    bucket_started_at timestamp with time zone NOT NULL,
    request_count integer NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT webhook_endpoint_ingress_limits_count_valid CHECK (((request_count >= 1) AND (request_count <= 60)))
);

ALTER TABLE ONLY app.webhook_endpoint_ingress_limits FORCE ROW LEVEL SECURITY;

CREATE TABLE app.webhook_trigger_deliveries (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    trigger_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    workflow_run_id uuid,
    dedupe_kind character varying(16),
    received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '90 days'::interval) NOT NULL,
    outcome character varying(32) DEFAULT 'accepted'::character varying NOT NULL,
    http_status smallint DEFAULT 202 NOT NULL,
    signature_check character varying(16) DEFAULT 'verified'::character varying NOT NULL,
    replay_check character varying(16) DEFAULT 'new'::character varying NOT NULL,
    body_bytes integer,
    CONSTRAINT webhook_trigger_deliveries_body_bytes_valid CHECK (((body_bytes IS NULL) OR ((body_bytes >= 0) AND (body_bytes <= 262144)))),
    CONSTRAINT webhook_trigger_deliveries_dedupe_valid CHECK (((dedupe_kind)::text = ANY ((ARRAY['keyed'::character varying, 'fingerprint'::character varying])::text[]))),
    CONSTRAINT webhook_trigger_deliveries_outcome_valid CHECK (((((outcome)::text = 'accepted'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text) AND (workflow_run_id IS NOT NULL) AND (dedupe_kind IS NOT NULL)) OR (((outcome)::text = 'replayed'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'duplicate'::text) AND (workflow_run_id IS NOT NULL) AND (dedupe_kind IS NOT NULL)) OR ((workflow_run_id IS NULL) AND ((((outcome)::text = 'authentication_failed'::text) AND (http_status = 401) AND ((((signature_check)::text = 'not_checked'::text) AND ((replay_check)::text = 'stale_timestamp'::text)) OR (((signature_check)::text = 'mismatch'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))) OR (((outcome)::text = 'invalid_request'::text) AND (http_status = 400) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((outcome)::text = 'conflict'::text) AND (http_status = 409) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'conflict'::text)) OR (((outcome)::text = 'rate_limited'::text) AND (http_status = 429) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)) OR (((outcome)::text = 'paused'::text) AND (http_status = 423) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))))),
    CONSTRAINT webhook_trigger_deliveries_retention_valid CHECK (((expires_at >= (received_at + '89 days 23:59:59'::interval)) AND (expires_at <= (received_at + '90 days 00:00:01'::interval))))
);

ALTER TABLE ONLY app.webhook_trigger_deliveries FORCE ROW LEVEL SECURITY;

CREATE TABLE app.webhook_trigger_endpoints (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    trigger_id uuid NOT NULL,
    endpoint_key_hash character(64) NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    current_secret_version_id uuid NOT NULL,
    previous_secret_version_id uuid,
    previous_secret_valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT webhook_trigger_endpoints_hash_valid CHECK ((endpoint_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT webhook_trigger_endpoints_rotation_valid CHECK ((((previous_secret_version_id IS NULL) AND (previous_secret_valid_until IS NULL)) OR ((previous_secret_version_id IS NOT NULL) AND (previous_secret_valid_until IS NOT NULL) AND (previous_secret_version_id <> current_secret_version_id)))),
    CONSTRAINT webhook_trigger_endpoints_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying])::text[])))
);

ALTER TABLE ONLY app.webhook_trigger_endpoints FORCE ROW LEVEL SECURITY;

CREATE TABLE app.webhook_trigger_replay_records (
    workspace_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    dedupe_kind character varying(16) NOT NULL,
    dedupe_key_hash character(64) NOT NULL,
    request_fingerprint character(64) NOT NULL,
    delivery_id uuid NOT NULL,
    workflow_run_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT webhook_trigger_replay_records_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT webhook_trigger_replay_records_hashes_valid CHECK (((dedupe_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_fingerprint ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT webhook_trigger_replay_records_kind_valid CHECK (((dedupe_kind)::text = ANY ((ARRAY['keyed'::character varying, 'fingerprint'::character varying])::text[]))),
    CONSTRAINT webhook_trigger_replay_retention_valid CHECK (((((dedupe_kind)::text = 'fingerprint'::text) AND (expires_at >= (created_at + '00:04:59'::interval)) AND (expires_at <= (created_at + '00:05:01'::interval))) OR (((dedupe_kind)::text = 'keyed'::text) AND (expires_at >= (created_at + '23:59:59'::interval)) AND (expires_at <= (created_at + '24:00:01'::interval)))))
);

ALTER TABLE ONLY app.webhook_trigger_replay_records FORCE ROW LEVEL SECURITY;

CREATE TABLE app.webhook_trigger_secret_versions (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    trigger_id uuid NOT NULL,
    purpose character varying(32) DEFAULT 'webhook_hmac_sha256'::character varying NOT NULL,
    schema_version smallint NOT NULL,
    kms_key_reference character varying(2048) NOT NULL,
    encrypted_data_key text NOT NULL,
    ciphertext text NOT NULL,
    nonce character varying(64) NOT NULL,
    auth_tag character varying(64) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT webhook_trigger_secret_versions_purpose_valid CHECK (((purpose)::text = 'webhook_hmac_sha256'::text)),
    CONSTRAINT webhook_trigger_secret_versions_schema_valid CHECK ((schema_version = 1))
);

ALTER TABLE ONLY app.webhook_trigger_secret_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_auto_pause_command_receipts (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    operation text NOT NULL,
    key_hash text NOT NULL,
    request_hash text NOT NULL,
    result jsonb,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT workflow_auto_pause_command_receipts_operation_check CHECK ((operation = ANY (ARRAY['resume'::text, 'settings'::text, 'workspace_settings'::text])))
);

ALTER TABLE ONLY app.workflow_auto_pause_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_concurrency_command_receipts (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    key_hash text NOT NULL,
    request_hash text NOT NULL,
    result jsonb,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL
);

ALTER TABLE ONLY app.workflow_concurrency_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_concurrency_policies (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    active_run_limit integer,
    revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT workflow_concurrency_policies_active_run_limit_check CHECK (((active_run_limit >= 1) AND (active_run_limit <= 10000))),
    CONSTRAINT workflow_concurrency_policies_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY app.workflow_concurrency_policies FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_drafts (
    workflow_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    schema_version integer NOT NULL,
    graph_json jsonb NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_drafts_graph_bounded CHECK ((octet_length((graph_json)::text) <= 2097152)),
    CONSTRAINT workflow_drafts_graph_object CHECK ((jsonb_typeof(graph_json) = 'object'::text)),
    CONSTRAINT workflow_drafts_revision_positive CHECK ((revision > 0)),
    CONSTRAINT workflow_drafts_schema_version_supported CHECK ((schema_version = 1))
);

ALTER TABLE ONLY app.workflow_drafts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_failure_notification_policies (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    destination_id uuid NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY app.workflow_failure_notification_policies FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_failure_streaks (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    consecutive_failures integer NOT NULL,
    last_run_id uuid,
    last_ended_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    resumed_after timestamp with time zone,
    CONSTRAINT workflow_failure_streaks_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT workflow_failure_streaks_last_run_valid CHECK (((last_run_id IS NULL) = (last_ended_at IS NULL)))
);

ALTER TABLE ONLY app.workflow_failure_streaks FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_favorite_held_evidence (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    generation uuid NOT NULL,
    favorite boolean NOT NULL,
    revision uuid NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT workflow_favorite_held_evidence_check CHECK (((favorite AND (expires_at IS NULL)) OR ((NOT favorite) AND (expires_at IS NOT NULL))))
);

ALTER TABLE ONLY app.workflow_favorite_held_evidence FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_favorite_membership_generations (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    generation uuid NOT NULL,
    retired_at timestamp with time zone
);

ALTER TABLE ONLY app.workflow_favorite_membership_generations FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_favorite_receipts (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    generation uuid NOT NULL,
    workflow_id uuid NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT workflow_favorite_receipts_check CHECK ((expires_at > created_at)),
    CONSTRAINT workflow_favorite_receipts_key_hash_check CHECK (((key_hash COLLATE "C") ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_favorite_receipts_request_hash_check CHECK (((request_hash COLLATE "C") ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_favorite_receipts_result_check CHECK (((result IS NULL) OR (octet_length((result)::text) <= 512)))
);

ALTER TABLE ONLY app.workflow_favorite_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_favorites (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    generation uuid NOT NULL,
    favorite boolean NOT NULL,
    revision uuid NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT workflow_favorites_check CHECK (((favorite AND (expires_at IS NULL)) OR ((NOT favorite) AND (expires_at IS NOT NULL))))
);

ALTER TABLE ONLY app.workflow_favorites FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_folders (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    parent_id uuid,
    name text NOT NULL COLLATE pg_catalog."C",
    name_key text NOT NULL COLLATE pg_catalog."C",
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT workflow_folders_check CHECK ((name_key = translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, 'abcdefghijklmnopqrstuvwxyz'::text))),
    CONSTRAINT workflow_folders_check1 CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT workflow_folders_name_check CHECK (((name = btrim(name, ' '::text)) AND ((octet_length(name) >= 1) AND (octet_length(name) <= 128)) AND ((name COLLATE "C") !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workflow_folders_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)))
);

ALTER TABLE ONLY app.workflow_folders FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_input_case_payloads (
    workspace_id uuid NOT NULL,
    case_id uuid NOT NULL,
    revision integer NOT NULL,
    input text NOT NULL,
    canonical_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workflow_input_case_payloads_canonical_bytes_check CHECK (((canonical_bytes >= 1) AND (canonical_bytes <= 65536))),
    CONSTRAINT workflow_input_case_payloads_check CHECK ((octet_length(input) = canonical_bytes)),
    CONSTRAINT workflow_input_case_payloads_input_check CHECK (((input)::jsonb IS NOT NULL)),
    CONSTRAINT workflow_input_case_payloads_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY app.workflow_input_case_payloads FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_input_case_receipts (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    operation character varying(8) NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    case_id uuid NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT workflow_input_case_receipts_check CHECK ((expires_at > created_at)),
    CONSTRAINT workflow_input_case_receipts_key_hash_check CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_input_case_receipts_operation_check CHECK (((operation)::text = ANY ((ARRAY['create'::character varying, 'update'::character varying, 'delete'::character varying])::text[]))),
    CONSTRAINT workflow_input_case_receipts_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_input_case_receipts_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY app.workflow_input_case_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_input_case_rollout (
    singleton boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT workflow_input_case_rollout_singleton_check CHECK (singleton)
);

CREATE TABLE app.workflow_input_cases (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    version_checksum character varying(77) NOT NULL,
    name character varying(128) NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT workflow_input_cases_name_check CHECK (((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))),
    CONSTRAINT workflow_input_cases_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY app.workflow_input_cases FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_integration_usage (
    workspace_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    provider_key character varying(64) NOT NULL,
    operation_key character varying(128) NOT NULL,
    connection_id uuid NOT NULL,
    CONSTRAINT workflow_integration_usage_operation_key_format CHECK (((operation_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text)),
    CONSTRAINT workflow_integration_usage_provider_key_format CHECK (((provider_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text))
);

ALTER TABLE ONLY app.workflow_integration_usage FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_manual_start_rejections (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    scope character varying(128) NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    expected_version_id uuid NOT NULL,
    observed_version_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT workflow_manual_start_rejections_check CHECK (((scope)::text = (('workflow:'::text || (workflow_id)::text) || ':manual'::text))),
    CONSTRAINT workflow_manual_start_rejections_check1 CHECK ((expected_version_id <> observed_version_id)),
    CONSTRAINT workflow_manual_start_rejections_key_hash_check CHECK ((key_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT workflow_manual_start_rejections_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY app.workflow_manual_start_rejections FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_organization_coordination (
    workspace_id uuid NOT NULL
);

ALTER TABLE ONLY app.workflow_organization_coordination FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_organization_receipts (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    operation text NOT NULL,
    target_id uuid NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    admission_xid xid8,
    CONSTRAINT workflow_organization_receipts_admission_xid_check CHECK ((((operation = 'organization.batch.identity'::text) AND ((result IS NULL) OR (admission_xid IS NOT NULL))) OR ((operation <> 'organization.batch.identity'::text) AND (admission_xid IS NULL)))),
    CONSTRAINT workflow_organization_receipts_check CHECK ((expires_at > created_at)),
    CONSTRAINT workflow_organization_receipts_key_hash_check CHECK (((key_hash COLLATE "C") ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_organization_receipts_operation_check CHECK ((operation = ANY (ARRAY['tag.create'::text, 'tag.rename'::text, 'tag.delete'::text, 'tags.replace'::text, 'tag.detach'::text, 'folder.create'::text, 'folder.rename'::text, 'folder.move'::text, 'folder.delete'::text, 'folder.place'::text, 'organization.batch.identity'::text, 'organization.batch.item'::text]))),
    CONSTRAINT workflow_organization_receipts_request_hash_check CHECK (((request_hash COLLATE "C") ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_organization_receipts_result_check CHECK (((result IS NULL) OR (octet_length((result)::text) <= 8192)))
);

ALTER TABLE ONLY app.workflow_organization_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_organization_rollout (
    singleton boolean DEFAULT true NOT NULL,
    writes_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT workflow_organization_rollout_singleton_check CHECK (singleton)
);

CREATE TABLE app.workflow_organization_state (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    folder_id uuid,
    CONSTRAINT workflow_organization_state_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)))
);

ALTER TABLE ONLY app.workflow_organization_state FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_portability_rollout (
    singleton boolean DEFAULT true NOT NULL,
    import_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT workflow_portability_rollout_singleton_check CHECK (singleton)
);

CREATE TABLE app.workflow_run_active_admissions (
    workspace_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    outbox_event_id uuid NOT NULL,
    recover_after timestamp with time zone,
    recovery_count bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    workflow_concurrency_order_exempt boolean DEFAULT true CONSTRAINT workflow_run_active_admissi_workflow_concurrency_order_not_null NOT NULL,
    CONSTRAINT workflow_run_active_admissions_recovery_count_valid CHECK ((recovery_count >= 0))
);

ALTER TABLE ONLY app.workflow_run_active_admissions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE app.workflow_run_admission_ticket_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE app.workflow_runs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    trigger_type character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deadline_at timestamp with time zone,
    cancel_requested_at timestamp with time zone,
    cancel_requested_by character varying(128),
    cancel_reason character varying(512),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    output_ref jsonb,
    error_summary character varying(2048),
    input_ref jsonb,
    deadline_wakeup_at timestamp with time zone,
    failure_notification_policy_version smallint,
    failure_notification_destination_id uuid,
    failure_notification_destination_config_version integer,
    failure_notification_side_effect_class character varying(32),
    failure_notification_connection_secret_version_id uuid,
    execution_entitlement_version integer,
    input_ref_expires_at timestamp with time zone,
    details_purged_at timestamp with time zone,
    replay_source_run_id uuid,
    replay_command_id uuid,
    admission_ticket bigint NOT NULL,
    CONSTRAINT workflow_runs_admission_ticket_positive CHECK ((admission_ticket > 0)),
    CONSTRAINT workflow_runs_cancel_actor_format CHECK (((cancel_requested_by IS NULL) OR ((cancel_requested_by)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'::text))),
    CONSTRAINT workflow_runs_cancel_metadata_complete CHECK ((((cancel_requested_at IS NULL) AND (cancel_requested_by IS NULL) AND (cancel_reason IS NULL)) OR ((cancel_requested_at IS NOT NULL) AND (cancel_requested_by IS NOT NULL)))),
    CONSTRAINT workflow_runs_deadline_valid CHECK (((deadline_at IS NULL) OR (deadline_at > created_at))),
    CONSTRAINT workflow_runs_deadline_wakeup_consistent CHECK ((((deadline_wakeup_at IS NULL) OR ((deadline_at IS NOT NULL) AND (deadline_wakeup_at = deadline_at))) IS TRUE)),
    CONSTRAINT workflow_runs_failure_notification_policy_complete CHECK (((((failure_notification_policy_version IS NULL) AND (failure_notification_destination_id IS NULL) AND (failure_notification_destination_config_version IS NULL) AND (failure_notification_side_effect_class IS NULL) AND (failure_notification_connection_secret_version_id IS NULL)) OR ((failure_notification_policy_version = 1) AND (failure_notification_destination_id IS NOT NULL) AND (failure_notification_destination_config_version IS NOT NULL) AND (failure_notification_destination_config_version > 0) AND (failure_notification_side_effect_class IS NOT NULL) AND ((failure_notification_side_effect_class)::text = ANY ((ARRAY['safe'::character varying, 'idempotent_with_key'::character varying, 'unsafe'::character varying])::text[])))) IS TRUE)),
    CONSTRAINT workflow_runs_input_ref_bounded CHECK (((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304))),
    CONSTRAINT workflow_runs_input_ref_expiry_valid CHECK ((((input_ref IS NULL) AND (input_ref_expires_at IS NULL)) OR ((input_ref IS NOT NULL) AND (input_ref_expires_at IS NOT NULL) AND (input_ref_expires_at > created_at) AND (input_ref_expires_at <= (created_at + '30 days'::interval))))),
    CONSTRAINT workflow_runs_output_ref_bounded CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304))),
    CONSTRAINT workflow_runs_status_valid CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'waiting'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[]))),
    CONSTRAINT workflow_runs_trigger_type_valid CHECK (((trigger_type)::text = ANY ((ARRAY['api'::character varying, 'manual'::character varying, 'replay'::character varying, 'schedule'::character varying, 'webhook'::character varying])::text[])))
);

ALTER TABLE ONLY app.workflow_runs FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_tag_assignments (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    tag_id uuid NOT NULL
);

ALTER TABLE ONLY app.workflow_tag_assignments FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_tags (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    key text NOT NULL COLLATE pg_catalog."C",
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT workflow_tags_key_check CHECK ((((octet_length(key) >= 1) AND (octet_length(key) <= 32)) AND ((key COLLATE "C") ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))),
    CONSTRAINT workflow_tags_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)))
);

ALTER TABLE ONLY app.workflow_tags FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_template_origins (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    origin jsonb NOT NULL,
    CONSTRAINT workflow_template_origins_origin_check CHECK (((jsonb_typeof(origin) = 'object'::text) AND (octet_length((origin)::text) <= 512)))
);

ALTER TABLE ONLY app.workflow_template_origins FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_trigger_outcomes (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    run_id uuid NOT NULL,
    counts_as_failure boolean NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY app.workflow_trigger_outcomes FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_trigger_pause_periods (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    pause_revision bigint NOT NULL,
    paused_at timestamp with time zone NOT NULL,
    resumed_at timestamp with time zone NOT NULL,
    CONSTRAINT workflow_trigger_pause_periods_check CHECK ((resumed_at >= paused_at)),
    CONSTRAINT workflow_trigger_pause_periods_pause_revision_check CHECK ((pause_revision > 0))
);

ALTER TABLE ONLY app.workflow_trigger_pause_periods FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_triggers (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    kind character varying(16) NOT NULL,
    status character varying(32) DEFAULT 'desired'::character varying NOT NULL,
    desired_config jsonb NOT NULL,
    config_fingerprint character varying(82) NOT NULL,
    health_status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    last_error_code character varying(128),
    reconciled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workflow_triggers_config_bounded CHECK ((octet_length((desired_config)::text) <= 4096)),
    CONSTRAINT workflow_triggers_config_strict CHECK (((((kind)::text = 'webhook'::text) AND (desired_config = '{}'::jsonb)) OR (((kind)::text = 'schedule'::text) AND (jsonb_typeof(desired_config) = 'object'::text)))),
    CONSTRAINT workflow_triggers_fingerprint_valid CHECK (((config_fingerprint)::text ~ '^trigger:v1:sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_triggers_health_valid CHECK (((health_status)::text = ANY ((ARRAY['pending'::character varying, 'healthy'::character varying, 'degraded'::character varying, 'unhealthy'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT workflow_triggers_kind_valid CHECK (((kind)::text = ANY ((ARRAY['webhook'::character varying, 'schedule'::character varying])::text[]))),
    CONSTRAINT workflow_triggers_status_valid CHECK (((status)::text = ANY ((ARRAY['desired'::character varying, 'configuration_required'::character varying, 'pending'::character varying, 'active'::character varying, 'degraded'::character varying, 'disabled'::character varying, 'error'::character varying])::text[])))
);

ALTER TABLE ONLY app.workflow_triggers FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflow_versions (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    version_number integer NOT NULL,
    schema_version integer NOT NULL,
    graph_json jsonb NOT NULL,
    checksum character varying(77) NOT NULL,
    published_by uuid NOT NULL,
    published_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    executable_schema_version integer,
    executable_json jsonb,
    compatibility_release_epoch integer,
    CONSTRAINT workflow_versions_checksum_format CHECK ((((((checksum)::text ~ '^wf:v1:sha256:[0-9a-f]{64}$'::text) AND (executable_schema_version IS NULL) AND (executable_json IS NULL) AND (compatibility_release_epoch IS NULL)) OR (((checksum)::text ~ '^wf:v2:sha256:[0-9a-f]{64}$'::text) AND (executable_schema_version IS NOT NULL) AND (executable_schema_version = 2) AND (executable_json IS NOT NULL) AND (jsonb_typeof(executable_json) = 'object'::text) AND (compatibility_release_epoch IS NOT NULL) AND (compatibility_release_epoch > 0))) IS TRUE)),
    CONSTRAINT workflow_versions_executable_bounded CHECK (((executable_json IS NULL) OR (octet_length((executable_json)::text) <= 1048576))),
    CONSTRAINT workflow_versions_graph_bounded CHECK ((octet_length((graph_json)::text) <= 2097152)),
    CONSTRAINT workflow_versions_graph_object CHECK ((jsonb_typeof(graph_json) = 'object'::text)),
    CONSTRAINT workflow_versions_number_positive CHECK ((version_number > 0)),
    CONSTRAINT workflow_versions_schema_version_supported CHECK ((schema_version = 1))
);

ALTER TABLE ONLY app.workflow_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workflows (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(128) NOT NULL,
    lifecycle_status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    activation_status character varying(32) DEFAULT 'inactive'::character varying NOT NULL,
    published_version_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lifecycle_revision integer DEFAULT 1 NOT NULL,
    name_revision integer DEFAULT 1 NOT NULL,
    auto_pause_enabled boolean DEFAULT true NOT NULL,
    auto_pause_threshold smallint,
    trigger_pause_state character varying(16) DEFAULT 'none'::character varying NOT NULL,
    trigger_paused_at timestamp with time zone,
    trigger_pause_reason character varying(32),
    trigger_pause_failures integer,
    trigger_pause_last_run_id uuid,
    trigger_pause_revision bigint DEFAULT 1 NOT NULL,
    auto_pause_settings_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT workflows_activation_status_valid CHECK (((activation_status)::text = ANY ((ARRAY['inactive'::character varying, 'activating'::character varying, 'active'::character varying, 'deactivating'::character varying, 'degraded'::character varying, 'error'::character varying])::text[]))),
    CONSTRAINT workflows_auto_pause_settings_revision_check CHECK ((auto_pause_settings_revision > 0)),
    CONSTRAINT workflows_auto_pause_threshold_valid CHECK (((auto_pause_threshold IS NULL) OR ((auto_pause_threshold >= 3) AND (auto_pause_threshold <= 100)))),
    CONSTRAINT workflows_created_at_millisecond_precision CHECK ((created_at = date_trunc('milliseconds'::text, created_at))),
    CONSTRAINT workflows_lifecycle_revision_positive CHECK ((lifecycle_revision > 0)),
    CONSTRAINT workflows_lifecycle_status_valid CHECK (((lifecycle_status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT workflows_name_nonempty CHECK (((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))),
    CONSTRAINT workflows_name_revision_positive CHECK ((name_revision > 0)),
    CONSTRAINT workflows_trigger_pause_valid CHECK (((trigger_pause_revision > 0) AND ((((trigger_pause_state)::text = 'none'::text) AND (trigger_paused_at IS NULL) AND (trigger_pause_reason IS NULL) AND (trigger_pause_failures IS NULL) AND (trigger_pause_last_run_id IS NULL)) OR (((trigger_pause_state)::text = 'paused'::text) AND (trigger_paused_at IS NOT NULL) AND ((trigger_pause_reason)::text = 'consecutive_failures'::text) AND (trigger_pause_failures > 0) AND (trigger_pause_last_run_id IS NOT NULL)))))
);

ALTER TABLE ONLY app.workflows FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_artifact_capacity (
    workspace_id uuid NOT NULL,
    byte_limit bigint DEFAULT 1073741824 NOT NULL,
    artifact_count_limit integer DEFAULT 1000 NOT NULL,
    charged_bytes bigint DEFAULT 0 NOT NULL,
    charged_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_artifact_capacity_byte_limit_valid CHECK ((byte_limit >= 0)),
    CONSTRAINT workspace_artifact_capacity_charged_bytes_valid CHECK ((charged_bytes >= 0)),
    CONSTRAINT workspace_artifact_capacity_charged_count_valid CHECK ((charged_count >= 0)),
    CONSTRAINT workspace_artifact_capacity_count_limit_valid CHECK ((artifact_count_limit >= 0))
);

ALTER TABLE ONLY app.workspace_artifact_capacity FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_control_ledger_projection (
    workspace_id uuid NOT NULL,
    sequence bigint NOT NULL,
    command_id uuid NOT NULL,
    command_type character varying(32) NOT NULL,
    subject_id uuid NOT NULL,
    previous_hash character(64) NOT NULL,
    record_hash character(64) NOT NULL,
    actor_ref character varying(128) NOT NULL,
    legal_authority character varying(256),
    reason character varying(512) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    projected_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_control_ledger_projection_actor_bounded CHECK (((length(btrim((actor_ref)::text)) >= 1) AND (length(btrim((actor_ref)::text)) <= 128))),
    CONSTRAINT workspace_control_ledger_projection_authority_valid CHECK (((((command_type)::text = ANY ((ARRAY['legal_hold_placed'::character varying, 'legal_hold_released'::character varying])::text[])) AND (legal_authority IS NOT NULL) AND ((length(btrim((legal_authority)::text)) >= 1) AND (length(btrim((legal_authority)::text)) <= 256))) OR (((command_type)::text <> ALL ((ARRAY['legal_hold_placed'::character varying, 'legal_hold_released'::character varying])::text[])) AND (legal_authority IS NULL)))),
    CONSTRAINT workspace_control_ledger_projection_command_type_valid CHECK (((command_type)::text = ANY ((ARRAY['legal_hold_placed'::character varying, 'legal_hold_released'::character varying, 'deletion_requested'::character varying, 'deletion_restored'::character varying, 'purge_started'::character varying, 'deletion_completed'::character varying])::text[]))),
    CONSTRAINT workspace_control_ledger_projection_hashes_valid CHECK (((previous_hash ~ '^[0-9a-f]{64}$'::text) AND (record_hash ~ '^[0-9a-f]{64}$'::text) AND (previous_hash <> record_hash))),
    CONSTRAINT workspace_control_ledger_projection_reason_bounded CHECK (((length(btrim((reason)::text)) >= 1) AND (length(btrim((reason)::text)) <= 512))),
    CONSTRAINT workspace_control_ledger_projection_sequence_positive CHECK ((sequence > 0))
);

ALTER TABLE ONLY app.workspace_control_ledger_projection FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_creation_idempotency_records (
    id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    operation character varying(64) NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(16) NOT NULL,
    resource_id uuid,
    result_ref jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT workspace_creation_idempotency_completed_result CHECK ((((status)::text <> 'completed'::text) OR ((resource_id IS NOT NULL) AND (result_ref <> '{}'::jsonb)))),
    CONSTRAINT workspace_creation_idempotency_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT workspace_creation_idempotency_key_hash_format CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_creation_idempotency_operation_format CHECK (((operation)::text ~ '^[a-z][a-z0-9.]{0,63}$'::text)),
    CONSTRAINT workspace_creation_idempotency_request_hash_format CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_creation_idempotency_result_ref_bounded CHECK ((octet_length((result_ref)::text) <= 4096)),
    CONSTRAINT workspace_creation_idempotency_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_creation_idempotency_records FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_execution_admission_counters (
    workspace_id uuid NOT NULL,
    queued_runs integer DEFAULT 0 NOT NULL,
    active_runs integer DEFAULT 0 NOT NULL,
    reconciled_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_execution_admission_counters_nonnegative CHECK (((queued_runs >= 0) AND (active_runs >= 0)))
);

ALTER TABLE ONLY app.workspace_execution_admission_counters FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_execution_entitlement_versions (
    workspace_id uuid NOT NULL,
    version integer NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    active_run_limit integer CONSTRAINT workspace_execution_entitlement_versi_active_run_limit_not_null NOT NULL,
    queued_run_limit integer CONSTRAINT workspace_execution_entitlement_versi_queued_run_limit_not_null NOT NULL,
    effective_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_execution_entitlement_versions_limits_valid CHECK ((((active_run_limit >= 1) AND (active_run_limit <= 10000)) AND ((queued_run_limit >= 1) AND (queued_run_limit <= 100000)))),
    CONSTRAINT workspace_execution_entitlement_versions_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[]))),
    CONSTRAINT workspace_execution_entitlement_versions_time_valid CHECK (((expires_at IS NULL) OR (expires_at > effective_at))),
    CONSTRAINT workspace_execution_entitlement_versions_version_positive CHECK ((version > 0))
);

ALTER TABLE ONLY app.workspace_execution_entitlement_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_execution_entitlements (
    workspace_id uuid NOT NULL,
    current_version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY app.workspace_execution_entitlements FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_inbox_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    run_id uuid NOT NULL,
    terminal_event_sequence bigint NOT NULL,
    kind character varying(32) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_inbox_events_kind_check CHECK (((kind)::text = ANY ((ARRAY['failed'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[]))),
    CONSTRAINT workspace_inbox_events_terminal_event_sequence_check CHECK ((terminal_event_sequence > 0))
);

ALTER TABLE ONLY app.workspace_inbox_events FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_inbox_reads (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    read_revision bigint NOT NULL,
    read_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_inbox_reads_read_revision_check CHECK ((read_revision > 0))
);

ALTER TABLE ONLY app.workspace_inbox_reads FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE app.workspace_inbox_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE app.workspace_inbox_threads (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    revision bigint NOT NULL,
    occurrence_count bigint NOT NULL,
    first_occurred_at timestamp with time zone NOT NULL,
    latest_occurred_at timestamp with time zone NOT NULL,
    latest_run_id uuid NOT NULL,
    latest_kind character varying(32) NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_inbox_threads_latest_kind_check CHECK (((latest_kind)::text = ANY ((ARRAY['failed'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[]))),
    CONSTRAINT workspace_inbox_threads_occurrence_count_check CHECK ((occurrence_count > 0)),
    CONSTRAINT workspace_inbox_threads_occurrence_order CHECK ((latest_occurred_at >= first_occurred_at)),
    CONSTRAINT workspace_inbox_threads_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY app.workspace_inbox_threads FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_invitation_acceptance_intents (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    invitation_id uuid NOT NULL,
    invitation_revision integer CONSTRAINT workspace_invitation_acceptance_in_invitation_revision_not_null NOT NULL,
    binding_digest character(64) NOT NULL,
    csrf_digest character(64) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    verified_user_id uuid,
    verified_email character varying(320),
    verified_at timestamp with time zone,
    accepted_user_id uuid,
    receipt jsonb,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    abandoned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_invitation_intents_completion_shape CHECK (((((status)::text = 'completed'::text) AND (accepted_user_id IS NOT NULL) AND (receipt IS NOT NULL) AND (completed_at IS NOT NULL)) OR (((status)::text <> 'completed'::text) AND (accepted_user_id IS NULL) AND (receipt IS NULL) AND (completed_at IS NULL)))),
    CONSTRAINT workspace_invitation_intents_digests_valid CHECK (((binding_digest ~ '^[0-9a-f]{64}$'::text) AND (csrf_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_invitation_intents_revision_positive CHECK ((invitation_revision > 0)),
    CONSTRAINT workspace_invitation_intents_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'verified'::character varying, 'wrong_account'::character varying, 'completed'::character varying, 'abandoned'::character varying, 'superseded'::character varying])::text[]))),
    CONSTRAINT workspace_invitation_intents_verification_shape CHECK ((((verified_user_id IS NULL) AND (verified_email IS NULL) AND (verified_at IS NULL)) OR ((verified_user_id IS NOT NULL) AND (verified_email IS NOT NULL) AND (verified_at IS NOT NULL))))
);

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_invitation_binding_replacement_claims (
    prior_workspace_id uuid CONSTRAINT workspace_invitation_binding_replac_prior_workspace_id_not_null NOT NULL,
    prior_intent_id uuid CONSTRAINT workspace_invitation_binding_replaceme_prior_intent_id_not_null NOT NULL,
    prior_binding_digest character(64) CONSTRAINT workspace_invitation_binding_repl_prior_binding_digest_not_null NOT NULL,
    successor_workspace_id uuid CONSTRAINT workspace_invitation_binding_re_successor_workspace_id_not_null NOT NULL,
    successor_intent_id uuid CONSTRAINT workspace_invitation_binding_repla_successor_intent_id_not_null NOT NULL,
    successor_invitation_id uuid CONSTRAINT workspace_invitation_binding_r_successor_invitation_id_not_null NOT NULL,
    successor_invitation_revision integer CONSTRAINT workspace_invitation_bindin_successor_invitation_revis_not_null NOT NULL,
    successor_binding_digest character(64) CONSTRAINT workspace_invitation_binding__successor_binding_digest_not_null NOT NULL,
    successor_csrf_digest character(64) CONSTRAINT workspace_invitation_binding_rep_successor_csrf_digest_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT workspace_invitation_binding_replacement_cl_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT workspace_invitation_binding_replacement_cl_updated_at_not_null NOT NULL,
    CONSTRAINT workspace_invitation_binding_replacement_claims_check CHECK (((prior_binding_digest ~ '^[0-9a-f]{64}$'::text) AND (successor_binding_digest ~ '^[0-9a-f]{64}$'::text) AND (successor_csrf_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_invitation_binding_successor_invitation_revisio_check CHECK ((successor_invitation_revision > 0))
);

ALTER TABLE ONLY app.workspace_invitation_binding_replacement_claims FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_invitation_claim_cleanup_cursors (
    scan_kind character varying(32) NOT NULL,
    scan_id uuid NOT NULL,
    workspace_id uuid,
    purge_job_id uuid,
    cursor_updated_at timestamp with time zone,
    cursor_prior_workspace_id uuid,
    cursor_prior_intent_id uuid,
    cursor_prior_binding_digest character(64),
    high_water_updated_at timestamp with time zone,
    high_water_prior_workspace_id uuid,
    high_water_prior_intent_id uuid,
    high_water_prior_binding_digest character(64),
    cycle_completed boolean DEFAULT false CONSTRAINT workspace_invitation_claim_cleanup_cur_cycle_completed_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_invitation_claim_cleanup_bounds_valid CHECK (((cursor_updated_at IS NULL) OR (high_water_updated_at IS NOT NULL))),
    CONSTRAINT workspace_invitation_claim_cleanup_cursor_position_valid CHECK ((((cursor_updated_at IS NULL) AND (cursor_prior_workspace_id IS NULL) AND (cursor_prior_intent_id IS NULL) AND (cursor_prior_binding_digest IS NULL)) OR ((cursor_updated_at IS NOT NULL) AND (cursor_prior_workspace_id IS NOT NULL) AND (cursor_prior_intent_id IS NOT NULL) AND (cursor_prior_binding_digest ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT workspace_invitation_claim_cleanup_cursor_scope_valid CHECK (((((scan_kind)::text = 'transient'::text) AND (scan_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (workspace_id IS NULL) AND (purge_job_id IS NULL)) OR (((scan_kind)::text = 'workspace_purge'::text) AND (scan_id = purge_job_id) AND (workspace_id IS NOT NULL) AND (purge_job_id IS NOT NULL)))),
    CONSTRAINT workspace_invitation_claim_cleanup_high_water_valid CHECK ((((high_water_updated_at IS NULL) AND (high_water_prior_workspace_id IS NULL) AND (high_water_prior_intent_id IS NULL) AND (high_water_prior_binding_digest IS NULL)) OR ((high_water_updated_at IS NOT NULL) AND (high_water_prior_workspace_id IS NOT NULL) AND (high_water_prior_intent_id IS NOT NULL) AND (high_water_prior_binding_digest ~ '^[0-9a-f]{64}$'::text))))
);

CREATE TABLE app.workspace_invitation_command_receipts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    operation character varying(32) NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_invitation_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_invitation_receipts_operation_valid CHECK (((operation)::text = ANY ((ARRAY['create'::character varying, 'resend'::character varying, 'revoke'::character varying, 'accept'::character varying])::text[]))),
    CONSTRAINT workspace_invitation_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT workspace_invitation_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_invitation_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_invitation_delivery_attempts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    invitation_id uuid NOT NULL,
    invitation_revision integer CONSTRAINT workspace_invitation_delivery_atte_invitation_revision_not_null NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    token_ciphertext text,
    token_nonce character varying(128),
    token_tag character varying(256),
    token_key_version character varying(64),
    provider_reference character varying(512),
    failure_code character varying(128),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    workspace_name character varying(256) NOT NULL,
    CONSTRAINT workspace_invitation_delivery_revision_positive CHECK ((invitation_revision > 0)),
    CONSTRAINT workspace_invitation_delivery_sealed_shape CHECK ((((token_ciphertext IS NULL) AND (token_nonce IS NULL) AND (token_tag IS NULL) AND (token_key_version IS NULL)) OR ((token_ciphertext IS NOT NULL) AND (token_nonce IS NOT NULL) AND (token_tag IS NOT NULL) AND (token_key_version IS NOT NULL)))),
    CONSTRAINT workspace_invitation_delivery_status_valid CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'submitted'::character varying, 'failed'::character varying, 'unknown'::character varying, 'canceled'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_invitation_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_invitations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recipient_email character varying(320) NOT NULL,
    normalized_email character varying(320) NOT NULL,
    role character varying(32) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    token_digest character(64) NOT NULL,
    delivery_status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    created_by uuid NOT NULL,
    accepted_by uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_invitations_delivery_status_valid CHECK (((delivery_status)::text = ANY ((ARRAY['queued'::character varying, 'submitted'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[]))),
    CONSTRAINT workspace_invitations_normalized_email_valid CHECK (((normalized_email)::text = lower(btrim((recipient_email)::text)))),
    CONSTRAINT workspace_invitations_revision_positive CHECK ((revision > 0)),
    CONSTRAINT workspace_invitations_role_valid CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'builder'::character varying, 'operator'::character varying, 'viewer'::character varying])::text[]))),
    CONSTRAINT workspace_invitations_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'revoked'::character varying, 'expired'::character varying])::text[]))),
    CONSTRAINT workspace_invitations_terminal_shape CHECK (((((status)::text = 'accepted'::text) AND (accepted_by IS NOT NULL) AND (accepted_at IS NOT NULL) AND (revoked_at IS NULL)) OR (((status)::text = 'revoked'::text) AND (accepted_by IS NULL) AND (accepted_at IS NULL) AND (revoked_at IS NOT NULL)) OR (((status)::text = ANY ((ARRAY['pending'::character varying, 'expired'::character varying])::text[])) AND (accepted_by IS NULL) AND (accepted_at IS NULL) AND (revoked_at IS NULL)))),
    CONSTRAINT workspace_invitations_token_digest_valid CHECK ((token_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY app.workspace_invitations FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_legal_holds (
    workspace_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    placed_sequence bigint NOT NULL,
    placed_record_hash character(64) NOT NULL,
    legal_authority character varying(256) NOT NULL,
    placement_reason character varying(512) NOT NULL,
    placed_by character varying(128) NOT NULL,
    placed_at timestamp with time zone NOT NULL,
    released_sequence bigint,
    released_record_hash character(64),
    release_authority character varying(256),
    release_reason character varying(512),
    released_by character varying(128),
    released_at timestamp with time zone,
    CONSTRAINT workspace_legal_holds_placement_valid CHECK (((placed_sequence > 0) AND (placed_record_hash ~ '^[0-9a-f]{64}$'::text) AND ((length(btrim((legal_authority)::text)) >= 1) AND (length(btrim((legal_authority)::text)) <= 256)) AND ((length(btrim((placement_reason)::text)) >= 1) AND (length(btrim((placement_reason)::text)) <= 512)) AND ((length(btrim((placed_by)::text)) >= 1) AND (length(btrim((placed_by)::text)) <= 128)))),
    CONSTRAINT workspace_legal_holds_release_valid CHECK ((((released_sequence IS NULL) AND (released_record_hash IS NULL) AND (release_authority IS NULL) AND (release_reason IS NULL) AND (released_by IS NULL) AND (released_at IS NULL)) OR ((released_sequence IS NOT NULL) AND (released_record_hash IS NOT NULL) AND (release_authority IS NOT NULL) AND (release_reason IS NOT NULL) AND (released_by IS NOT NULL) AND (released_at IS NOT NULL) AND (released_sequence > placed_sequence) AND (released_record_hash ~ '^[0-9a-f]{64}$'::text) AND ((length(btrim((release_authority)::text)) >= 1) AND (length(btrim((release_authority)::text)) <= 256)) AND ((length(btrim((release_reason)::text)) >= 1) AND (length(btrim((release_reason)::text)) <= 512)) AND ((length(btrim((released_by)::text)) >= 1) AND (length(btrim((released_by)::text)) <= 128)) AND (released_at >= placed_at))))
);

ALTER TABLE ONLY app.workspace_legal_holds FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_lifecycle_operations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    idempotency_key_hash character(64) NOT NULL,
    command_type character varying(32) NOT NULL,
    actor_user_id uuid NOT NULL,
    reason character varying(512) NOT NULL,
    request_hash character(64) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    lease_owner character varying(128),
    lease_token uuid,
    lease_fence bigint DEFAULT 0 NOT NULL,
    lease_acquired_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    control_sequence bigint,
    control_record_hash character(64),
    error_code character varying(64),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    append_authorized_at timestamp with time zone,
    CONSTRAINT workspace_lifecycle_operations_attempt_nonnegative CHECK ((attempt_count >= 0)),
    CONSTRAINT workspace_lifecycle_operations_authorization_time_valid CHECK (((append_authorized_at IS NULL) OR (append_authorized_at >= occurred_at))),
    CONSTRAINT workspace_lifecycle_operations_command_valid CHECK (((command_type)::text = ANY ((ARRAY['deletion_requested'::character varying, 'deletion_restored'::character varying])::text[]))),
    CONSTRAINT workspace_lifecycle_operations_fence_nonnegative CHECK ((lease_fence >= 0)),
    CONSTRAINT workspace_lifecycle_operations_idempotency_hash_valid CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_lifecycle_operations_lease_valid CHECK (((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text = 'running'::text) AND (lease_owner IS NOT NULL) AND ((length(btrim((lease_owner)::text)) >= 1) AND (length(btrim((lease_owner)::text)) <= 128)) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)),
    CONSTRAINT workspace_lifecycle_operations_reason_bounded CHECK (((length(btrim((reason)::text)) >= 1) AND (length(btrim((reason)::text)) <= 512))),
    CONSTRAINT workspace_lifecycle_operations_request_hash_valid CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_lifecycle_operations_result_paired CHECK (((control_sequence IS NULL) = (control_record_hash IS NULL))),
    CONSTRAINT workspace_lifecycle_operations_result_valid CHECK ((((((status)::text = 'completed'::text) AND (control_sequence IS NOT NULL) AND (control_sequence > 0) AND (control_record_hash IS NOT NULL) AND (control_record_hash ~ '^[0-9a-f]{64}$'::text) AND (completed_at IS NOT NULL) AND (error_code IS NULL) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text = 'failed'::text) AND (control_sequence IS NULL) AND (control_record_hash IS NULL) AND (error_code IS NOT NULL) AND ((length((error_code)::text) >= 1) AND (length((error_code)::text) <= 64)) AND (completed_at IS NOT NULL) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying])::text[])) AND (control_sequence IS NULL) AND (control_record_hash IS NULL) AND (error_code IS NULL) AND (completed_at IS NULL))) IS TRUE)),
    CONSTRAINT workspace_lifecycle_operations_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_lifecycle_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_member_departure_command_receipts (
    id uuid NOT NULL,
    workspace_id uuid CONSTRAINT workspace_member_departure_command_receip_workspace_id_not_null NOT NULL,
    actor_user_id uuid CONSTRAINT workspace_member_departure_command_recei_actor_user_id_not_null NOT NULL,
    target_user_id uuid CONSTRAINT workspace_member_departure_command_rece_target_user_id_not_null NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) CONSTRAINT workspace_member_departure_command_receip_request_hash_not_null NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_member_departure_command_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_member_departure_command_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT workspace_member_departure_command_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_member_departure_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_member_removal_command_receipts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid CONSTRAINT workspace_member_removal_command_receipt_actor_user_id_not_null NOT NULL,
    target_user_id uuid CONSTRAINT workspace_member_removal_command_receip_target_user_id_not_null NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_member_removal_command_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_member_removal_command_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT workspace_member_removal_command_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_member_removal_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_member_role_command_receipts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_member_role_command_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_member_role_command_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT workspace_member_role_command_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_member_role_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_member_suspension_command_receipts (
    id uuid NOT NULL,
    workspace_id uuid CONSTRAINT workspace_member_suspension_command_recei_workspace_id_not_null NOT NULL,
    actor_user_id uuid CONSTRAINT workspace_member_suspension_command_rece_actor_user_id_not_null NOT NULL,
    target_user_id uuid CONSTRAINT workspace_member_suspension_command_rec_target_user_id_not_null NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) CONSTRAINT workspace_member_suspension_command_recei_request_hash_not_null NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT workspace_member_suspension_command_receipt_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT workspace_member_suspension_command_receipt_updated_at_not_null NOT NULL,
    CONSTRAINT workspace_member_suspension_command_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_member_suspension_command_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT workspace_member_suspension_command_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_member_suspension_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_memberships (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(32) NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT workspace_memberships_role_revision_positive CHECK ((role_revision > 0)),
    CONSTRAINT workspace_memberships_role_valid CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'builder'::character varying, 'operator'::character varying, 'viewer'::character varying])::text[]))),
    CONSTRAINT workspace_memberships_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'removed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_memberships FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_ownership_transfer_command_receipts (
    id uuid NOT NULL,
    workspace_id uuid CONSTRAINT workspace_ownership_transfer_command_rece_workspace_id_not_null NOT NULL,
    actor_user_id uuid CONSTRAINT workspace_ownership_transfer_command_rec_actor_user_id_not_null NOT NULL,
    target_user_id uuid CONSTRAINT workspace_ownership_transfer_command_re_target_user_id_not_null NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) CONSTRAINT workspace_ownership_transfer_command_rece_request_hash_not_null NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT workspace_ownership_transfer_command_receip_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT workspace_ownership_transfer_command_receip_updated_at_not_null NOT NULL,
    CONSTRAINT workspace_ownership_transfer_command_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_ownership_transfer_command_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT workspace_ownership_transfer_command_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_ownership_transfer_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_purge_completions (
    job_id uuid NOT NULL,
    command_id uuid NOT NULL,
    actor_ref character varying(128) DEFAULT 'maintenance:workspace-purge'::character varying NOT NULL,
    reason character varying(512) DEFAULT 'Workspace purge completed'::character varying NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    status character varying(16) DEFAULT 'ready'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    lease_owner character varying(128),
    lease_token uuid,
    lease_fence bigint DEFAULT 0 NOT NULL,
    lease_acquired_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    projected_at timestamp with time zone,
    CONSTRAINT workspace_purge_completions_attempt_nonnegative CHECK ((attempt_count >= 0)),
    CONSTRAINT workspace_purge_completions_fence_nonnegative CHECK ((lease_fence >= 0)),
    CONSTRAINT workspace_purge_completions_lease_valid CHECK (((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text = 'running'::text) AND (lease_owner IS NOT NULL) AND ((length(btrim((lease_owner)::text)) >= 1) AND (length(btrim((lease_owner)::text)) <= 128)) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)),
    CONSTRAINT workspace_purge_completions_material_valid CHECK ((((actor_ref)::text = 'maintenance:workspace-purge'::text) AND ((reason)::text = 'Workspace purge completed'::text))),
    CONSTRAINT workspace_purge_completions_projection_valid CHECK ((((((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying])::text[])) AND (projected_at IS NULL)) OR (((status)::text = 'projected'::text) AND (projected_at IS NOT NULL))) IS TRUE)),
    CONSTRAINT workspace_purge_completions_status_valid CHECK (((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying, 'projected'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_purge_completions FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_purge_jobs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    command_id uuid NOT NULL,
    actor_ref character varying(128) NOT NULL,
    reason character varying(512) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    status character varying(16) DEFAULT 'ready'::character varying NOT NULL,
    lease_owner character varying(128),
    lease_token uuid,
    lease_fence bigint DEFAULT 0 NOT NULL,
    lease_acquired_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    control_sequence bigint,
    control_record_hash character(64),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT workspace_purge_jobs_fence_nonnegative CHECK ((lease_fence >= 0)),
    CONSTRAINT workspace_purge_jobs_lease_valid CHECK (((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text = 'running'::text) AND (lease_owner IS NOT NULL) AND ((length(btrim((lease_owner)::text)) >= 1) AND (length(btrim((lease_owner)::text)) <= 128)) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)),
    CONSTRAINT workspace_purge_jobs_material_valid CHECK ((((length(btrim((actor_ref)::text)) >= 1) AND (length(btrim((actor_ref)::text)) <= 128)) AND ((length(btrim((reason)::text)) >= 1) AND (length(btrim((reason)::text)) <= 512)))),
    CONSTRAINT workspace_purge_jobs_projection_valid CHECK ((((((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying])::text[])) AND (control_sequence IS NULL) AND (control_record_hash IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'purging'::text) AND (control_sequence IS NOT NULL) AND (control_record_hash IS NOT NULL) AND (control_record_hash ~ '^[0-9a-f]{64}$'::text) AND (completed_at IS NULL)) OR (((status)::text = 'completed'::text) AND (control_sequence IS NOT NULL) AND (control_record_hash IS NOT NULL) AND (control_record_hash ~ '^[0-9a-f]{64}$'::text) AND (completed_at IS NOT NULL))) IS TRUE)),
    CONSTRAINT workspace_purge_jobs_status_valid CHECK (((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying, 'purging'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_purge_jobs FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_purge_steps (
    job_id uuid NOT NULL,
    step_name character varying(32) NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error_code character varying(64),
    lease_owner character varying(128),
    lease_token uuid,
    lease_fence bigint DEFAULT 0 NOT NULL,
    lease_acquired_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT workspace_purge_steps_attempt_nonnegative CHECK ((attempt_count >= 0)),
    CONSTRAINT workspace_purge_steps_completion_valid CHECK ((((((status)::text = 'completed'::text) AND (completed_at IS NOT NULL)) OR (((status)::text <> 'completed'::text) AND (completed_at IS NULL))) IS TRUE)),
    CONSTRAINT workspace_purge_steps_error_valid CHECK (((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[a-z][a-z0-9_.:-]{0,63}$'::text))),
    CONSTRAINT workspace_purge_steps_fence_nonnegative CHECK ((lease_fence >= 0)),
    CONSTRAINT workspace_purge_steps_lease_valid CHECK (((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR (((status)::text = 'running'::text) AND (lease_owner IS NOT NULL) AND ((length(btrim((lease_owner)::text)) >= 1) AND (length(btrim((lease_owner)::text)) <= 128)) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)),
    CONSTRAINT workspace_purge_steps_name_valid CHECK (((step_name)::text = ANY ((ARRAY['object_versions'::character varying, 'tenant_rows'::character varying])::text[]))),
    CONSTRAINT workspace_purge_steps_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_purge_steps FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspace_rename_command_receipts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_rename_command_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_rename_command_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT workspace_rename_command_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY app.workspace_rename_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE app.workspaces (
    id uuid NOT NULL,
    name character varying(128) NOT NULL,
    slug character varying(64) NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid,
    deletion_requested_at timestamp with time zone,
    deletion_requested_by uuid,
    deletion_reason character varying(512),
    purge_after timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    retention_control_sequence bigint DEFAULT 0 NOT NULL,
    retention_control_hash character(64) DEFAULT repeat('0'::text, 64) NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    auto_pause_threshold smallint DEFAULT 10 NOT NULL,
    CONSTRAINT workspaces_auto_pause_threshold_valid CHECK (((auto_pause_threshold >= 3) AND (auto_pause_threshold <= 100))),
    CONSTRAINT workspaces_deletion_state_valid CHECK (((((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[])) AND (created_by IS NOT NULL) AND (deletion_requested_at IS NULL) AND (deletion_requested_by IS NULL) AND (deletion_reason IS NULL) AND (purge_after IS NULL)) OR (((status)::text = ANY ((ARRAY['pending_deletion'::character varying, 'purging'::character varying])::text[])) AND (created_by IS NOT NULL) AND (deletion_requested_at IS NOT NULL) AND (deletion_requested_by IS NOT NULL) AND (deletion_reason IS NOT NULL) AND ((length(btrim((deletion_reason)::text)) >= 1) AND (length(btrim((deletion_reason)::text)) <= 512)) AND (purge_after IS NOT NULL) AND (purge_after > deletion_requested_at)) OR (((status)::text = 'deleted'::text) AND (created_by IS NULL) AND (deletion_requested_at IS NOT NULL) AND (deletion_requested_by IS NULL) AND ((deletion_reason)::text = 'purged'::text) AND (purge_after IS NOT NULL) AND (purge_after > deletion_requested_at) AND ((name)::text = 'Deleted workspace'::text) AND ((slug)::text = ('deleted-'::text || (id)::text))))),
    CONSTRAINT workspaces_name_nonempty CHECK (((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))),
    CONSTRAINT workspaces_retention_control_hash_format CHECK ((retention_control_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspaces_retention_control_sequence_nonnegative CHECK ((retention_control_sequence >= 0)),
    CONSTRAINT workspaces_revision_positive CHECK ((revision > 0)),
    CONSTRAINT workspaces_slug_format CHECK (((slug)::text ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text)),
    CONSTRAINT workspaces_status_valid CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'pending_deletion'::character varying, 'purging'::character varying, 'deleted'::character varying])::text[])))
);

CREATE TABLE pertexo_internal.preview_retention_transition_capabilities (
    transaction_id xid8 CONSTRAINT preview_retention_transition_capabiliti_transaction_id_not_null NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    target_status character varying(32) CONSTRAINT preview_retention_transition_capabilitie_target_status_not_null NOT NULL,
    CONSTRAINT preview_retention_transition_capabilities_target_status_check CHECK (((target_status)::text = ANY ((ARRAY['deleting'::character varying, 'deleted'::character varying])::text[])))
);

GRANT USAGE ON SCHEMA app TO {{api_runtime_role}};
GRANT USAGE ON SCHEMA app TO {{worker_runtime_role}};
GRANT USAGE ON SCHEMA app TO {{dispatcher_role}};
GRANT USAGE ON SCHEMA app TO {{maintenance_role}};
GRANT USAGE ON SCHEMA app TO {{lifecycle_command_role}};
GRANT USAGE ON SCHEMA app TO {{operator_role}};

GRANT USAGE ON SCHEMA pertexo_internal TO {{api_runtime_role}};
GRANT USAGE ON SCHEMA pertexo_internal TO {{worker_runtime_role}};
GRANT USAGE ON SCHEMA pertexo_internal TO {{dispatcher_role}};
GRANT USAGE ON SCHEMA pertexo_internal TO {{maintenance_role}};
GRANT USAGE ON SCHEMA pertexo_internal TO {{lifecycle_command_role}};
GRANT USAGE ON SCHEMA pertexo_internal TO {{operator_role}};

REVOKE ALL ON FUNCTION app.admit_workflow_organization_batch(p_key_hash text, p_body jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION app.admit_workflow_organization_batch(p_key_hash text, p_body jsonb) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.apply_connection_health_observation(p_workspace uuid, p_observation uuid, p_mode text, p_outbox uuid, p_checksum text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.apply_connection_health_observation(p_workspace uuid, p_observation uuid, p_mode text, p_outbox uuid, p_checksum text) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.apply_workflow_organization_item(p_operation text, p_workflow uuid, p_body jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.apply_workspace_deletion_side_effects() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.apply_workspace_invitation_deletion_side_effects() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) TO {{dispatcher_role}};

REVOKE ALL ON FUNCTION app.arm_workspace_control_projection() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.artifact_capacity_purge_start() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.artifact_capacity_transition() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.assert_workflow_input_cases_enabled() FROM PUBLIC;
GRANT ALL ON FUNCTION app.assert_workflow_input_cases_enabled() TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.assert_workflow_organization_writes_enabled() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.audit_connection_secret_access(p_workspace uuid, p_connection uuid, p_secret uuid, p_actor text, p_request text, p_trace text, p_purpose text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.audit_connection_secret_access(p_workspace uuid, p_connection uuid, p_secret uuid, p_actor text, p_request text, p_trace text, p_purpose text) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.authorize_workspace_lifecycle_append(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION app.authorize_workspace_lifecycle_append(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) TO {{lifecycle_command_role}};

REVOKE ALL ON FUNCTION app.authorize_workspace_purge_completion_append(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_projected_sequence bigint, p_projected_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.authorize_workspace_purge_completion_append(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_projected_sequence bigint, p_projected_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.bind_node_attempt_connection_dispatch(p_workspace uuid, p_attempt uuid, p_worker text, p_fence bigint, p_connection uuid, p_secret uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.bind_node_attempt_connection_dispatch(p_workspace uuid, p_attempt uuid, p_worker text, p_fence bigint, p_connection uuid, p_secret uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.block_incomplete_workspace_deletion() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.cancel_operator_run(uuid, uuid, uuid, character varying, character varying, boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION app.cancel_operator_run(uuid, uuid, uuid, character varying, character varying, boolean) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.canonicalize_workspace_lifecycle_operation_time() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.checkpoint_retention_batch(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_cursor_expires_at timestamp with time zone, p_cursor_id uuid, p_examined_delta integer, p_eligible_delta integer, p_complete boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.checkpoint_workspace_object_versions_page(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_deleted_count integer, p_completed boolean, p_projected_sequence bigint, p_projected_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.checkpoint_workspace_object_versions_page(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_deleted_count integer, p_completed boolean, p_projected_sequence bigint, p_projected_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.claim_authentication_mail(p_worker_id text, p_limit integer, p_lease_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_authentication_mail(p_worker_id text, p_limit integer, p_lease_token uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.claim_due_node_run_wakeups(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_due_node_run_wakeups(p_limit integer) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.claim_due_trigger_schedules(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_due_trigger_schedules(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.claim_retention_batches(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.claim_retention_destructive_batches(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_retention_destructive_batches(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.claim_retention_dry_run_batches(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_retention_dry_run_batches(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.claim_workflow_organization_command(p_operation text, p_target uuid, p_key_hash text, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.claim_workspace_lifecycle_operations(p_lease_owner character varying, p_limit integer, p_lease_interval interval) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_workspace_lifecycle_operations(p_lease_owner character varying, p_limit integer, p_lease_interval interval) TO {{lifecycle_command_role}};

REVOKE ALL ON FUNCTION app.claim_workspace_purge_step(p_job_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_workspace_purge_step(p_job_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.cleanup_connection_health_command() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.complete_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_result_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.complete_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_result_run_id uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.complete_preview_artifact_cleanup(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.complete_preview_artifact_cleanup(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.complete_preview_cleanup(p_workspace_id uuid, p_preview_run_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.complete_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.complete_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.complete_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid, p_occurrence_id uuid, p_scheduled_at timestamp with time zone, p_disposition character varying, p_workflow_run_id uuid, p_next_fire_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.complete_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid, p_occurrence_id uuid, p_scheduled_at timestamp with time zone, p_disposition character varying, p_workflow_run_id uuid, p_next_fire_at timestamp with time zone) TO {{worker_runtime_role}};
GRANT ALL ON FUNCTION app.complete_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid, p_occurrence_id uuid, p_scheduled_at timestamp with time zone, p_disposition character varying, p_workflow_run_id uuid, p_next_fire_at timestamp with time zone) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.complete_workflow_organization_command(p_operation text, p_target uuid, p_key_hash text, p_result jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.complete_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint, p_control_sequence bigint, p_control_record_hash character) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.connection_dispatch_fence_current(p_workspace_id uuid, p_connection_id uuid, p_expected_provider_key text, p_expected_auth_type text, p_secret_version_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.connection_dispatch_fence_current(p_workspace_id uuid, p_connection_id uuid, p_expected_provider_key text, p_expected_auth_type text, p_secret_version_id uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.consume_auth_email_proof(p_digest bytea, p_next_id uuid, p_next_digest bytea, p_next_expires_at timestamp with time zone, p_mail_id uuid, p_mail_expires_at timestamp with time zone, p_ciphertext text, p_nonce text, p_tag text, p_key_version text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.consume_auth_email_proof(p_digest bytea, p_next_id uuid, p_next_digest bytea, p_next_expires_at timestamp with time zone, p_mail_id uuid, p_mail_expires_at timestamp with time zone, p_ciphertext text, p_nonce text, p_tag text, p_key_version text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.consume_webhook_ingress_limit(p_endpoint_key_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.consume_webhook_ingress_limit(p_endpoint_key_hash character) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.create_workflow_duplicate_draft(p_destination uuid, p_workspace uuid, p_source uuid, p_actor uuid, p_name character varying, p_schema integer, p_graph jsonb, p_key_hash character, p_request_hash character, p_kind text, p_version uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.create_workflow_duplicate_draft(p_destination uuid, p_workspace uuid, p_source uuid, p_actor uuid, p_name character varying, p_schema integer, p_graph jsonb, p_key_hash character, p_request_hash character, p_kind text, p_version uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.create_workflow_import_draft(p_destination uuid, p_workspace uuid, p_actor uuid, p_graph jsonb, p_key_hash character, p_request_hash character, p_command text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.create_workflow_import_draft(p_destination uuid, p_workspace uuid, p_actor uuid, p_graph jsonb, p_key_hash character, p_request_hash character, p_command text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.create_workflow_with_draft(p_workflow_id uuid, p_workspace_id uuid, p_name character varying, p_actor_id uuid, p_schema_version integer, p_graph_json jsonb, p_key_hash character, p_request_hash character, p_request_id character varying, p_trace_id character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION app.create_workflow_with_draft(p_workflow_id uuid, p_workspace_id uuid, p_name character varying, p_actor_id uuid, p_schema_version integer, p_graph_json jsonb, p_key_hash character, p_request_hash character, p_request_id character varying, p_trace_id character varying) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.curated_https_endpoint_valid(p_value text) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.curated_template_inventory_matches(p_digest text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.curated_template_inventory_matches(p_digest text) TO {{api_runtime_role}};
GRANT ALL ON FUNCTION app.curated_template_inventory_matches(p_digest text) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.current_workflow_favorite_generation() FROM PUBLIC;
GRANT ALL ON FUNCTION app.current_workflow_favorite_generation() TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.defer_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.defer_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.defer_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid, p_retry_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.defer_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid, p_retry_seconds integer) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.enforce_connection_health_protocol() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.enforce_manual_start_writer() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.enforce_oidc_login_transaction_capacity() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.enforce_preview_artifact_retention() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.enforce_workflow_run_admission() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.enforce_workspace_legal_hold_ledger_links() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.enforce_workspace_retention_control_initial_state() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.enqueue_authentication_mail(p_id uuid, p_purpose text, p_expires_at timestamp with time zone, p_ciphertext text, p_nonce text, p_tag text, p_key_version text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.enqueue_authentication_mail(p_id uuid, p_purpose text, p_expires_at timestamp with time zone, p_ciphertext text, p_nonce text, p_tag text, p_key_version text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.execute_operator_execution_command(p_command_id uuid, p_command_type character varying, p_workspace_id uuid, p_target_id uuid, p_expected_fence bigint, p_action character varying, p_evidence_kind character varying, p_evidence_ref jsonb, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.execute_standard_retention_dry_run_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_standard_retention_dry_run_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.execute_standard_retention_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer, p_expected_control_sequence bigint, p_expected_control_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_standard_retention_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer, p_expected_control_sequence bigint, p_expected_control_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.execute_workflow_favorite_command(p_workflow_id uuid, p_key_hash text, p_body jsonb, p_verified_generation uuid, p_issued_seconds bigint, p_expires_seconds bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workflow_favorite_command(p_workflow_id uuid, p_key_hash text, p_body jsonb, p_verified_generation uuid, p_issued_seconds bigint, p_expires_seconds bigint) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.execute_workflow_folder_command(p_operation text, p_folder uuid, p_key_hash text, p_body jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workflow_folder_command(p_operation text, p_folder uuid, p_key_hash text, p_body jsonb) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.execute_workflow_folder_placement(p_workflow uuid, p_key_hash text, p_body jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workflow_folder_placement(p_workflow uuid, p_key_hash text, p_body jsonb) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.execute_workflow_organization_batch_item(p_parent_key_hash text, p_body jsonb, p_workflow uuid, p_item_key_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workflow_organization_batch_item(p_parent_key_hash text, p_body jsonb, p_workflow uuid, p_item_key_hash text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.execute_workflow_run_input_retention_dry_run_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workflow_run_input_retention_dry_run_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.execute_workflow_run_input_retention_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer, p_expected_control_sequence bigint, p_expected_control_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workflow_run_input_retention_page(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_limit integer, p_expected_control_sequence bigint, p_expected_control_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.execute_workflow_tag_assignment_command(p_operation text, p_workflow_id uuid, p_key_hash text, p_body jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workflow_tag_assignment_command(p_operation text, p_workflow_id uuid, p_key_hash text, p_body jsonb) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.execute_workflow_tag_command(p_operation text, p_tag_id uuid, p_key_hash text, p_body jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workflow_tag_command(p_operation text, p_tag_id uuid, p_key_hash text, p_body jsonb) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execute_workspace_tenant_rows_page(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page_before_folders(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page_before_input_cases(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page_before_organization(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_page_size integer, p_projected_sequence bigint, p_projected_hash character) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.expire_workspace_inbox_threads(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.expire_workspace_inbox_threads(p_limit integer) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.fail_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_safe_error_code character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION app.fail_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_safe_error_code character varying) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.fail_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.fail_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.fail_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint, p_error_code character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION app.fail_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint, p_error_code character varying) TO {{lifecycle_command_role}};

REVOKE ALL ON FUNCTION app.find_due_preview_cleanup(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.find_due_preview_cleanup(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.find_due_run_artifact_retention(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.find_due_run_artifact_retention(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.find_due_workspace_purge() FROM PUBLIC;
GRANT ALL ON FUNCTION app.find_due_workspace_purge() TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.find_due_workspace_purge_completion() FROM PUBLIC;
GRANT ALL ON FUNCTION app.find_due_workspace_purge_completion() TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.find_due_workspace_purge_step() FROM PUBLIC;
GRANT ALL ON FUNCTION app.find_due_workspace_purge_step() TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.finish_preview_cleanup(p_workspace_id uuid, p_preview_run_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.finish_preview_cleanup(p_workspace_id uuid, p_preview_run_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.fold_workflow_trigger_outcomes(p_limit integer, p_enforce boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION app.fold_workflow_trigger_outcomes(p_limit integer, p_enforce boolean) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.fold_workspace_inbox_events(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.fold_workspace_inbox_events(p_limit integer) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.get_operator_command(p_command_id uuid, p_workspace_id uuid, p_actor_ref character varying, p_reason character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION app.get_operator_command(p_command_id uuid, p_workspace_id uuid, p_actor_ref character varying, p_reason character varying) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.guard_curated_template_descriptor() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.guard_preview_artifact_destruction() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.guard_workflow_input_case_write() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.inspect_auth_email_proof(p_digest bytea) FROM PUBLIC;
GRANT ALL ON FUNCTION app.inspect_auth_email_proof(p_digest bytea) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.invalidate_workflow_favorite_membership() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.issue_auth_email_proof(p_id uuid, p_digest bytea, p_user_id uuid, p_purpose text, p_email text, p_new_email text, p_expires_at timestamp with time zone, p_mail_id uuid, p_mail_purpose text, p_mail_expires_at timestamp with time zone, p_ciphertext text, p_nonce text, p_tag text, p_key_version text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.issue_auth_email_proof(p_id uuid, p_digest bytea, p_user_id uuid, p_purpose text, p_email text, p_new_email text, p_expires_at timestamp with time zone, p_mail_id uuid, p_mail_purpose text, p_mail_expires_at timestamp with time zone, p_ciphertext text, p_nonce text, p_tag text, p_key_version text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.jsonb_references_artifact(p_value jsonb, p_artifact_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.lock_curated_template_descriptor(p_id text, p_version integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_curated_template_descriptor(p_id text, p_version integer) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_execution_artifact_references() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.lock_failure_notification_dispatch_destination(p_workspace_id uuid, p_intent_id uuid, p_attempt_number integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_failure_notification_dispatch_destination(p_workspace_id uuid, p_intent_id uuid, p_attempt_number integer) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_manual_workflow_run_start(p_actor uuid, p_workflow uuid, p_scope text, p_key_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_manual_workflow_run_start(p_actor uuid, p_workflow uuid, p_scope text, p_key_hash text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_notification_connection(p_workspace uuid, p_connection uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_notification_connection(p_workspace uuid, p_connection uuid) TO {{api_runtime_role}};
GRANT ALL ON FUNCTION app.lock_notification_connection(p_workspace uuid, p_connection uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_workflow_failure_notification_policy(p_workspace_id uuid, p_workflow_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_failure_notification_policy(p_workspace_id uuid, p_workflow_id uuid) TO {{api_runtime_role}};
GRANT ALL ON FUNCTION app.lock_workflow_failure_notification_policy(p_workspace_id uuid, p_workflow_id uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_workflow_favorite_generation(p_update boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.lock_workflow_organization_authority(p_roles text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.lock_workflow_organization_coordination(p_exclusive boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.lock_workflow_organization_for_lifecycle() FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_organization_for_lifecycle() TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_workflow_portable_version(p_workspace uuid, p_workflow uuid, p_version uuid, p_actor uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_portable_version(p_workspace uuid, p_workflow uuid, p_version uuid, p_actor uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_source(p_workspace_id uuid, p_source_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_run_replay_source(p_workspace_id uuid, p_source_run_id uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.lock_workspace_control_ledger(p_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workspace_control_ledger(p_workspace_id uuid) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.lock_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) TO {{lifecycle_command_role}};

REVOKE ALL ON FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) TO {{api_runtime_role}};
GRANT ALL ON FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.minimize_terminal_workspace_invitation_pii(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.minimize_terminal_workspace_invitation_pii(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.populate_operator_command_result() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.prepare_preview_cleanup_step(p_workspace_id uuid, p_preview_run_id uuid, p_quiescence_seconds integer, p_expected_control_sequence bigint, p_expected_control_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prepare_preview_cleanup_step(p_workspace_id uuid, p_preview_run_id uuid, p_quiescence_seconds integer, p_expected_control_sequence bigint, p_expected_control_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.prepare_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prepare_run_artifact_retention(p_workspace_id uuid, p_artifact_id uuid, p_expected_control_sequence bigint, p_expected_control_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.prepare_workflow_favorite_command(p_workflow_id uuid, p_key_hash text, p_body jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prepare_workflow_favorite_command(p_workflow_id uuid, p_key_hash text, p_body jsonb) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.prepare_workspace_purge_completion(p_job_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prepare_workspace_purge_completion(p_job_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.prepare_workspace_purge_job(p_workspace_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prepare_workspace_purge_job(p_workspace_id uuid, p_projected_sequence bigint, p_projected_hash character, p_lease_owner character varying, p_lease_interval interval) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.preserve_workspace_inbox_read_revision() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.process_operator_maintenance_rerun() FROM PUBLIC;
GRANT ALL ON FUNCTION app.process_operator_maintenance_rerun() TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.project_and_complete_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.project_and_complete_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) TO {{lifecycle_command_role}};

REVOKE ALL ON FUNCTION app.project_workspace_deletion(p_workspace_id uuid, p_sequence bigint, p_command_id uuid, p_command_type character varying, p_subject_id uuid, p_previous_hash character, p_record_hash character, p_actor_ref character varying, p_legal_authority character varying, p_reason character varying, p_occurred_at timestamp with time zone, p_recovery_interval interval) FROM PUBLIC;
GRANT ALL ON FUNCTION app.project_workspace_deletion(p_workspace_id uuid, p_sequence bigint, p_command_id uuid, p_command_type character varying, p_subject_id uuid, p_previous_hash character, p_record_hash character, p_actor_ref character varying, p_legal_authority character varying, p_reason character varying, p_occurred_at timestamp with time zone, p_recovery_interval interval) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.project_workspace_purge_completion(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.project_workspace_purge_completion(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.project_workspace_purge_started(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.project_workspace_purge_started(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint, p_sequence bigint, p_previous_hash character, p_record_hash character) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.provision_retention_schedule_state() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.provision_workspace_execution_admission() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.prune_auth_email_evidence(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prune_auth_email_evidence(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.prune_auth_legacy_method_migration_attempts(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prune_auth_legacy_method_migration_attempts(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.prune_auth_method_link_attempts(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prune_auth_method_link_attempts(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.prune_authentication_mail(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prune_authentication_mail(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.prune_expired_auth_sessions(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prune_expired_auth_sessions(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.prune_manual_start_rejections(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.prune_manual_start_rejections(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.read_workflow_favorite_generation() FROM PUBLIC;
GRANT ALL ON FUNCTION app.read_workflow_favorite_generation() TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.read_workspace_lifecycle_operation(p_workspace_id uuid, p_operation_id uuid, p_actor_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.read_workspace_lifecycle_operation(p_workspace_id uuid, p_operation_id uuid, p_actor_user_id uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.reap_transient_data(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.reap_transient_data(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.reap_workflow_input_cases(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.reap_workflow_input_cases(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.reap_workflow_organization(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.reap_workflow_organization(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.reap_workspace_invitation_transients(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.reap_workspace_invitation_transients(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.reconcile_operator_attempt(p_command_id uuid, p_workspace_id uuid, p_attempt_id uuid, p_expected_fence bigint, p_action character varying, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION app.reconcile_operator_attempt(p_command_id uuid, p_workspace_id uuid, p_attempt_id uuid, p_expected_fence bigint, p_action character varying, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.reconcile_workspace_execution_admission(p_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.reconcile_workspace_execution_admission(p_workspace_id uuid) TO {{api_runtime_role}};
GRANT ALL ON FUNCTION app.reconcile_workspace_execution_admission(p_workspace_id uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.record_identity_method_audit_fact(p_user_id uuid, p_event_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.record_identity_method_audit_fact(p_user_id uuid, p_event_type text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.record_identity_profile_audit_fact(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.record_identity_profile_audit_fact(p_user_id uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.record_node_attempt_connection_health(p_workspace uuid, p_attempt uuid, p_worker text, p_fence bigint, p_kind text, p_reason text, p_mode text, p_observation uuid, p_outbox uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.record_node_attempt_connection_health(p_workspace uuid, p_attempt uuid, p_worker text, p_fence bigint, p_kind text, p_reason text, p_mode text, p_observation uuid, p_outbox uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.record_operator_unknown_outcome_evidence(uuid, uuid, uuid, character varying, jsonb, character varying, character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION app.record_operator_unknown_outcome_evidence(uuid, uuid, uuid, character varying, jsonb, character varying, character varying) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.record_workflow_organization_audit(p_action text, p_target uuid, p_metadata jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.recover_due_run_failure_notifications(p_limit integer, p_max_attempts integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.recover_due_run_failure_notifications(p_limit integer, p_max_attempts integer) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer) TO {{dispatcher_role}};

REVOKE ALL ON FUNCTION app.redispatch_failed_outbox_event(p_command_id uuid, p_workspace_id uuid, p_outbox_event_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION app.redispatch_failed_outbox_event(p_command_id uuid, p_workspace_id uuid, p_outbox_event_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.refresh_workflow_run_admission_counters() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_connection_history_change() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_execution_entitlement_version_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_failure_notification_destination_version_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_preview_run_pin_change() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_retention_batch_direct_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_retention_control_fact_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_trigger_schedule_config_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_webhook_trigger_secret_version_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_workflow_version_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_workspace_control_direct_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_workspace_legal_hold_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_workspace_lifecycle_operation_direct_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reject_workspace_purge_direct_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) TO {{dispatcher_role}};

REVOKE ALL ON FUNCTION app.release_retention_batch(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_retention_batch(p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.release_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_workspace_lifecycle_operation(p_operation_id uuid, p_lease_token uuid, p_lease_fence bigint) TO {{lifecycle_command_role}};

REVOKE ALL ON FUNCTION app.release_workspace_purge_completion(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_workspace_purge_completion(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.release_workspace_purge_job(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_workspace_purge_job(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.release_workspace_purge_step(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_workspace_purge_step(p_job_id uuid, p_lease_token uuid, p_lease_fence bigint) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.request_operator_maintenance_rerun(p_command_id uuid, p_workspace_id uuid, p_target_type character varying, p_target_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION app.request_operator_maintenance_rerun(p_command_id uuid, p_workspace_id uuid, p_target_type character varying, p_target_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.request_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_source_run_id uuid, p_workflow_version_id uuid, p_run_input jsonb, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION app.request_operator_run_replay(p_command_id uuid, p_workspace_id uuid, p_source_run_id uuid, p_workflow_version_id uuid, p_run_input jsonb, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.request_workspace_lifecycle_operation(p_id uuid, p_workspace_id uuid, p_idempotency_key_hash character, p_command_type character varying, p_actor_user_id uuid, p_reason character varying, p_request_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.request_workspace_lifecycle_operation(p_id uuid, p_workspace_id uuid, p_idempotency_key_hash character, p_command_type character varying, p_actor_user_id uuid, p_reason character varying, p_request_hash character) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.require_active_workspace_integration() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.require_new_failure_notification_intent_pin() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.reserve_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.reserve_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) TO {{dispatcher_role}};

REVOKE ALL ON FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.resume_operator_due_work(uuid, uuid, uuid, character varying, character varying, boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION app.resume_operator_due_work(uuid, uuid, uuid, character varying, character varying, boolean) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.retry_operator_trigger_reconciliation(p_command_id uuid, p_workspace_id uuid, p_workflow_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION app.retry_operator_trigger_reconciliation(p_command_id uuid, p_workspace_id uuid, p_workflow_id uuid, p_actor_ref character varying, p_reason character varying, p_dry_run boolean) TO {{operator_role}};

REVOKE ALL ON FUNCTION app.revoke_auth_sessions_for_email_change() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.revoke_auth_sessions_for_inactive_user() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.revoke_auth_sessions_for_workspace_unavailability() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.scan_workspace_invitation_replacement_claims(p_scan_kind character varying, p_scan_id uuid, p_workspace_id uuid, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.schedule_claim_is_eligible(p_trigger_id uuid, p_lease_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.schedule_claim_is_eligible(p_trigger_id uuid, p_lease_token uuid) TO {{worker_runtime_role}};
GRANT ALL ON FUNCTION app.schedule_claim_is_eligible(p_trigger_id uuid, p_lease_token uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid, p_lease_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid, p_lease_token uuid) TO {{worker_runtime_role}};
GRANT ALL ON FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid, p_lease_token uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid, p_lease_token uuid, p_scheduled_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid, p_lease_token uuid, p_scheduled_at timestamp with time zone) TO {{api_runtime_role}};
GRANT ALL ON FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid, p_lease_token uuid, p_scheduled_at timestamp with time zone) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.schedule_workflow_run_input_retention(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.schedule_workflow_run_input_retention(p_limit integer) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.settle_authentication_mail(p_id uuid, p_lease_token uuid, p_lease_generation bigint, p_outcome text, p_provider_reference text, p_failure_code text, p_retry_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.settle_authentication_mail(p_id uuid, p_lease_token uuid, p_lease_generation bigint, p_outcome text, p_provider_reference text, p_failure_code text, p_retry_at timestamp with time zone) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.standard_retention_dry_run_stage_keys(p_workspace_id uuid, p_retention_kind character varying, p_retention_stage character varying, p_cutoff_at timestamp with time zone, p_cursor jsonb, p_upper jsonb, p_descending boolean, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.start_retention_batch(p_id uuid, p_workspace_id uuid, p_idempotency_key character varying, p_retention_kind character varying, p_cutoff_at timestamp with time zone, p_dry_run boolean, p_requested_by character varying, p_reason character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION app.start_retention_batch(p_id uuid, p_workspace_id uuid, p_idempotency_key character varying, p_retention_kind character varying, p_cutoff_at timestamp with time zone, p_dry_run boolean, p_requested_by character varying, p_reason character varying) TO {{maintenance_role}};

REVOKE ALL ON FUNCTION app.validate_workflow_run_failure_notification_pin() FROM PUBLIC;

REVOKE ALL ON FUNCTION app.verify_curated_template_origin(p_manifest jsonb, p_origin jsonb, p_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workflow_auto_pause_control(p_workspace uuid, p_actor uuid, p_workflow uuid, p_operation text, p_request jsonb, p_key_hash text, p_request_hash text, p_request_id text, p_trace_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workflow_auto_pause_control(p_workspace uuid, p_actor uuid, p_workflow uuid, p_operation text, p_request jsonb, p_key_hash text, p_request_hash text, p_request_id text, p_trace_id text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.workflow_concurrency_admissible(p_workspace uuid, p_run uuid, p_grant boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workflow_concurrency_control(p_workspace uuid, p_actor uuid, p_workflow uuid, p_operation text, p_request jsonb, p_key_hash text, p_request_hash text, p_request_id text, p_trace_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workflow_concurrency_control(p_workspace uuid, p_actor uuid, p_workflow uuid, p_operation text, p_request jsonb, p_key_hash text, p_request_hash text, p_request_id text, p_trace_id text) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.workflow_favorite_command_body(p_body jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workflow_folder_command_body(p_operation text, p_body jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workflow_folder_depth(p_workspace uuid, p_folder uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workflow_organization_batch_body(p_body jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workflow_organization_revision(p_value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workflow_organization_uuid(p_value jsonb, p_nullable boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) TO {{dispatcher_role}};

REVOKE ALL ON FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) TO {{worker_runtime_role}};

REVOKE ALL ON FUNCTION app.workflow_run_admission_blockers(p_workspace uuid, p_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workflow_run_admission_blockers(p_workspace uuid, p_run uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid, p_user_id uuid) TO {{api_runtime_role}};

REVOKE ALL ON FUNCTION app.workspace_invitation_replacement_claim_is_reapable(p_prior_workspace_id uuid, p_prior_intent_id uuid, p_prior_binding_digest character) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workspace_purge_immutable_delete_is_armed(p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION app.workspace_reserved_active_slot_count(p_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workspace_reserved_active_slot_count(p_workspace_id uuid) TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.artifact_links TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.artifact_links TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.artifacts TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.artifacts TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.artifacts TO {{api_runtime_role}};
GRANT UPDATE(status) ON TABLE app.artifacts TO {{worker_runtime_role}};

GRANT UPDATE(expires_at) ON TABLE app.artifacts TO {{api_runtime_role}};
GRANT UPDATE(expires_at) ON TABLE app.artifacts TO {{worker_runtime_role}};

GRANT UPDATE(finalized_at) ON TABLE app.artifacts TO {{api_runtime_role}};
GRANT UPDATE(finalized_at) ON TABLE app.artifacts TO {{worker_runtime_role}};

GRANT UPDATE(deleted_at) ON TABLE app.artifacts TO {{api_runtime_role}};
GRANT UPDATE(deleted_at) ON TABLE app.artifacts TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.artifacts TO {{api_runtime_role}};
GRANT UPDATE(updated_at) ON TABLE app.artifacts TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.audit_events TO {{api_runtime_role}};
GRANT INSERT ON TABLE app.audit_events TO {{worker_runtime_role}};

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_accounts TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.auth_identities TO {{api_runtime_role}};

GRANT UPDATE(profile_metadata) ON TABLE app.auth_identities TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.auth_identities TO {{api_runtime_role}};

GRANT UPDATE(native_method_verified_at) ON TABLE app.auth_identities TO {{api_runtime_role}};

GRANT SELECT,INSERT,UPDATE ON TABLE app.auth_legacy_method_migration_attempts TO {{api_runtime_role}};

GRANT SELECT,INSERT,UPDATE ON TABLE app.auth_method_link_attempts TO {{api_runtime_role}};

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_sessions TO {{api_runtime_role}};

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_verifications TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.connection_events TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.connection_health_observations TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.connection_secret_versions TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.connection_secret_versions TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.connections TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.connections TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(current_secret_version_id) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(last_tested_at) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(last_healthy_at) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(last_error_code) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(health_revision) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(last_run_observed_at) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(last_health_transition_at) ON TABLE app.connections TO {{api_runtime_role}};

GRANT UPDATE(last_health_transition_source) ON TABLE app.connections TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.curated_template_descriptors TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.curated_template_rollout TO {{api_runtime_role}};

GRANT UPDATE(singleton) ON TABLE app.curated_template_rollout TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.failure_notification_destination_versions TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.failure_notification_destination_versions TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.failure_notification_destinations TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.failure_notification_destinations TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.failure_notification_destinations TO {{api_runtime_role}};

GRANT UPDATE(current_config_version) ON TABLE app.failure_notification_destinations TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.failure_notification_destinations TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.idempotency_records TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.idempotency_records TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.idempotency_records TO {{api_runtime_role}};
GRANT UPDATE(status) ON TABLE app.idempotency_records TO {{worker_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.idempotency_records TO {{api_runtime_role}};
GRANT UPDATE(result_ref) ON TABLE app.idempotency_records TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.idempotency_records TO {{api_runtime_role}};
GRANT UPDATE(updated_at) ON TABLE app.idempotency_records TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.inbox_receipts TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.inbox_receipts TO {{worker_runtime_role}};

GRANT UPDATE(completed_at) ON TABLE app.inbox_receipts TO {{api_runtime_role}};
GRANT UPDATE(completed_at) ON TABLE app.inbox_receipts TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.node_attempt_connection_dispatches TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.node_attempts TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(lease_owner) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(lease_expires_at) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(fence_token) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(dispatch_marked_at) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(output_ref) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(safe_error_code) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(error_summary) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(reconciliation_ref) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(started_at) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(completed_at) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(executor_failure_kind) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(executor_error_kind) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(executor_possibly_dispatched) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT UPDATE(retry_decision) ON TABLE app.node_attempts TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.node_runs TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(input_ref) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(output_ref) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(current_attempt_id) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(current_attempt_number) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(resume_at) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(retry_due_at) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(safe_error_code) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(started_at) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(completed_at) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(due_wakeup_at) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(control_kind) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(wait_kind) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT UPDATE(provider_dispatch_binding) ON TABLE app.node_runs TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.oidc_login_transactions TO {{api_runtime_role}};

GRANT UPDATE(consumed_at) ON TABLE app.oidc_login_transactions TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.operator_run_replay_requests TO {{worker_runtime_role}};

GRANT SELECT(command_id) ON TABLE app.operator_unknown_outcome_evidence TO {{worker_runtime_role}};

GRANT SELECT(workspace_id) ON TABLE app.operator_unknown_outcome_evidence TO {{worker_runtime_role}};

GRANT SELECT(attempt_id) ON TABLE app.operator_unknown_outcome_evidence TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.outbox_events TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.outbox_events TO {{worker_runtime_role}};
GRANT SELECT ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(available_at) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(lease_owner) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(lease_token) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(lease_expires_at) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(publish_attempts) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(published_at) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(failed_at) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(last_error_code) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT UPDATE(updated_at) ON TABLE app.outbox_events TO {{dispatcher_role}};

GRANT SELECT ON TABLE app.outbox_fair_dispatch_cursor TO {{dispatcher_role}};

GRANT UPDATE(last_workspace_id) ON TABLE app.outbox_fair_dispatch_cursor TO {{dispatcher_role}};

GRANT UPDATE(updated_at) ON TABLE app.outbox_fair_dispatch_cursor TO {{dispatcher_role}};

GRANT SELECT,INSERT ON TABLE app.preview_attempts TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(lease_owner) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(lease_expires_at) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(fence_token) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(dispatch_marked_at) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(output_ref) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(safe_error_code) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(reconciliation_ref) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(started_at) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(completed_at) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT UPDATE(provider_dispatch_binding) ON TABLE app.preview_attempts TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.preview_runs TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.preview_runs TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.preview_runs TO {{worker_runtime_role}};

GRANT UPDATE(output_ref) ON TABLE app.preview_runs TO {{worker_runtime_role}};

GRANT UPDATE(safe_error_code) ON TABLE app.preview_runs TO {{worker_runtime_role}};

GRANT UPDATE(started_at) ON TABLE app.preview_runs TO {{worker_runtime_role}};

GRANT UPDATE(completed_at) ON TABLE app.preview_runs TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.preview_runs TO {{worker_runtime_role}};

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.rls_probe_records TO {{api_runtime_role}};
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.rls_probe_records TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.run_checkpoints TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(revision) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(engine_version) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(scheduler_state) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(resume_at) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(resume_lease_owner) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(resume_lease_token) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(resume_lease_expires_at) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT UPDATE(last_transition_fingerprint) ON TABLE app.run_checkpoints TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.run_events TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.run_events TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.run_failure_notification_audit_facts TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.run_failure_notification_audit_facts TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.run_failure_notification_intents TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(delivery_attempts) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(dispatch_marked_at) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(recovery_at) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(next_delivery_at) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(safe_error_code) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(possibly_dispatched) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(provider_reference) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(completed_at) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT UPDATE(delivery_binding) ON TABLE app.run_failure_notification_intents TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.sessions TO {{api_runtime_role}};

GRANT UPDATE(revoked_at) ON TABLE app.sessions TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.transport_security_audit_facts TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.transport_security_audit_facts TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.trigger_schedule_occurrences TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(next_fire_at) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(next_fire_at) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(last_fire_at) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(last_fire_at) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(status) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(health_status) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(health_status) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(last_error_code) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(last_error_code) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(lease_owner) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(lease_owner) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(lease_token) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(lease_token) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(lease_acquired_at) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(lease_acquired_at) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(lease_expires_at) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(lease_expires_at) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.trigger_schedules TO {{api_runtime_role}};
GRANT UPDATE(updated_at) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT UPDATE(admission_deferred_until) ON TABLE app.trigger_schedules TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.usage_events TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.usage_events TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.user_profile_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.user_profile_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.user_profile_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.user_profile_command_receipts TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.users TO {{api_runtime_role}};

GRANT UPDATE(email) ON TABLE app.users TO {{api_runtime_role}};

GRANT UPDATE(display_name) ON TABLE app.users TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.users TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.users TO {{api_runtime_role}};

GRANT UPDATE(email_verified) ON TABLE app.users TO {{api_runtime_role}};

GRANT UPDATE(image) ON TABLE app.users TO {{api_runtime_role}};

GRANT UPDATE(profile_revision) ON TABLE app.users TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.webhook_trigger_deliveries TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.webhook_trigger_endpoints TO {{api_runtime_role}};

GRANT SELECT(id) ON TABLE app.webhook_trigger_endpoints TO {{worker_runtime_role}};

GRANT SELECT(workspace_id) ON TABLE app.webhook_trigger_endpoints TO {{worker_runtime_role}};

GRANT SELECT(trigger_id) ON TABLE app.webhook_trigger_endpoints TO {{worker_runtime_role}};

GRANT UPDATE(endpoint_key_hash) ON TABLE app.webhook_trigger_endpoints TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.webhook_trigger_endpoints TO {{api_runtime_role}};
GRANT SELECT(status),UPDATE(status) ON TABLE app.webhook_trigger_endpoints TO {{worker_runtime_role}};

GRANT UPDATE(current_secret_version_id) ON TABLE app.webhook_trigger_endpoints TO {{api_runtime_role}};

GRANT UPDATE(previous_secret_version_id) ON TABLE app.webhook_trigger_endpoints TO {{api_runtime_role}};

GRANT UPDATE(previous_secret_valid_until) ON TABLE app.webhook_trigger_endpoints TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.webhook_trigger_endpoints TO {{api_runtime_role}};
GRANT UPDATE(updated_at) ON TABLE app.webhook_trigger_endpoints TO {{worker_runtime_role}};

GRANT SELECT,INSERT,DELETE ON TABLE app.webhook_trigger_replay_records TO {{api_runtime_role}};

GRANT UPDATE(workflow_run_id) ON TABLE app.webhook_trigger_replay_records TO {{api_runtime_role}};

GRANT INSERT ON TABLE app.webhook_trigger_secret_versions TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_drafts TO {{api_runtime_role}};

GRANT UPDATE(revision) ON TABLE app.workflow_drafts TO {{api_runtime_role}};

GRANT UPDATE(schema_version) ON TABLE app.workflow_drafts TO {{api_runtime_role}};

GRANT UPDATE(graph_json) ON TABLE app.workflow_drafts TO {{api_runtime_role}};

GRANT UPDATE(updated_by) ON TABLE app.workflow_drafts TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workflow_drafts TO {{api_runtime_role}};

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_failure_notification_policies TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_favorite_receipts TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_favorites TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_folders TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workflow_input_case_payloads TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workflow_input_case_receipts TO {{api_runtime_role}};

GRANT SELECT,UPDATE ON TABLE app.workflow_input_case_rollout TO {{operator_role}};

GRANT SELECT,INSERT,UPDATE ON TABLE app.workflow_input_cases TO {{api_runtime_role}};

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_integration_usage TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workflow_manual_start_rejections TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_organization_rollout TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_organization_state TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_portability_rollout TO {{api_runtime_role}};

GRANT UPDATE(singleton) ON TABLE app.workflow_portability_rollout TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workflow_runs TO {{api_runtime_role}};
GRANT SELECT,INSERT ON TABLE app.workflow_runs TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workflow_runs TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workflow_runs TO {{worker_runtime_role}};
GRANT UPDATE(updated_at) ON TABLE app.workflow_runs TO {{api_runtime_role}};

GRANT UPDATE(cancel_requested_at) ON TABLE app.workflow_runs TO {{api_runtime_role}};

GRANT UPDATE(cancel_requested_by) ON TABLE app.workflow_runs TO {{api_runtime_role}};

GRANT UPDATE(cancel_reason) ON TABLE app.workflow_runs TO {{api_runtime_role}};

GRANT UPDATE(started_at) ON TABLE app.workflow_runs TO {{worker_runtime_role}};

GRANT UPDATE(completed_at) ON TABLE app.workflow_runs TO {{worker_runtime_role}};

GRANT UPDATE(output_ref) ON TABLE app.workflow_runs TO {{worker_runtime_role}};

GRANT UPDATE(error_summary) ON TABLE app.workflow_runs TO {{worker_runtime_role}};

GRANT UPDATE(deadline_wakeup_at) ON TABLE app.workflow_runs TO {{owner_role}};
GRANT UPDATE(deadline_wakeup_at) ON TABLE app.workflow_runs TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.workflow_tag_assignments TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_tags TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workflow_template_origins TO {{api_runtime_role}};

GRANT INSERT ON TABLE app.workflow_trigger_outcomes TO {{worker_runtime_role}};

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_triggers TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.workflow_triggers TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workflow_triggers TO {{api_runtime_role}};
GRANT UPDATE(status) ON TABLE app.workflow_triggers TO {{worker_runtime_role}};

GRANT UPDATE(desired_config) ON TABLE app.workflow_triggers TO {{api_runtime_role}};

GRANT UPDATE(config_fingerprint) ON TABLE app.workflow_triggers TO {{api_runtime_role}};

GRANT UPDATE(health_status) ON TABLE app.workflow_triggers TO {{api_runtime_role}};
GRANT UPDATE(health_status) ON TABLE app.workflow_triggers TO {{worker_runtime_role}};

GRANT UPDATE(last_error_code) ON TABLE app.workflow_triggers TO {{api_runtime_role}};
GRANT UPDATE(last_error_code) ON TABLE app.workflow_triggers TO {{worker_runtime_role}};

GRANT UPDATE(reconciled_at) ON TABLE app.workflow_triggers TO {{api_runtime_role}};
GRANT UPDATE(reconciled_at) ON TABLE app.workflow_triggers TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workflow_triggers TO {{api_runtime_role}};
GRANT UPDATE(updated_at) ON TABLE app.workflow_triggers TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workflow_versions TO {{api_runtime_role}};

GRANT SELECT(id) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT(workspace_id) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT(workflow_id) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT(version_number) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT(schema_version) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT(checksum) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT(executable_schema_version) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT(executable_json) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT(compatibility_release_epoch) ON TABLE app.workflow_versions TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.workflows TO {{api_runtime_role}};

GRANT SELECT(id) ON TABLE app.workflows TO {{worker_runtime_role}};

GRANT SELECT(workspace_id) ON TABLE app.workflows TO {{worker_runtime_role}};

GRANT UPDATE(name) ON TABLE app.workflows TO {{api_runtime_role}};

GRANT UPDATE(lifecycle_status) ON TABLE app.workflows TO {{api_runtime_role}};
GRANT SELECT(lifecycle_status) ON TABLE app.workflows TO {{worker_runtime_role}};

GRANT UPDATE(activation_status) ON TABLE app.workflows TO {{api_runtime_role}};
GRANT SELECT(activation_status),UPDATE(activation_status) ON TABLE app.workflows TO {{worker_runtime_role}};

GRANT UPDATE(published_version_id) ON TABLE app.workflows TO {{api_runtime_role}};
GRANT SELECT(published_version_id) ON TABLE app.workflows TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workflows TO {{api_runtime_role}};
GRANT UPDATE(updated_at) ON TABLE app.workflows TO {{worker_runtime_role}};

GRANT UPDATE(lifecycle_revision) ON TABLE app.workflows TO {{api_runtime_role}};

GRANT UPDATE(name_revision) ON TABLE app.workflows TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workspace_artifact_capacity TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.workspace_artifact_capacity TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_creation_idempotency_records TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_creation_idempotency_records TO {{api_runtime_role}};

GRANT UPDATE(resource_id) ON TABLE app.workspace_creation_idempotency_records TO {{api_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.workspace_creation_idempotency_records TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_creation_idempotency_records TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workspace_execution_admission_counters TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.workspace_execution_admission_counters TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.workspace_execution_entitlement_versions TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.workspace_execution_entitlement_versions TO {{worker_runtime_role}};

GRANT SELECT ON TABLE app.workspace_execution_entitlements TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.workspace_execution_entitlements TO {{worker_runtime_role}};

GRANT INSERT ON TABLE app.workspace_inbox_events TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_inbox_reads TO {{api_runtime_role}};

GRANT UPDATE(read_revision) ON TABLE app.workspace_inbox_reads TO {{api_runtime_role}};

GRANT UPDATE(read_at) ON TABLE app.workspace_inbox_reads TO {{api_runtime_role}};

GRANT SELECT ON TABLE app.workspace_inbox_threads TO {{api_runtime_role}};

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitation_acceptance_intents TO {{api_runtime_role}};

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitation_binding_replacement_claims TO {{api_runtime_role}};

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitation_command_receipts TO {{api_runtime_role}};

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitation_delivery_attempts TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT UPDATE(token_ciphertext) ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT UPDATE(token_nonce) ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT UPDATE(token_tag) ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT UPDATE(token_key_version) ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT UPDATE(provider_reference) ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT UPDATE(failure_code) ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitations TO {{api_runtime_role}};
GRANT SELECT ON TABLE app.workspace_invitations TO {{worker_runtime_role}};

GRANT UPDATE(delivery_status) ON TABLE app.workspace_invitations TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_invitations TO {{worker_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_member_departure_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_member_departure_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.workspace_member_departure_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_member_departure_command_receipts TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_member_removal_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_member_removal_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.workspace_member_removal_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_member_removal_command_receipts TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_member_role_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_member_role_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.workspace_member_role_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_member_role_command_receipts TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_member_suspension_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_member_suspension_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.workspace_member_suspension_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_member_suspension_command_receipts TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_memberships TO {{api_runtime_role}};

GRANT UPDATE(role) ON TABLE app.workspace_memberships TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_memberships TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_memberships TO {{api_runtime_role}};

GRANT UPDATE(role_revision) ON TABLE app.workspace_memberships TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_ownership_transfer_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_ownership_transfer_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.workspace_ownership_transfer_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_ownership_transfer_command_receipts TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspace_rename_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(status) ON TABLE app.workspace_rename_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(result_ref) ON TABLE app.workspace_rename_command_receipts TO {{api_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspace_rename_command_receipts TO {{api_runtime_role}};

GRANT SELECT,INSERT ON TABLE app.workspaces TO {{api_runtime_role}};

GRANT SELECT(id) ON TABLE app.workspaces TO {{worker_runtime_role}};

GRANT UPDATE(name) ON TABLE app.workspaces TO {{api_runtime_role}};

GRANT SELECT(status) ON TABLE app.workspaces TO {{worker_runtime_role}};

GRANT UPDATE(updated_at) ON TABLE app.workspaces TO {{api_runtime_role}};

GRANT UPDATE(revision) ON TABLE app.workspaces TO {{api_runtime_role}};

-- Seed rows

INSERT INTO app.curated_template_descriptors (template_id, template_version, schema_version, base_manifest, base_manifest_digest, setup_targets, supported_profile, selection_enabled) VALUES ('controlled-http-notification', 1, 1, '{"connectionSlots":[{"authType":"http_headers","nodeId":"controlled-http","providerKey":"http","slot":"http_headers"},{"authType":"slack_bot_token","nodeId":"slack-notification","providerKey":"slack","slot":"slack_bot_token"}],"format":"pertexo.workflow","formatVersion":1,"graph":{"edges":[{"id":"notification-http","source":{"nodeId":"notification-start","port":"out"},"target":{"nodeId":"controlled-http","port":"in"}},{"id":"http-condition","source":{"nodeId":"controlled-http","port":"out"},"target":{"nodeId":"notify-on-200","port":"in"}},{"id":"condition-slack","source":{"nodeId":"notify-on-200","port":"true"},"target":{"nodeId":"slack-notification","port":"in"}},{"id":"slack-complete","source":{"nodeId":"slack-notification","port":"out"},"target":{"nodeId":"notification-complete","port":"in"}},{"id":"condition-skip","source":{"nodeId":"notify-on-200","port":"false"},"target":{"nodeId":"notification-skipped","port":"in"}}],"nodes":[{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.webhook","version":1},"id":"notification-start","inputMappings":{},"position":{"x":0,"y":0}},{"config":{"headers":{},"inlineResponseBytes":1024,"maxRedirects":0,"maxResponseBytes":1024,"method":"GET","timeoutMillis":1000,"url":"https://example.test/curated-demo"},"configVersion":1,"connectionRefs":{},"definition":{"key":"http.request","version":1},"id":"controlled-http","inputMappings":{},"position":{"x":0,"y":0}},{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.condition","version":1},"id":"notify-on-200","inputMappings":{"condition":{"expression":"nodeOutputs.\"controlled-http\".status = 200","kind":"expression","language":"jsonata","policyVersion":1}},"position":{"x":0,"y":0}},{"config":{"timeoutMillis":1000},"configVersion":1,"connectionRefs":{},"definition":{"key":"slack.send_message","version":1},"id":"slack-notification","inputMappings":{"channelId":{"kind":"literal","value":"CEXAMPLE"},"text":{"kind":"literal","value":"Curated demo: controlled endpoint returned 200."}},"position":{"x":0,"y":0}},{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.terminate","version":1},"id":"notification-complete","inputMappings":{"outcome":{"kind":"literal","value":"notification-complete"}},"position":{"x":0,"y":0}},{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.terminate","version":1},"id":"notification-skipped","inputMappings":{"outcome":{"kind":"literal","value":"notification-skipped"}},"position":{"x":0,"y":0}}],"schemaVersion":1,"settings":{"maxRunDurationMs":300000}},"requirements":{"definitions":[{"configVersion":1,"key":"core.condition","version":1},{"configVersion":1,"key":"core.terminate","version":1},{"configVersion":1,"key":"core.webhook","version":1},{"configVersion":1,"key":"http.request","version":1},{"configVersion":1,"key":"slack.send_message","version":1}],"selectionFingerprint":"node-select:v1:sha256:8d088833aecf943752bcd78cf18475e682cfae0b62f1b6445fb709fc4bd53513"}}', 'be2a8daaa8d220abf8be00c936df2cc3198cf8e64b88f0713baff8e3cebfdd46', '[{"key": "url", "nodeId": "controlled-http", "location": "config", "valueKind": "curated_https_endpoint_v1"}, {"key": "channelId", "nodeId": "slack-notification", "location": "literalInput", "valueKind": "slack_channel_id"}]', 'validate_activation', true);
INSERT INTO app.curated_template_descriptors (template_id, template_version, schema_version, base_manifest, base_manifest_digest, setup_targets, supported_profile, selection_enabled) VALUES ('schedule-bounded-batch', 1, 1, '{"connectionSlots":[],"format":"pertexo.workflow","formatVersion":1,"graph":{"edges":[{"id":"schedule-batch","source":{"nodeId":"schedule-start","port":"out"},"target":{"nodeId":"batch-items","port":"in"}},{"id":"batch-complete-edge","source":{"nodeId":"batch-items","port":"out"},"target":{"nodeId":"batch-complete","port":"in"}}],"nodes":[{"config":{"intervalMinutes":60,"kind":"interval","misfirePolicy":"skip"},"configVersion":3,"connectionRefs":{},"definition":{"key":"core.schedule","version":3},"id":"schedule-start","inputMappings":{},"position":{"x":0,"y":0}},{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.foreach","version":1},"id":"batch-items","inputMappings":{"items":{"kind":"literal","value":[{"value":"alpha"},{"value":"beta"}]}},"position":{"x":0,"y":0},"structured":{"body":{"edges":[],"inputPorts":["item","ordinal"],"nodes":[{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.set","version":1},"id":"batch-body-result","inputMappings":{"item":{"kind":"structured_input","path":"$","port":"item"},"ordinal":{"kind":"structured_input","path":"$","port":"ordinal"}},"position":{"x":0,"y":0}}],"outputPorts":["result"],"schemaVersion":1,"settings":{"maxRunDurationMs":300000}},"kind":"for_each","maxConcurrency":1,"maxIterations":3}},{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.terminate","version":1},"id":"batch-complete","inputMappings":{"result":{"kind":"node_output","nodeId":"batch-items","path":"$"}},"position":{"x":0,"y":0}}],"schemaVersion":1,"settings":{"maxRunDurationMs":300000}},"requirements":{"definitions":[{"configVersion":1,"key":"core.foreach","version":1},{"configVersion":3,"key":"core.schedule","version":3},{"configVersion":1,"key":"core.set","version":1},{"configVersion":1,"key":"core.terminate","version":1}],"selectionFingerprint":"node-select:v1:sha256:b6b636ddd0e5c092bd3020641f09cfc86dd9445fb9f8cc38328c9c2b25b7f7ad"}}', '1ecab1f1b462fca2ad6542178952067eff50311e637caed1342d727fe2817a5d', '[]', 'validate_activation', true);
INSERT INTO app.curated_template_descriptors (template_id, template_version, schema_version, base_manifest, base_manifest_digest, setup_targets, supported_profile, selection_enabled) VALUES ('webhook-validation-routing', 1, 1, '{"connectionSlots":[],"format":"pertexo.workflow","formatVersion":1,"graph":{"edges":[{"id":"start-validate","source":{"nodeId":"webhook-start","port":"out"},"target":{"nodeId":"validate-request","port":"in"}},{"id":"validate-route","source":{"nodeId":"validate-request","port":"out"},"target":{"nodeId":"route-validity","port":"in"}},{"id":"route-accepted","source":{"nodeId":"route-validity","port":"true"},"target":{"nodeId":"accepted","port":"in"}},{"id":"route-rejected","source":{"nodeId":"route-validity","port":"false"},"target":{"nodeId":"rejected","port":"in"}}],"nodes":[{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.webhook","version":1},"id":"webhook-start","inputMappings":{},"position":{"x":0,"y":0}},{"config":{"rules":[{"enum":["notification"],"id":"request-type","path":"$.payload.type","required":true,"type":"string"}]},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.validate","version":1},"id":"validate-request","inputMappings":{"payload":{"kind":"run_input","path":"$"}},"position":{"x":0,"y":0}},{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.condition","version":1},"id":"route-validity","inputMappings":{"condition":{"kind":"node_output","nodeId":"validate-request","path":"$.valid"}},"position":{"x":0,"y":0}},{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.terminate","version":1},"id":"accepted","inputMappings":{"outcome":{"kind":"literal","value":"accepted"}},"position":{"x":0,"y":0}},{"config":{},"configVersion":1,"connectionRefs":{},"definition":{"key":"core.terminate","version":1},"id":"rejected","inputMappings":{"outcome":{"kind":"literal","value":"rejected"}},"position":{"x":0,"y":0}}],"schemaVersion":1,"settings":{"maxRunDurationMs":300000}},"requirements":{"definitions":[{"configVersion":1,"key":"core.condition","version":1},{"configVersion":1,"key":"core.terminate","version":1},{"configVersion":1,"key":"core.validate","version":1},{"configVersion":1,"key":"core.webhook","version":1}],"selectionFingerprint":"node-select:v1:sha256:a0be3045940d79316109ba42ce12878987f59a13a5ee16c352a70948f5ba1090"}}', '054903475c92270db247af785f4be6ba806e68023c167770cb9f767c77bb5239', '[]', 'validate_activation', true);

INSERT INTO app.curated_template_rollout (singleton, import_enabled) VALUES (true, true);

INSERT INTO app.outbox_fair_dispatch_cursor (singleton, last_workspace_id, updated_at) VALUES (true, NULL, '2026-10-09 00:02:10.639066+00');

INSERT INTO app.workflow_input_case_rollout (singleton, enabled) VALUES (true, true);

INSERT INTO app.workflow_organization_rollout (singleton, writes_enabled) VALUES (true, true);

INSERT INTO app.workflow_portability_rollout (singleton, import_enabled) VALUES (true, true);

INSERT INTO app.workspace_invitation_claim_cleanup_cursors (scan_kind, scan_id, workspace_id, purge_job_id, cursor_updated_at, cursor_prior_workspace_id, cursor_prior_intent_id, cursor_prior_binding_digest, high_water_updated_at, high_water_prior_workspace_id, high_water_prior_intent_id, high_water_prior_binding_digest, cycle_completed, updated_at) VALUES ('transient', '00000000-0000-0000-0000-000000000000', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, '2026-10-09 00:02:10.873331+00');

ALTER TABLE ONLY app.artifact_links
    ADD CONSTRAINT artifact_links_identity_unique PRIMARY KEY (workspace_id, artifact_id, owner_kind, owner_id);

ALTER TABLE ONLY app.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE app.audit_events
    ADD CONSTRAINT audit_events_preview_terminal_uuid_v7 CHECK ((((action)::text <> 'preview.execution_terminal'::text) OR (uuid_extract_version(id) = 7))) NOT VALID;

ALTER TABLE ONLY app.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.auth_accounts
    ADD CONSTRAINT auth_accounts_provider_identity_unique UNIQUE (provider_id, account_id);

ALTER TABLE ONLY app.auth_email_proofs
    ADD CONSTRAINT auth_email_proofs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.auth_email_proofs
    ADD CONSTRAINT auth_email_proofs_token_digest_key UNIQUE (token_digest);

ALTER TABLE ONLY app.auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.auth_legacy_method_migration_attempts
    ADD CONSTRAINT auth_legacy_method_migration_attempts_oidc_state_digest_key UNIQUE (oidc_state_digest);

ALTER TABLE ONLY app.auth_legacy_method_migration_attempts
    ADD CONSTRAINT auth_legacy_method_migration_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.auth_legacy_method_migration_attempts
    ADD CONSTRAINT auth_legacy_method_migration_attempts_target_state_digest_key UNIQUE (target_state_digest);

ALTER TABLE ONLY app.auth_method_link_attempts
    ADD CONSTRAINT auth_method_link_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.auth_method_link_attempts
    ADD CONSTRAINT auth_method_link_attempts_state_digest_key UNIQUE (state_digest);

ALTER TABLE ONLY app.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.auth_sessions
    ADD CONSTRAINT auth_sessions_token_key UNIQUE (token);

ALTER TABLE ONLY app.auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.authentication_mail_deliveries
    ADD CONSTRAINT authentication_mail_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.connection_events
    ADD CONSTRAINT connection_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.connection_health_observations
    ADD CONSTRAINT connection_health_observations_attempt_unique UNIQUE (workspace_id, attempt_id);

ALTER TABLE ONLY app.connection_health_observations
    ADD CONSTRAINT connection_health_observations_outbox_event_id_key UNIQUE (outbox_event_id);

ALTER TABLE ONLY app.connection_health_observations
    ADD CONSTRAINT connection_health_observations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.connection_secret_versions
    ADD CONSTRAINT connection_secret_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.connection_secret_versions
    ADD CONSTRAINT connection_secret_versions_workspace_connection_identity_unique UNIQUE (workspace_id, connection_id, id);

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.curated_template_descriptors
    ADD CONSTRAINT curated_template_descriptors_pkey PRIMARY KEY (template_id, template_version);

ALTER TABLE ONLY app.curated_template_rollout
    ADD CONSTRAINT curated_template_rollout_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_pkey PRIMARY KEY (destination_id, version);

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_workspace_identity_ef UNIQUE (workspace_id, destination_id, version, side_effect_class);

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_workspace_identity_un UNIQUE (workspace_id, destination_id, version);

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_workspace_identity_kind_uniqu UNIQUE (workspace_id, id, kind);

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.idempotency_records
    ADD CONSTRAINT idempotency_records_active_key_unique UNIQUE (workspace_id, operation, scope, key_hash);

ALTER TABLE ONLY app.idempotency_records
    ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.identity_security_audit_facts
    ADD CONSTRAINT identity_security_audit_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.inbox_receipts
    ADD CONSTRAINT inbox_receipts_pkey PRIMARY KEY (consumer_name, message_id);

ALTER TABLE ONLY app.node_attempt_connection_dispatches
    ADD CONSTRAINT node_attempt_connection_dispatches_pkey PRIMARY KEY (workspace_id, attempt_id);

ALTER TABLE ONLY app.node_attempts
    ADD CONSTRAINT node_attempts_number_unique UNIQUE (node_run_id, attempt_number);

ALTER TABLE ONLY app.node_attempts
    ADD CONSTRAINT node_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.node_attempts
    ADD CONSTRAINT node_attempts_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_invocation_unique UNIQUE (workflow_run_id, invocation_key);

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.oidc_login_transactions
    ADD CONSTRAINT oidc_login_transactions_pkey PRIMARY KEY (state_digest);

ALTER TABLE ONLY app.operator_commands
    ADD CONSTRAINT operator_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.operator_maintenance_rerun_requests
    ADD CONSTRAINT operator_maintenance_rerun_re_target_type_target_id_command_key UNIQUE (target_type, target_id, command_id);

ALTER TABLE ONLY app.operator_maintenance_rerun_requests
    ADD CONSTRAINT operator_maintenance_rerun_requests_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_requests_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY app.operator_unknown_outcome_evidence
    ADD CONSTRAINT operator_unknown_outcome_evidence_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY app.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.outbox_fair_dispatch_cursor
    ADD CONSTRAINT outbox_fair_dispatch_cursor_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY app.preview_attempts
    ADD CONSTRAINT preview_attempts_one_per_run UNIQUE (preview_run_id);

ALTER TABLE ONLY app.preview_attempts
    ADD CONSTRAINT preview_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.preview_attempts
    ADD CONSTRAINT preview_attempts_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_workspace_workflow_identity_unique UNIQUE (workspace_id, workflow_id, id);

ALTER TABLE ONLY app.retention_batches
    ADD CONSTRAINT retention_batches_idempotency_unique UNIQUE (workspace_id, idempotency_key);

ALTER TABLE ONLY app.retention_batches
    ADD CONSTRAINT retention_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.retention_control_audit_facts
    ADD CONSTRAINT retention_control_audit_facts_command_unique UNIQUE (workspace_id, command_id);

ALTER TABLE ONLY app.retention_control_audit_facts
    ADD CONSTRAINT retention_control_audit_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.retention_schedule_state
    ADD CONSTRAINT retention_schedule_state_pkey PRIMARY KEY (workspace_id, retention_kind);

ALTER TABLE ONLY app.rls_probe_records
    ADD CONSTRAINT rls_probe_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.run_checkpoints
    ADD CONSTRAINT run_checkpoints_pkey PRIMARY KEY (workflow_run_id);

ALTER TABLE ONLY app.run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (workflow_run_id, sequence);

ALTER TABLE ONLY app.run_failure_notification_audit_facts
    ADD CONSTRAINT run_failure_notification_audit_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_logical_unique UNIQUE (workflow_run_id, terminal_event_sequence, policy_version);

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.transport_security_audit_facts
    ADD CONSTRAINT transport_security_audit_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_identity_unique UNIQUE (trigger_id, scheduled_at);

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.trigger_schedules
    ADD CONSTRAINT trigger_schedules_pkey PRIMARY KEY (trigger_id);

ALTER TABLE ONLY app.trigger_schedules
    ADD CONSTRAINT trigger_schedules_workspace_identity_unique UNIQUE (workspace_id, trigger_id);

ALTER TABLE ONLY app.usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);

ALTER TABLE app.usage_events
    ADD CONSTRAINT usage_events_preview_uuid_v7 CHECK ((((category)::text <> 'preview_execution'::text) OR (uuid_extract_version(id) = 7))) NOT VALID;

ALTER TABLE ONLY app.usage_events
    ADD CONSTRAINT usage_events_workspace_idempotency_unique UNIQUE (workspace_id, idempotency_key);

ALTER TABLE ONLY app.user_profile_command_receipts
    ADD CONSTRAINT user_profile_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.webhook_endpoint_ingress_limits
    ADD CONSTRAINT webhook_endpoint_ingress_limits_pkey PRIMARY KEY (endpoint_id);

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_endpoint_key_hash_key UNIQUE (endpoint_key_hash);

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_trigger_id_key UNIQUE (trigger_id);

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_pkey PRIMARY KEY (endpoint_id, dedupe_kind, dedupe_key_hash);

ALTER TABLE ONLY app.webhook_trigger_secret_versions
    ADD CONSTRAINT webhook_trigger_secret_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.webhook_trigger_secret_versions
    ADD CONSTRAINT webhook_trigger_secret_versions_trigger_identity_unique UNIQUE (workspace_id, trigger_id, id);

ALTER TABLE ONLY app.workflow_auto_pause_command_receipts
    ADD CONSTRAINT workflow_auto_pause_command_receipts_pkey PRIMARY KEY (workspace_id, actor_id, resource_id, operation, key_hash);

ALTER TABLE ONLY app.workflow_concurrency_command_receipts
    ADD CONSTRAINT workflow_concurrency_command_receipts_pkey PRIMARY KEY (workspace_id, actor_id, workflow_id, key_hash);

ALTER TABLE ONLY app.workflow_concurrency_policies
    ADD CONSTRAINT workflow_concurrency_policies_pkey PRIMARY KEY (workspace_id, workflow_id);

ALTER TABLE ONLY app.workflow_drafts
    ADD CONSTRAINT workflow_drafts_pkey PRIMARY KEY (workflow_id);

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_pkey PRIMARY KEY (workflow_id);

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_workspace_workflow_uniqu UNIQUE (workspace_id, workflow_id);

ALTER TABLE ONLY app.workflow_failure_streaks
    ADD CONSTRAINT workflow_failure_streaks_pkey PRIMARY KEY (workspace_id, workflow_id);

ALTER TABLE ONLY app.workflow_favorite_held_evidence
    ADD CONSTRAINT workflow_favorite_held_evidence_pkey PRIMARY KEY (workspace_id, actor_id, workflow_id, generation);

ALTER TABLE ONLY app.workflow_favorite_membership_generations
    ADD CONSTRAINT workflow_favorite_membership_generations_pkey PRIMARY KEY (workspace_id, actor_id);

ALTER TABLE ONLY app.workflow_favorite_receipts
    ADD CONSTRAINT workflow_favorite_receipts_pkey PRIMARY KEY (workspace_id, actor_id, workflow_id, key_hash);

ALTER TABLE ONLY app.workflow_favorites
    ADD CONSTRAINT workflow_favorites_pkey PRIMARY KEY (workspace_id, actor_id, workflow_id);

ALTER TABLE ONLY app.workflow_folders
    ADD CONSTRAINT workflow_folders_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY app.workflow_folders
    ADD CONSTRAINT workflow_folders_workspace_id_parent_id_name_key_key UNIQUE NULLS NOT DISTINCT (workspace_id, parent_id, name_key);

ALTER TABLE ONLY app.workflow_input_case_payloads
    ADD CONSTRAINT workflow_input_case_payloads_pkey PRIMARY KEY (workspace_id, case_id, revision);

ALTER TABLE ONLY app.workflow_input_case_receipts
    ADD CONSTRAINT workflow_input_case_receipts_pkey PRIMARY KEY (workspace_id, actor_id, workflow_id, operation, key_hash);

ALTER TABLE ONLY app.workflow_input_case_rollout
    ADD CONSTRAINT workflow_input_case_rollout_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY app.workflow_input_cases
    ADD CONSTRAINT workflow_input_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workflow_input_cases
    ADD CONSTRAINT workflow_input_cases_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.workflow_integration_usage
    ADD CONSTRAINT workflow_integration_usage_identity_pk PRIMARY KEY (workflow_version_id, provider_key, operation_key, connection_id);

ALTER TABLE ONLY app.workflow_manual_start_rejections
    ADD CONSTRAINT workflow_manual_start_rejections_pkey PRIMARY KEY (workspace_id, scope, key_hash);

ALTER TABLE ONLY app.workflow_organization_coordination
    ADD CONSTRAINT workflow_organization_coordination_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY app.workflow_organization_receipts
    ADD CONSTRAINT workflow_organization_receipts_pkey PRIMARY KEY (workspace_id, actor_id, operation, target_id, key_hash);

ALTER TABLE ONLY app.workflow_organization_rollout
    ADD CONSTRAINT workflow_organization_rollout_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY app.workflow_organization_state
    ADD CONSTRAINT workflow_organization_state_pkey PRIMARY KEY (workspace_id, workflow_id);

ALTER TABLE ONLY app.workflow_portability_rollout
    ADD CONSTRAINT workflow_portability_rollout_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_outbox_event_id_key UNIQUE (outbox_event_id);

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_pkey PRIMARY KEY (workflow_run_id);

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_failure_notification_pin_unique UNIQUE (workspace_id, id, failure_notification_policy_version, failure_notification_destination_id, failure_notification_destination_config_version, failure_notification_side_effect_class, failure_notification_connection_secret_version_id);

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_replay_command_unique UNIQUE (replay_command_id);

ALTER TABLE app.workflow_runs
    ADD CONSTRAINT workflow_runs_replay_lineage_valid CHECK ((((trigger_type)::text = 'replay'::text) = ((replay_source_run_id IS NOT NULL) AND (replay_command_id IS NOT NULL)))) NOT VALID;

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_workspace_version_identity_unique UNIQUE (workspace_id, id, workflow_version_id);

ALTER TABLE ONLY app.workflow_tag_assignments
    ADD CONSTRAINT workflow_tag_assignments_pkey PRIMARY KEY (workspace_id, workflow_id, tag_id);

ALTER TABLE ONLY app.workflow_tags
    ADD CONSTRAINT workflow_tags_pkey PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY app.workflow_tags
    ADD CONSTRAINT workflow_tags_workspace_id_key_key UNIQUE (workspace_id, key);

ALTER TABLE ONLY app.workflow_template_origins
    ADD CONSTRAINT workflow_template_origins_pkey PRIMARY KEY (workspace_id, workflow_id);

ALTER TABLE ONLY app.workflow_trigger_outcomes
    ADD CONSTRAINT workflow_trigger_outcomes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workflow_trigger_pause_periods
    ADD CONSTRAINT workflow_trigger_pause_periods_pkey PRIMARY KEY (workspace_id, workflow_id, pause_revision);

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_version_node_unique UNIQUE (workflow_version_id, node_id);

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_checksum_unique UNIQUE (workflow_id, checksum);

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_number_unique UNIQUE (workflow_id, version_number);

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_workspace_identity_unique UNIQUE (workspace_id, workflow_id, id);

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_workspace_version_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_workspace_identity_unique UNIQUE (workspace_id, id);

ALTER TABLE ONLY app.workspace_artifact_capacity
    ADD CONSTRAINT workspace_artifact_capacity_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY app.workspace_control_ledger_projection
    ADD CONSTRAINT workspace_control_ledger_projection_audit_record_unique UNIQUE (workspace_id, command_id, subject_id, command_type, sequence, record_hash, actor_ref, occurred_at);

ALTER TABLE ONLY app.workspace_control_ledger_projection
    ADD CONSTRAINT workspace_control_ledger_projection_command_record_unique UNIQUE (workspace_id, command_id, subject_id, command_type, sequence);

ALTER TABLE ONLY app.workspace_control_ledger_projection
    ADD CONSTRAINT workspace_control_ledger_projection_command_unique UNIQUE (workspace_id, command_id);

ALTER TABLE ONLY app.workspace_control_ledger_projection
    ADD CONSTRAINT workspace_control_ledger_projection_pk PRIMARY KEY (workspace_id, sequence);

ALTER TABLE ONLY app.workspace_control_ledger_projection
    ADD CONSTRAINT workspace_control_ledger_projection_subject_record_unique UNIQUE (workspace_id, sequence, subject_id, command_type, record_hash);

ALTER TABLE ONLY app.workspace_creation_idempotency_records
    ADD CONSTRAINT workspace_creation_idempotency_active_key_unique UNIQUE (actor_user_id, operation, key_hash);

ALTER TABLE ONLY app.workspace_creation_idempotency_records
    ADD CONSTRAINT workspace_creation_idempotency_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_execution_admission_counters
    ADD CONSTRAINT workspace_execution_admission_counters_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY app.workspace_execution_entitlement_versions
    ADD CONSTRAINT workspace_execution_entitlement_versions_pkey PRIMARY KEY (workspace_id, version);

ALTER TABLE ONLY app.workspace_execution_entitlements
    ADD CONSTRAINT workspace_execution_entitlements_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY app.workspace_inbox_events
    ADD CONSTRAINT workspace_inbox_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_inbox_reads
    ADD CONSTRAINT workspace_inbox_reads_pkey PRIMARY KEY (workspace_id, user_id, workflow_id);

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_pkey PRIMARY KEY (workspace_id, workflow_id);

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_invitation_binding_replacement_claims
    ADD CONSTRAINT workspace_invitation_binding_replacement_claims_pkey PRIMARY KEY (prior_workspace_id, prior_intent_id, prior_binding_digest);

ALTER TABLE ONLY app.workspace_invitation_claim_cleanup_cursors
    ADD CONSTRAINT workspace_invitation_claim_cleanup_cursors_pkey PRIMARY KEY (scan_kind, scan_id);

ALTER TABLE ONLY app.workspace_invitation_command_receipts
    ADD CONSTRAINT workspace_invitation_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_invitation_delivery_attempts
    ADD CONSTRAINT workspace_invitation_delivery_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_invitations
    ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_legal_holds
    ADD CONSTRAINT workspace_legal_holds_pk PRIMARY KEY (workspace_id, hold_id);

ALTER TABLE ONLY app.workspace_lifecycle_operations
    ADD CONSTRAINT workspace_lifecycle_operations_idempotency_unique UNIQUE (workspace_id, idempotency_key_hash);

ALTER TABLE ONLY app.workspace_lifecycle_operations
    ADD CONSTRAINT workspace_lifecycle_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_member_departure_command_receipts
    ADD CONSTRAINT workspace_member_departure_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_member_removal_command_receipts
    ADD CONSTRAINT workspace_member_removal_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_member_role_command_receipts
    ADD CONSTRAINT workspace_member_role_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_member_suspension_command_receipts
    ADD CONSTRAINT workspace_member_suspension_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey PRIMARY KEY (workspace_id, user_id);

ALTER TABLE ONLY app.workspace_ownership_transfer_command_receipts
    ADD CONSTRAINT workspace_ownership_transfer_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_purge_completions
    ADD CONSTRAINT workspace_purge_completions_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY app.workspace_purge_completions
    ADD CONSTRAINT workspace_purge_completions_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY app.workspace_purge_jobs
    ADD CONSTRAINT workspace_purge_jobs_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY app.workspace_purge_jobs
    ADD CONSTRAINT workspace_purge_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspace_purge_jobs
    ADD CONSTRAINT workspace_purge_jobs_workspace_id_key UNIQUE (workspace_id);

ALTER TABLE ONLY app.workspace_purge_steps
    ADD CONSTRAINT workspace_purge_steps_pkey PRIMARY KEY (job_id, step_name);

ALTER TABLE ONLY app.workspace_rename_command_receipts
    ADD CONSTRAINT workspace_rename_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY pertexo_internal.preview_retention_transition_capabilities
    ADD CONSTRAINT preview_retention_transition_capabilities_pkey PRIMARY KEY (transaction_id, workspace_id, artifact_id, target_status);

CREATE INDEX artifact_links_owner_idx ON app.artifact_links USING btree (workspace_id, owner_kind, owner_id, artifact_id);

CREATE INDEX artifacts_available_retention_idx ON app.artifacts USING btree (expires_at, retention_retry_at, id) WHERE ((status)::text = 'available'::text);

CREATE INDEX artifacts_pending_expiry_idx ON app.artifacts USING btree (workspace_id, expires_at, id) WHERE ((status)::text = 'pending'::text);

CREATE UNIQUE INDEX artifacts_storage_key_idx ON app.artifacts USING btree (storage_key);

CREATE UNIQUE INDEX artifacts_workspace_identity_unique ON app.artifacts USING btree (workspace_id, id);

CREATE INDEX artifacts_workspace_status_idx ON app.artifacts USING btree (workspace_id, status, id);

CREATE INDEX audit_events_workspace_target_idx ON app.audit_events USING btree (workspace_id, target_type, target_id, occurred_at DESC);

CREATE INDEX audit_events_workspace_time_idx ON app.audit_events USING btree (workspace_id, occurred_at DESC, id);

CREATE INDEX auth_accounts_user_idx ON app.auth_accounts USING btree (user_id, id);

CREATE INDEX auth_email_proofs_retention_idx ON app.auth_email_proofs USING btree (expires_at, id);

CREATE INDEX auth_email_proofs_user_idx ON app.auth_email_proofs USING btree (user_id, purpose, created_at);

CREATE UNIQUE INDEX auth_identities_issuer_subject_unique ON app.auth_identities USING btree (issuer, provider_subject);

CREATE INDEX auth_identities_user_idx ON app.auth_identities USING btree (user_id, id);

CREATE INDEX auth_legacy_method_migration_retention_idx ON app.auth_legacy_method_migration_attempts USING btree (expires_at, id);

CREATE INDEX auth_legacy_method_migration_user_idx ON app.auth_legacy_method_migration_attempts USING btree (user_id, created_at);

CREATE INDEX auth_method_link_attempts_retention_idx ON app.auth_method_link_attempts USING btree (expires_at, id);

CREATE INDEX auth_method_link_attempts_user_idx ON app.auth_method_link_attempts USING btree (user_id, session_id, created_at);

CREATE INDEX auth_sessions_expiry_idx ON app.auth_sessions USING btree (expires_at, id);

CREATE INDEX auth_sessions_user_expiry_idx ON app.auth_sessions USING btree (user_id, expires_at, id);

CREATE INDEX auth_verifications_expiry_idx ON app.auth_verifications USING btree (expires_at, id);

CREATE INDEX auth_verifications_identifier_idx ON app.auth_verifications USING btree (identifier, id);

CREATE INDEX authentication_mail_due_idx ON app.authentication_mail_deliveries USING btree (next_attempt_at, id) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'outcome_unknown'::character varying, 'retry'::character varying])::text[]));

CREATE INDEX authentication_mail_retention_idx ON app.authentication_mail_deliveries USING btree (completed_at, id) WHERE ((status)::text = ANY ((ARRAY['submitted'::character varying, 'failed'::character varying, 'reconciliation_required'::character varying, 'expired'::character varying])::text[]));

CREATE INDEX connection_events_connection_time_idx ON app.connection_events USING btree (workspace_id, connection_id, created_at DESC, id);

CREATE INDEX connection_events_workspace_time_idx ON app.connection_events USING btree (workspace_id, created_at DESC, id);

CREATE INDEX connection_health_observations_workspace_time_idx ON app.connection_health_observations USING btree (workspace_id, observed_at, id);

CREATE INDEX connection_secret_versions_connection_created_idx ON app.connection_secret_versions USING btree (workspace_id, connection_id, created_at DESC, id);

CREATE UNIQUE INDEX connections_active_name_provider_unique ON app.connections USING btree (workspace_id, provider_key, lower((name)::text)) WHERE ((status)::text <> 'revoked'::text);

CREATE INDEX connections_workspace_status_idx ON app.connections USING btree (workspace_id, status, created_at DESC, id);

CREATE INDEX failure_notification_destination_versions_workspace_idx ON app.failure_notification_destination_versions USING btree (workspace_id, destination_id, version DESC);

CREATE INDEX failure_notification_destinations_workspace_status_idx ON app.failure_notification_destinations USING btree (workspace_id, status, created_at, id);

CREATE INDEX idempotency_records_expiry_idx ON app.idempotency_records USING btree (expires_at, id) WHERE (expires_at IS NOT NULL);

CREATE INDEX idempotency_records_resource_idx ON app.idempotency_records USING btree (workspace_id, resource_id);

CREATE INDEX identity_security_audit_retention_idx ON app.identity_security_audit_facts USING btree (occurred_at, id);

CREATE INDEX identity_security_audit_user_idx ON app.identity_security_audit_facts USING btree (user_id, occurred_at);

CREATE INDEX inbox_receipts_workspace_idx ON app.inbox_receipts USING btree (workspace_id, received_at DESC);

CREATE INDEX node_attempts_expired_lease_idx ON app.node_attempts USING btree (lease_expires_at, id) WHERE (((status)::text = 'running'::text) AND (lease_expires_at IS NOT NULL));

CREATE INDEX node_attempts_node_status_idx ON app.node_attempts USING btree (workspace_id, node_run_id, status, attempt_number);

CREATE UNIQUE INDEX node_attempts_one_nonterminal_idx ON app.node_attempts USING btree (node_run_id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'ready'::character varying, 'running'::character varying, 'waiting'::character varying])::text[]));

CREATE INDEX node_runs_due_idx ON app.node_runs USING btree (workspace_id, retry_due_at, resume_at, id) WHERE ((status)::text = 'waiting'::text);

CREATE INDEX node_runs_due_wakeup_idx ON app.node_runs USING btree (COALESCE(retry_due_at, resume_at), id) WHERE (((status)::text = 'waiting'::text) AND (COALESCE(retry_due_at, resume_at) IS NOT NULL));

CREATE INDEX node_runs_operator_due_idx ON app.node_runs USING btree (workspace_id, workflow_run_id, COALESCE(retry_due_at, resume_at), id) WHERE ((status)::text = 'waiting'::text);

CREATE INDEX node_runs_run_status_idx ON app.node_runs USING btree (workspace_id, workflow_run_id, status, id);

CREATE INDEX oidc_login_transactions_consumed_idx ON app.oidc_login_transactions USING btree (consumed_at, state_digest) WHERE (consumed_at IS NOT NULL);

CREATE INDEX oidc_login_transactions_expiry_idx ON app.oidc_login_transactions USING btree (expires_at, state_digest) WHERE (consumed_at IS NULL);

CREATE INDEX operator_maintenance_rerun_pending_idx ON app.operator_maintenance_rerun_requests USING btree (created_at, command_id) WHERE ((status)::text = 'pending'::text);

CREATE INDEX outbox_events_dispatch_job_due_idx ON app.outbox_events USING btree (job_name, available_at, id) WHERE ((published_at IS NULL) AND (failed_at IS NULL));

CREATE INDEX outbox_events_due_idx ON app.outbox_events USING btree (available_at, id) WHERE ((published_at IS NULL) AND (failed_at IS NULL));

CREATE INDEX outbox_events_expired_lease_idx ON app.outbox_events USING btree (lease_expires_at, id) WHERE ((lease_expires_at IS NOT NULL) AND (published_at IS NULL) AND (failed_at IS NULL));

CREATE INDEX outbox_events_workspace_idx ON app.outbox_events USING btree (workspace_id, id);

CREATE INDEX preview_attempts_claim_idx ON app.preview_attempts USING btree (status, lease_expires_at, id) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[]));

CREATE INDEX preview_runs_expiry_idx ON app.preview_runs USING btree (expires_at, id);

CREATE INDEX preview_runs_workflow_created_idx ON app.preview_runs USING btree (workspace_id, workflow_id, created_at DESC, id);

CREATE INDEX preview_runs_workspace_created_idx ON app.preview_runs USING btree (workspace_id, created_at DESC, id);

CREATE INDEX retention_batches_claim_idx ON app.retention_batches USING btree (created_at, id) WHERE ((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying, 'paused'::character varying])::text[]));

CREATE INDEX retention_control_audit_facts_workspace_time_idx ON app.retention_control_audit_facts USING btree (workspace_id, occurred_at, id);

CREATE INDEX retention_schedule_state_due_idx ON app.retention_schedule_state USING btree (next_scan_at, workspace_id);

CREATE INDEX rls_probe_records_workspace_idx ON app.rls_probe_records USING btree (workspace_id, id);

CREATE INDEX run_checkpoints_due_resume_idx ON app.run_checkpoints USING btree (resume_at, workflow_run_id) WHERE (resume_at IS NOT NULL);

CREATE INDEX run_events_workspace_created_idx ON app.run_events USING btree (workspace_id, created_at DESC, workflow_run_id, sequence);

CREATE INDEX run_failure_notification_audit_workspace_intent_idx ON app.run_failure_notification_audit_facts USING btree (workspace_id, notification_intent_id, occurred_at, id);

CREATE INDEX run_failure_notification_intents_recovery_idx ON app.run_failure_notification_intents USING btree (recovery_at, id) WHERE ((status)::text = ANY ((ARRAY['claimed'::character varying, 'dispatching'::character varying])::text[]));

CREATE INDEX run_failure_notification_intents_retry_idx ON app.run_failure_notification_intents USING btree (next_delivery_at, id) WHERE ((status)::text = 'retry'::text);

CREATE INDEX run_failure_notification_intents_workspace_run_idx ON app.run_failure_notification_intents USING btree (workspace_id, workflow_run_id, id);

CREATE INDEX schedule_occurrences_retention_dry_run_idx ON app.trigger_schedule_occurrences USING btree (workspace_id, scheduled_at, id);

CREATE INDEX schedule_occurrences_run_retention_idx ON app.trigger_schedule_occurrences USING btree (workspace_id, workflow_run_id) WHERE (workflow_run_id IS NOT NULL);

CREATE INDEX sessions_expiry_idx ON app.sessions USING btree (expires_at, id) WHERE (revoked_at IS NULL);

CREATE INDEX sessions_retention_idx ON app.sessions USING btree (COALESCE(revoked_at, expires_at), id);

CREATE UNIQUE INDEX sessions_token_digest_unique ON app.sessions USING btree (token_digest);

CREATE INDEX sessions_user_active_idx ON app.sessions USING btree (user_id, expires_at, id) WHERE (revoked_at IS NULL);

CREATE INDEX transport_audit_retention_dry_run_idx ON app.transport_security_audit_facts USING btree (workspace_id, occurred_at, id);

CREATE INDEX transport_security_audit_facts_message_idx ON app.transport_security_audit_facts USING btree (workspace_id, message_id);

CREATE INDEX transport_security_audit_facts_workspace_time_idx ON app.transport_security_audit_facts USING btree (workspace_id, occurred_at DESC);

CREATE INDEX trigger_schedule_occurrences_trigger_time_idx ON app.trigger_schedule_occurrences USING btree (workspace_id, trigger_id, scheduled_at DESC, id);

CREATE INDEX trigger_schedules_due_idx ON app.trigger_schedules USING btree (next_fire_at, workspace_id, trigger_id) WHERE ((status)::text = 'enabled'::text);

CREATE INDEX usage_events_resource_idx ON app.usage_events USING btree (workspace_id, resource_type, resource_id, id);

CREATE INDEX usage_events_workspace_period_idx ON app.usage_events USING btree (workspace_id, occurred_at DESC, id);

CREATE UNIQUE INDEX user_profile_command_receipts_key_unique ON app.user_profile_command_receipts USING btree (actor_user_id, key_hash);

CREATE UNIQUE INDEX users_email_lower_unique ON app.users USING btree (lower((email)::text));

CREATE INDEX webhook_deliveries_retention_dry_run_idx ON app.webhook_trigger_deliveries USING btree (workspace_id, expires_at, id);

CREATE INDEX webhook_deliveries_run_retention_idx ON app.webhook_trigger_deliveries USING btree (workspace_id, workflow_run_id) WHERE (workflow_run_id IS NOT NULL);

CREATE INDEX webhook_replay_delivery_retention_idx ON app.webhook_trigger_replay_records USING btree (workspace_id, delivery_id, expires_at) WHERE (delivery_id IS NOT NULL);

CREATE INDEX webhook_replay_retention_dry_run_idx ON app.webhook_trigger_replay_records USING btree (workspace_id, expires_at, endpoint_id, dedupe_kind, dedupe_key_hash);

CREATE INDEX webhook_replay_run_retention_idx ON app.webhook_trigger_replay_records USING btree (workspace_id, workflow_run_id) WHERE (workflow_run_id IS NOT NULL);

CREATE INDEX webhook_trigger_deliveries_expiry_idx ON app.webhook_trigger_deliveries USING btree (expires_at, id);

CREATE INDEX webhook_trigger_deliveries_trigger_time_idx ON app.webhook_trigger_deliveries USING btree (workspace_id, trigger_id, received_at DESC, id);

CREATE INDEX webhook_trigger_replay_records_expiry_idx ON app.webhook_trigger_replay_records USING btree (expires_at, endpoint_id);

CREATE INDEX workflow_auto_pause_receipts_expiry_idx ON app.workflow_auto_pause_command_receipts USING btree (expires_at) WHERE (result IS NOT NULL);

CREATE INDEX workflow_concurrency_receipts_expiry_idx ON app.workflow_concurrency_command_receipts USING btree (expires_at) WHERE (result IS NOT NULL);

CREATE INDEX workflow_drafts_workspace_idx ON app.workflow_drafts USING btree (workspace_id, workflow_id);

CREATE INDEX workflow_failure_notification_policies_destination_idx ON app.workflow_failure_notification_policies USING btree (workspace_id, destination_id, workflow_id);

CREATE INDEX workflow_favorite_held_evidence_workflow_idx ON app.workflow_favorite_held_evidence USING btree (workspace_id, workflow_id, actor_id, generation);

CREATE INDEX workflow_favorite_membership_generations_actor_idx ON app.workflow_favorite_membership_generations USING btree (actor_id, workspace_id);

CREATE INDEX workflow_favorite_membership_generations_retired_idx ON app.workflow_favorite_membership_generations USING btree (retired_at, workspace_id, actor_id) WHERE (retired_at IS NOT NULL);

CREATE INDEX workflow_favorite_membership_generations_workspace_retired_idx ON app.workflow_favorite_membership_generations USING btree (workspace_id, retired_at, actor_id) WHERE (retired_at IS NOT NULL);

CREATE INDEX workflow_favorite_receipts_expiry_idx ON app.workflow_favorite_receipts USING btree (expires_at, workspace_id);

CREATE INDEX workflow_favorite_receipts_generation_idx ON app.workflow_favorite_receipts USING btree (workspace_id, actor_id, generation, workflow_id);

CREATE INDEX workflow_favorite_receipts_workflow_idx ON app.workflow_favorite_receipts USING btree (workspace_id, workflow_id, actor_id, generation);

CREATE INDEX workflow_favorite_receipts_workspace_expiry_idx ON app.workflow_favorite_receipts USING btree (workspace_id, expires_at, actor_id, workflow_id, key_hash);

CREATE INDEX workflow_favorites_expiry_idx ON app.workflow_favorites USING btree (expires_at, workspace_id, actor_id, workflow_id) WHERE (NOT favorite);

CREATE INDEX workflow_favorites_generation_idx ON app.workflow_favorites USING btree (workspace_id, actor_id, generation, workflow_id);

CREATE INDEX workflow_favorites_workflow_idx ON app.workflow_favorites USING btree (workspace_id, workflow_id, actor_id);

CREATE INDEX workflow_favorites_workspace_expiry_idx ON app.workflow_favorites USING btree (workspace_id, expires_at, actor_id, workflow_id) WHERE (NOT favorite);

CREATE INDEX workflow_folders_parent_idx ON app.workflow_folders USING btree (workspace_id, parent_id, id);

CREATE INDEX workflow_input_case_receipts_expiry_idx ON app.workflow_input_case_receipts USING btree (expires_at, workspace_id);

CREATE INDEX workflow_input_cases_page_idx ON app.workflow_input_cases USING btree (workspace_id, workflow_id, created_at, id) WHERE (deleted_at IS NULL);

CREATE INDEX workflow_integration_usage_connection_idx ON app.workflow_integration_usage USING btree (workspace_id, connection_id, workflow_version_id, provider_key, operation_key);

CREATE INDEX workflow_integration_usage_impact_idx ON app.workflow_integration_usage USING btree (workspace_id, provider_key, operation_key, workflow_version_id, connection_id);

CREATE INDEX workflow_manual_start_rejections_expiry_idx ON app.workflow_manual_start_rejections USING btree (expires_at, workspace_id, scope, key_hash);

CREATE INDEX workflow_organization_receipts_expiry_idx ON app.workflow_organization_receipts USING btree (expires_at, workspace_id);

CREATE INDEX workflow_organization_receipts_workspace_expiry_idx ON app.workflow_organization_receipts USING btree (workspace_id, expires_at, actor_id, operation, target_id, key_hash);

CREATE INDEX workflow_organization_state_folder_idx ON app.workflow_organization_state USING btree (workspace_id, folder_id, workflow_id);

CREATE INDEX workflow_run_active_admissions_workspace_idx ON app.workflow_run_active_admissions USING btree (workspace_id);

CREATE INDEX workflow_runs_detail_retention_idx ON app.workflow_runs USING btree (workspace_id, completed_at, id) WHERE ((completed_at IS NOT NULL) AND (details_purged_at IS NULL));

CREATE INDEX workflow_runs_due_deadline_idx ON app.workflow_runs USING btree (deadline_at, id) WHERE ((deadline_at IS NOT NULL) AND ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'waiting'::character varying])::text[])) AND (deadline_wakeup_at IS NULL));

CREATE INDEX workflow_runs_due_input_ref_retention_idx ON app.workflow_runs USING btree (workspace_id, input_ref_expires_at, id) WHERE (input_ref IS NOT NULL);

CREATE INDEX workflow_runs_queued_admission_order_idx ON app.workflow_runs USING btree (workspace_id, workflow_id, admission_ticket, id) WHERE ((status)::text = 'queued'::text);

CREATE INDEX workflow_runs_replay_source_idx ON app.workflow_runs USING btree (workspace_id, replay_source_run_id, id) WHERE (replay_source_run_id IS NOT NULL);

CREATE INDEX workflow_runs_summary_retention_idx ON app.workflow_runs USING btree (workspace_id, completed_at, id) WHERE (completed_at IS NOT NULL);

CREATE INDEX workflow_runs_workflow_active_idx ON app.workflow_runs USING btree (workspace_id, workflow_id, id) WHERE ((status)::text = ANY ((ARRAY['running'::character varying, 'waiting'::character varying])::text[]));

CREATE INDEX workflow_runs_workflow_version_idx ON app.workflow_runs USING btree (workspace_id, workflow_version_id, id);

CREATE INDEX workflow_runs_workspace_created_idx ON app.workflow_runs USING btree (workspace_id, created_at, id);

CREATE INDEX workflow_runs_workspace_created_statistics_idx ON app.workflow_runs USING btree (workspace_id, created_at) INCLUDE (status, workflow_id);

CREATE INDEX workflow_runs_workspace_status_created_idx ON app.workflow_runs USING btree (workspace_id, status, created_at DESC, id DESC);

CREATE INDEX workflow_runs_workspace_workflow_created_idx ON app.workflow_runs USING btree (workspace_id, workflow_id, created_at, id);

CREATE INDEX workflow_tag_assignments_tag_idx ON app.workflow_tag_assignments USING btree (workspace_id, tag_id, workflow_id);

CREATE INDEX workflow_trigger_outcomes_pending_idx ON app.workflow_trigger_outcomes USING btree (created_at, id);

CREATE UNIQUE INDEX workflow_trigger_outcomes_run_unique ON app.workflow_trigger_outcomes USING btree (workspace_id, run_id);

CREATE INDEX workflow_trigger_outcomes_workflow_idx ON app.workflow_trigger_outcomes USING btree (workspace_id, workflow_id);

CREATE INDEX workflow_trigger_pause_periods_due_idx ON app.workflow_trigger_pause_periods USING btree (workspace_id, workflow_id, paused_at DESC) INCLUDE (resumed_at);

CREATE INDEX workflow_triggers_active_kind_idx ON app.workflow_triggers USING btree (workspace_id, kind, status, id) WHERE ((status)::text = ANY ((ARRAY['configuration_required'::character varying, 'pending'::character varying, 'active'::character varying, 'degraded'::character varying])::text[]));

CREATE INDEX workflow_triggers_workflow_version_idx ON app.workflow_triggers USING btree (workspace_id, workflow_id, workflow_version_id, node_id);

CREATE INDEX workflow_versions_workspace_workflow_idx ON app.workflow_versions USING btree (workspace_id, workflow_id, version_number DESC);

CREATE INDEX workflows_workspace_created_idx ON app.workflows USING btree (workspace_id, created_at, id);

CREATE INDEX workflows_workspace_name_idx ON app.workflows USING btree (workspace_id, name, id);

CREATE INDEX workflows_workspace_updated_idx ON app.workflows USING btree (workspace_id, updated_at DESC, id DESC);

CREATE INDEX workspace_creation_idempotency_expiry_idx ON app.workspace_creation_idempotency_records USING btree (expires_at, id);

CREATE INDEX workspace_execution_entitlement_versions_workspace_time_idx ON app.workspace_execution_entitlement_versions USING btree (workspace_id, effective_at DESC, version DESC);

CREATE INDEX workspace_inbox_events_pending_idx ON app.workspace_inbox_events USING btree (created_at, id);

CREATE UNIQUE INDEX workspace_inbox_events_terminal_unique ON app.workspace_inbox_events USING btree (workspace_id, run_id, terminal_event_sequence);

CREATE INDEX workspace_inbox_events_workflow_idx ON app.workspace_inbox_events USING btree (workspace_id, workflow_id);

CREATE INDEX workspace_inbox_threads_expiry_idx ON app.workspace_inbox_threads USING btree (latest_occurred_at, workspace_id, workflow_id);

CREATE INDEX workspace_inbox_threads_recent_idx ON app.workspace_inbox_threads USING btree (workspace_id, latest_occurred_at DESC, workflow_id DESC);

CREATE INDEX workspace_invitation_binding_replacement_cleanup_idx ON app.workspace_invitation_binding_replacement_claims USING btree (updated_at, prior_workspace_id, prior_intent_id);

CREATE INDEX workspace_invitation_binding_replacement_successor_idx ON app.workspace_invitation_binding_replacement_claims USING btree (successor_workspace_id, successor_intent_id, successor_binding_digest);

CREATE UNIQUE INDEX workspace_invitation_delivery_generation_unique ON app.workspace_invitation_delivery_attempts USING btree (invitation_id, invitation_revision);

CREATE INDEX workspace_invitation_delivery_workspace_idx ON app.workspace_invitation_delivery_attempts USING btree (workspace_id, created_at, id);

CREATE UNIQUE INDEX workspace_invitation_intents_binding_unique ON app.workspace_invitation_acceptance_intents USING btree (workspace_id, binding_digest);

CREATE INDEX workspace_invitation_intents_expiry_idx ON app.workspace_invitation_acceptance_intents USING btree (expires_at, id);

CREATE INDEX workspace_invitation_intents_invitation_idx ON app.workspace_invitation_acceptance_intents USING btree (workspace_id, invitation_id, invitation_revision, id);

CREATE UNIQUE INDEX workspace_invitation_receipts_key_unique ON app.workspace_invitation_command_receipts USING btree (actor_user_id, workspace_id, operation, key_hash);

CREATE INDEX workspace_invitation_receipts_workspace_idx ON app.workspace_invitation_command_receipts USING btree (workspace_id, created_at, id);

CREATE INDEX workspace_invitations_expiry_idx ON app.workspace_invitations USING btree (expires_at, id) WHERE ((status)::text = 'pending'::text);

CREATE INDEX workspace_invitations_list_idx ON app.workspace_invitations USING btree (workspace_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX workspace_invitations_pending_recipient_unique ON app.workspace_invitations USING btree (workspace_id, normalized_email) WHERE ((status)::text = 'pending'::text);

CREATE UNIQUE INDEX workspace_invitations_token_digest_unique ON app.workspace_invitations USING btree (workspace_id, id, token_digest);

CREATE INDEX workspace_legal_holds_active_idx ON app.workspace_legal_holds USING btree (workspace_id, hold_id) WHERE (released_sequence IS NULL);

CREATE INDEX workspace_lifecycle_operations_claim_idx ON app.workspace_lifecycle_operations USING btree (created_at, id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying])::text[]));

CREATE INDEX workspace_lifecycle_operations_workspace_status_idx ON app.workspace_lifecycle_operations USING btree (workspace_id, status, created_at, id);

CREATE UNIQUE INDEX workspace_member_departure_command_receipts_key_unique ON app.workspace_member_departure_command_receipts USING btree (actor_user_id, workspace_id, key_hash);

CREATE INDEX workspace_member_departure_command_receipts_workspace_idx ON app.workspace_member_departure_command_receipts USING btree (workspace_id, created_at, id);

CREATE UNIQUE INDEX workspace_member_removal_command_receipts_key_unique ON app.workspace_member_removal_command_receipts USING btree (actor_user_id, workspace_id, key_hash);

CREATE INDEX workspace_member_removal_command_receipts_workspace_idx ON app.workspace_member_removal_command_receipts USING btree (workspace_id, created_at, id);

CREATE UNIQUE INDEX workspace_member_role_command_receipts_key_unique ON app.workspace_member_role_command_receipts USING btree (actor_user_id, workspace_id, key_hash);

CREATE INDEX workspace_member_role_command_receipts_workspace_idx ON app.workspace_member_role_command_receipts USING btree (workspace_id, created_at, id);

CREATE UNIQUE INDEX workspace_member_suspension_command_receipts_key_unique ON app.workspace_member_suspension_command_receipts USING btree (actor_user_id, workspace_id, key_hash);

CREATE INDEX workspace_member_suspension_command_receipts_workspace_idx ON app.workspace_member_suspension_command_receipts USING btree (workspace_id, created_at, id);

CREATE UNIQUE INDEX workspace_memberships_one_owner_unique ON app.workspace_memberships USING btree (workspace_id) WHERE (((role)::text = 'owner'::text) AND ((status)::text <> 'removed'::text));

CREATE INDEX workspace_memberships_user_idx ON app.workspace_memberships USING btree (user_id, workspace_id);

CREATE INDEX workspace_memberships_workspace_created_idx ON app.workspace_memberships USING btree (workspace_id, created_at, user_id) WHERE ((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[]));

CREATE INDEX workspace_memberships_workspace_status_idx ON app.workspace_memberships USING btree (workspace_id, status, user_id);

CREATE UNIQUE INDEX workspace_ownership_transfer_command_receipts_key_unique ON app.workspace_ownership_transfer_command_receipts USING btree (actor_user_id, workspace_id, key_hash);

CREATE INDEX workspace_ownership_transfer_command_receipts_workspace_idx ON app.workspace_ownership_transfer_command_receipts USING btree (workspace_id, created_at, id);

CREATE INDEX workspace_purge_jobs_claim_idx ON app.workspace_purge_jobs USING btree (created_at, id) WHERE ((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying])::text[]));

CREATE UNIQUE INDEX workspace_rename_command_receipts_key_unique ON app.workspace_rename_command_receipts USING btree (actor_user_id, workspace_id, key_hash);

CREATE INDEX workspace_rename_command_receipts_workspace_idx ON app.workspace_rename_command_receipts USING btree (workspace_id, created_at, id);

CREATE UNIQUE INDEX workspaces_slug_lower_unique ON app.workspaces USING btree (lower((slug)::text));

CREATE INDEX workspaces_status_purge_idx ON app.workspaces USING btree (status, purge_after, id) WHERE ((status)::text = ANY ((ARRAY['pending_deletion'::character varying, 'purging'::character varying])::text[]));

CREATE TRIGGER artifact_link_preview_retention BEFORE INSERT ON app.artifact_links FOR EACH ROW EXECUTE FUNCTION app.enforce_preview_artifact_retention();

CREATE TRIGGER artifacts_capacity_transition BEFORE INSERT OR DELETE OR UPDATE OF workspace_id, byte_length, purpose, storage_key, media_type, sha256, status, created_at ON app.artifacts FOR EACH ROW EXECUTE FUNCTION app.artifact_capacity_transition();

CREATE TRIGGER artifacts_preview_destruction_guard BEFORE UPDATE OF status ON app.artifacts FOR EACH ROW EXECUTE FUNCTION app.guard_preview_artifact_destruction();

CREATE TRIGGER connection_events_immutable BEFORE DELETE OR UPDATE ON app.connection_events FOR EACH ROW EXECUTE FUNCTION app.reject_connection_history_change();

CREATE TRIGGER connection_health_observations_command_cleanup AFTER DELETE ON app.connection_health_observations FOR EACH ROW EXECUTE FUNCTION app.cleanup_connection_health_command();

CREATE TRIGGER connection_secret_versions_immutable BEFORE DELETE OR UPDATE ON app.connection_secret_versions FOR EACH ROW EXECUTE FUNCTION app.reject_connection_history_change();

CREATE TRIGGER connections_health_protocol BEFORE UPDATE ON app.connections FOR EACH ROW EXECUTE FUNCTION app.enforce_connection_health_protocol();

CREATE TRIGGER connections_require_active_workspace BEFORE INSERT OR UPDATE OF status ON app.connections FOR EACH ROW WHEN (((new.status)::text = 'active'::text)) EXECUTE FUNCTION app.require_active_workspace_integration();

CREATE TRIGGER curated_template_descriptor_immutable BEFORE DELETE OR UPDATE ON app.curated_template_descriptors FOR EACH ROW EXECUTE FUNCTION app.guard_curated_template_descriptor();

CREATE TRIGGER failure_notification_destination_versions_immutable BEFORE DELETE OR UPDATE ON app.failure_notification_destination_versions FOR EACH ROW EXECUTE FUNCTION app.reject_failure_notification_destination_version_mutation();

CREATE TRIGGER manual_start_writer_fence BEFORE INSERT ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.enforce_manual_start_writer();

CREATE TRIGGER node_attempts_lock_artifact_references BEFORE INSERT OR UPDATE OF output_ref, reconciliation_ref ON app.node_attempts FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();

CREATE TRIGGER node_runs_lock_artifact_references BEFORE INSERT OR UPDATE OF input_ref, output_ref ON app.node_runs FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();

CREATE TRIGGER notification_destinations_require_active_workspace BEFORE INSERT OR UPDATE OF status ON app.failure_notification_destinations FOR EACH ROW WHEN (((new.status)::text = 'enabled'::text)) EXECUTE FUNCTION app.require_active_workspace_integration();

CREATE TRIGGER oidc_login_transactions_capacity BEFORE INSERT ON app.oidc_login_transactions FOR EACH ROW EXECUTE FUNCTION app.enforce_oidc_login_transaction_capacity();

CREATE TRIGGER operator_commands_result_default BEFORE INSERT ON app.operator_commands FOR EACH ROW EXECUTE FUNCTION app.populate_operator_command_result();

CREATE TRIGGER preview_run_pins_immutable BEFORE UPDATE ON app.preview_runs FOR EACH ROW EXECUTE FUNCTION app.reject_preview_run_pin_change();

CREATE TRIGGER retention_batches_controlled_mutation BEFORE DELETE OR UPDATE ON app.retention_batches FOR EACH ROW EXECUTE FUNCTION app.reject_retention_batch_direct_mutation();

CREATE TRIGGER retention_control_audit_facts_immutable BEFORE DELETE OR UPDATE ON app.retention_control_audit_facts FOR EACH ROW EXECUTE FUNCTION app.reject_retention_control_fact_mutation();

CREATE TRIGGER run_checkpoints_lock_artifact_references BEFORE INSERT OR UPDATE OF scheduler_state ON app.run_checkpoints FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();

CREATE TRIGGER run_events_lock_artifact_references BEFORE INSERT OR UPDATE OF payload ON app.run_events FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();

CREATE TRIGGER run_failure_notification_intents_require_run_pin BEFORE INSERT OR UPDATE OF workspace_id, workflow_run_id, policy_version, destination_id, destination_config_version, side_effect_class, connection_secret_version_id ON app.run_failure_notification_intents FOR EACH ROW EXECUTE FUNCTION app.require_new_failure_notification_intent_pin();

CREATE TRIGGER trigger_schedules_config_immutable BEFORE UPDATE ON app.trigger_schedules FOR EACH ROW EXECUTE FUNCTION app.reject_trigger_schedule_config_mutation();

CREATE TRIGGER trigger_schedules_require_active_workspace BEFORE INSERT OR UPDATE OF status ON app.trigger_schedules FOR EACH ROW WHEN (((new.status)::text = 'enabled'::text)) EXECUTE FUNCTION app.require_active_workspace_integration();

CREATE TRIGGER users_revoke_auth_sessions_on_deactivation AFTER UPDATE OF status ON app.users FOR EACH ROW EXECUTE FUNCTION app.revoke_auth_sessions_for_inactive_user();

CREATE TRIGGER users_revoke_auth_sessions_on_email_change AFTER UPDATE OF email ON app.users FOR EACH ROW WHEN (((old.email)::text IS DISTINCT FROM (new.email)::text)) EXECUTE FUNCTION app.revoke_auth_sessions_for_email_change();

CREATE TRIGGER webhook_endpoints_require_active_workspace BEFORE INSERT OR UPDATE OF status ON app.webhook_trigger_endpoints FOR EACH ROW WHEN (((new.status)::text = 'active'::text)) EXECUTE FUNCTION app.require_active_workspace_integration();

CREATE TRIGGER webhook_trigger_secret_versions_immutable BEFORE DELETE OR UPDATE ON app.webhook_trigger_secret_versions FOR EACH ROW EXECUTE FUNCTION app.reject_webhook_trigger_secret_version_mutation();

CREATE TRIGGER workflow_favorite_membership_departure AFTER UPDATE OF status ON app.workspace_memberships FOR EACH ROW EXECUTE FUNCTION app.invalidate_workflow_favorite_membership();

CREATE TRIGGER workflow_input_case_payloads_write_guard BEFORE INSERT ON app.workflow_input_case_payloads FOR EACH ROW EXECUTE FUNCTION app.guard_workflow_input_case_write();

CREATE TRIGGER workflow_input_case_receipts_write_guard BEFORE INSERT ON app.workflow_input_case_receipts FOR EACH ROW EXECUTE FUNCTION app.guard_workflow_input_case_write();

CREATE TRIGGER workflow_input_cases_write_guard BEFORE INSERT OR UPDATE ON app.workflow_input_cases FOR EACH ROW EXECUTE FUNCTION app.guard_workflow_input_case_write();

CREATE TRIGGER workflow_runs_execution_admission BEFORE INSERT OR UPDATE OF workspace_id, status, execution_entitlement_version ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.enforce_workflow_run_admission();

CREATE TRIGGER workflow_runs_lock_artifact_references BEFORE INSERT OR UPDATE OF input_ref, output_ref ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();

CREATE TRIGGER workflow_runs_refresh_execution_admission AFTER INSERT OR UPDATE OF workspace_id, status, execution_entitlement_version ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.refresh_workflow_run_admission_counters();

CREATE TRIGGER workflow_runs_require_new_failure_notification_pin BEFORE INSERT OR UPDATE OF failure_notification_policy_version, failure_notification_destination_id, failure_notification_destination_config_version, failure_notification_side_effect_class, failure_notification_connection_secret_version_id ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.validate_workflow_run_failure_notification_pin();

CREATE TRIGGER workflow_triggers_require_active_workspace BEFORE INSERT OR UPDATE OF status ON app.workflow_triggers FOR EACH ROW WHEN (((new.status)::text <> 'disabled'::text)) EXECUTE FUNCTION app.require_active_workspace_integration();

CREATE TRIGGER workflow_versions_immutable BEFORE DELETE OR UPDATE ON app.workflow_versions FOR EACH ROW EXECUTE FUNCTION app.reject_workflow_version_mutation();

CREATE TRIGGER workspace_artifact_capacity_purge_start BEFORE UPDATE OF status ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.artifact_capacity_purge_start();

CREATE TRIGGER workspace_control_ledger_projection_immutable BEFORE DELETE OR UPDATE ON app.workspace_control_ledger_projection FOR EACH ROW EXECUTE FUNCTION app.reject_retention_control_fact_mutation();

CREATE TRIGGER workspace_execution_entitlement_versions_immutable BEFORE DELETE OR UPDATE ON app.workspace_execution_entitlement_versions FOR EACH ROW EXECUTE FUNCTION app.reject_execution_entitlement_version_mutation();

CREATE TRIGGER workspace_inbox_reads_monotonic BEFORE UPDATE ON app.workspace_inbox_reads FOR EACH ROW EXECUTE FUNCTION app.preserve_workspace_inbox_read_revision();

CREATE TRIGGER workspace_legal_holds_controlled_mutation BEFORE DELETE OR UPDATE ON app.workspace_legal_holds FOR EACH ROW EXECUTE FUNCTION app.reject_workspace_legal_hold_mutation();

CREATE CONSTRAINT TRIGGER workspace_legal_holds_ledger_links AFTER INSERT OR UPDATE ON app.workspace_legal_holds DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION app.enforce_workspace_legal_hold_ledger_links();

CREATE TRIGGER workspace_lifecycle_operations_canonical_time BEFORE INSERT ON app.workspace_lifecycle_operations FOR EACH ROW EXECUTE FUNCTION app.canonicalize_workspace_lifecycle_operation_time();

CREATE TRIGGER workspace_lifecycle_operations_controlled_mutation BEFORE DELETE OR UPDATE ON app.workspace_lifecycle_operations FOR EACH ROW EXECUTE FUNCTION app.reject_workspace_lifecycle_operation_direct_mutation();

CREATE TRIGGER workspace_purge_completions_controlled_mutation BEFORE DELETE OR UPDATE ON app.workspace_purge_completions FOR EACH ROW EXECUTE FUNCTION app.reject_workspace_purge_direct_mutation();

CREATE TRIGGER workspace_purge_jobs_controlled_mutation BEFORE DELETE OR UPDATE ON app.workspace_purge_jobs FOR EACH ROW EXECUTE FUNCTION app.reject_workspace_purge_direct_mutation();

CREATE TRIGGER workspace_purge_steps_controlled_mutation BEFORE DELETE OR UPDATE ON app.workspace_purge_steps FOR EACH ROW EXECUTE FUNCTION app.reject_workspace_purge_direct_mutation();

CREATE TRIGGER workspaces_apply_deletion_side_effects AFTER UPDATE OF status ON app.workspaces FOR EACH ROW WHEN (((new.status)::text = 'pending_deletion'::text)) EXECUTE FUNCTION app.apply_workspace_deletion_side_effects();

CREATE TRIGGER workspaces_apply_invitation_deletion_side_effects AFTER UPDATE OF status ON app.workspaces FOR EACH ROW WHEN (((new.status)::text = 'pending_deletion'::text)) EXECUTE FUNCTION app.apply_workspace_invitation_deletion_side_effects();

CREATE TRIGGER workspaces_arm_control_projection BEFORE UPDATE ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.arm_workspace_control_projection();

CREATE TRIGGER workspaces_controlled_lifecycle_mutation BEFORE UPDATE ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.reject_workspace_control_direct_mutation();

CREATE TRIGGER workspaces_incomplete_deletion_guard BEFORE UPDATE ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.block_incomplete_workspace_deletion();

CREATE TRIGGER workspaces_provision_execution_admission AFTER INSERT ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.provision_workspace_execution_admission();

CREATE TRIGGER workspaces_provision_retention_schedule AFTER INSERT ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.provision_retention_schedule_state();

CREATE TRIGGER workspaces_retention_control_initial_state BEFORE INSERT ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.enforce_workspace_retention_control_initial_state();

CREATE TRIGGER workspaces_revoke_auth_sessions_on_unavailability AFTER UPDATE OF status ON app.workspaces FOR EACH ROW WHEN ((((old.status)::text IS DISTINCT FROM (new.status)::text) AND ((new.status)::text = ANY ((ARRAY['suspended'::character varying, 'pending_deletion'::character varying, 'purging'::character varying, 'deleted'::character varying])::text[])))) EXECUTE FUNCTION app.revoke_auth_sessions_for_workspace_unavailability();

ALTER TABLE ONLY app.artifact_links
    ADD CONSTRAINT artifact_links_artifact_fk FOREIGN KEY (workspace_id, artifact_id) REFERENCES app.artifacts(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.artifact_links
    ADD CONSTRAINT artifact_links_preview_run_fk FOREIGN KEY (workspace_id, owner_id) REFERENCES app.preview_runs(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.audit_events
    ADD CONSTRAINT audit_events_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.audit_events
    ADD CONSTRAINT audit_events_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.auth_accounts
    ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.auth_email_proofs
    ADD CONSTRAINT auth_email_proofs_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.auth_identities
    ADD CONSTRAINT auth_identities_user_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.auth_legacy_method_migration_attempts
    ADD CONSTRAINT auth_legacy_method_migration_attempts_legacy_identity_id_fkey FOREIGN KEY (legacy_identity_id) REFERENCES app.auth_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.auth_legacy_method_migration_attempts
    ADD CONSTRAINT auth_legacy_method_migration_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.auth_method_link_attempts
    ADD CONSTRAINT auth_method_link_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.connection_events
    ADD CONSTRAINT connection_events_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.connection_health_observations
    ADD CONSTRAINT connection_health_observations_dispatch_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES app.node_attempt_connection_dispatches(workspace_id, attempt_id) ON DELETE CASCADE;

ALTER TABLE ONLY app.connection_secret_versions
    ADD CONSTRAINT connection_secret_versions_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.connection_secret_versions
    ADD CONSTRAINT connection_secret_versions_created_by_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_created_by_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_current_secret_same_connection_fk FOREIGN KEY (workspace_id, id, current_secret_version_id) REFERENCES app.connection_secret_versions(workspace_id, connection_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_creator_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_destination_kind_fk FOREIGN KEY (workspace_id, destination_id, kind) REFERENCES app.failure_notification_destinations(workspace_id, id, kind) ON DELETE RESTRICT;

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_creator_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_current_version_fk FOREIGN KEY (workspace_id, id, current_config_version) REFERENCES app.failure_notification_destination_versions(workspace_id, destination_id, version) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.node_attempt_connection_dispatches
    ADD CONSTRAINT node_attempt_connection_dispatches_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES app.node_attempts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.node_attempts
    ADD CONSTRAINT node_attempts_node_run_workspace_fk FOREIGN KEY (workspace_id, node_run_id) REFERENCES app.node_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_current_attempt_workspace_fk FOREIGN KEY (workspace_id, current_attempt_id) REFERENCES app.node_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_run_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.operator_maintenance_rerun_requests
    ADD CONSTRAINT operator_maintenance_rerun_requests_command_id_fkey FOREIGN KEY (command_id) REFERENCES app.operator_commands(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_requests_command_id_fkey FOREIGN KEY (command_id) REFERENCES app.operator_commands(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_result_fk FOREIGN KEY (workspace_id, result_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_source_fk FOREIGN KEY (workspace_id, source_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_version_fk FOREIGN KEY (workspace_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.operator_unknown_outcome_evidence
    ADD CONSTRAINT operator_unknown_evidence_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES app.node_attempts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.preview_attempts
    ADD CONSTRAINT preview_attempts_run_fk FOREIGN KEY (workspace_id, preview_run_id) REFERENCES app.preview_runs(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_prior_preview_fk FOREIGN KEY (workspace_id, workflow_id, prior_preview_run_id) REFERENCES app.preview_runs(workspace_id, workflow_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.retention_batches
    ADD CONSTRAINT retention_batches_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.retention_control_audit_facts
    ADD CONSTRAINT retention_control_audit_facts_record_fk FOREIGN KEY (workspace_id, command_id, subject_id, fact_type, control_sequence, control_record_hash, actor_ref, occurred_at) REFERENCES app.workspace_control_ledger_projection(workspace_id, command_id, subject_id, command_type, sequence, record_hash, actor_ref, occurred_at) ON DELETE RESTRICT;

ALTER TABLE ONLY app.retention_schedule_state
    ADD CONSTRAINT retention_schedule_state_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.run_checkpoints
    ADD CONSTRAINT run_checkpoints_run_version_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id, workflow_version_id) REFERENCES app.workflow_runs(workspace_id, id, workflow_version_id) ON DELETE CASCADE;

ALTER TABLE ONLY app.run_checkpoints
    ADD CONSTRAINT run_checkpoints_run_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.run_events
    ADD CONSTRAINT run_events_run_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.run_failure_notification_audit_facts
    ADD CONSTRAINT run_failure_notification_audit_intent_workspace_fk FOREIGN KEY (workspace_id, notification_intent_id) REFERENCES app.run_failure_notification_intents(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_destination_version_fk FOREIGN KEY (workspace_id, destination_id, destination_config_version) REFERENCES app.failure_notification_destination_versions(workspace_id, destination_id, version) ON DELETE RESTRICT NOT VALID;

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_run_pin_fk FOREIGN KEY (workspace_id, workflow_run_id, policy_version, destination_id, destination_config_version, side_effect_class, connection_secret_version_id) REFERENCES app.workflow_runs(workspace_id, id, failure_notification_policy_version, failure_notification_destination_id, failure_notification_destination_config_version, failure_notification_side_effect_class, failure_notification_connection_secret_version_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_run_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_run_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_schedule_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES app.trigger_schedules(workspace_id, trigger_id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.trigger_schedules
    ADD CONSTRAINT trigger_schedules_trigger_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES app.workflow_triggers(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.usage_events
    ADD CONSTRAINT usage_events_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.user_profile_command_receipts
    ADD CONSTRAINT user_profile_command_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.webhook_endpoint_ingress_limits
    ADD CONSTRAINT webhook_endpoint_ingress_limits_endpoint_fk FOREIGN KEY (workspace_id, endpoint_id) REFERENCES app.webhook_trigger_endpoints(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_endpoint_fk FOREIGN KEY (workspace_id, endpoint_id) REFERENCES app.webhook_trigger_endpoints(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_run_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_trigger_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES app.workflow_triggers(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_current_secret_fk FOREIGN KEY (workspace_id, trigger_id, current_secret_version_id) REFERENCES app.webhook_trigger_secret_versions(workspace_id, trigger_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_previous_secret_fk FOREIGN KEY (workspace_id, trigger_id, previous_secret_version_id) REFERENCES app.webhook_trigger_secret_versions(workspace_id, trigger_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_trigger_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES app.workflow_triggers(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_delivery_fk FOREIGN KEY (workspace_id, delivery_id) REFERENCES app.webhook_trigger_deliveries(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_endpoint_fk FOREIGN KEY (workspace_id, endpoint_id) REFERENCES app.webhook_trigger_endpoints(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_run_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_secret_versions
    ADD CONSTRAINT webhook_trigger_secret_versions_creator_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.webhook_trigger_secret_versions
    ADD CONSTRAINT webhook_trigger_secret_versions_trigger_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES app.workflow_triggers(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflow_auto_pause_command_receipts
    ADD CONSTRAINT workflow_auto_pause_command_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_concurrency_command_receipts
    ADD CONSTRAINT workflow_concurrency_command_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_concurrency_policies
    ADD CONSTRAINT workflow_concurrency_policies_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_drafts
    ADD CONSTRAINT workflow_drafts_updated_by_fk FOREIGN KEY (updated_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflow_drafts
    ADD CONSTRAINT workflow_drafts_workflow_workspace_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_destination_fk FOREIGN KEY (workspace_id, destination_id) REFERENCES app.failure_notification_destinations(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_updater_fk FOREIGN KEY (updated_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_failure_streaks
    ADD CONSTRAINT workflow_failure_streaks_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_favorite_held_evidence
    ADD CONSTRAINT workflow_favorite_held_evidence_workspace_id_actor_id_fkey FOREIGN KEY (workspace_id, actor_id) REFERENCES app.workflow_favorite_membership_generations(workspace_id, actor_id);

ALTER TABLE ONLY app.workflow_favorite_held_evidence
    ADD CONSTRAINT workflow_favorite_held_evidence_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);

ALTER TABLE ONLY app.workflow_favorite_membership_generations
    ADD CONSTRAINT workflow_favorite_membership_generat_workspace_id_actor_id_fkey FOREIGN KEY (workspace_id, actor_id) REFERENCES app.workspace_memberships(workspace_id, user_id);

ALTER TABLE ONLY app.workflow_favorite_membership_generations
    ADD CONSTRAINT workflow_favorite_membership_generations_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES app.users(id);

ALTER TABLE ONLY app.workflow_favorite_membership_generations
    ADD CONSTRAINT workflow_favorite_membership_generations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);

ALTER TABLE ONLY app.workflow_favorite_receipts
    ADD CONSTRAINT workflow_favorite_receipts_workspace_id_actor_id_fkey FOREIGN KEY (workspace_id, actor_id) REFERENCES app.workflow_favorite_membership_generations(workspace_id, actor_id);

ALTER TABLE ONLY app.workflow_favorites
    ADD CONSTRAINT workflow_favorites_workspace_id_actor_id_fkey FOREIGN KEY (workspace_id, actor_id) REFERENCES app.workflow_favorite_membership_generations(workspace_id, actor_id);

ALTER TABLE ONLY app.workflow_favorites
    ADD CONSTRAINT workflow_favorites_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);

ALTER TABLE ONLY app.workflow_folders
    ADD CONSTRAINT workflow_folders_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);

ALTER TABLE ONLY app.workflow_folders
    ADD CONSTRAINT workflow_folders_workspace_id_parent_id_fkey FOREIGN KEY (workspace_id, parent_id) REFERENCES app.workflow_folders(workspace_id, id);

ALTER TABLE ONLY app.workflow_input_case_payloads
    ADD CONSTRAINT workflow_input_case_payloads_workspace_id_case_id_fkey FOREIGN KEY (workspace_id, case_id) REFERENCES app.workflow_input_cases(workspace_id, id);

ALTER TABLE ONLY app.workflow_input_case_receipts
    ADD CONSTRAINT workflow_input_case_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);

ALTER TABLE ONLY app.workflow_input_cases
    ADD CONSTRAINT workflow_input_cases_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);

ALTER TABLE ONLY app.workflow_input_cases
    ADD CONSTRAINT workflow_input_cases_workspace_id_workflow_id_workflow_ver_fkey FOREIGN KEY (workspace_id, workflow_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id);

ALTER TABLE ONLY app.workflow_integration_usage
    ADD CONSTRAINT workflow_integration_usage_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflow_integration_usage
    ADD CONSTRAINT workflow_integration_usage_version_fk FOREIGN KEY (workspace_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_manual_start_rejections
    ADD CONSTRAINT workflow_manual_start_rejections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);

ALTER TABLE ONLY app.workflow_manual_start_rejections
    ADD CONSTRAINT workflow_manual_start_rejections_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);

ALTER TABLE ONLY app.workflow_organization_coordination
    ADD CONSTRAINT workflow_organization_coordination_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);

ALTER TABLE ONLY app.workflow_organization_receipts
    ADD CONSTRAINT workflow_organization_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);

ALTER TABLE ONLY app.workflow_organization_state
    ADD CONSTRAINT workflow_organization_state_folder_fk FOREIGN KEY (workspace_id, folder_id) REFERENCES app.workflow_folders(workspace_id, id);

ALTER TABLE ONLY app.workflow_organization_state
    ADD CONSTRAINT workflow_organization_state_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_outbox_fk FOREIGN KEY (outbox_event_id) REFERENCES app.outbox_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_run_fk FOREIGN KEY (workflow_run_id) REFERENCES app.workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_execution_entitlement_fk FOREIGN KEY (workspace_id, execution_entitlement_version) REFERENCES app.workspace_execution_entitlement_versions(workspace_id, version) ON DELETE RESTRICT NOT VALID;

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_failure_notification_destination_version_fk FOREIGN KEY (workspace_id, failure_notification_destination_id, failure_notification_destination_config_version) REFERENCES app.failure_notification_destination_versions(workspace_id, destination_id, version) ON DELETE RESTRICT NOT VALID;

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_replay_source_fk FOREIGN KEY (workspace_id, replay_source_run_id) REFERENCES app.workflow_runs(workspace_id, id);

ALTER TABLE ONLY app.workflow_tag_assignments
    ADD CONSTRAINT workflow_tag_assignments_workspace_id_tag_id_fkey FOREIGN KEY (workspace_id, tag_id) REFERENCES app.workflow_tags(workspace_id, id);

ALTER TABLE ONLY app.workflow_tag_assignments
    ADD CONSTRAINT workflow_tag_assignments_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);

ALTER TABLE ONLY app.workflow_tags
    ADD CONSTRAINT workflow_tags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);

ALTER TABLE ONLY app.workflow_template_origins
    ADD CONSTRAINT workflow_template_origins_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_trigger_outcomes
    ADD CONSTRAINT workflow_trigger_outcomes_run_fk FOREIGN KEY (workspace_id, run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_trigger_outcomes
    ADD CONSTRAINT workflow_trigger_outcomes_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_trigger_pause_periods
    ADD CONSTRAINT workflow_trigger_pause_periods_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_version_fk FOREIGN KEY (workspace_id, workflow_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_published_by_fk FOREIGN KEY (published_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_workflow_workspace_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_created_by_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_published_version_workspace_fk FOREIGN KEY (workspace_id, id, published_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_control_ledger_projection
    ADD CONSTRAINT workspace_control_ledger_projection_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_creation_idempotency_records
    ADD CONSTRAINT workspace_creation_idempotency_records_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES app.users(id);

ALTER TABLE ONLY app.workspace_creation_idempotency_records
    ADD CONSTRAINT workspace_creation_idempotency_records_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES app.workspaces(id);

ALTER TABLE ONLY app.workspace_execution_admission_counters
    ADD CONSTRAINT workspace_execution_admission_counters_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_execution_entitlement_versions
    ADD CONSTRAINT workspace_execution_entitlement_versions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_execution_entitlements
    ADD CONSTRAINT workspace_execution_entitlements_version_fk FOREIGN KEY (workspace_id, current_version) REFERENCES app.workspace_execution_entitlement_versions(workspace_id, version) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_inbox_events
    ADD CONSTRAINT workspace_inbox_events_run_fk FOREIGN KEY (workspace_id, run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_inbox_events
    ADD CONSTRAINT workspace_inbox_events_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_inbox_reads
    ADD CONSTRAINT workspace_inbox_reads_membership_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_inbox_reads
    ADD CONSTRAINT workspace_inbox_reads_thread_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workspace_inbox_threads(workspace_id, workflow_id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_accepted_user_id_fkey FOREIGN KEY (accepted_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES app.workspace_invitations(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_verified_user_id_fkey FOREIGN KEY (verified_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_invitation_binding_replacement_claims
    ADD CONSTRAINT workspace_invitation_binding_replacemen_prior_workspace_id_fkey FOREIGN KEY (prior_workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_invitation_claim_cleanup_cursors
    ADD CONSTRAINT workspace_invitation_claim_cleanup_cursors_purge_job_id_fkey FOREIGN KEY (purge_job_id) REFERENCES app.workspace_purge_jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_invitation_command_receipts
    ADD CONSTRAINT workspace_invitation_command_receipts_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_invitation_command_receipts
    ADD CONSTRAINT workspace_invitation_command_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_invitation_delivery_attempts
    ADD CONSTRAINT workspace_invitation_delivery_attempts_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES app.workspace_invitations(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_invitation_delivery_attempts
    ADD CONSTRAINT workspace_invitation_delivery_attempts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_invitations
    ADD CONSTRAINT workspace_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_invitations
    ADD CONSTRAINT workspace_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_invitations
    ADD CONSTRAINT workspace_invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_legal_holds
    ADD CONSTRAINT workspace_legal_holds_placement_record_fk FOREIGN KEY (workspace_id, placed_sequence) REFERENCES app.workspace_control_ledger_projection(workspace_id, sequence) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_legal_holds
    ADD CONSTRAINT workspace_legal_holds_release_record_fk FOREIGN KEY (workspace_id, released_sequence) REFERENCES app.workspace_control_ledger_projection(workspace_id, sequence) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_legal_holds
    ADD CONSTRAINT workspace_legal_holds_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_lifecycle_operations
    ADD CONSTRAINT workspace_lifecycle_operations_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_lifecycle_operations
    ADD CONSTRAINT workspace_lifecycle_operations_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_departure_command_receipts
    ADD CONSTRAINT workspace_member_departure_command_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_departure_command_receipts
    ADD CONSTRAINT workspace_member_departure_command_receipts_target_fk FOREIGN KEY (target_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_departure_command_receipts
    ADD CONSTRAINT workspace_member_departure_command_receipts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_member_removal_command_receipts
    ADD CONSTRAINT workspace_member_removal_command_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_removal_command_receipts
    ADD CONSTRAINT workspace_member_removal_command_receipts_target_fk FOREIGN KEY (target_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_removal_command_receipts
    ADD CONSTRAINT workspace_member_removal_command_receipts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_member_role_command_receipts
    ADD CONSTRAINT workspace_member_role_command_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_role_command_receipts
    ADD CONSTRAINT workspace_member_role_command_receipts_target_fk FOREIGN KEY (target_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_role_command_receipts
    ADD CONSTRAINT workspace_member_role_command_receipts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_member_suspension_command_receipts
    ADD CONSTRAINT workspace_member_suspension_command_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_suspension_command_receipts
    ADD CONSTRAINT workspace_member_suspension_command_receipts_target_fk FOREIGN KEY (target_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_member_suspension_command_receipts
    ADD CONSTRAINT workspace_member_suspension_command_receipts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_memberships
    ADD CONSTRAINT workspace_memberships_user_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_memberships
    ADD CONSTRAINT workspace_memberships_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_ownership_transfer_command_receipts
    ADD CONSTRAINT workspace_ownership_transfer_command_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_ownership_transfer_command_receipts
    ADD CONSTRAINT workspace_ownership_transfer_command_receipts_target_fk FOREIGN KEY (target_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_ownership_transfer_command_receipts
    ADD CONSTRAINT workspace_ownership_transfer_command_receipts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspace_purge_completions
    ADD CONSTRAINT workspace_purge_completions_job_id_fkey FOREIGN KEY (job_id) REFERENCES app.workspace_purge_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_purge_jobs
    ADD CONSTRAINT workspace_purge_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_purge_steps
    ADD CONSTRAINT workspace_purge_steps_job_id_fkey FOREIGN KEY (job_id) REFERENCES app.workspace_purge_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_rename_command_receipts
    ADD CONSTRAINT workspace_rename_command_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspace_rename_command_receipts
    ADD CONSTRAINT workspace_rename_command_receipts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY app.workspaces
    ADD CONSTRAINT workspaces_created_by_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY app.workspaces
    ADD CONSTRAINT workspaces_deletion_requested_by_fk FOREIGN KEY (deletion_requested_by) REFERENCES app.users(id) ON DELETE RESTRICT;

ALTER TABLE app.artifact_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY artifact_links_workspace_scope ON app.artifact_links TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY artifacts_owner_retention_delete ON app.artifacts FOR DELETE TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY artifacts_owner_retention_inventory ON app.artifacts FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY artifacts_owner_retention_update ON app.artifacts FOR UPDATE TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY artifacts_workspace_scope ON app.artifacts TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_events_retention_scope ON app.audit_events TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY audit_events_workspace_insert ON app.audit_events FOR INSERT TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY audit_events_workspace_select ON app.audit_events FOR SELECT TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.connection_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY connection_events_workspace_scope ON app.connection_events TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.connection_health_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY connection_health_observations_workspace_scope ON app.connection_health_observations TO {{owner_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.connection_secret_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY connection_secret_versions_workspace_scope ON app.connection_secret_versions TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY connections_workspace_scope ON app.connections TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.failure_notification_destination_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY failure_notification_destination_versions_workspace_scope ON app.failure_notification_destination_versions TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.failure_notification_destinations ENABLE ROW LEVEL SECURITY;

CREATE POLICY failure_notification_destinations_workspace_scope ON app.failure_notification_destinations TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.idempotency_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_records_owner_maintenance ON app.idempotency_records TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY idempotency_records_workspace_scope ON app.idempotency_records TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.inbox_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbox_receipts_connection_health_owner_select ON app.inbox_receipts FOR SELECT TO {{owner_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND ((consumer_name)::text = 'connection-health-worker'::text)));

CREATE POLICY inbox_receipts_owner_leased_purge_delete ON app.inbox_receipts FOR DELETE TO {{owner_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND app.workspace_purge_immutable_delete_is_armed(workspace_id)));

CREATE POLICY inbox_receipts_owner_leased_purge_lock ON app.inbox_receipts FOR UPDATE TO {{owner_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND app.workspace_purge_immutable_delete_is_armed(workspace_id))) WITH CHECK ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND app.workspace_purge_immutable_delete_is_armed(workspace_id)));

CREATE POLICY inbox_receipts_owner_leased_purge_select ON app.inbox_receipts FOR SELECT TO {{owner_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND app.workspace_purge_immutable_delete_is_armed(workspace_id)));

CREATE POLICY inbox_receipts_workspace_scope ON app.inbox_receipts TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.node_attempt_connection_dispatches ENABLE ROW LEVEL SECURITY;

CREATE POLICY node_attempt_connection_dispatches_workspace_scope ON app.node_attempt_connection_dispatches TO {{owner_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.node_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY node_attempts_retention_scope ON app.node_attempts TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY node_attempts_workspace_scope ON app.node_attempts TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.node_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY node_runs_due_wakeup_owner_select ON app.node_runs FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY node_runs_due_wakeup_owner_update ON app.node_runs FOR UPDATE TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY node_runs_lifecycle_owner_select ON app.node_runs FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY node_runs_retention_scope ON app.node_runs TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY node_runs_workspace_scope ON app.node_runs TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.operator_maintenance_rerun_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY operator_maintenance_rerun_workspace_scope ON app.operator_maintenance_rerun_requests TO {{owner_role}}, {{maintenance_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.operator_run_replay_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY operator_run_replay_requests_workspace_scope ON app.operator_run_replay_requests TO {{owner_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY operator_unknown_evidence_owner_all ON app.operator_unknown_outcome_evidence TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY operator_unknown_evidence_worker_select ON app.operator_unknown_outcome_evidence FOR SELECT TO {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.operator_unknown_outcome_evidence ENABLE ROW LEVEL SECURITY;

ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbox_events_active_admission_owner_select ON app.outbox_events FOR SELECT TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY outbox_events_active_admission_owner_update ON app.outbox_events FOR UPDATE TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY outbox_events_connection_health_owner_delete ON app.outbox_events FOR DELETE TO {{owner_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND ((job_name)::text = 'apply-connection-health-observation'::text)));

CREATE POLICY outbox_events_dispatcher_select ON app.outbox_events FOR SELECT TO {{dispatcher_role}} USING (true);

CREATE POLICY outbox_events_dispatcher_update ON app.outbox_events FOR UPDATE TO {{dispatcher_role}} USING (true) WITH CHECK (true);

CREATE POLICY outbox_events_due_wakeup_owner_insert ON app.outbox_events FOR INSERT TO {{owner_role}} WITH CHECK (true);

CREATE POLICY outbox_events_operator_command_select ON app.outbox_events FOR SELECT TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY outbox_events_operator_command_update ON app.outbox_events FOR UPDATE TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY outbox_events_owner_leased_purge_delete ON app.outbox_events FOR DELETE TO {{owner_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND app.workspace_purge_immutable_delete_is_armed(workspace_id)));

CREATE POLICY outbox_events_tenant_insert ON app.outbox_events FOR INSERT TO {{api_runtime_role}}, {{worker_runtime_role}} WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY outbox_events_tenant_select ON app.outbox_events FOR SELECT TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.preview_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY preview_attempts_workspace_scope ON app.preview_attempts TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.preview_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY preview_runs_owner_retention_inventory ON app.preview_runs FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY preview_runs_workspace_scope ON app.preview_runs TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.retention_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY retention_batches_owner_all ON app.retention_batches TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.retention_control_audit_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY retention_control_audit_facts_owner_all ON app.retention_control_audit_facts TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.retention_schedule_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY retention_schedule_state_owner_all ON app.retention_schedule_state TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.rls_probe_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_probe_records_workspace_scope ON app.rls_probe_records TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.run_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_checkpoints_lifecycle_owner_select ON app.run_checkpoints FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY run_checkpoints_lifecycle_owner_update ON app.run_checkpoints FOR UPDATE TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY run_checkpoints_retention_scope ON app.run_checkpoints TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY run_checkpoints_workspace_scope ON app.run_checkpoints TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.run_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_events_lifecycle_owner_insert ON app.run_events FOR INSERT TO {{owner_role}} WITH CHECK (true);

CREATE POLICY run_events_lifecycle_owner_select ON app.run_events FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY run_events_retention_scope ON app.run_events TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY run_events_workspace_scope ON app.run_events TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.run_failure_notification_audit_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_failure_notification_audit_recovery_owner_insert ON app.run_failure_notification_audit_facts FOR INSERT TO {{owner_role}} WITH CHECK (true);

CREATE POLICY run_failure_notification_audit_workspace_scope ON app.run_failure_notification_audit_facts TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.run_failure_notification_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_failure_notification_intents_recovery_owner_select ON app.run_failure_notification_intents FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY run_failure_notification_intents_recovery_owner_update ON app.run_failure_notification_intents FOR UPDATE TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY run_failure_notification_intents_workspace_scope ON app.run_failure_notification_intents TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.transport_security_audit_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY transport_security_audit_facts_retention_scope ON app.transport_security_audit_facts TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY transport_security_audit_facts_workspace_scope ON app.transport_security_audit_facts TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.trigger_schedule_occurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY trigger_schedule_occurrences_owner_worker ON app.trigger_schedule_occurrences TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY trigger_schedule_occurrences_retention_scope ON app.trigger_schedule_occurrences TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY trigger_schedule_occurrences_workspace_scope ON app.trigger_schedule_occurrences TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.trigger_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY trigger_schedules_owner_worker ON app.trigger_schedules TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY trigger_schedules_worker_reconciliation ON app.trigger_schedules TO {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY trigger_schedules_workspace_scope ON app.trigger_schedules TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_events_workspace_insert ON app.usage_events FOR INSERT TO {{owner_role}}, {{worker_runtime_role}} WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY usage_events_workspace_select ON app.usage_events FOR SELECT TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.webhook_endpoint_ingress_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_endpoint_ingress_limits_owner ON app.webhook_endpoint_ingress_limits TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.webhook_trigger_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_trigger_deliveries_retention_scope ON app.webhook_trigger_deliveries TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY webhook_trigger_deliveries_workspace_scope ON app.webhook_trigger_deliveries TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.webhook_trigger_endpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_trigger_endpoints_api_scope ON app.webhook_trigger_endpoints TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY webhook_trigger_endpoints_owner_resolver ON app.webhook_trigger_endpoints FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY webhook_trigger_endpoints_worker_reconciliation ON app.webhook_trigger_endpoints TO {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.webhook_trigger_replay_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_trigger_replay_records_retention_scope ON app.webhook_trigger_replay_records TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY webhook_trigger_replay_records_workspace_scope ON app.webhook_trigger_replay_records TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.webhook_trigger_secret_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_trigger_secret_versions_api_scope ON app.webhook_trigger_secret_versions TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY webhook_trigger_secret_versions_owner_resolver ON app.webhook_trigger_secret_versions FOR SELECT TO {{owner_role}} USING (true);

ALTER TABLE app.workflow_auto_pause_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_auto_pause_receipts_owner ON app.workflow_auto_pause_command_receipts TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_concurrency_command_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE app.workflow_concurrency_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_concurrency_policies_owner ON app.workflow_concurrency_policies TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_concurrency_receipts_owner ON app.workflow_concurrency_command_receipts TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_drafts_workspace_scope ON app.workflow_drafts TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_failure_notification_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_failure_notification_policies_workspace_scope ON app.workflow_failure_notification_policies TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_failure_streaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_failure_streaks_owner_commands ON app.workflow_failure_streaks TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_favorite_held_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_favorite_held_evidence_owner ON app.workflow_favorite_held_evidence TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_favorite_membership_generations ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_favorite_membership_generations_owner ON app.workflow_favorite_membership_generations TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_favorite_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_favorite_receipts_actor ON app.workflow_favorite_receipts FOR SELECT TO {{api_runtime_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND ((actor_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)) AND (generation = app.current_workflow_favorite_generation())));

CREATE POLICY workflow_favorite_receipts_owner ON app.workflow_favorite_receipts TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_favorites_actor ON app.workflow_favorites FOR SELECT TO {{api_runtime_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND ((actor_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)) AND (generation = app.current_workflow_favorite_generation())));

CREATE POLICY workflow_favorites_owner ON app.workflow_favorites TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_folders_owner ON app.workflow_folders TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_folders_reader ON app.workflow_folders FOR SELECT TO {{api_runtime_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1
   FROM ((app.workspaces w
     JOIN app.workspace_memberships m ON ((m.workspace_id = w.id)))
     JOIN app.users u ON ((u.id = m.user_id)))
  WHERE ((w.id = workflow_folders.workspace_id) AND ((w.status)::text = 'active'::text) AND ((m.user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)) AND ((m.status)::text = 'active'::text) AND ((u.status)::text = 'active'::text))))));

ALTER TABLE app.workflow_input_case_payloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_input_case_payloads_owner ON app.workflow_input_case_payloads TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_input_case_payloads_tenant ON app.workflow_input_case_payloads TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_input_case_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_input_case_receipts_owner ON app.workflow_input_case_receipts TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_input_case_receipts_tenant ON app.workflow_input_case_receipts TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_input_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_input_cases_owner ON app.workflow_input_cases TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_input_cases_tenant ON app.workflow_input_cases TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_integration_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_integration_usage_workspace_scope ON app.workflow_integration_usage TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_manual_start_rejections ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_manual_start_rejections_owner ON app.workflow_manual_start_rejections TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_manual_start_rejections_tenant ON app.workflow_manual_start_rejections TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_organization_coordination ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_organization_coordination_owner ON app.workflow_organization_coordination TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_organization_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_organization_receipts_owner ON app.workflow_organization_receipts TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_organization_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_organization_state_owner ON app.workflow_organization_state TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_organization_state_reader ON app.workflow_organization_state FOR SELECT TO {{api_runtime_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1
   FROM ((app.workspaces w
     JOIN app.workspace_memberships m ON ((m.workspace_id = w.id)))
     JOIN app.users u ON ((u.id = m.user_id)))
  WHERE ((w.id = workflow_organization_state.workspace_id) AND ((w.status)::text = 'active'::text) AND ((m.user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)) AND ((m.status)::text = 'active'::text) AND ((u.status)::text = 'active'::text))))));

ALTER TABLE app.workflow_run_active_admissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_run_active_admissions_owner ON app.workflow_run_active_admissions TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_runs_deadline_wakeup_owner_select ON app.workflow_runs FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY workflow_runs_deadline_wakeup_owner_update ON app.workflow_runs FOR UPDATE TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_runs_retention_delete_scope ON app.workflow_runs FOR DELETE TO {{owner_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY workflow_runs_workspace_scope ON app.workflow_runs TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_tag_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_tag_assignments_owner ON app.workflow_tag_assignments TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_tag_assignments_reader ON app.workflow_tag_assignments FOR SELECT TO {{api_runtime_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1
   FROM ((app.workspaces w
     JOIN app.workspace_memberships m ON ((m.workspace_id = w.id)))
     JOIN app.users u ON ((u.id = m.user_id)))
  WHERE ((w.id = workflow_tag_assignments.workspace_id) AND ((w.status)::text = 'active'::text) AND ((m.user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)) AND ((m.status)::text = 'active'::text) AND ((u.status)::text = 'active'::text))))));

ALTER TABLE app.workflow_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_tags_owner ON app.workflow_tags TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_tags_reader ON app.workflow_tags FOR SELECT TO {{api_runtime_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1
   FROM ((app.workspaces w
     JOIN app.workspace_memberships m ON ((m.workspace_id = w.id)))
     JOIN app.users u ON ((u.id = m.user_id)))
  WHERE ((w.id = workflow_tags.workspace_id) AND ((w.status)::text = 'active'::text) AND ((m.user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)) AND ((m.status)::text = 'active'::text) AND ((u.status)::text = 'active'::text))))));

ALTER TABLE app.workflow_template_origins ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_template_origins_owner ON app.workflow_template_origins TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_template_origins_tenant ON app.workflow_template_origins FOR SELECT TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_trigger_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_trigger_outcomes_owner_commands ON app.workflow_trigger_outcomes TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workflow_trigger_outcomes_worker_insert ON app.workflow_trigger_outcomes FOR INSERT TO {{worker_runtime_role}} WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_trigger_pause_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_trigger_pause_periods_owner ON app.workflow_trigger_pause_periods TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workflow_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_triggers_owner_resolver ON app.workflow_triggers FOR SELECT TO {{owner_role}} USING (true);

CREATE POLICY workflow_triggers_worker_reconciliation ON app.workflow_triggers TO {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY workflow_triggers_workspace_scope ON app.workflow_triggers TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflow_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_versions_worker_execution_read ON app.workflow_versions FOR SELECT TO {{worker_runtime_role}} USING ((((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)) AND ((checksum)::text ~~ 'wf:v2:sha256:%'::text) AND (executable_schema_version = 2) AND (executable_json IS NOT NULL) AND (compatibility_release_epoch > 0)));

CREATE POLICY workflow_versions_workspace_scope ON app.workflow_versions TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflows_worker_trigger_reconciliation ON app.workflows TO {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

CREATE POLICY workflows_workspace_scope ON app.workflows TO {{owner_role}}, {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_artifact_capacity ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_artifact_capacity_owner_all ON app.workspace_artifact_capacity TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_artifact_capacity_workspace_scope ON app.workspace_artifact_capacity TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_control_ledger_projection ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_control_ledger_projection_owner_all ON app.workspace_control_ledger_projection TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_creation_idempotency_actor_scope ON app.workspace_creation_idempotency_records TO {{api_runtime_role}} USING (((actor_user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text))) WITH CHECK (((actor_user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)));

CREATE POLICY workspace_creation_idempotency_owner_maintenance ON app.workspace_creation_idempotency_records TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workspace_creation_idempotency_records ENABLE ROW LEVEL SECURITY;

ALTER TABLE app.workspace_execution_admission_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_execution_admission_counters_scope ON app.workspace_execution_admission_counters TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_execution_entitlement_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_execution_entitlement_versions_scope ON app.workspace_execution_entitlement_versions TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_execution_entitlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_execution_entitlements_scope ON app.workspace_execution_entitlements TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_inbox_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_inbox_events_owner_commands ON app.workspace_inbox_events TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_inbox_events_worker_insert ON app.workspace_inbox_events FOR INSERT TO {{worker_runtime_role}} WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_inbox_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_inbox_reads_owner_commands ON app.workspace_inbox_reads TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_inbox_reads_recipient_scope ON app.workspace_inbox_reads TO {{api_runtime_role}} USING (app.workspace_inbox_recipient_eligible(workspace_id, user_id)) WITH CHECK (app.workspace_inbox_recipient_eligible(workspace_id, user_id));

ALTER TABLE app.workspace_inbox_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_inbox_threads_owner_commands ON app.workspace_inbox_threads TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_inbox_threads_recipient_select ON app.workspace_inbox_threads FOR SELECT TO {{api_runtime_role}} USING ((app.workspace_inbox_recipient_eligible(workspace_id, (NULLIF(current_setting('app.actor_id'::text, true), ''::text))::uuid) AND (latest_occurred_at > (statement_timestamp() - '720:00:00'::interval))));

ALTER TABLE app.workspace_invitation_acceptance_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_invitation_acceptance_intents_owner_maintenance ON app.workspace_invitation_acceptance_intents TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_invitation_acceptance_intents_workspace_scope ON app.workspace_invitation_acceptance_intents TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_invitation_binding_replacement_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_invitation_binding_replacement_claims_owner_maintenan ON app.workspace_invitation_binding_replacement_claims TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_invitation_binding_replacement_claims_workspace_scope ON app.workspace_invitation_binding_replacement_claims TO {{api_runtime_role}} USING (((prior_workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((prior_workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_invitation_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_invitation_command_receipts_owner_maintenance ON app.workspace_invitation_command_receipts TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_invitation_command_receipts_workspace_scope ON app.workspace_invitation_command_receipts TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_invitation_delivery_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_invitation_delivery_attempts_owner_maintenance ON app.workspace_invitation_delivery_attempts TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_invitation_delivery_attempts_workspace_scope ON app.workspace_invitation_delivery_attempts TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_invitations_owner_maintenance ON app.workspace_invitations TO {{owner_role}} USING (true) WITH CHECK (true);

CREATE POLICY workspace_invitations_workspace_scope ON app.workspace_invitations TO {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_legal_holds ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_legal_holds_owner_all ON app.workspace_legal_holds TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workspace_lifecycle_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_lifecycle_operations_owner_all ON app.workspace_lifecycle_operations TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workspace_member_departure_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_member_departure_command_receipts_workspace_scope ON app.workspace_member_departure_command_receipts TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_member_removal_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_member_removal_command_receipts_workspace_scope ON app.workspace_member_removal_command_receipts TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_member_role_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_member_role_command_receipts_workspace_scope ON app.workspace_member_role_command_receipts TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_member_suspension_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_member_suspension_command_receipts_workspace_scope ON app.workspace_member_suspension_command_receipts TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_memberships_actor_discovery ON app.workspace_memberships FOR SELECT TO {{api_runtime_role}} USING (((current_setting('app.discovery_scope'::text, true) = 'workspace_memberships'::text) AND (NULLIF(current_setting('app.workspace_id'::text, true), ''::text) IS NULL) AND ((user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)) AND ((status)::text = 'active'::text)));

CREATE POLICY workspace_memberships_workspace_scope ON app.workspace_memberships TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_ownership_transfer_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_ownership_transfer_command_receipts_workspace_scope ON app.workspace_ownership_transfer_command_receipts TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));

ALTER TABLE app.workspace_purge_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_purge_completions_owner_all ON app.workspace_purge_completions TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workspace_purge_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_purge_jobs_owner_all ON app.workspace_purge_jobs TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workspace_purge_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_purge_steps_owner_all ON app.workspace_purge_steps TO {{owner_role}} USING (true) WITH CHECK (true);

ALTER TABLE app.workspace_rename_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_rename_command_receipts_workspace_scope ON app.workspace_rename_command_receipts TO {{api_runtime_role}} USING (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text))) WITH CHECK (((workspace_id)::text = NULLIF(current_setting('app.workspace_id'::text, true), ''::text)));
