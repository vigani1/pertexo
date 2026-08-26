-- ADR 013 deletion-request side effects belong to the authoritative workspace
-- projection so normal command processing and disaster recovery behave alike.

CREATE POLICY run_events_lifecycle_owner_select
  ON app.run_events FOR SELECT TO {{owner_role}} USING (true);
CREATE POLICY run_events_lifecycle_owner_insert
  ON app.run_events FOR INSERT TO {{owner_role}} WITH CHECK (true);
CREATE POLICY run_checkpoints_lifecycle_owner_select
  ON app.run_checkpoints FOR SELECT TO {{owner_role}} USING (true);
CREATE POLICY run_checkpoints_lifecycle_owner_update
  ON app.run_checkpoints FOR UPDATE TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY node_runs_lifecycle_owner_select
  ON app.node_runs FOR SELECT TO {{owner_role}} USING (true);

CREATE FUNCTION app.apply_workspace_deletion_side_effects()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_prior_workspace text;
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

  UPDATE app.connections SET status='reauthorization_required',
    last_error_code='workspace.pending_deletion',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status='active';

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

CREATE TRIGGER workspaces_apply_deletion_side_effects
  AFTER UPDATE OF status ON app.workspaces FOR EACH ROW
  WHEN (NEW.status='pending_deletion')
  EXECUTE FUNCTION app.apply_workspace_deletion_side_effects();

REVOKE ALL ON FUNCTION app.apply_workspace_deletion_side_effects() FROM PUBLIC;

-- Repair workspaces projected before this migration. Reapplying status invokes
-- the same idempotent trigger without changing lifecycle authority.
UPDATE app.workspaces SET status=status WHERE status='pending_deletion';

CREATE FUNCTION app.require_active_workspace_integration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  PERFORM 1 FROM app.workspaces workspace
    WHERE workspace.id=NEW.workspace_id AND workspace.status='active'
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace integration is disabled' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER connections_require_active_workspace
  BEFORE INSERT OR UPDATE OF status ON app.connections FOR EACH ROW
  WHEN (NEW.status='active')
  EXECUTE FUNCTION app.require_active_workspace_integration();
CREATE TRIGGER workflow_triggers_require_active_workspace
  BEFORE INSERT OR UPDATE OF status ON app.workflow_triggers FOR EACH ROW
  WHEN (NEW.status<>'disabled')
  EXECUTE FUNCTION app.require_active_workspace_integration();
CREATE TRIGGER webhook_endpoints_require_active_workspace
  BEFORE INSERT OR UPDATE OF status ON app.webhook_trigger_endpoints FOR EACH ROW
  WHEN (NEW.status='active')
  EXECUTE FUNCTION app.require_active_workspace_integration();
CREATE TRIGGER trigger_schedules_require_active_workspace
  BEFORE INSERT OR UPDATE OF status ON app.trigger_schedules FOR EACH ROW
  WHEN (NEW.status='enabled')
  EXECUTE FUNCTION app.require_active_workspace_integration();
CREATE TRIGGER notification_destinations_require_active_workspace
  BEFORE INSERT OR UPDATE OF status ON app.failure_notification_destinations FOR EACH ROW
  WHEN (NEW.status='enabled')
  EXECUTE FUNCTION app.require_active_workspace_integration();

REVOKE ALL ON FUNCTION app.require_active_workspace_integration() FROM PUBLIC;
