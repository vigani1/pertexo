-- History and version tables are append-only through grants: the app role
-- may insert but not update or delete them, and only purge and retention
-- (the maintenance role) delete. The triggers that re-checked this, and the
-- "purge is armed" function they asked, go. Artifact capacity asks whether
-- the workspace is purging directly.

DROP TRIGGER connection_events_immutable ON app.connection_events;
DROP TRIGGER connection_secret_versions_immutable ON app.connection_secret_versions;
DROP FUNCTION app.reject_connection_history_change();
DROP TRIGGER workflow_versions_immutable ON app.workflow_versions;
DROP FUNCTION app.reject_workflow_version_mutation();
DROP TRIGGER workspace_execution_entitlement_versions_immutable ON app.workspace_execution_entitlement_versions;
DROP FUNCTION app.reject_execution_entitlement_version_mutation();
DROP TRIGGER webhook_trigger_secret_versions_immutable ON app.webhook_trigger_secret_versions;
DROP FUNCTION app.reject_webhook_trigger_secret_version_mutation();
DROP TRIGGER failure_notification_destination_versions_immutable ON app.failure_notification_destination_versions;
DROP FUNCTION app.reject_failure_notification_destination_version_mutation();
DROP TRIGGER trigger_schedules_config_immutable ON app.trigger_schedules;
DROP FUNCTION app.reject_trigger_schedule_config_mutation();
DROP TRIGGER preview_run_pins_immutable ON app.preview_runs;
DROP FUNCTION app.reject_preview_run_pin_change();

CREATE OR REPLACE FUNCTION app.artifact_capacity_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_workspace_id uuid:=coalesce(NEW.workspace_id,OLD.workspace_id);
  v_context text:=nullif(current_setting('app.workspace_id',true),'');
  v_capacity app.workspace_artifact_capacity%ROWTYPE;
  v_purge boolean:=false;
  v_release boolean:=false;
BEGIN
  -- A purging workspace releases its artifacts without a tenant context.
  v_purge:=EXISTS(SELECT 1 FROM app.workspaces
    WHERE id=v_workspace_id AND status='purging');
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
$function$;

DROP FUNCTION app.workspace_purge_immutable_delete_is_armed(uuid);
